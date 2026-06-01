---
name: health-heal-issue
description: Drive the healer loop from open GitHub issues — execute approved ops fixes (close + announce), or for code fixes write the diff and ship it as a PR linked "Fixes #N".
argument-hint: "[--list | --approve all|<#,#> | --issue <#,#>]"
user-invocable: true
---

# health-heal-issue

## When to use
Use this **after** findings have been filed to GitHub (via `/health-issues`) and a human has approved which issues to remediate. This is the closing half of the loop: it acts **from open GitHub issues**, not from the latest report.

```
run → report → channels → approve → create GitHub issue
  ── then (here) ──
heal-issue → ops: fix + close + announce
           code: agent writes the fix → ship a PR ("Fixes #N") + announce link
```

Every issue is matched to its originating collector by fingerprint, then routed by the collector's `fix.type`:
- **ops fix** (`sql` / `shell` / `http` / `retrigger`) — the engine executes it deterministically.
- **code fix** — the engine cannot author code; the healing-agent must write the diff, then ship a PR.
- **manual** — no auto-fix; needs a human.

## Steps

1. **List** what is open and how each issue would be remediated:
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts heal-issue --list
   ```
   Output is one line per open issue: `#<number> [ops fix (<type>) | code fix → PR (agent) | manual] <title>`. Note these are **issue numbers**, not list indices.

2. **Present** the list to the user, grouped by path, with the risk of each ops fix. Ask which **issue numbers** they approve. Do not pick for them — wait for explicit approval. Optionally scope a run with `--issue <#,#>`.

3. **Ops path** — execute the approved fixes:
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts heal-issue --approve <#,#>
   # or, only if the user approves every ops fix out loud:
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts heal-issue --approve all
   ```
   `--approve` takes **issue numbers**. The engine runs the fix, verifies, **closes** the GitHub issue, and broadcasts `✅ Resolved #N` to **all** channels (Discord + Slack). Gates are the same as report-driven healing: `healing.enabled`, `allowedFixTypes`, approval, `maxPerRun`, `dryRun`. Anything blocked is reported as `[skip]` with the reason.

4. **Code path** — issues route here as outcome `needs_agent` (icon 🤖). The CLI cannot fix them; the **healing-agent** must:
   1. Read the issue (`gh issue view <N>`) and its evidence.
   2. Investigate the codebase to find the root cause.
   3. Write the actual code fix in the working tree (minimal, targeted diff).
   4. Ship it as a PR by calling the programmatic API, passing a plain-language **`summary`** of what you fixed (required — it's what the channel notification shows):
      ```
      shipCodeFix(config, issue, { prTitle, prBody, summary }, store)
      ```
      This creates a branch (default prefix `health-fix/`, e.g. `health-fix/issue-42`), commits the agent's changes, pushes, opens a PR via `gh` whose body leads with the summary and contains `Fixes #N` (so merging auto-closes the issue), comments the summary + PR link on the issue, and broadcasts to **all** channels: `🔧 Fixed issue #N — <title> · What was fixed: <summary> · 🔀 PR: <url>`. Requires the `gh` CLI installed + authenticated and a clean-ish working tree. **No fix in the tree → no PR.**

5. **Report** executed vs. skipped vs. needs-agent, with the outcome and reason for each, plus the what-was-fixed summary and PR link for any code fix.

## What to tell the user
- `--approve` / `--issue` take **issue numbers**, never list positions.
- Ops fixes close the issue immediately; code fixes only open a PR — the issue auto-closes when the PR **merges**.
- The resolution (ops) and the PR link (code) are always announced to Discord **and** Slack.
- If it errors that GitHub is disabled, or gates block a fix the user wanted, point them to `/health-configure` to adjust `github.*` / `healing.*`.
