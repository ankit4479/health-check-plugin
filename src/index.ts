/**
 * Public API surface — import these to embed the engine in your own code, a custom
 * scheduler, or a Trigger.dev / cron task. The CLI (src/cli.ts) is a thin wrapper
 * over exactly these functions.
 */

export { loadConfig, validateConfig, findConfigPath, ConfigError } from "./config.js";
export type {
  HealthCheckConfig,
  CollectorConfig,
  DataSourceConfig,
  ChannelConfig,
  GitHubConfig,
  HealingConfig,
  FixAction,
} from "./config.js";

export { runCycle } from "./orchestrator.js";
export type { RunOptions, RunResult } from "./orchestrator.js";

export { runCollectors } from "./collectors/index.js";
export { buildReport } from "./report.js";
export { computeScore, classifyBand } from "./scoring.js";
export { buildFingerprint, parseFingerprint } from "./fingerprint.js";
export { StateStore } from "./state.js";
export { updateFingerprintHistory, compoundFix, recurrenceOf } from "./memory.js";
export { syncIssuesToGitHub } from "./github.js";
export { generateHealingPlan } from "./healing/plan.js";
export { executeHealing } from "./healing/execute.js";
export { deliver } from "./delivery/index.js";

export type * from "./types.js";
