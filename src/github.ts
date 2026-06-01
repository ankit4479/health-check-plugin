/**
 * GitHub integration — turns approved issues into tracked GitHub issues, with
 * fingerprint-based dedup so the same problem is never filed twice:
 *   - open issue with same fingerprint exists  → comment "still occurring", don't duplicate
 *   - closed issue with same fingerprint exists → it recurred; reopen + comment
 *   - no match                                  → create new issue
 * Resolved issues (present before, gone now) are auto-closed.
 *
 * Auth: a PAT from `tokenEnv` (REST API) if present, else the local `gh` CLI.
 */

import { execFileSync } from "node:child_process";
import type { HealthIssue, IssueSeverity } from "./types.js";
import type { GitHubConfig } from "./config.js";
import { requireEnv } from "./config.js";
import { fingerprintMarker, parseFingerprint } from "./fingerprint.js";

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export interface GitHubResult {
  created: Array<{ number: number; url: string; title: string }>;
  updated: Array<{ number: number; url: string; title: string }>;
  reopened: Array<{ number: number; url: string; title: string }>;
  skipped: number;
}

interface GhClient {
  search(fingerprint: string): Promise<{ number: number; state: string } | null>;
  create(title: string, body: string, labels: string[]): Promise<{ number: number; url: string }>;
  comment(number: number, body: string): Promise<void>;
  reopen(number: number): Promise<void>;
  close(number: number, comment: string): Promise<void>;
  listOpen(labels: string[]): Promise<Array<{ number: number; title: string; body: string; url: string }>>;
}

// ── REST client (PAT) ──────────────────────────────────────────────────────────

function restClient(repo: string, token: string): GhClient {
  const base = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  return {
    async search(fingerprint) {
      const q = encodeURIComponent(`repo:${repo} "fingerprint:${fingerprint}" in:body`);
      const res = await fetch(`https://api.github.com/search/issues?q=${q}`, { headers });
      if (!res.ok) throw new Error(`GitHub search failed: ${res.status}`);
      const data = (await res.json()) as { items: Array<{ number: number; state: string }> };
      return data.items[0] ?? null;
    },
    async create(title, body, labels) {
      const res = await fetch(`${base}/issues`, {
        method: "POST",
        headers,
        body: JSON.stringify({ title, body, labels }),
      });
      if (!res.ok) throw new Error(`GitHub create failed: ${res.status} ${await res.text()}`);
      const data = (await res.json()) as { number: number; html_url: string };
      return { number: data.number, url: data.html_url };
    },
    async comment(number, body) {
      await fetch(`${base}/issues/${number}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body }),
      });
    },
    async reopen(number) {
      await fetch(`${base}/issues/${number}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ state: "open" }),
      });
    },
    async close(number, comment) {
      await fetch(`${base}/issues/${number}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: comment }),
      });
      await fetch(`${base}/issues/${number}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ state: "closed" }),
      });
    },
    async listOpen(labels) {
      const labelQ = labels.length ? `&labels=${encodeURIComponent(labels.join(","))}` : "";
      const res = await fetch(`${base}/issues?state=open&per_page=100${labelQ}`, { headers });
      if (!res.ok) throw new Error(`GitHub list failed: ${res.status}`);
      const data = (await res.json()) as Array<{ number: number; title: string; body: string; html_url: string; pull_request?: unknown }>;
      return data
        .filter((i) => !i.pull_request) // issues only, not PRs
        .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", url: i.html_url }));
    },
  };
}

// ── gh CLI client (fallback) ────────────────────────────────────────────────────

function ghCliClient(repo: string): GhClient {
  const gh = (args: string[]): string =>
    execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  // The gh CLI rejects an issue if any --label doesn't already exist (unlike the
  // REST API, which auto-creates them). Create missing labels first; ignore the
  // "already exists" error so it's idempotent.
  const ensureLabels = (labels: string[]): void => {
    for (const l of labels) {
      try {
        gh(["label", "create", l, "--repo", repo, "--color", "ededed", "--description", "health-check"]);
      } catch {
        /* already exists — fine */
      }
    }
  };
  return {
    async search(fingerprint) {
      const out = gh([
        "issue", "list", "--repo", repo, "--state", "all", "--search",
        `fingerprint:${fingerprint} in:body`, "--json", "number,state", "--limit", "1",
      ]);
      const arr = JSON.parse(out) as Array<{ number: number; state: string }>;
      return arr[0] ?? null;
    },
    async create(title, body, labels) {
      ensureLabels(labels);
      const args = ["issue", "create", "--repo", repo, "--title", title, "--body", body];
      for (const l of labels) args.push("--label", l);
      const url = gh(args).trim();
      const number = Number(url.split("/").pop());
      return { number, url };
    },
    async comment(number, body) {
      gh(["issue", "comment", String(number), "--repo", repo, "--body", body]);
    },
    async reopen(number) {
      gh(["issue", "reopen", String(number), "--repo", repo]);
    },
    async close(number, comment) {
      gh(["issue", "close", String(number), "--repo", repo, "--comment", comment]);
    },
    async listOpen(labels) {
      const args = [
        "issue", "list", "--repo", repo, "--state", "open",
        "--json", "number,title,body,url", "--limit", "100",
      ];
      for (const l of labels) args.push("--label", l);
      const out = gh(args);
      return JSON.parse(out) as Array<{ number: number; title: string; body: string; url: string }>;
    },
  };
}

function resolveClient(config: GitHubConfig): { client: GhClient; repo: string } {
  const repo = requireEnv(config.repoEnv, "github integration");
  const token = config.tokenEnv ? process.env[config.tokenEnv] : undefined;
  return { client: token ? restClient(repo, token) : ghCliClient(repo), repo };
}

function issueBody(issue: HealthIssue): string {
  const lines = [
    `**Severity:** ${issue.severity}`,
    `**Source:** \`${issue.source}\``,
    "",
    issue.description,
  ];
  if (issue.rootCause) lines.push("", `**Root cause:** ${issue.rootCause}`);
  if (issue.suggestedFix) lines.push("", `**Suggested fix:** ${issue.suggestedFix}`);
  if (issue.codeReference) lines.push("", `**Reference:** ${issue.codeReference}`);
  lines.push("", "```json", JSON.stringify(issue.details, null, 2).slice(0, 2000), "```");
  lines.push("", fingerprintMarker(issue.fingerprint));
  lines.push("", "_Filed automatically by health-check-plugin._");
  return lines.join("\n");
}

/**
 * Sync a set of approved issues to GitHub. Honors `minSeverity`. Idempotent:
 * safe to call every run — dedups via fingerprint.
 */
export async function syncIssuesToGitHub(
  issues: HealthIssue[],
  config: GitHubConfig
): Promise<GitHubResult> {
  const result: GitHubResult = { created: [], updated: [], reopened: [], skipped: 0 };
  if (!config.enabled) return result;

  const min = SEVERITY_RANK[config.minSeverity ?? "high"];
  const { client } = resolveClient(config);
  const labels = config.labels ?? ["health-check", "automated"];

  for (const issue of issues) {
    if (SEVERITY_RANK[issue.severity] < min) {
      result.skipped++;
      continue;
    }
    const existing = await client.search(issue.fingerprint);
    if (existing && existing.state === "open") {
      await client.comment(existing.number, `Still occurring as of ${new Date().toISOString()}.`);
      result.updated.push({ number: existing.number, url: "", title: issue.title });
    } else if (existing && existing.state === "closed") {
      await client.reopen(existing.number);
      await client.comment(existing.number, `Recurred as of ${new Date().toISOString()}. Reopening.`);
      result.reopened.push({ number: existing.number, url: "", title: issue.title });
    } else {
      const created = await client.create(
        `[${issue.severity}] ${issue.title}`,
        issueBody(issue),
        [...labels, `severity:${issue.severity}`]
      );
      result.created.push({ ...created, title: issue.title });
    }
  }

  return result;
}

// ── Healer loop: drive remediation FROM open GitHub issues ───────────────────────

export interface OpenHealthIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  /** Parsed from the issue body's `fingerprint:<hash>` marker (null if absent). */
  fingerprint: string | null;
}

/**
 * Fetch the open issues that health-check filed (by label), each with its parsed
 * fingerprint so the healer can map it back to the collector + fix that produced it.
 */
export async function fetchOpenHealthIssues(config: GitHubConfig): Promise<OpenHealthIssue[]> {
  if (!config.enabled) return [];
  const { client } = resolveClient(config);
  const labels = config.labels ?? ["health-check", "automated"];
  const issues = await client.listOpen(labels);
  return issues.map((i) => ({ ...i, fingerprint: parseFingerprint(i.body) }));
}

/** Comment on and close a GitHub issue (used after a verified fix). */
export async function closeHealthIssue(
  config: GitHubConfig,
  number: number,
  comment: string
): Promise<void> {
  const { client } = resolveClient(config);
  await client.close(number, comment);
}

/** Add a comment to a GitHub issue (e.g. "PR opened: <url>"). */
export async function commentOnIssue(
  config: GitHubConfig,
  number: number,
  comment: string
): Promise<void> {
  const { client } = resolveClient(config);
  await client.comment(number, comment);
}

export interface OpenPrOptions {
  /** Issue number the PR fixes (adds "Fixes #N" so merge auto-closes it). */
  issueNumber: number;
  title: string;
  body: string;
  baseBranch?: string;
  branchPrefix?: string;
}

/**
 * Open a pull request for code changes the agent has ALREADY made in the working
 * tree. The engine stages everything, commits to a fresh branch, pushes, and opens
 * the PR via the `gh` CLI (requires `gh` to be installed + authenticated). Returns
 * the PR URL so it can be broadcast to the channels.
 *
 * This is the code-fix path: the engine never writes code itself — the healing-agent
 * authors the change, then calls this to ship it as a reviewable PR.
 */
export async function openPullRequest(opts: OpenPrOptions): Promise<{ url: string; branch: string }> {
  const base = opts.baseBranch ?? "main";
  const prefix = opts.branchPrefix ?? "health-fix/";
  const branch = `${prefix}issue-${opts.issueNumber}`;
  const run = (args: string[]): string =>
    execFileSync(args[0], args.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // Stage + branch + commit + push. Assumes the agent already edited files.
  run(["git", "checkout", "-B", branch]);
  run(["git", "add", "-A"]);
  run(["git", "commit", "-m", opts.title, "-m", `Fixes #${opts.issueNumber}\n\n${opts.body}`]);
  run(["git", "push", "-u", "origin", branch]);

  const body = `${opts.body}\n\nFixes #${opts.issueNumber}\n\n_Opened by health-check-plugin healer._`;
  const url = run([
    "gh", "pr", "create", "--base", base, "--head", branch,
    "--title", opts.title, "--body", body,
  ]).trim();

  return { url, branch };
}
