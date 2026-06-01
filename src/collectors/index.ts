/**
 * Collector runner — executes every enabled collector from config, applies the
 * declarative `issueWhen` predicate, interpolates the title/message templates, and
 * emits fingerprinted HealthIssues. This is the generic bridge between "raw signal"
 * and "scored issue" — no system-specific logic lives here.
 */

import type { CollectorConfig, HealthCheckConfig, IssueWhen } from "../config.js";
import type { HealthIssue, CollectorStatus } from "../types.js";
import { buildFingerprint } from "../fingerprint.js";
import { PostgresPool } from "./postgres.js";
import { runPostgresCollector } from "./postgres.js";
import { runHttpCollector } from "./http.js";
import { runShellCollector } from "./shell.js";

/** What a collector hands back before issue-shaping. */
export interface RawResult {
  /** Row objects (postgres) — length and field values feed issueWhen + fingerprint. */
  rows?: Array<Record<string, unknown>>;
  /** A single scalar (shell numeric, http latency) for numeric predicates. */
  numeric?: number;
  /** Free-form evidence attached to the issue's details. */
  details?: Record<string, unknown>;
  /** Collector decided on its own this is/ isn't an issue (overrides issueWhen). */
  fired?: boolean;
}

export interface CollectorContext {
  config: HealthCheckConfig;
  periodHours: number;
  pools: Map<string, PostgresPool>;
}

export interface CollectorRunOutput {
  issues: HealthIssue[];
  status: Record<string, CollectorStatus>;
}

/** Evaluate the issueWhen predicate against a raw result. */
export function evaluateIssueWhen(when: IssueWhen | undefined, raw: RawResult): boolean {
  if (raw.fired !== undefined) return raw.fired;
  if (!when) return (raw.rows?.length ?? 0) > 0;
  if (when.always) return (raw.rows?.length ?? 0) > 0 || raw.numeric !== undefined;
  if (when.rowsAtLeast !== undefined) return (raw.rows?.length ?? 0) >= when.rowsAtLeast;
  if (when.numericAtLeast !== undefined) return (raw.numeric ?? -Infinity) >= when.numericAtLeast;
  if (when.numericAtMost !== undefined) return (raw.numeric ?? Infinity) <= when.numericAtMost;
  return false;
}

/** Interpolate {{count}}, {{value}}, and {{field}} tokens in a template string. */
export function interpolate(template: string, raw: RawResult): string {
  const count = raw.rows?.length ?? 0;
  const value = raw.numeric ?? "";
  return template
    .replace(/\{\{count\}\}/g, String(count))
    .replace(/\{\{value\}\}/g, String(value))
    .replace(/\{\{field:(\w+)\}\}/g, (_, f) => String(raw.rows?.[0]?.[f] ?? ""));
}

function shapeIssue(col: CollectorConfig, raw: RawResult): HealthIssue {
  const fpFields = col.fingerprintFields ?? [];
  const keyParts =
    fpFields.length > 0 && raw.rows?.length
      ? fpFields.map((f) => raw.rows!.map((r) => r[f]).join(","))
      : [col.id];

  return {
    id: `${col.id}:${Date.now()}`,
    source: col.id,
    severity: col.severity,
    title: interpolate(col.title, raw),
    description: col.message ? interpolate(col.message, raw) : interpolate(col.title, raw),
    fingerprint: buildFingerprint(col.id, keyParts),
    details: {
      count: raw.rows?.length ?? undefined,
      value: raw.numeric ?? undefined,
      sample: raw.rows?.slice(0, 5),
      ...raw.details,
    },
    suggestedFix: col.suggestedFix,
    codeReference: col.codeReference,
  };
}

async function dispatch(col: CollectorConfig, ctx: CollectorContext): Promise<RawResult> {
  switch (col.type) {
    case "postgres":
      return runPostgresCollector(col, ctx);
    case "http":
      return runHttpCollector(col, ctx);
    case "shell":
      return runShellCollector(col, ctx);
    default:
      throw new Error(`Unknown collector type: ${(col as { type: string }).type}`);
  }
}

/** Run all enabled collectors, returning issues and per-collector status. */
export async function runCollectors(ctx: CollectorContext): Promise<CollectorRunOutput> {
  const issues: HealthIssue[] = [];
  const status: Record<string, CollectorStatus> = {};

  for (const col of ctx.config.collectors) {
    if (col.enabled === false) continue;
    const started = Date.now();
    try {
      const raw = await dispatch(col, ctx);
      const fired = evaluateIssueWhen(
        (col as { issueWhen?: IssueWhen }).issueWhen,
        raw
      );
      if (fired) issues.push(shapeIssue(col, raw));
      status[col.id] = { success: true, durationMs: Date.now() - started };
    } catch (err) {
      status[col.id] = {
        success: false,
        durationMs: Date.now() - started,
        error: (err as Error).message,
      };
      // A failed collector is itself a (low) health signal so silent breakage shows up.
      issues.push({
        id: `${col.id}:error:${Date.now()}`,
        source: col.id,
        severity: "low",
        title: `Collector "${col.id}" failed to run`,
        description: `The "${col.id}" collector threw: ${(err as Error).message}`,
        fingerprint: buildFingerprint(`${col.id}:collector_error`, [col.id]),
        details: { error: (err as Error).message },
      });
    }
  }

  return { issues, status };
}
