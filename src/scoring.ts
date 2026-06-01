/**
 * Scoring engine — converts a set of issues into a 0-100 health score and a band.
 *
 * Generic and deterministic: score = 100 − Σ(weight[severity] × count), clamped to
 * [0, 100]. Weights and band thresholds come from config, so the same engine scores
 * a data pipeline, a SaaS API, or a CI system identically once configured.
 */

import type { HealthIssue, IssueSeverity, SeverityWeights } from "./types.js";

export type HealthBand = "healthy" | "warning" | "degraded" | "critical";

export interface ScoreResult {
  score: number;
  band: HealthBand;
  bySeverity: Record<IssueSeverity, number>;
}

const SEVERITIES: IssueSeverity[] = ["critical", "high", "medium", "low"];

export function countBySeverity(issues: HealthIssue[]): Record<IssueSeverity, number> {
  const counts: Record<IssueSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return counts;
}

export function computeScore(
  issues: HealthIssue[],
  weights: SeverityWeights,
  bands: { healthy: number; warning: number; degraded: number }
): ScoreResult {
  const bySeverity = countBySeverity(issues);
  let penalty = 0;
  for (const sev of SEVERITIES) penalty += bySeverity[sev] * weights[sev];

  const score = Math.max(0, Math.min(100, Math.round((100 - penalty) * 100) / 100));
  return { score, band: classifyBand(score, bands), bySeverity };
}

export function classifyBand(
  score: number,
  bands: { healthy: number; warning: number; degraded: number }
): HealthBand {
  if (score >= bands.healthy) return "healthy";
  if (score >= bands.warning) return "warning";
  if (score >= bands.degraded) return "degraded";
  return "critical";
}

/** Discord/terminal color for a band (decimal RGB for Discord embeds). */
export function bandColor(band: HealthBand): number {
  switch (band) {
    case "healthy":
      return 0x2ecc71; // green
    case "warning":
      return 0xf1c40f; // yellow
    case "degraded":
      return 0xe67e22; // orange
    case "critical":
      return 0xe74c3c; // red
  }
}

export function bandEmoji(band: HealthBand): string {
  return { healthy: "🟢", warning: "🟡", degraded: "🟠", critical: "🔴" }[band];
}
