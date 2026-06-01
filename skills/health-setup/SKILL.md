---
name: health-setup
description: One guided setup that asks for everything the health check needs — what to monitor, channels, GitHub, healing, schedule, and (optionally) the 24/7 bot — then leaves it running autonomously. Use this first, on any project.
argument-hint: "(no args — it interviews you)"
user-invocable: true
---

# Health Check — guided setup

This is the **front door**. Walk the user through everything once; when you finish,
the health check runs on its own. Ask **one topic at a time**, confirm, then move on.
Pre-fill sensible defaults and only ask what you can't infer. At the end, write
`health-check.config.json` + `.env` (+ `.env.example`) and set up the schedule.

Scaffold the starting point first: `npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts init`.

## Interview (one step at a time)

1. **Project** — name, and an optional scope label (environment/service).
2. **What to monitor** — for each thing the user cares about, add a collector to
   `collectors[]`. Use the right type:
   - `postgres` (stuck rows, error counts, data freshness) — needs a data source in
     `dataSources` and a `urlEnv` (e.g. `DATABASE_URL`).
   - `http` (uptime / endpoint health) — a URL + expected status.
   - `shell` (disk %, queue depth, CLI checks) — a command whose output is a number
     or lines.
   See `${CLAUDE_PLUGIN_ROOT}/docs/collector-reference.md`. Keep titles templated
   (`{{count}}`, `{{value}}`, `{{field:NAME}}`) and set a `severity`.
3. **Channels** — where reports go. You can use BOTH Discord and Slack. Two modes:
   - **Webhook (notifications)** — add to `channels[]`: `{ "type": "discord",
     "webhookEnv": "HEALTH_DISCORD_WEBHOOK_URL" }` and/or the Slack equivalent. No
     hosting. Approvals happen here in the agent.
   - **Bot (interactive buttons)** — ask if the team wants to click "Fix" inside
     Discord/Slack. If yes, set `bot.enabled: true` with `bot.discord`/`bot.slack`
     (bot tokens + channel ids) and tell them it needs a **24/7 host** (see step 7).
4. **GitHub** — repo (`repoEnv` → `HEALTH_GITHUB_REPO` as `owner/repo`) and a token
   (`tokenEnv` → `GITHUB_TOKEN`, or rely on the local `gh` CLI). Set `minSeverity`.
5. **Healing** — ask how autonomous they want fixes:
   - leave `enabled: false` for report-only (safest), or
   - enable with `requireApproval: true`, an `allowedFixTypes` list (start with
     `["retrigger"]`), `dryRun: true` to watch first, and `pr` settings for code fixes.
   Explain the two approval gates (file the issue, then fix the issue) and that code
   fixes become PRs.
6. **Schedule** — ask **what time** it should run. Then:
   ```
   npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts schedule --at "09:00" --tz "<IANA tz>" --mode both
   ```
   This prints a cron line and writes a GitHub Actions workflow. Help them install
   whichever fits (crontab, or commit the workflow + add repo secrets).
7. **Bot hosting (only if step 3 chose the bot)** — the bot must run 24/7. Point them
   to `${CLAUDE_PLUGIN_ROOT}/docs/deployment.md` (Docker / systemd / Railway / Render /
   Fly). They create bot tokens, set them in `.env`, then run `health-check bot`.
8. **Secrets** — collect every env var the config references into `.env` (gitignored)
   and write matching placeholders to `.env.example`. Never hardcode secrets in the
   config — it only holds env var NAMES.

## Finish

- Validate: `npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts run` (a first reading).
- Tell the user, plainly: **setup is done and it now runs autonomously** — on the
  schedule (Model A) and/or via the 24/7 bot (Model B). From here they only get
  involved at the two approval gates (file an issue, fix an issue).
- Mention the other skills for day-to-day: `/health-run`, `/health-report`,
  `/health-issues`, `/health-heal-issue` (and `health-check verify` for recurrence).
