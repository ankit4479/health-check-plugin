---
name: health-configure
description: Interactively scaffold or edit this project's health-check.config.json so the generic engine monitors your specific system.
argument-hint: ""
user-invocable: true
---

# health-configure

## When to use
Use this to adapt the generic engine to **this** project. It walks the user through creating or editing `health-check.config.json` in the project root — defining what to monitor, where to deliver, and what to automate.

## Steps
1. If no config exists yet, scaffold one from the example:
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts init
   ```
   (It won't overwrite an existing config.) Then open and edit `health-check.config.json`.
2. Walk the user through each section, one topic at a time, and edit the file as you go:
   - **project / periodHours**: name and default lookback window.
   - **dataSources**: Postgres connections — reference each connection string by env var **name** (e.g. `DATABASE_URL`), never inline the secret.
   - **collectors**: what to monitor. Each has an `id`, `type` (`postgres` / `http` / `shell`), `severity`, a `title` template (supports `{{count}}`, `{{value}}`, `{{field:NAME}}`), an `issueWhen` predicate that decides when it's a problem, and an optional `fix` action for healing.
   - **channel**: where reports go — `console` or `discord` (Discord needs a webhook env var like `HEALTH_DISCORD_WEBHOOK_URL`).
   - **github**: whether to file issues — `enabled`, `repoEnv`, `tokenEnv`, `minSeverity`, `labels`.
   - **healing**: whether to auto-fix — `enabled`, `requireApproval`, `maxPerRun`, `allowedFixTypes`, `dryRun`.
   - **severityWeights / scoreBands**: how findings roll up into the 0-100 score.
3. Remind the user to set the referenced env vars (by name) in their environment / `.env`.

## What to tell the user
- The config is the contract between the generic engine and their system — collectors define every signal it can raise.
- Suggest a first `/health-run` to validate the config end to end once it's saved.
