// セッション/サブエージェントごとのツール呼び出しログを JSONL で読み書きする。
// フォーマット:
//   {"ts": <epoch ms>, "tool_name": "Bash", "success": true, "input_summary": "...", "output_summary": "..."}

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

export function logDir(root) {
  return join(root, ".claimguard", "logs");
}

export function logPathFor(root, sessionId) {
  const safe = String(sessionId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(logDir(root), `${safe}.jsonl`);
}

export function appendToolCall(root, sessionId, entry) {
  const p = logPathFor(root, sessionId);
  mkdirSync(dirname(p), { recursive: true });
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
  appendFileSync(p, line, "utf8");
}

// SubagentStopでの突き合わせが終わったログは消費済みとして消す。
// v0レビューで判明：消さないままだと、過去（無関係な時点）の失敗が以後すべての
// 報告を汚染し続ける（一度こけると以後ずっとhighフラグが出る）。
export function clearLog(root, sessionId) {
  const p = logPathFor(root, sessionId);
  try {
    rmSync(p, { force: true });
  } catch {
    // 消せなくても致命的ではない（次回また同じ内容で誤検知するだけ）
  }
}

export function readToolCalls(root, sessionId) {
  const p = logPathFor(root, sessionId);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      // 壊れた行は無視（監査ツール自体がクラッシュしないことを優先）
    }
  }
  return out;
}

// ツール実行結果から「件数っぽい数字」を粗く推定する。
// v0レビューで判明：任意のテキスト出力の「非空行数」を件数として使うと、ファイル内容や
// ビルドログなど件数と無関係な出力まで比較対象になり、count-mismatch がほぼ全件誤検知に
// なることが実測で確認された。そのため v0 では **JSON配列の要素数が明確に分かる場合のみ**
// 件数として扱い、それ以外（プレーンテキストの行数等）は「件数不明」として比較対象から
// 外す（誤検知を減らすため、検知漏れの方を許容する設計判断）。
export function estimateCount(outputText) {
  if (outputText == null) return null;
  const text = String(outputText);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.length;
  } catch {
    // JSONでなければ「件数不明」とする
  }
  return null;
}

export function summarize(text, max = 200) {
  if (text == null) return "";
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
