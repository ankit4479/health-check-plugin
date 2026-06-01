/**
 * Report builder — assembles collector output + scoring into a HealthReport, the
 * single artifact that downstream steps (delivery, GitHub issues, healing) consume.
 */

import type { HealthCheckConfig } from "./config.js";
import type { HealthReport, HealthIssue, CollectorStatus, HealthNote } from "./types.js";
import { computeScore } from "./scoring.js";

export function buildReport(
  config: HealthCheckConfig,
  issues: HealthIssue[],
  collectorStatus: Record<string, CollectorStatus>,
  notes: HealthNote[] = []
): HealthReport {
  const { score, bySeverity } = computeScore(issues, config.severityWeights, config.scoreBands);

  return {
    generatedAt: new Date().toISOString(),
    periodHours: config.periodHours,
    scope: config.scope,
    summary: {
      totalIssues: issues.length,
      bySeverity,
      healthScore: score,
    },
    // Surface the worst problems first.
    issues: [...issues].sort((a, b) => severityRank(b.severity) - severityRank(a.severity)),
    notes,
    collectorStatus,
  };
}

function severityRank(s: HealthIssue["severity"]): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[s];
}
