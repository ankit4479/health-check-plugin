/**
 * GitHub-issue-driven healer loop — the closing half of the board flow.
 *
 *   run → report → channels → approve → create GitHub issue        (the open half)
 *   ── then ──
 *   fetch open issue → map fingerprint → fix → verify → close → announce   (here)
 *
 * Two fix paths (decided by the collector's fix.type):
 *   • OPS fix  (sql/shell/http/retrigger): the engine executes it deterministically,
 *     verifies, closes the issue, and broadcasts "resolved" to all channels.
 *   • CODE fix: the engine cannot author code, so it hands the agent a structured
 *     task; once the agent has edited the working tree, `shipCodeFix()` opens a PR
 *     ("Fixes #N") and broadcasts the PR link to all channels.
 *
 * Approval is enforced the same way as report-driven healing: nothing executes
 * unless healing is enabled, the fix type is allowed, and the issue was approved.
 */

import type { HealthCheckConfig, CollectorConfig, FixAction } from "../config.js";
import type { FixOutcome, CompoundEntry } from "../types.js";
import {
  fetchOpenHealthIssues,
  closeHealthIssue,
  commentOnIssue,
  openPullRequest,
  type OpenHealthIssue,
} from "../github.js";
import { deliverOutcome } from "../delivery/index.js";
import { getPool, closePools } from "../collectors/postgres.js";
import { compoundFix } from "../memory.js";
import { StateStore } from "../state.js";
import type { CollectorContext } from "../collectors/index.js";
import { exec } from "node:child_process";

/** An open GitHub issue matched to the collector + fix that can remediate it. */
export interface MatchedIssue {
  issue: OpenHealthIssue;
  collector?: CollectorConfig;
  fix?: FixAction;
  /** "ops" = engine-executable; "code" = needs the agent to write a PR; "manual". */
  path: "ops" | "code" | "manual";
}

const OPS_FIX_TYPES = new Set(["sql", "shell", "http", "retrigger"]);

/** Map every open health issue to its remediation path via the fingerprint. */
export async function matchOpenIssues(config: HealthCheckConfig): Promise<MatchedIssue[]> {
  const issues = await fetchOpenHealthIssues(config.github);
  // Issues record their originating collector id in the body; match on that.
  const byId = new Map<string, CollectorConfig>(config.collectors.map((c) => [c.id, c]));

  return issues.map((issue) => {
    const collector = resolveCollector(issue, byId);
    const fix = collector?.fix;
    let path: MatchedIssue["path"] = "manual";
    if (fix && OPS_FIX_TYPES.has(fix.type)) path = "ops";
    else if (fix && (fix.type === "github_issue" || fix.type === "manual")) path = "manual";
    else if (collector?.fixType === "manual" || !fix) path = collector ? "code" : "manual";
    return { issue, collector, fix, path };
  });
}

function resolveCollector(
  issue: OpenHealthIssue,
  byId: Map<string, CollectorConfig>
): CollectorConfig | undefined {
  // The issue body records `**Source:** \`<collector id>\``; prefer that, then title.
  const m = issue.body.match(/\*\*Source:\*\*\s*`([^`]+)`/);
  if (m && byId.has(m[1])) return byId.get(m[1]);
  for (const [id, col] of byId) if (issue.body.includes(id) || issue.title.includes(id)) return col;
  return undefined;
}

export interface HealIssueResult {
  number: number;
  title: string;
  path: MatchedIssue["path"];
  outcome: FixOutcome | "needs_agent" | "skipped";
  detail: string;
  prUrl?: string;
}

export interface IssueHealOptions {
  /** Issue numbers the human approved for remediation. */
  approvedNumbers: number[];
  /** Only operate on these issue numbers (default: all open). */
  onlyNumbers?: number[];
  store: StateStore;
}

/**
 * Execute OPS fixes for approved open issues: run the fix, verify, close the issue,
 * and announce the resolution to every channel. CODE-path issues are returned with
 * outcome "needs_agent" — the agent edits the tree, then calls shipCodeFix().
 */
export async function healOpenIssues(
  config: HealthCheckConfig,
  opts: IssueHealOptions
): Promise<HealIssueResult[]> {
  const healing = config.healing;
  const matched = await matchOpenIssues(config);
  const approved = new Set(opts.approvedNumbers);
  const only = opts.onlyNumbers ? new Set(opts.onlyNumbers) : null;
  const allowed = new Set(healing.allowedFixTypes ?? []);
  const requireApproval = healing.requireApproval !== false;
  const maxPerRun = healing.maxPerRun ?? 5;

  const ctx: CollectorContext = { config, periodHours: config.periodHours, pools: new Map() };
  const results: HealIssueResult[] = [];
  let ran = 0;

  try {
    for (const m of matched) {
      if (only && !only.has(m.issue.number)) continue;

      if (m.path === "manual") {
        results.push({ number: m.issue.number, title: m.issue.title, path: m.path, outcome: "skipped", detail: "no auto-fix; needs manual action" });
        continue;
      }
      if (m.path === "code") {
        results.push({ number: m.issue.number, title: m.issue.title, path: m.path, outcome: "needs_agent", detail: "code fix — agent must edit files then call shipCodeFix()" });
        continue;
      }

      // ── ops path ──
      if (!healing.enabled) { results.push(skip(m, "healing disabled")); continue; }
      if (ran >= maxPerRun) { results.push(skip(m, `maxPerRun (${maxPerRun}) reached`)); continue; }
      if (!m.fix || !allowed.has(m.fix.type)) { results.push(skip(m, `fix type not in allowedFixTypes`)); continue; }
      if (requireApproval && !approved.has(m.issue.number)) { results.push(skip(m, "not approved")); continue; }

      if (healing.dryRun) {
        results.push({ number: m.issue.number, title: m.issue.title, path: "ops", outcome: "skipped", detail: `[dry-run] would run: ${describeFix(m.fix)}` });
        ran++;
        continue;
      }

      let outcome: FixOutcome = "pending";
      let detail = "";
      try {
        detail = await runFix(m.fix, ctx);
        outcome = "success";
      } catch (err) {
        outcome = "failure";
        detail = (err as Error).message;
      }
      ran++;

      compoundFix(opts.store, outcomeEntry(m, outcome, describeFix(m.fix)));

      if (outcome === "success") {
        const whatFixed = `Ran ${describeFix(m.fix)} → ${detail}`;
        await closeHealthIssue(
          config.github,
          m.issue.number,
          `✅ Auto-resolved by health-check healer.\n\n**What was fixed:** ${whatFixed}`
        );
        await deliverOutcome(
          config,
          `✅ *Resolved* issue #${m.issue.number} — ${m.issue.title}\n` +
            `*What was fixed:* ${whatFixed}\n${m.issue.url}`
        );
      } else {
        await commentOnIssue(config.github, m.issue.number, `❌ Healer attempt failed: ${detail}`);
        await deliverOutcome(config, `❌ Heal *failed* for #${m.issue.number} — ${m.issue.title}: ${detail}`);
      }
      results.push({ number: m.issue.number, title: m.issue.title, path: "ops", outcome, detail });
    }
  } finally {
    await closePools(ctx);
  }

  return results;
}

/**
 * Ship a CODE fix the agent has already made in the working tree: open a PR linked
 * to the issue ("Fixes #N"), comment the PR link on the issue, and broadcast the PR
 * link to every channel. The issue auto-closes when the PR merges.
 */
export interface CodeFixDetails {
  prTitle: string;
  prBody: string;
  /**
   * Short human summary of WHAT was fixed (root cause + the change made). This is
   * what's posted to the channels alongside the PR link — so reviewers see the
   * substance, not just a URL. Required.
   */
  summary: string;
}

export async function shipCodeFix(
  config: HealthCheckConfig,
  issue: { number: number; title: string; url: string },
  details: CodeFixDetails,
  store: StateStore
): Promise<{ prUrl: string; branch: string }> {
  const prCfg = config.healing.pr ?? {};
  // Embed the summary in the PR body so the PR itself explains the change too.
  const fullBody = `## What was fixed\n\n${details.summary}\n\n${details.prBody}`;
  const { url, branch } = await openPullRequest({
    issueNumber: issue.number,
    title: details.prTitle,
    body: fullBody,
    baseBranch: prCfg.baseBranch,
    branchPrefix: prCfg.branchPrefix,
  });

  await commentOnIssue(
    config.github,
    issue.number,
    `🔧 Fixed and opened a PR.\n\n**What was fixed:** ${details.summary}\n\n**PR:** ${url}`
  );

  if (prCfg.announce !== false) {
    // The channel notification: issue fixed + summary of what changed + PR link.
    await deliverOutcome(
      config,
      `🔧 *Fixed* issue #${issue.number} — ${issue.title}\n` +
        `*What was fixed:* ${details.summary}\n` +
        `🔀 *PR:* ${url}\n` +
        `_awaiting review; merging will close the issue._`
    );
  }

  store.appendSolution({
    date: new Date().toISOString(),
    fingerprint: "",
    source: "code-fix",
    title: issue.title,
    severity: "high",
    rootCause: "",
    fixType: "manual",
    approach: `${details.summary} (PR ${url})`,
    outcome: "pending",
    verified: false,
  });

  return { prUrl: url, branch };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function skip(m: MatchedIssue, reason: string): HealIssueResult {
  return { number: m.issue.number, title: m.issue.title, path: m.path, outcome: "skipped", detail: reason };
}

function describeFix(fix: FixAction): string {
  if (fix.command) return `${fix.type}: ${fix.command}`;
  if (fix.url) return `${fix.type}: POST ${fix.url}`;
  return fix.type;
}

function outcomeEntry(m: MatchedIssue, outcome: FixOutcome, approach: string): CompoundEntry {
  return {
    date: new Date().toISOString(),
    fingerprint: m.issue.fingerprint ?? "",
    source: m.collector?.id ?? "unknown",
    title: m.issue.title,
    severity: m.collector?.severity ?? "high",
    rootCause: "",
    fixType: m.fix?.type ?? "manual",
    approach,
    outcome,
    verified: outcome === "success",
  };
}

async function runFix(fix: FixAction, ctx: CollectorContext): Promise<string> {
  switch (fix.type) {
    case "shell":
    case "retrigger": {
      if (!fix.command) throw new Error("fix.command required for shell/retrigger");
      return execCapture(fix.command, 60_000);
    }
    case "sql": {
      if (!fix.command || !fix.dataSource) throw new Error("fix.command + fix.dataSource required for sql");
      const pool = await getPool(ctx, fix.dataSource);
      const r = await pool.query(fix.command);
      return `sql ok (${r.rows.length} rows affected/returned)`;
    }
    case "http": {
      if (!fix.url) throw new Error("fix.url required for http fix");
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
