/**
 * Console delivery — renders a HealthReport to the terminal. Always available
 * (no config needed) and the default channel, so the engine is useful the moment
 * it's installed, before any chat integration is wired up.
 */

import type { HealthReport } from "../types.js";
import { classifyBand, bandEmoji } from "../scoring.js";
import type { HealthCheckConfig } from "../config.js";

export function renderConsole(report: HealthReport, config: HealthCheckConfig): string {
  const band = classifyBand(report.summary.healthScore, config.scoreBands);
  const lines: string[] = [];

  lines.push("");
  lines.push(`${bandEmoji(band)}  ${config.project} — Health ${report.summary.healthScore}/100 (${band})`);
  if (report.scope) lines.push(`   scope: ${report.scope}`);
  lines.push(
    `   ${report.summary.totalIssues} issue(s) · ` +
      `critical ${report.summary.bySeverity.critical} · high ${report.summary.bySeverity.high} · ` +
      `medium ${report.summary.bySeverity.medium} · low ${report.summary.bySeverity.low}`
  );
  lines.push(`   window: last ${report.periodHours}h · generated ${report.generatedAt}`);
  lines.push("");

  if (report.issues.length === 0) {
    lines.push("   ✓ No issues detected.");
  } else {
    for (const issue of report.issues) {
      lines.push(`   ${sevTag(issue.severity)} [${issue.source}] ${issue.title}`);
      if (issue.suggestedFix) lines.push(`        fix: ${issue.suggestedFix}`);
    }
  }

  const failed = Object.entries(report.collectorStatus).filter(([, s]) => !s.success);
  if (failed.length) {
    lines.push("");
    lines.push(`   ⚠ ${failed.length} collector(s) failed: ${failed.map(([id]) => id).join(", ")}`);
  }

  lines.push("");
  return lines.join("\n");
}

function sevTag(sev: string): string {
  return { critical: "🔴 CRIT", high: "🟠 HIGH", medium: "🟡 MED ", low: "⚪ LOW " }[sev] ?? sev;
}
