/**
 * Orchestrator — the run cycle that ties every layer together:
 *   collect → score → build report → update memory/verify → persist → deliver
 *            → (optional) file GitHub issues → (optional) generate healing plan.
 *
 * This is the single entry point used by the CLI, by scheduled jobs, and by agent
 * skills. Each phase is also exposed individually so an agent can drive the board
 * interactively (run, then discuss, then approve, then heal).
 */

import type { HealthCheckConfig } from "./config.js";
import type { HealthReport, VerificationResult, HealingPlan } from "./types.js";
import { runCollectors, type CollectorContext } from "./collectors/index.js";
import { closePools } from "./collectors/postgres.js";
import { buildReport } from "./report.js";
import { deliver } from "./delivery/index.js";
import { StateStore } from "./state.js";
import { updateFingerprintHistory } from "./memory.js";
import { syncIssuesToGitHub, type GitHubResult } from "./github.js";
import { generateHealingPlan } from "./healing/plan.js";

export interface RunOptions {
  /** Override the lookback window. */
  periodHours?: number;
  /** Create GitHub issues in the same run (skips the discuss-first step). */
  fileIssues?: boolean;
  /** Generate (but do not execute) a healing plan. */
  withPlan?: boolean;
  /** Suppress channel delivery (collect + score only). */
  quiet?: boolean;
}

export interface RunResult {
  report: HealthReport;
  reportPath: string;
  verification: VerificationResult;
  github?: GitHubResult;
  plan?: HealingPlan;
}

export async function runCycle(config: HealthCheckConfig, opts: RunOptions = {}): Promise<RunResult> {
  const periodHours = opts.periodHours ?? config.periodHours;
  const ctx: CollectorContext = { config, periodHours, pools: new Map() };
  const store = new StateStore(config.stateDir);

  try {
    const { issues, status } = await runCollectors(ctx);
    const report = buildReport(config, issues, status);

    const verification = updateFingerprintHistory(store, report);
    const reportPath = store.saveReport(report);

    if (!opts.quiet) await deliver(report, config);

    let github: GitHubResult | undefined;
    if (opts.fileIssues && config.github.enabled) {
      github = await syncIssuesToGitHub(report.issues, config.github);
    }

    let plan: HealingPlan | undefined;
    if (opts.withPlan) plan = generateHealingPlan(report, config, store);

    return { report, reportPath, verification, github, plan };
  } finally {
    await closePools(ctx);
  }
}
