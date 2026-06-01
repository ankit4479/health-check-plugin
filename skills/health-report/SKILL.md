---
name: health-report
description: Re-render the latest saved health report without re-collecting any data.
argument-hint: ""
user-invocable: true
---

# health-report

## When to use
Use this when someone wants to see the most recent report again — to re-read it, share it, or discuss it — without spending time or hitting data sources to re-collect. Nothing is re-run; it just re-renders what's already saved.

## Steps
1. Re-render the latest saved report:
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts report
   ```
2. If it reports "No saved report," there's nothing to show yet — point the user to `/health-run` first.

## What to tell the user
- Restate the score and the headline issues from the rendered report.
- Make clear this is the **last saved snapshot**, not a fresh check. If they need current data, use `/health-run`.
