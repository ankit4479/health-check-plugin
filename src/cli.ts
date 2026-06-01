#!/usr/bin/env node
/**
 * health-check CLI — the standalone, agent-agnostic entry point. Every command an
 * agent skill calls is also runnable by a human or a cron job:
 *
 *   health-check run        collect → score → deliver → (optionally) file issues
 *   health-check report     re-render the latest saved report
 *   health-check issues     file the latest report's issues to GitHub (after discussion)
 *   health-check plan       generate a healing plan from the latest report
 *   health-check heal       execute approved fixes from a plan (safety-gated)
 *   health-check verify     show what resolved vs. persists since the prior run
 *   health-check init       scaffold a starter health-check.config.json
 */

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ConfigError } from "./config.js";
import { runCycle } from "./orchestrator.js";
import { StateStore } from "./state.js";
import { renderConsole } from "./delivery/console.js";
import { syncIssuesToGitHub } from "./github.js";
import { generateHealingPlan } from "./healing/plan.js";
import { executeHealing } from "./healing/execute.js";
import { matchOpenIssues, healOpenIssues } from "./healing/issue-heal.js";
import { generateSchedule, type ScheduleSpec } from "./schedule.js";
import type { CollectorContext } from "./collectors/index.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(name: string): boolean {
  return args.includes(`--${name}`);
}

async function main(): Promise<void> {
  switch (command) {
    case "run":
      return cmdRun();
    case "report":
      return cmdReport();
    case "issues":
      return cmdIssues();
    case "plan":
      return cmdPlan();
    case "heal":
      return cmdHeal();
    case "heal-issue":
      return cmdHealIssue();
    case "verify":
      return cmdVerify();
    case "schedule":
      return cmdSchedule();
    case "bot":
      return cmdBot();
    case "init":
      return cmdInit();
    case "help":
    default:
      printHelp();
  }
}

async function cmdRun(): Promise<void> {
  const config = loadConfig(flag("config"));
  const result = await runCycle(config, {
    periodHours: flag("period") ? Number(flag("period")) : undefined,
    fileIssues: has("file-issues"),
    withPlan: has("plan"),
  });
  const { report, verification } = result;
  console.error(
    `\nResolved since last run: ${verification.resolved.length} · ` +
      `persisting: ${verification.persisting.length} · new: ${verification.newIssues}`
  );
  if (result.github) {
    console.error(
      `GitHub: created ${result.github.created.length}, updated ${result.github.updated.length}, ` +
        `reopened ${result.github.reopened.length}, skipped ${result.github.skipped}`
    );
  }
  // Non-zero exit when critical issues exist (useful for CI gating).
  if (report.summary.bySeverity.critical > 0) process.exitCode = 2;
}

async function cmdReport(): Promise<void> {
  const config = loadConfig(flag("config"));
  const store = new StateStore(config.stateDir);
  const report = store.latestReport();
  if (!report) {
    console.error("No saved report. Run `health-check run` first.");
    process.exitCode = 1;
    return;
  }
  console.log(renderConsole(report, config));
}

async function cmdIssues(): Promise<void> {
  const config = loadConfig(flag("config"));
  if (!config.github.enabled) {
    console.error("github.enabled is false in config — nothing to file.");
    process.exitCode = 1;
    return;
  }
  const store = new StateStore(config.stateDir);
  const report = store.latestReport();
  if (!report) {
    console.error("No saved report. Run `health-check run` first.");
    process.exitCode = 1;
    return;
  }
  const result = await syncIssuesToGitHub(report.issues, config.github);
  console.log(
    `GitHub: created ${result.created.length}, updated ${result.updated.length}, ` +
      `reopened ${result.reopened.length}, skipped ${result.skipped}`
  );
  for (const c of result.created) console.log(`  + #${c.number} ${c.title} ${c.url}`);
}

async function cmdPlan(): Promise<void> {
  const config = loadConfig(flag("config"));
  const store = new StateStore(config.stateDir);
  const report = store.latestReport();
  if (!report) {
    console.error("No saved report. Run `health-check run` first.");
    process.exitCode = 1;
    return;
  }
  const plan = generateHealingPlan(report, config, store);
  console.log(JSON.stringify(plan, null, 2));
}

async function cmdHeal(): Promise<void> {
  const config = loadConfig(flag("config"));
  const store = new StateStore(config.stateDir);
  const report = store.latestReport();
  if (!report) {
    console.error("No saved report. Run `health-check run` first.");
    process.exitCode = 1;
    return;
  }
  const plan = generateHealingPlan(report, config, store);
  const approve = flag("approve"); // comma-separated indices, or "all"
  const approvedIndices =
    approve === "all"
      ? plan.items.map((i) => i.index)
      : (approve ?? "").split(",").filter((s) => s !== "").map(Number);

  const ctx: CollectorContext = { config, periodHours: config.periodHours, pools: new Map() };
  try {
    const result = await executeHealing(plan, config, { approvedIndices, ctx, store });
    console.log(`Executed ${result.executed.length}, skipped ${result.skipped.length}`);
    for (const e of result.executed) console.log(`  [${e.outcome}] #${e.index} ${e.fixType}: ${e.detail}`);
    for (const s of result.skipped) console.log(`  [skip] #${s.index}: ${s.reason}`);
  } finally {
    const { closePools } = await import("./collectors/postgres.js");
    await closePools(ctx);
  }
}

async function cmdHealIssue(): Promise<void> {
  const config = loadConfig(flag("config"));
  if (!config.github.enabled) {
    console.error("github.enabled is false — the issue-driven healer needs GitHub.");
    process.exitCode = 1;
    return;
  }
  const store = new StateStore(config.stateDir);

  // --list: show open health issues and how each would be remediated.
  if (has("list")) {
    const matched = await matchOpenIssues(config);
    if (matched.length === 0) {
      console.log("No open health-check issues found.");
      return;
    }
    for (const m of matched) {
      const how =
        m.path === "ops" ? `ops fix (${m.fix?.type})` : m.path === "code" ? "code fix → PR (agent)" : "manual";
      console.log(`  #${m.issue.number}  [${how}]  ${m.issue.title}`);
    }
    console.log(`\nApprove ops fixes with:  health-check heal-issue --approve <numbers>|all`);
    console.log(`Code fixes: the healing-agent edits files, then ships a PR (see docs).`);
    return;
  }

  const approve = flag("approve");
  const onlyArg = flag("issue");
  const matched = await matchOpenIssues(config);
  const approvedNumbers =
    approve === "all"
      ? matched.filter((m) => m.path === "ops").map((m) => m.issue.number)
      : (approve ?? "").split(",").filter((s) => s !== "").map(Number);
  const onlyNumbers = onlyArg ? onlyArg.split(",").map(Number) : undefined;

  const results = await healOpenIssues(config, { approvedNumbers, onlyNumbers, store });
  for (const r of results) {
    const icon = r.outcome === "success" ? "✅" : r.outcome === "failure" ? "❌" : r.outcome === "needs_agent" ? "🤖" : "•";
    console.log(`  ${icon} #${r.number} [${r.path}/${r.outcome}] ${r.title} — ${r.detail}`);
  }
  const needAgent = results.filter((r) => r.outcome === "needs_agent");
  if (needAgent.length) {
    console.log(
      `\n${needAgent.length} issue(s) need a code fix. The healing-agent should edit the files, ` +
        `then call shipCodeFix() (or use /health-heal-issue) to open a PR linked "Fixes #N".`
    );
  }
}

async function cmdVerify(): Promise<void> {
  const config = loadConfig(flag("config"));
  const store = new StateStore(config.stateDir);
  const history = store.loadFingerprints();
  const active = Object.values(history).filter((h) => h.consecutiveRuns > 0);
  const recurring = active.filter((h) => h.consecutiveRuns >= 2);
  console.log(`Active issues: ${active.length} · recurring (>=2 runs): ${recurring.length}`);
  for (const h of recurring.sort((a, b) => b.consecutiveRuns - a.consecutiveRuns)) {
    console.log(`  ${h.consecutiveRuns}x  [${h.source}] ${h.title}`);
  }
}

async function cmdBot(): Promise<void> {
  const config = loadConfig(flag("config"));
  const { startBot } = await import("./bot/index.js");
  const runtime = await startBot(config);
  console.log("[bot] running. Press Ctrl-C to stop.");

  // Optionally post an immediate report on startup.
  if (has("run-now")) {
    const { report } = await runCycle(config, { quiet: true });
    for (const h of runtime.handles) await h.postReport(report);
  }

  // Keep the process alive until interrupted.
  const shutdown = async () => {
    console.log("\n[bot] shutting down…");
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {}); // run forever
}

function cmdSchedule(): void {
  const at = flag("at");
  const cron = flag("cron");
  if (!at && !cron) {
    console.error('Provide a time: `schedule --at "09:00" [--tz "Asia/Kolkata"]` or `--cron "0 9 * * *"`.');
    process.exitCode = 1;
    return;
  }
  const spec: ScheduleSpec = {
    at: at ?? "09:00",
    tz: flag("tz"),
    cron,
    command: flag("cmd"),
  };
  const mode = (flag("mode") as "cron" | "github-actions" | "both") ?? "both";
  const result = generateSchedule(spec, mode);

  if (result.cronLine) {
    console.log("\nAdd this line to your crontab (`crontab -e`):\n");
    console.log("  " + result.cronLine + "\n");
  }
  if (result.workflowPath) {
    console.log(`Wrote GitHub Actions workflow: ${result.workflowPath}`);
    console.log("Commit it, and add the referenced secrets in repo Settings → Secrets.\n");
  }
  console.log("Once scheduled, the health check runs autonomously — no manual kicks needed.");
}

function cmdInit(): void {
  const target = resolve(process.cwd(), "health-check.config.json");
  if (existsSync(target)) {
    console.error("health-check.config.json already exists — not overwriting.");
    process.exitCode = 1;
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  // Example ships at ../config relative to dist/, and ../../config from src/ during dev.
  const candidates = [
    resolve(here, "../config/health-check.config.example.json"),
    resolve(here, "../../config/health-check.config.example.json"),
  ];
  const example = candidates.find((p) => existsSync(p));
  if (!example) {
    console.error("Could not locate the example config to copy.");
    process.exitCode = 1;
    return;
  }
  writeFileSync(target, readFileSync(example, "utf8"));
  console.log(`Created health-check.config.json — edit it, then run \`health-check run\`.`);
}

function printHelp(): void {
  console.log(`health-check — universal health-check + healer board

Usage: health-check <command> [options]

Commands:
  run        Collect, score, persist, and deliver a health report
             --file-issues   also open GitHub issues for actionable findings
             --plan          also print a healing plan
             --period <h>    override lookback window (hours)
  report     Re-render the latest saved report
  issues     File the latest report's issues to GitHub (dedup by fingerprint)
  plan       Print a healing plan (advisory, JSON) from the latest report
  heal       Execute approved fixes from the latest report's plan (safety-gated)
             --approve all | --approve 0,2,3
  heal-issue Drive remediation FROM open GitHub issues (the healer loop)
             --list                 show open issues + how each would be fixed
             --approve all|<#,#>     approve ops fixes (sql/shell/http/retrigger)
             --issue <#,#>           restrict to specific issue numbers
             Ops fixes run, verify, close the issue, and announce to all channels.
             Code fixes are flagged for the agent to write + ship as a PR.
  verify     Show recurring vs. resolved issues across runs
  schedule   Set up autonomous runs (cron line + GitHub Actions workflow)
             --at "09:00" [--tz "Asia/Kolkata"] | --cron "0 9 * * *"
             --mode cron|github-actions|both    --cmd "<command>"
  bot        Start the 24/7 interactive bot (Discord/Slack buttons) — needs hosting
  init       Scaffold a starter health-check.config.json

Global:
  --config <path>   path to config (default: ./health-check.config.json)

Config & env are documented in README.md and docs/configuration.md.`);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`Config error: ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
});
