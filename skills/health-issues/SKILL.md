---
name: health-issues
description: File the latest report's actionable issues to GitHub — the "board" step, done after a human has discussed the report.
argument-hint: ""
user-invocable: true
---

# health-issues

## When to use
This is the **board step**. Use it after a human has actually looked at and discussed the latest report (for example in Discord) and agreed which findings are worth tracking. It files those findings to GitHub as issues.

**Discuss first, then file.** Do not jump straight from a raw `/health-run` to filing issues — the point of this step is that a person has decided the findings are real and worth a ticket.

## Steps
1. Confirm the report has been discussed and the user wants to file. If not, suggest `/health-report` and a discussion first.
2. File the latest report's issues:
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts issues
   ```
3. Read back the created / updated / reopened / skipped counts and any new issue links.

## What to tell the user
- Dedup is automatic — issues are fingerprinted, so re-filing won't create duplicates (existing ones get updated or reopened).
- Only findings at or above `github.minSeverity` are filed; the rest are skipped.
- Requires `github.enabled` plus the configured repo/token env vars (e.g. `HEALTH_GITHUB_REPO`, `GITHUB_TOKEN`). If it errors that GitHub is disabled, point them to `/health-configure`.
