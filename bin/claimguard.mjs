#!/usr/bin/env node
// claimguard — Claude Code のサブエージェントが「完了しました」と報告した内容を、
// 実際のツール実行ログと機械的に突き合わせ、食い違いを検知する CLI。
//
// 使い方:
//   claimguard init                      # .claude/settings.json に足す hooks 設定を表示
//   claimguard hook post-tool-use         # PostToolUse フックから呼ばれる（stdinにJSON）
//   claimguard hook subagent-stop         # SubagentStop フックから呼ばれる（stdinにJSON）
//   claimguard report [--root .]          # 記録済みの食い違いをまとめて表示
//
// 設計原則：hookハンドラは何が起きても例外を外に投げない。フックがクラッシュすると
// Claude Code本体の動作を妨げるため、監査に失敗したら「何もしない」に倒す
// （adversarial-reviewer指摘対応）。

import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { appendToolCall, readToolCalls, clearLog, estimateCount, summarize, logDir } from "../src/hooklog.mjs";
import { extractClaims } from "../src/claims.mjs";
import { crossCheck } from "../src/crosscheck.mjs";
import { renderFlagsConsole, renderReportSummary } from "../src/report.mjs";
import { lastAssistantMessage } from "../src/transcript.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") args.root = argv[++i];
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

const HELP = `claimguard — サブエージェントの報告とツール実行ログを突き合わせて食い違いを検知する

使い方:
  claimguard init                 .claude/settings.json に追加する hooks 設定を表示
  claimguard hook post-tool-use    PostToolUse フックから呼ばれる（stdinにJSON、Claude Codeが自動で渡す）
  claimguard hook subagent-stop    SubagentStop フックから呼ばれる（stdinにJSON、Claude Codeが自動で渡す）
  claimguard report [--root .]     記録済みの食い違いをまとめて表示
`;

const HOOKS_SNIPPET = `{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "npx claimguard hook post-tool-use" }]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [{ "type": "command", "command": "npx claimguard hook subagent-stop" }]
      }
    ]
  }
}`;

function readStdinJSON() {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// v0レビュー指摘対応：以前はツール出力の**本文**に "error" 等の単語が含まれるだけで
// 失敗扱いにしていたため、grepの検索結果やログファイルの中身に"error"という文字列が
// 含まれるだけで誤って失敗判定していた（日常的に発生する）。v0では構造化フィールド
// （is_error等）のみを見る、保守的な判定に限定する。本文の文字列スキャンはしない。
function isErrorResponse(toolResponse) {
  if (toolResponse == null) return false;
  if (typeof toolResponse !== "object") return false;
  if (toolResponse.is_error === true) return true;
  if (typeof toolResponse.error === "string" && toolResponse.error.length > 0) return true;
  return false;
}

function toolResponseText(toolResponse) {
  if (toolResponse == null) return "";
  if (typeof toolResponse === "string") return toolResponse;
  if (typeof toolResponse.output === "string") return toolResponse.output;
  if (typeof toolResponse.content === "string") return toolResponse.content;
  try {
    return JSON.stringify(toolResponse);
  } catch {
    return String(toolResponse);
  }
}

// tool_input からファイルパスを直接取り出す（file_path/path/notebook_path等の
// よくあるキー名を試す）。v0レビュー指摘対応：JSON.stringify後に200文字で切り詰めた
// input_summary だけに頼ると、file_pathがJSONの後ろの方にあるだけで消えてしまい、
// Write/Editの主張が常に「未検証」になっていた。
function extractFilePath(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  return toolInput.file_path || toolInput.path || toolInput.notebook_path || "";
}

function cmdPostToolUse(root) {
  const payload = readStdinJSON();
  if (!payload) return; // 入力がなければ何もしない（監査対象外として静かにスキップ）
  const sessionId = payload.session_id || "unknown";
  const toolName = payload.tool_name || "unknown";
  const responseText = toolResponseText(payload.tool_response);
  appendToolCall(root, sessionId, {
    tool_name: toolName,
    success: !isErrorResponse(payload.tool_response),
    input_summary: summarize(JSON.stringify(payload.tool_input || {})),
    file_path: extractFilePath(payload.tool_input),
    output_summary: summarize(responseText),
    output_count: estimateCount(responseText),
  });
}

function cmdSubagentStop(root) {
  const payload = readStdinJSON();
  if (!payload) return;
  const sessionId = payload.session_id || "unknown";

  let reportText = payload.last_message || payload.message || "";
  if (!reportText && payload.transcript_path) {
    reportText = lastAssistantMessage(payload.transcript_path);
  }
  if (!reportText) return; // 報告テキストが取れなければ監査をスキップ

  const toolCalls = readToolCalls(root, sessionId);
  const claims = extractClaims(reportText);
  const flags = crossCheck(claims, toolCalls);

  if (flags.length > 0) {
    const dir = logDir(root);
    mkdirSync(dir, { recursive: true });
    const flagPath = join(dir, "flags.jsonl");
    for (const f of flags) {
      appendFileSync(flagPath, JSON.stringify({ ts: Date.now(), sessionId, ...f }) + "\n", "utf8");
    }
    // Claude Code の hook 出力（stderr）に警告を出す。ブロック(decision:"block")は
    // v0では行わない — まずは「気づかせる」ことを優先し、誤検知で作業を止めない設計。
    process.stderr.write(renderFlagsConsole(flags, { sessionId }) + "\n");
  }

  // 突き合わせが終わったログは消費済みとして消す（v0レビュー指摘：残したままだと
  // 過去の無関係な失敗が以後すべての報告を汚染し続ける）。
  clearLog(root, sessionId);
}

function cmdReport(root) {
  const dir = logDir(root);
  const flagPath = join(dir, "flags.jsonl");
  if (!existsSync(flagPath)) {
    console.log(renderReportSummary([]));
    return;
  }
  const lines = readFileSync(flagPath, "utf8").split("\n").filter(Boolean);
  const flags = [];
  for (const line of lines) {
    try {
      flags.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  console.log(renderReportSummary(flags));
}

// hookハンドラをこの関数で包み、どんな例外が起きても黙って握りつぶす
// （フックのクラッシュがClaude Code本体を妨げないようにするための最終防御）。
function runHookSafely(fn) {
  try {
    fn();
  } catch {
    // 監査に失敗しても、フック自体は必ず正常終了させる
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.root || ".");
  const cmd = args._[0];
  const sub = args._[1];

  if (args.help || !cmd) {
    console.log(HELP);
    return;
  }

  if (cmd === "init") {
    console.log("以下を .claude/settings.json の hooks に追記してください:\n");
    console.log(HOOKS_SNIPPET);
    return;
  }

  if (cmd === "hook" && sub === "post-tool-use") {
    runHookSafely(() => cmdPostToolUse(root));
    return;
  }

  if (cmd === "hook" && sub === "subagent-stop") {
    runHookSafely(() => cmdSubagentStop(root));
    return;
  }

  if (cmd === "report") {
    cmdReport(root);
    return;
  }

  console.error(`不明なコマンド: ${cmd}`);
  console.log(HELP);
  process.exitCode = 1;
}

main();
