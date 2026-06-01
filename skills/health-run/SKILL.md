---
name: health-run
description: Run a full health-check cycle (collect, score, deliver) and summarize the score, top issues, and what's recurring.
argument-hint: "[--file-issues] [--plan] [--period <hours>]"
user-invocable: true
---

# health-run

## When to use
Use this when someone wants a fresh read on system health: run the collectors, score 0-100, persist the report, and deliver it (console always; Discord if configured). This is the normal "how are we doing right now" entry point.

## Steps
1. Run the cycle:
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts run
   ```
   Pass through any args the user gave:
   - `--period <hours>` to override the lookback window.
   - `--file-issues` only if the user explicitly wants GitHub issues opened in the same pass (normally prefer discuss-first via `/health-issues`).
   - `--plan` to also print an advisory healing plan.
2. Read the rendered report and the trailer line (`Resolved since last run: … · persisting: … · new: …`).

## What to tell the user
- The overall score and which band it falls in.
- The top issues by severity (lead with any `critical`).
- What's recurring vs newly resolved (from the trailer line).
- Note that **exit code 2 means at least one critical issue is present** — call this out clearly, since it's the CI/cron gate signal.
- Suggest next step: discuss the report, then `/health-issues` to file, or `/health-heal` to plan fixes.
