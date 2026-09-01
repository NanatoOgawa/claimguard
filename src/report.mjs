export function renderFlagsConsole(flags, { sessionId } = {}) {
  if (flags.length === 0) {
    return `claimguard: 食い違いは検出されませんでした${sessionId ? `（session ${sessionId}）` : ""}。`;
  }
  const lines = [];
  lines.push(`claimguard: ${flags.length}件の食い違いを検出しました${sessionId ? `（session ${sessionId}）` : ""}`);
  for (const f of flags) {
    const mark = f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟡" : "⚪";
    lines.push(`  ${mark} [${f.kind}] ${f.message}`);
  }
  return lines.join("\n");
}

export function renderReportSummary(allFlags) {
  if (allFlags.length === 0) {
    return "claimguard report: 記録された食い違いはありません。";
  }
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const f of allFlags) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  const lines = [];
  lines.push(
    `claimguard report: 累計${allFlags.length}件（🔴high ${bySeverity.high || 0} / 🟡medium ${bySeverity.medium || 0} / ⚪low ${bySeverity.low || 0}）`
  );
  for (const f of allFlags.slice(-20)) {
    const mark = f.severity === "high" ? "🔴" : f.severity === "medium" ? "🟡" : "⚪";
    lines.push(`  ${mark} [${f.sessionId || "?"}] ${f.message}`);
  }
  return lines.join("\n");
}
