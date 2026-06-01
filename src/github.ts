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
import { fingerprintMarker } from "./fingerprint.js";

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
  };
}

// ── gh CLI client (fallback) ────────────────────────────────────────────────────

function ghCliClient(repo: string): GhClient {
  const gh = (args: string[]): string =>
    execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
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
