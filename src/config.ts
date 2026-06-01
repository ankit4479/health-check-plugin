/**
 * Configuration system — the source of all domain specificity.
 *
 * Everything that makes a health check "about your system" lives in a JSON config
 * file: which data sources to connect to, which collectors to run, how raw results
 * become issues, where to deliver the report, and whether/how to heal. The engine
 * code itself contains zero knowledge of any particular system.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { IssueSeverity, SeverityWeights, FixType } from "./types.js";

// ── Data sources ─────────────────────────────────────────────────────────────

export interface PostgresDataSource {
  type: "postgres";
  /** Name of the env var holding the connection string. */
  urlEnv: string;
  /** Pass `{ rejectUnauthorized: false }` (managed PGs with self-signed certs). */
  ssl?: boolean;
}

export type DataSourceConfig = PostgresDataSource;

// ── Collectors ───────────────────────────────────────────────────────────────

/**
 * Predicate deciding whether a collector result becomes an issue.
 * - rowsAtLeast: SQL/array result length >= N
 * - numericAtLeast / numericAtMost: a single scalar crosses a threshold
 * - statusNot: HTTP status differs from expected
 * - always: any non-empty result is an issue (collector did its own filtering)
 */
export interface IssueWhen {
  rowsAtLeast?: number;
  numericAtLeast?: number;
  numericAtMost?: number;
  always?: boolean;
}

/**
 * Declarative fix action — lets the healer actually remediate this collector's
 * issue (not just file a ticket). Without it, the issue is "manual" only.
 * Execution is always gated by `healing.enabled`, `healing.allowedFixTypes`,
 * approval, and the listed `safetyGates`.
 */
export interface FixAction {
  type: FixType;
  /** shell: command to run · sql: statement (on `dataSource`) · http: URL to POST · retrigger: command. */
  command?: string;
  url?: string;
  /** Postgres data source for `sql` fixes. */
  dataSource?: string;
  /** Human-readable preconditions a reviewer/agent must confirm before running. */
  safetyGates?: string[];
  estimatedRisk?: "low" | "medium" | "high";
}

interface BaseCollector {
  id: string;
  description?: string;
  /** Severity assigned when this collector fires. */
  severity: IssueSeverity;
  /** Template; `{{count}}`, `{{value}}`, and `{{field}}` are interpolated. */
  title: string;
  /** Optional richer description template. */
  message?: string;
  /** Fields (from result rows) combined into the dedup fingerprint. */
  fingerprintFields?: string[];
  suggestedFix?: string;
  codeReference?: string;
  /** Default fix classification for the healer. */
  fixType?: FixType;
  /** Declarative remediation the healer can execute (safety-gated). */
  fix?: FixAction;
  /** Skip this collector without deleting it. */
  enabled?: boolean;
}

export interface PostgresCollector extends BaseCollector {
  type: "postgres";
  dataSource: string;
  /** Parameterized read-only SQL. `$1` is bound to `periodHours` when present. */
  query: string;
  issueWhen: IssueWhen;
}

export interface HttpCollector extends BaseCollector {
  type: "http";
  url: string;
  method?: "GET" | "POST" | "HEAD";
  headers?: Record<string, string>;
  /** Env-var indirection for secret headers, e.g. { "Authorization": "API_TOKEN" }. */
  headersFromEnv?: Record<string, string>;
  expectStatus?: number;
  timeoutMs?: number;
}

export interface ShellCollector extends BaseCollector {
  type: "shell";
  /** Command whose stdout is captured and evaluated against issueWhen. */
  command: string;
  timeoutMs?: number;
  issueWhen: IssueWhen;
}

export type CollectorConfig = PostgresCollector | HttpCollector | ShellCollector;

// ── Delivery channels ────────────────────────────────────────────────────────
// Multiple channels can run at once (e.g. Discord AND Slack). Every report and
// every healing outcome (including PR links) is broadcast to all of them.

export interface DiscordChannel {
  type: "discord";
  /** Env var holding a Discord incoming-webhook URL. */
  webhookEnv: string;
}

export interface SlackChannel {
  type: "slack";
  /** Env var holding a Slack incoming-webhook URL. */
  webhookEnv: string;
}

export interface ConsoleChannel {
  type: "console";
}

export type ChannelConfig = DiscordChannel | SlackChannel | ConsoleChannel;

// ── GitHub ───────────────────────────────────────────────────────────────────

export interface GitHubConfig {
  enabled: boolean;
  /** Env var holding "owner/repo". */
  repoEnv: string;
  /** Env var holding a PAT with `repo` scope. Falls back to `gh` CLI if absent. */
  tokenEnv?: string;
  /** Only open issues at or above this severity. */
  minSeverity?: IssueSeverity;
  labels?: string[];
}

// ── Healing ──────────────────────────────────────────────────────────────────

export interface HealingConfig {
  enabled: boolean;
  /** If true (default), never execute a fix without explicit approval. */
  requireApproval?: boolean;
  maxPerRun?: number;
  /** Fix types the healer is permitted to execute automatically. */
  allowedFixTypes?: FixType[];
  /** Log what would run without executing. */
  dryRun?: boolean;
  /**
   * Pull-request behavior for code fixes. The agent writes the code change; the
   * engine commits it to a branch and opens a PR linked to the GitHub issue.
   */
  pr?: {
    /** Branch the PR targets (default "main"). */
    baseBranch?: string;
    /** Prefix for auto-created fix branches (default "health-fix/"). */
    branchPrefix?: string;
    /** If true, after a code fix, post the PR link to all channels (default true). */
    announce?: boolean;
  };
}

// ── Top-level config ─────────────────────────────────────────────────────────

export interface HealthCheckConfig {
  project: string;
  scope?: string;
  periodHours: number;
  severityWeights: SeverityWeights;
  /** Score thresholds for healthy/warning/degraded bands (below = critical). */
  scoreBands: { healthy: number; warning: number; degraded: number };
  dataSources: Record<string, DataSourceConfig>;
  collectors: CollectorConfig[];
  /** One or more delivery channels — reports + healing outcomes go to all of them. */
  channels: ChannelConfig[];
  github: GitHubConfig;
  healing: HealingConfig;
  /** Where run state (reports, fingerprint history, solutions log) is stored. */
  stateDir?: string;
}

export const DEFAULT_SEVERITY_WEIGHTS: SeverityWeights = {
  critical: 25,
  high: 10,
  medium: 3,
  low: 0.25,
};

export const DEFAULT_SCORE_BANDS = { healthy: 90, warning: 70, degraded: 50 };

const CONFIG_FILENAMES = [
  "health-check.config.json",
  ".health-check.config.json",
];

/** Resolve the config path: explicit arg, env, or conventional filenames in cwd. */
export function findConfigPath(explicit?: string): string | null {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit);
    return existsSync(p) ? p : null;
  }
  if (process.env.HEALTH_CHECK_CONFIG) {
    const p = resolve(process.cwd(), process.env.HEALTH_CHECK_CONFIG);
    if (existsSync(p)) return p;
  }
  for (const name of CONFIG_FILENAMES) {
    const p = resolve(process.cwd(), name);
    if (existsSync(p)) return p;
  }
  return null;
}

export class ConfigError extends Error {}

/** Load, parse, default, and validate a config file. Throws ConfigError on problems. */
export function loadConfig(explicitPath?: string): HealthCheckConfig {
  const path = findConfigPath(explicitPath);
  if (!path) {
    throw new ConfigError(
      "No config found. Create `health-check.config.json` (see config/health-check.config.example.json) " +
        "or set HEALTH_CHECK_CONFIG."
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  return validateConfig(raw, path);
}

export function validateConfig(raw: unknown, path = "<inline>"): HealthCheckConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError(`Config at ${path} must be a JSON object.`);
  }
  const c = raw as Record<string, unknown>;

  if (!c.project || typeof c.project !== "string") {
    throw new ConfigError(`Config: "project" (string) is required.`);
  }
  if (!Array.isArray(c.collectors) || c.collectors.length === 0) {
    throw new ConfigError(`Config: "collectors" must be a non-empty array.`);
  }

  // Normalize channels: prefer `channels` array; accept legacy singular `channel`;
  // default to console. Multiple channels (e.g. Discord + Slack) run together.
  let channels: ChannelConfig[];
  if (Array.isArray(c.channels) && c.channels.length > 0) {
    channels = c.channels as ChannelConfig[];
  } else if (c.channel) {
    channels = [c.channel as ChannelConfig];
  } else {
    channels = [{ type: "console" }];
  }

  const config: HealthCheckConfig = {
    project: c.project as string,
    scope: typeof c.scope === "string" ? c.scope : undefined,
    periodHours: typeof c.periodHours === "number" ? c.periodHours : 24,
    severityWeights: { ...DEFAULT_SEVERITY_WEIGHTS, ...(c.severityWeights as object) },
    scoreBands: { ...DEFAULT_SCORE_BANDS, ...(c.scoreBands as object) },
    dataSources: (c.dataSources as Record<string, DataSourceConfig>) ?? {},
    collectors: c.collectors as CollectorConfig[],
    channels,
    github: (c.github as GitHubConfig) ?? { enabled: false, repoEnv: "HEALTH_GITHUB_REPO" },
    healing: (c.healing as HealingConfig) ?? { enabled: false, requireApproval: true },
    stateDir: typeof c.stateDir === "string" ? c.stateDir : ".health-check",
  };

  // Referential integrity: every postgres collector points at a declared data source.
  const ids = new Set<string>();
  for (const col of config.collectors) {
    if (!col.id) throw new ConfigError(`Config: every collector needs an "id".`);
    if (ids.has(col.id)) throw new ConfigError(`Config: duplicate collector id "${col.id}".`);
    ids.add(col.id);
    if (col.type === "postgres" && !config.dataSources[col.dataSource]) {
      throw new ConfigError(
        `Collector "${col.id}" references unknown dataSource "${col.dataSource}".`
      );
    }
  }

  return config;
}

/** Read an env var or throw a clear, actionable error. */
export function requireEnv(name: string, usedBy: string): string {
  const v = process.env[name];
  if (!v) {
    throw new ConfigError(`Environment variable ${name} (required by ${usedBy}) is not set.`);
  }
  return v;
}
