// サブエージェントの最終報告テキストから「検証可能な主張」を抜き出す。
// 意味理解はせず、正規表現ベースのヒューリスティックで拾う（LLM判定に頼らない）。
//
// v0レビュー（adversarial-reviewer）で判明した既知の限界:
// - 部分文字列一致による誤検知（"abandoned"→"done"、"unblocked"→"blocked"）を
//   単語境界(\b)で防いでいるが、\b は Unicode 単語文字を認識しないため日本語には
//   効かない。日本語は「完了しました」のような複数文字の固有フレーズを使うことで
//   同種の事故を避けている
// - 否定の検出は「直前15文字以内の否定語」という粗いヒューリスティックであり、
//   複雑な否定構文（二重否定等）までは対応しない

const NEGATION_BEFORE_EN =
  /\b(not|never|n't|isn't|wasn't|didn't|couldn't|doesn't|hasn't)\s*$/i;
const NEGATION_BEFORE_JA = /(未|不|まだ)\s*$/;
const NEGATION_AFTER_JA = /^\s*(していません|していない|ではありません|ではない)/;

function findSignal(text, pattern) {
  const re = new RegExp(pattern, "gi");
  let m;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 15), m.index);
    const after = text.slice(re.lastIndex, re.lastIndex + 15);
    if (NEGATION_BEFORE_EN.test(before)) continue;
    if (NEGATION_BEFORE_JA.test(before)) continue;
    if (NEGATION_AFTER_JA.test(after)) continue;
    return true;
  }
  return false;
}

// 英語の単語は \b で単語境界を切り、部分文字列一致（"abandoned"→"done" 等）を防ぐ。
// 日本語は複数文字の固有フレーズにして同種の事故を避ける。
const SUCCESS_PATTERN =
  "\\b(completed|done|succeeded|successfully)\\b|no errors?\\b|完了しました|全部完了|問題なく|正常に完了|エラーなし|エラーはありません|すべて成功";
const FAILURE_PATTERN =
  "\\b(blocked|failed|failure|unable)\\b|couldn'?t|エラー(?:が発生|になりました)|失敗|ブロックされ|できませんでした|アクセスできません";

// 桁区切りカンマ（1,234件）を1つの数値として拾う。カンマ無しの数字にもマッチする。
const COUNT_CLAIM =
  /(\d{1,3}(?:,\d{3})+|\d+)\s*(files?|件|個|entries|items?|lines?|matches?|行|箇所)/gi;

// 英語は「動詞 + パス」、日本語は「パス + を + 動詞」の語順になるため別パターンで拾う。
// バッククォート（コードスパン）で囲まれたパスも拾えるよう、事前にバッククォートを除去してから照合する。
const FILE_ACTION_CLAIM_EN =
  /(wrote|created|deleted|updated|removed)\s+([\w./\\-]+\.[a-zA-Z0-9]{1,8})/gi;
const FILE_ACTION_CLAIM_JA =
  /([\w./\\-]+\.[a-zA-Z0-9]{1,8})\s*を\s*(作成し|削除し|更新し|書き込み)/g;

export function extractClaims(reportText) {
  const text = String(reportText || "");
  const textForFileActions = text.replace(/`/g, "");

  const claims = {
    success: findSignal(text, SUCCESS_PATTERN),
    failure: findSignal(text, FAILURE_PATTERN),
    counts: [],
    fileActions: [],
  };

  let m;
  const countRe = new RegExp(COUNT_CLAIM);
  while ((m = countRe.exec(text)) !== null) {
    claims.counts.push({ n: Number(m[1].replace(/,/g, "")), unit: m[2], raw: m[0] });
  }

  const enRe = new RegExp(FILE_ACTION_CLAIM_EN);
  while ((m = enRe.exec(textForFileActions)) !== null) {
    claims.fileActions.push({ verb: m[1], path: m[2], raw: m[0] });
  }
  const jaRe = new RegExp(FILE_ACTION_CLAIM_JA);
  while ((m = jaRe.exec(textForFileActions)) !== null) {
    claims.fileActions.push({ verb: m[2], path: m[1], raw: m[0] });
  }

  return claims;
}
