/**
 * Healing executor — runs the declarative fix actions from a plan, but only inside
 * a strict safety envelope:
 *   1. healing.enabled must be true
 *   2. the fix type must be in healing.allowedFixTypes
 *   3. approval must be granted (unless healing.requireApproval === false)
 *   4. healing.maxPerRun caps how many fixes run
 *   5. healing.dryRun short-circuits to a no-op that logs what *would* run
 * Manual fixes are never executed here. Every outcome is compounded to memory.
 */

import { exec } from "node:child_process";
import type { HealingPlan, HealingPlanItem, FixOutcome, CompoundEntry } from "../types.js";
import type { HealthCheckConfig, FixAction, CollectorConfig } from "../config.js";
import type { StateStore } from "../state.js";
import { getPool } from "../collectors/postgres.js";
import { compoundFix } from "../memory.js";
import type { CollectorContext } from "../collectors/index.js";

export interface HealOptions {
  /** Indices (into plan.items) the human approved. Empty + requireApproval = nothing runs. */
  approvedIndices?: number[];
  ctx: CollectorContext;
  store: StateStore;
}

export interface HealResult {
  executed: Array<{ index: number; fixType: string; outcome: FixOutcome; detail: string }>;
  skipped: Array<{ index: number; reason: string }>;
}

export async function executeHealing(
  plan: HealingPlan,
  config: HealthCheckConfig,
  opts: HealOptions
): Promise<HealResult> {
  const result: HealResult = { executed: [], skipped: [] };
  const healing = config.healing;
  if (!healing.enabled) {
    plan.items.forEach((i) => result.skipped.push({ index: i.index, reason: "healing disabled" }));
    return result;
  }

  const allowed = new Set(healing.allowedFixTypes ?? []);
  const requireApproval = healing.requireApproval !== false;
  const approved = new Set(opts.approvedIndices ?? []);
  const maxPerRun = healing.maxPerRun ?? 5;
  const collectorById = new Map<string, CollectorConfig>(config.collectors.map((c) => [c.id, c]));

  let ran = 0;
  for (const index of plan.executionOrder) {
    const item = plan.items.find((i) => i.index === index);
    if (!item) continue;

    if (ran >= maxPerRun) {
      result.skipped.push({ index, reason: `maxPerRun (${maxPerRun}) reached` });
      continue;
    }
    if (item.fixType === "manual" || item.fixType === "github_issue") {
      result.skipped.push({ index, reason: `${item.fixType} is not auto-executable` });
      continue;
    }
    if (!allowed.has(item.fixType)) {
      result.skipped.push({ index, reason: `fix type "${item.fixType}" not in allowedFixTypes` });
      continue;
    }
    if (requireApproval && !approved.has(index)) {
      result.skipped.push({ index, reason: "not approved" });
      continue;
    }

    const fix = collectorById.get(item.issue.source)?.fix;
    if (!fix) {
      result.skipped.push({ index, reason: "no declarative fix action on collector" });
      continue;
    }

    if (healing.dryRun) {
      result.executed.push({ index, fixType: item.fixType, outcome: "skipped", detail: `[dry-run] would run: ${describeFix(fix)}` });
      ran++;
      continue;
    }

    let outcome: FixOutcome = "pending";
    let detail = "";
    try {
      detail = await runFix(fix, opts.ctx);
      outcome = "success";
    } catch (err) {
      outcome = "failure";
      detail = (err as Error).message;
    }
    result.executed.push({ index, fixType: item.fixType, outcome, detail });
    ran++;

    const entry: CompoundEntry = {
      date: new Date().toISOString(),
      fingerprint: item.issue.fingerprint,
      source: item.issue.source,
      title: item.issue.title,
      severity: item.issue.severity,
      rootCause: item.issue.rootCause ?? "",
      fixType: item.fixType,
      approach: describeFix(fix),
      outcome,
      verified: false,
    };
    compoundFix(opts.store, entry);
  }

  return result;
}

function describeFix(fix: FixAction): string {
  if (fix.command) return `${fix.type}: ${fix.command}`;
  if (fix.url) return `${fix.type}: POST ${fix.url}`;
  return fix.type;
}

async function runFix(fix: FixAction, ctx: CollectorContext): Promise<string> {
  switch (fix.type) {
    case "shell":
    case "retrigger": {
      if (!fix.command) throw new Error("fix.command is required for shell/retrigger");
      return execCapture(fix.command, 60_000);
    }
    case "sql": {
      if (!fix.command || !fix.dataSource) throw new Error("fix.command + fix.dataSource required for sql");
      const pool = await getPool(ctx, fix.dataSource);
      const r = await pool.query(fix.command);
      return `sql ok (${r.rows.length} rows)`;
    }
    case "http": {
      if (!fix.url) throw new Error("fix.url is required for http fix");
      const res = await fetch(fix.url, { method: "POST" });
      if (!res.ok) throw new Error(`http fix returned ${res.status}`);
      return `http ${res.status}`;
    }
    default:
      throw new Error(`fix type "${fix.type}" is not executable`);
  }
}

function execCapture(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolvePromise(stdout.toString().trim().slice(0, 500));
    });
  });
}
