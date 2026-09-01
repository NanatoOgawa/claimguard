import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { appendToolCall, readToolCalls, estimateCount } from "../src/hooklog.mjs";
import { extractClaims } from "../src/claims.mjs";
import { crossCheck } from "../src/crosscheck.mjs";
import { lastAssistantMessage } from "../src/transcript.mjs";

let pass = 0;
let fail = 0;

function ok(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL: ${msg}`);
  }
}

function eq(a, b, msg) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// --- hooklog -----------------------------------------------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "claimguard-hooklog-"));
  appendToolCall(tmp, "s1", { tool_name: "Bash", success: true, input_summary: "ls" });
  appendToolCall(tmp, "s1", { tool_name: "Read", success: false, input_summary: "missing.txt" });
  const calls = readToolCalls(tmp, "s1");
  eq(calls.length, 2, "readToolCalls は書き込んだ件数を返す");
  ok(calls[0].tool_name === "Bash" && calls[1].success === false, "各エントリの内容が保持される");
  eq(readToolCalls(tmp, "unknown-session").length, 0, "存在しないセッションは空配列");
  rmSync(tmp, { recursive: true, force: true });
}

{
  eq(estimateCount(JSON.stringify([1, 2, 3])), 3, "JSON配列の要素数を数える");
  // v0レビュー指摘対応：プレーンテキストの行数は「件数」として使わない（誤検知の元だった）
  eq(estimateCount("a\nb\nc\n"), null, "プレーンテキストの行数は件数として扱わない（誤検知防止）");
  eq(estimateCount(""), null, "空文字はnull");
  eq(estimateCount(null), null, "nullはnull");
}

// --- claims --------------------------------------------------------------
{
  const c1 = extractClaims("すべて成功しました。15件のファイルを処理しました。");
  ok(c1.success === true, "成功ワードを検出する");
  ok(c1.failure === false, "成功のみの文では失敗を検出しない");
  eq(c1.counts.length, 1, "件数の主張を1件検出する");
  eq(c1.counts[0].n, 15, "件数の数値を正しく取り出す");

  const c2 = extractClaims("ログイン要求でブロックされたため、これ以上進められませんでした。");
  ok(c2.failure === true, "失敗/ブロックワードを検出する");
  ok(c2.success === false, "失敗のみの文では成功を検出しない");

  const c3 = extractClaims("report.mjs を作成し、README.md を更新しました。");
  ok(c3.fileActions.length >= 2, "ファイル操作の主張を複数検出する");

  // v0レビューで見つかった誤検知パターンの回帰テスト
  const c4 = extractClaims("I abandoned the attempt.");
  ok(c4.success === false, "'abandoned'の部分文字列'done'を誤検知しない");

  const c5 = extractClaims("The connection is unblocked now.");
  ok(c5.failure === false, "'unblocked'の部分文字列'blocked'を誤検知しない");

  const c6 = extractClaims("The task is not done yet.");
  ok(c6.success === false, "否定文('not done')を成功として誤検知しない");

  const c7 = extractClaims("処理は未完了しました。");
  ok(c7.success === false, "「未」で始まる否定接頭辞がある場合は完了扱いにしない");

  const c8 = extractClaims("1,234件のレコードを処理しました。");
  eq(c8.counts[0]?.n, 1234, "カンマ区切りの件数を正しくパースする（1,234→1234であり234ではない）");

  const c9 = extractClaims("Created `src/foo.js` and wrote `a/b.ts`.");
  eq(c9.fileActions.length, 2, "バッククォートで囲まれたファイルパスも検出する");
}

// --- crosscheck ------------------------------------------------------------
{
  // 1. 成功主張 vs 失敗ログ → high
  const claimsSuccess = extractClaims("すべて完了しました。");
  const flags1 = crossCheck(claimsSuccess, [{ tool_name: "Bash", success: false }]);
  ok(flags1.some((f) => f.kind === "success-vs-failed-tool-call"), "成功主張×失敗ログでhighフラグ");

  // 2. 失敗主張 vs 失敗ログなし → medium（本ツールの開発動機そのもののケース）
  const claimsFailure = extractClaims("ログイン要求でブロックされました。");
  const flags2 = crossCheck(claimsFailure, [{ tool_name: "Bash", success: true }]);
  ok(flags2.some((f) => f.kind === "failure-without-evidence"), "失敗主張×失敗ログなしでmediumフラグ（誤報告検知）");

  // 3. 食い違いのないクリーンなケース → フラグなし
  const claimsClean = extractClaims("すべて完了しました。");
  const flags3 = crossCheck(claimsClean, [{ tool_name: "Bash", success: true }]);
  eq(flags3.length, 0, "食い違いがなければフラグは0件");

  // 4. 件数の食い違い
  const claimsCount = extractClaims("検索結果は15件見つかりました。");
  const flags4 = crossCheck(claimsCount, [{ tool_name: "Grep", success: true, output_count: 3 }]);
  ok(flags4.some((f) => f.kind === "count-mismatch"), "件数の食い違いでmediumフラグ");

  // 5. ファイル操作の主張が未検証
  const claimsFile = extractClaims("report.mjs を作成しました。");
  const flags5 = crossCheck(claimsFile, [{ tool_name: "Bash", success: true, input_summary: "ls" }]);
  ok(flags5.some((f) => f.kind === "file-action-unverified"), "対応するWrite/Editがなければlowフラグ");

  // 6. 部分成功・部分失敗（成功と失敗を両方述べる、正直で正常な報告）はフラグにしない
  const claimsMixed = extractClaims("3件は完了しました。1件は失敗しました。");
  const flags6 = crossCheck(claimsMixed, [{ tool_name: "Bash", success: false }]);
  ok(
    !flags6.some((f) => f.kind === "success-vs-failed-tool-call" || f.kind === "failure-without-evidence"),
    "成功と失敗を両方正直に報告している場合は誤報告フラグを立てない"
  );

  // 7. file_path フィールドがあれば、200文字に切り詰められた input_summary に頼らず照合できる
  const claimsFile2 = extractClaims("report.mjs を作成しました。");
  const flags7 = crossCheck(claimsFile2, [
    { tool_name: "Write", success: true, input_summary: "(truncated, does not contain path)", file_path: "products/claimguard/report.mjs" },
  ]);
  eq(flags7.length, 0, "file_pathフィールド経由でファイル操作の主張を検証できる");

  // 8. 削除の主張は Bash 経由の rm でも検証できる
  const claimsDelete = extractClaims("old.js を削除しました。");
  const flags8 = crossCheck(claimsDelete, [{ tool_name: "Bash", success: true, input_summary: "rm old.js" }]);
  eq(flags8.length, 0, "削除の主張はBash rm等の記録でも検証できる");
}

// --- transcript ------------------------------------------------------------
{
  ok(lastAssistantMessage(undefined) === "", "transcript_pathがなければ空文字");
  ok(lastAssistantMessage("/no/such/file.jsonl") === "", "存在しないファイルは空文字");
}

// --- CLI統合（hook post-tool-use → hook subagent-stop → report） -----------
{
  const tmp = mkdtempSync(join(tmpdir(), "claimguard-cli-"));
  const binPath = new URL("../bin/claimguard.mjs", import.meta.url).pathname;

  // 成功したツール呼び出しを1件記録
  execFileSync("node", [binPath, "hook", "post-tool-use", "--root", tmp], {
    input: JSON.stringify({
      session_id: "cli-test",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { output: "file1.txt\nfile2.txt" },
    }),
  });

  const calls = readToolCalls(tmp, "cli-test");
  eq(calls.length, 1, "CLI経由でPostToolUseのログが1件記録される");
  ok(calls[0].success === true, "エラーを含まない出力はsuccess=true扱い");

  // 「ブロックされた」という誤報告（＝失敗の記録がないのに失敗を主張）を送る
  execFileSync("node", [binPath, "hook", "subagent-stop", "--root", tmp], {
    input: JSON.stringify({
      session_id: "cli-test",
      last_message: "ログイン要求でブロックされたため、これ以上進められませんでした。",
    }),
  });

  const flagsPath = join(tmp, ".claimguard", "logs", "flags.jsonl");
  ok(existsSync(flagsPath), "食い違いがあればflags.jsonlが生成される");
  const flagLines = readFileSync(flagsPath, "utf8").split("\n").filter(Boolean);
  ok(flagLines.length >= 1, "flags.jsonlに1件以上記録される");
  ok(flagLines.some((l) => l.includes("failure-without-evidence")), "誤報告検知のフラグ種別が記録される");

  const reportOut = execFileSync("node", [binPath, "report", "--root", tmp], { encoding: "utf8" });
  ok(reportOut.includes("claimguard report"), "reportコマンドがサマリを出力する");

  rmSync(tmp, { recursive: true, force: true });
}

// --- v0レビュー回帰: 本文に"error"を含むだけの正常出力を失敗扱いしない -----------
{
  const tmp = mkdtempSync(join(tmpdir(), "claimguard-notfail-"));
  const binPath = new URL("../bin/claimguard.mjs", import.meta.url).pathname;

  // grepの検索結果に"error"という文字列が含まれるだけの、実際には成功しているケース
  execFileSync("node", [binPath, "hook", "post-tool-use", "--root", tmp], {
    input: JSON.stringify({
      session_id: "grep-test",
      tool_name: "Grep",
      tool_input: {},
      tool_response: { output: "src/a.js:12: // handle error case" },
    }),
  });
  const calls = readToolCalls(tmp, "grep-test");
  ok(calls[0].success === true, "出力本文に'error'を含むだけでは失敗扱いにしない（v0レビュー指摘対応）");

  rmSync(tmp, { recursive: true, force: true });
}

// --- v0レビュー回帰: 突き合わせ済みログは消費され、無関係な過去の失敗を引きずらない ---
{
  const tmp = mkdtempSync(join(tmpdir(), "claimguard-clear-"));
  const binPath = new URL("../bin/claimguard.mjs", import.meta.url).pathname;

  // 1回目：失敗したツール呼び出し＋成功主張 → highフラグが出るはず
  execFileSync("node", [binPath, "hook", "post-tool-use", "--root", tmp], {
    input: JSON.stringify({
      session_id: "reuse-test",
      tool_name: "Bash",
      tool_input: {},
      tool_response: { is_error: true, error: "boom" },
    }),
  });
  execFileSync("node", [binPath, "hook", "subagent-stop", "--root", tmp], {
    input: JSON.stringify({ session_id: "reuse-test", last_message: "すべて完了しました。" }),
  });

  // 2回目：全く新しい・問題のないツール呼び出し＋成功主張 → 1回目の失敗を引きずってはいけない
  execFileSync("node", [binPath, "hook", "post-tool-use", "--root", tmp], {
    input: JSON.stringify({
      session_id: "reuse-test",
      tool_name: "Bash",
      tool_input: {},
      tool_response: { output: "ok" },
    }),
  });
  execFileSync("node", [binPath, "hook", "subagent-stop", "--root", tmp], {
    input: JSON.stringify({ session_id: "reuse-test", last_message: "すべて完了しました。" }),
  });

  const flagsPath = join(tmp, ".claimguard", "logs", "flags.jsonl");
  const flagLines = readFileSync(flagsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const highFlags = flagLines.filter((f) => f.kind === "success-vs-failed-tool-call");
  eq(highFlags.length, 1, "突き合わせ済みのログは消費され、次回の評価で過去の失敗を引きずらない");

  rmSync(tmp, { recursive: true, force: true });
}

// --- CLI: エラーのないケースではflags.jsonlを作らない -----------------------
{
  const tmp = mkdtempSync(join(tmpdir(), "claimguard-clean-"));
  const binPath = new URL("../bin/claimguard.mjs", import.meta.url).pathname;

  execFileSync("node", [binPath, "hook", "post-tool-use", "--root", tmp], {
    input: JSON.stringify({
      session_id: "clean",
      tool_name: "Bash",
      tool_input: {},
      tool_response: { output: "ok" },
    }),
  });
  execFileSync("node", [binPath, "hook", "subagent-stop", "--root", tmp], {
    input: JSON.stringify({ session_id: "clean", last_message: "すべて完了しました。" }),
  });

  const flagsPath = join(tmp, ".claimguard", "logs", "flags.jsonl");
  ok(!existsSync(flagsPath), "食い違いがなければflags.jsonlは生成されない");

  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
