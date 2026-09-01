// Claude Code の transcript_path（セッションのJSONLログ）から、
// サブエージェントが最後に発した「報告テキスト」を取り出す。
//
// 注意：Claude Codeのフック入力スキーマは将来変わりうる。ここでは
// 複数の想定パターンを順に試す防御的な実装にしてあり、どれにも
// 一致しない場合は空文字を返す（監査自体はスキップされるだけで、
// クラッシュはしない設計）。

import { existsSync, readFileSync } from "node:fs";

function extractTextFromContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && (c.type === "text" || typeof c.text === "string"))
      .map((c) => c.text || "")
      .join("\n");
  }
  return "";
}

export function lastAssistantMessage(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return "";
  const raw = readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const role = entry.role || entry.message?.role || entry.type;
    if (role === "assistant") {
      const content = entry.content ?? entry.message?.content;
      const text = extractTextFromContent(content);
      if (text) return text;
    }
  }
  return "";
}
