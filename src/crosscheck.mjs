// 「サブエージェントの主張」と「実際のツール呼び出しログ」を突き合わせ、
// 食い違いをフラグとして返す。判定はすべて機械的な照合で、LLMには問わない
// （checker自体が幻覚しうるリスクを避けるため）。

function pctDiff(a, b) {
  if (a === 0 && b === 0) return 0;
  const denom = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / denom;
}

// 出力（ツール実行結果・報告文由来のテキスト）を stderr に流す前に、制御文字
// （ANSIエスケープ等での端末操作）を無害化する。v0レビューで指摘された経路。
function sanitize(text) {
  return String(text).replace(/[\x00-\x1f\x7f]/g, "");
}

const FILE_ACTION_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const DELETE_VERBS = new Set(["deleted", "削除し", "removed"]);

export function crossCheck(claims, toolCalls) {
  const flags = [];
  const failedCalls = toolCalls.filter((c) => c.success === false);

  // 「成功した」「失敗した」を同じ報告内で両方述べているのは、部分成功・部分失敗を
  // 正直に報告している正常なケースであることが多い（v0レビューで、これを機械的に
  // 誤報告扱いすると正しい報告まで毎回フラグになると判明）。判定不能として両方スキップする。
  const ambiguous = claims.success && claims.failure;

  // 1. 「成功した」と言っているのに、ログ上に失敗したツール呼び出しがある
  if (!ambiguous && claims.success && failedCalls.length > 0) {
    flags.push({
      severity: "high",
      kind: "success-vs-failed-tool-call",
      message: `報告は成功/完了を主張していますが、ログには失敗したツール呼び出しが${failedCalls.length}件あります（例: ${failedCalls[0].tool_name}）。`,
    });
  }

  // 2. 「失敗/ブロックされた」と言っているのに、ログ上に失敗の記録が一切ない
  //    （本ツールの開発動機になった実体験：ログイン済みなのに「ブロックされた」と誤報告したケースと同型）
  if (!ambiguous && claims.failure && failedCalls.length === 0 && toolCalls.length > 0) {
    flags.push({
      severity: "medium",
      kind: "failure-without-evidence",
      message:
        "報告は失敗/ブロックを主張していますが、ログ上には失敗したツール呼び出しの記録が見当たりません。誤報告の可能性があります（実際は成功しているのに諦めていないか確認してください）。",
    });
  }

  // 3. 件数の主張とツール出力の推定件数の食い違い
  //    v0: estimateCount は JSON配列の要素数が明確な場合のみ値を持つ（誤検知を避けるため
  //    プレーンテキストの行数等は「件数不明」として比較対象から除外している）
  const countedCalls = toolCalls.filter((c) => typeof c.output_count === "number");
  for (const claim of claims.counts) {
    if (countedCalls.length === 0) continue;
    // 直近のツール呼び出しの推定件数と比較する（v0のヒューリスティック。複数呼び出し
    // をまたいだ集計は非対応）
    const nearest = countedCalls[countedCalls.length - 1];
    const diff = pctDiff(claim.n, nearest.output_count);
    if (diff > 0.2) {
      flags.push({
        severity: "medium",
        kind: "count-mismatch",
        message: `報告は「${sanitize(claim.raw)}」と主張していますが、直近のツール呼び出し（${nearest.tool_name}）の出力から推定される件数は約${nearest.output_count}件で、${Math.round(diff * 100)}%の食い違いがあります。`,
      });
    }
  }

  // 4. ファイル操作の主張に対応するログが見つからない
  //    Write/Edit/MultiEdit/NotebookEditのtool_input（file_pathがあればそれを優先）と、
  //    削除の主張は Bash 経由の rm 等も許容して照合する（v0レビュー：Writeのみだと
  //    削除・NotebookEdit経由の変更が常に「未検証」になっていた）
  for (const action of claims.fileActions) {
    const isDelete = DELETE_VERBS.has(action.verb);
    const matched = toolCalls.some((c) => {
      const haystack = `${c.input_summary || ""} ${c.file_path || ""}`;
      if (!haystack.includes(action.path)) return false;
      if (isDelete) return c.tool_name === "Bash" || FILE_ACTION_TOOLS.has(c.tool_name);
      return FILE_ACTION_TOOLS.has(c.tool_name);
    });
    if (!matched) {
      flags.push({
        severity: "low",
        kind: "file-action-unverified",
        message: `「${sanitize(action.raw)}」という主張に対応するツール呼び出しの記録がログに見つかりません。`,
      });
    }
  }

  return flags;
}
