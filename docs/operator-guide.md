# Operator Guide

Day-to-day operation of the health-check plugin: running it, scheduling it, working the
board, reading the score, approving heals, and troubleshooting.

## Running it

Every command works standalone — no agent required. Use the published bin or run from
source:

```bash
npx health-check <command> [flags]      # via the installed package
npx tsx src/cli.ts <command> [flags]    # from a checkout (dev)
```

### Commands

| Command | What it does |
|---------|--------------|
| `run` | Collect → score → persist → deliver. The normal "how are we doing now" entry point. |
| `report` | Re-render the latest saved report without re-collecting. |
| `issues` | File the latest report's issues to GitHub (deduped by fingerprint). |
| `plan` | Print an advisory healing plan (JSON) from the latest report. Nothing executes. |
| `heal` | Execute approved fixes from the plan, inside the safety envelope. |
| `heal-issue` | Drive the GitHub-issue-driven healer loop: list open health-check issues and remediate them (ops fix, code fix → PR, or manual). See [The healer loop](#the-healer-loop-github-issue-driven). |
| `verify` | Show recurring vs. resolved issues across runs. |
| `schedule` | Generate a crontab line and/or a `.github/workflows/health-check.yml` GitHub Actions workflow so runs happen autonomously. See [Scheduling & autonomy](#scheduling--autonomy). |
| `bot` | Start the interactive 24/7 bot: a persistent process that posts reports **with buttons** and runs the approve→file→fix loop from Discord/Slack clicks. See [Interactive bot](#interactive-bot). |
| `init` | Scaffold a starter `health-check.config.json`. |

### `run` flags

| Flag | Effect |
|------|--------|
| `--file-issues` | Also open GitHub issues for actionable findings in the same run (skips discuss-first). |
| `--plan` | Also print a healing plan after the report. |
| `--period <h>` | Override the lookback window (hours) for this run. |
| `--config <path>` | Use a specific config file (global flag, works on every command). |

### `heal` flags

| Flag | Effect |
|------|--------|
| `--approve all` | Approve every plan item. |
| `--approve 0,2,3` | Approve specific item indices (comma-separated). |

```bash
npx health-check run --period 6 --plan
npx health-check issues
npx health-check heal --approve 0,2
```

> `run` sets a non-zero exit code (`2`) when any **critical** issue exists — useful for
> gating CI.

## Scheduling & autonomy

There are two ways to make the health check run on its own. They are complementary —
pick one, or run both.

| Autonomy model | What it is | Hosting | Interactive? |
|----------------|-----------|---------|--------------|
| **Scheduled CLI + webhooks** | A scheduler (cron / GitHub Actions / Trigger.dev) fires `health-check run` on a clock; reports post to the one-way **webhook channels** (`channels[]`). | Cron/VPS or GitHub Actions runner; webhooks need no hosting. | No — webhooks are notifications only. |
| **Interactive 24/7 bot** | A persistent `health-check bot` process posts reports **with buttons** and runs the approve→file→fix loop from clicks. | A long-lived process (24/7 hosting). | Yes — Discord/Slack buttons. |

### The `schedule` command

`schedule` writes the scheduling artifacts for you instead of hand-rolling cron syntax:

```bash
health-check schedule --at "09:00" --tz "Asia/Kolkata" --mode both
```

| Flag | Effect |
|------|--------|
| `--at "HH:MM"` | Local time of day to run. |
| `--tz "<IANA>"` | IANA timezone the `--at` time is interpreted in (e.g. `Asia/Kolkata`). |
| `--cron "<expr>"` | Provide a raw cron expression instead of `--at`. |
| `--mode cron\|github-actions\|both` | Which artifact(s) to emit. |
| `--cmd "<command>"` | Command the schedule runs. Defaults to `npx health-check run --file-issues`. |

It generates:

- **(a) a crontab line** for a local machine or VPS, e.g.:

  ```cron
  0 9 * * * cd /path/to/project && npx health-check run --file-issues >> /var/log/health-check.log 2>&1
  ```

- **(b) a `.github/workflows/health-check.yml`** GitHub Actions cron workflow. The
  local `--at` time + `--tz` are **auto-converted to UTC** for the workflow's `cron:`
  expression (GitHub Actions cron is always UTC), so `09:00 Asia/Kolkata` becomes
  `30 3 * * *`.

Once scheduled, runs happen **autonomously**. Reports are delivered to whatever
`channels[]` you've configured (the one-way webhook notifications below).

The underlying `run` command also works unchanged inside **Trigger.dev** or any other
scheduler — it just needs the working directory, the config, and the required env vars
present. Example GitHub Actions step (what the generated workflow runs):

```yaml
- name: Health check
  run: npx health-check run --file-issues
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    HEALTH_GITHUB_REPO: ${{ github.repository }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    HEALTH_DISCORD_WEBHOOK_URL: ${{ secrets.HEALTH_DISCORD_WEBHOOK_URL }}
    HEALTH_SLACK_WEBHOOK_URL: ${{ secrets.HEALTH_SLACK_WEBHOOK_URL }}
```

### Interactive bot

The **webhook channels** (`channels[]`) are one-way notifications: they post a report
and stop. The **bot** is a separate, persistent, interactive process — it posts reports
**with buttons** and runs the approve→file→fix loop directly from clicks. Start it with:

```bash
health-check bot            # connect and serve reports + button clicks
health-check bot --run-now  # also run a check immediately on startup
```

With `bot.runAt` set (and `bot.tz`), the bot also self-runs the check daily at that
local time. Configure it under the [`bot`](./configuration.md#bot) config block.

**Buttons in each report, and the two approval gates:**

1. **File GitHub issues** — **approval gate #1**. Clicking it files the report's issues
   to GitHub (same as `health-check issues`).
2. **Fix #N** (one per issue) — **approval gate #2**. Clicking it runs that issue's fix.
   Only **ops fixes** (`sql`/`shell`/`http`/`retrigger`) are executed from a click; for
   **code** fixes the bot replies telling you to run the healing-agent instead.

**Tokens, not webhooks.** The bot needs a **bot token** per platform (never a webhook
URL):

- **Discord** — a **bot token** (`HEALTH_DISCORD_BOT_TOKEN`) + a channel id, with the
  bot invited to the server with **Send Messages** and **Read Message History**.
- **Slack** — **Socket Mode** (no public URL): a **bot token** `xoxb-…`
  (`HEALTH_SLACK_BOT_TOKEN`, `chat:write`) **and** an app-level token `xapp-…`
  (`HEALTH_SLACK_APP_TOKEN`, `connections:write`).

The bot requires the optional deps `discord.js` / `@slack/bolt` (installed via
`npm install`) and, because it must stay online to receive clicks, **24/7 hosting**. See
[`docs/deployment.md`](./deployment.md) for Docker / systemd / Railway / Render / Fly
options.

## The board flow

The "board" is the human-in-the-loop review step. The intended flow:

1. **Report** — a scheduled `run` posts the scored summary and the critical/high issues
   to every configured channel (Discord embeds **and** Slack, plus the console echo).
   Each channel is delivered independently; one failing never blocks the others.
2. **Discuss** — people read it in the channel(s) and decide which findings are worth
   tracking. Nothing is filed automatically by this path.
3. **`/health-issues`** (or `health-check issues`) — after discussion, file the agreed
   findings to GitHub. This is the deliberate board step: discuss first, then track.
4. **GitHub** — issues are created/updated/reopened, deduped by fingerprint.

Healing outcomes (including PR links) are likewise broadcast back to every channel, so
the Discord and Slack boards stay in sync with what was resolved and which PRs opened.

For unattended setups you can collapse this with `run --file-issues`, which files
issues in the same run without the discuss step.

## Reading the score and bands

The score starts at 100 and subtracts `weight × count` for each issue:

- `critical` = 25, `high` = 10, `medium` = 3, `low` = 0.25 (configurable).

Bands (default thresholds):

| Band | Score | Emoji |
|------|-------|-------|
| healthy | `>= 90` | 🟢 |
| warning | `>= 70` | 🟡 |
| degraded | `>= 50` | 🟠 |
| critical | `< 50` | 🔴 |

So a single critical issue (−25) drops a perfect system to 75 (warning); three (−75)
push it to 25 (critical). The console and Discord output both show the score, band, and
a per-severity breakdown.

## Recurrence and verification

The engine remembers every issue fingerprint across runs (`fingerprint-history.json`):

- **Recurrence** — how many *consecutive* runs an issue has persisted. `verify` lists
  issues seen `>= 2` runs in a row, sorted by streak — these are the chronic problems.
- **Verification** — each run reports what changed since the last:
  `Resolved since last run: N · persisting: M · new: K`. An issue present last run and
  absent now is counted **resolved**; this is how a fix is confirmed on the *next*
  cycle.

```bash
npx health-check verify
# Active issues: 4 · recurring (>=2 runs): 2
#   5x  [postgres:stuck_jobs] 3 jobs stuck in processing
#   2x  [http:api_uptime] API /health is not returning 200
```

## The healing approval flow

Healing is **off and approval-required by default**. The flow:

1. `plan` (or `run --plan`) generates an **advisory** plan. Each item shows the fix
   type, confidence, estimated risk, the safety gates that must hold, and any prior fix
   attempts from the solutions log. Items are ordered lowest-risk-first. Nothing runs.
2. A human reviews the gates and approves specific indices.
3. `heal --approve <indices>` executes — but **only** fixes that pass every gate:

   > `healing.enabled` is true **AND** the fix type is in `allowedFixTypes` **AND**
   > it's approved (unless `requireApproval: false`) **AND** the run is under
   > `maxPerRun`.

   `dryRun: true` logs what *would* run without executing. `github_issue` and `manual`
   fix types are never auto-executed. Executable types are `sql`, `shell`, `http`,
   `retrigger`.
4. Every outcome is compounded to the solutions log, so the next plan cites it.

Start conservative: `dryRun: true`, a narrow `allowedFixTypes` (e.g. `["retrigger"]`),
and a low `maxPerRun`. Widen only once you trust the gates.

## The healer loop (GitHub-issue-driven)

The `heal-issue` command closes the loop between filed GitHub issues and their fixes. It
reads the **open** health-check issues, classifies how each would be remediated, and —
once approved — drives them to resolution, announcing every outcome to all channels.

End-to-end flow:

1. **Run → report → channels** — a scheduled `run` scores the system and broadcasts the
   report to every configured channel (Discord + Slack + console).
2. **Approve → create issue** — agreed findings are filed to GitHub (`issues` or
   `run --file-issues`), deduped by fingerprint.
3. **`heal-issue`** — works the open issues. Each issue is routed by its collector's
   `fix.type` down one of two paths:
   - **OPS** (`sql` / `shell` / `http` / `retrigger`) — the engine executes the fix,
     verifies the result, **closes the issue**, and broadcasts **`✅ Resolved #N`** to all
     channels.
   - **CODE** (`fix.type: code`) — the healing-agent writes the code fix, then
     `shipCodeFix()` opens a pull request: it branches off `healing.pr.baseBranch`
     (default `main`) with prefix `healing.pr.branchPrefix` (default `health-fix/`), sets
     the PR body to include `Fixes #N`, comments the PR link on the issue, and (when
     `healing.pr.announce` is true) broadcasts **`🔀 PR opened #N <url>`** to all channels.
     **Merging the PR auto-closes the issue** via the `Fixes #N` reference.
   - **Manual** — issues with no executable/code fix are listed as manual; the engine
     does not act on them.

PR creation requires the **`gh` CLI** to be installed and authenticated.

### `heal-issue` flags

| Flag | Effect |
|------|--------|
| `--list` | List the open health-check issues and how each would be remediated (ops fix / code fix → PR / manual). Nothing executes. |
| `--approve all` | Approve **every** OPS fix (by issue number). |
| `--approve <#,#>` | Approve specific OPS fixes by **issue number** (comma-separated). |
| `--issue <#,#>` | Restrict the operation to specific issue numbers. |

```bash
npx health-check heal-issue --list
npx health-check heal-issue --approve all
npx health-check heal-issue --approve 142,145
npx health-check heal-issue --issue 142
```

The same gates as `heal` apply to OPS fixes: `healing.enabled` + the fix type in
`allowedFixTypes` + approval (unless `requireApproval: false`) + under `maxPerRun`, with
`dryRun` logging instead of executing.

## Where state lives

All state is plain, inspectable JSON under the configured `stateDir` (default
`.health-check/`):

```
.health-check/
  reports/                  one report-<timestamp>.json per run; `report` reads the newest
  fingerprint-history.json  cross-run recurrence + verification state
  solutions-log.json        compounded record of fix outcomes (drives plan confidence)
```

These files are portable across agents and machines — commit or back them up to
preserve memory and recurrence history.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| **A collector failed** | The runner turns a thrown collector into a **low-severity** issue (`Collector "X" failed to run`) instead of crashing the run, so silent breakage is visible. Check `details.error` and the collector's `status` block. |
| **Missing env var** | The engine throws a clear `ConfigError` naming the variable and what needs it (e.g. *"Environment variable DATABASE_URL (required by a postgres data source) is not set."*). Set the var and re-run. |
| **No config found** | Create `health-check.config.json`, pass `--config <path>`, or set `HEALTH_CHECK_CONFIG`. Run `init` to scaffold one. |
| **`pg` not installed** | postgres collectors need `npm install pg`. http/shell-only configs don't require it. |
| **`issues` does nothing** | `github.enabled` is `false`, or all issues are below `minSeverity` (default `high`). |
| **GitHub auth fails** | With `tokenEnv` set, a PAT (`repo` scope) is used via REST; without it, the local `gh` CLI must be authenticated. |
| **Heal skips everything** | Check the skip reasons it prints: healing disabled, fix type not in `allowedFixTypes`, not approved, `maxPerRun` reached, or the type isn't auto-executable. |
| **No critical-exit gating** | `run` exits `2` only when a critical issue exists; use that for CI gates. |

## See also

- [Configuration Reference](./configuration.md) — every config field.
- [Collector Reference](./collector-reference.md) — building the signals you operate on.
- [Universal Framework](./universal-framework.md) — the lifecycle and design philosophy.
