/**
 * Healing plan generator — for each actionable issue, classifies how it would be
 * fixed, the confidence and risk, the safety gates that must hold, and any prior
 * fix attempts (from the solutions log). The plan is advisory: it's what a human or
 * an LLM agent reviews before anything executes. Nothing here runs a fix.
 */

import type { HealthReport, HealingPlan, HealingPlanItem, FixType, FixAttempt } from "../types.js";
import type { HealthCheckConfig, CollectorConfig } from "../config.js";
import type { StateStore } from "../state.js";

const RISK_ORDER = { low: 0, medium: 1, high: 2 };

export function generateHealingPlan(
  report: HealthReport,
  config: HealthCheckConfig,
  store: StateStore
): HealingPlan {
  const collectorById = new Map<string, CollectorConfig>(
    config.collectors.map((c) => [c.id, c])
  );
  const solutions = store.loadSolutions();

  const items: HealingPlanItem[] = report.issues
    .filter((i) => i.severity === "critical" || i.severity === "high" || i.severity === "medium")
    .map((issue, index) => {
      const col = collectorById.get(issue.source);
      const fix = col?.fix;
      const fixType: FixType = fix?.type ?? col?.fixType ?? "manual";

      const priorAttempts: FixAttempt[] = solutions
        .filter((s) => s.fingerprint === issue.fingerprint)
        .map((s) => ({
          date: s.date,
          fixType: s.fixType,
          approach: s.approach,
          outcome: s.outcome,
        }));

      const risk = fix?.estimatedRisk ?? defaultRisk(fixType);
      return {
        index,
        issue,
        fixType,
        confidence: fixType === "manual" ? "low" : priorAttempts.some((a) => a.outcome === "success") ? "high" : "medium",
        rationale: fix
          ? `Collector "${issue.source}" defines a ${fixType} fix.`
          : `No declarative fix defined — needs manual action or a GitHub issue.`,
        estimatedRisk: risk,
        safetyGates: fix?.safetyGates ?? defaultGates(fixType),
        previousAttempts: priorAttempts,
      };
    });

  // Lowest-risk first so cheap, safe fixes land before risky ones.
  const executionOrder = [...items]
    .sort((a, b) => RISK_ORDER[a.estimatedRisk] - RISK_ORDER[b.estimatedRisk])
    .map((i) => i.index);

  return {
    id: `plan-${report.generatedAt.replace(/[:.]/g, "-")}`,
    reportId: report.generatedAt,
    generatedAt: new Date().toISOString(),
    items,
    executionOrder,
    safetyNotes: [
      "Fixes execute only when healing.enabled is true and the fix type is in allowedFixTypes.",
      "Every fix requires approval unless healing.requireApproval is explicitly false.",
      "Manual-classified items are never auto-executed — they become GitHub issues for a human.",
    ],
  };
}

function defaultRisk(fixType: FixType): "low" | "medium" | "high" {
  switch (fixType) {
    case "retrigger":
    case "github_issue":
      return "low";
    case "http":
    case "shell":
      return "medium";
    case "sql":
      return "high";
    default:
      return "high";
  }
}

function defaultGates(fixType: FixType): string[] {
  switch (fixType) {
    case "sql":
      return ["Statement is reversible or backed up", "Affects a bounded row count", "Tested on a copy first"];
    case "shell":
      return ["Command is idempotent", "No destructive flags", "Scoped to this service"];
    case "retrigger":
      return ["The underlying cause is transient", "No duplicate side effects on re-run"];
    default:
      return ["Reviewed by a human"];
  }
}
