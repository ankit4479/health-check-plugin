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
| `verify` | Show recurring vs. resolved issues across runs. |
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

## Scheduling

The engine is a plain CLI, so any scheduler can drive it. A typical hourly cron:

```cron
# Run a health check every hour, file high+ issues to GitHub
0 * * * * cd /path/to/project && npx health-check run --file-issues >> /var/log/health-check.log 2>&1
```

The same `run` command works unchanged inside **Trigger.dev**, **GitHub Actions**, or
any other scheduler — it just needs the working directory, the config, and the
required env vars present. Example GitHub Actions step:

```yaml
- name: Health check
  run: npx health-check run --file-issues
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    HEALTH_GITHUB_REPO: ${{ github.repository }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## The board flow

The "board" is the human-in-the-loop review step. The intended flow:

1. **Report** — a scheduled `run` posts the scored summary and the critical/high issues
   to the channel (Discord embeds, plus the console echo).
2. **Discuss** — people read it in the channel and decide which findings are worth
   tracking. Nothing is filed automatically by this path.
3. **`/health-issues`** (or `health-check issues`) — after discussion, file the agreed
   findings to GitHub. This is the deliberate board step: discuss first, then track.
4. **GitHub** — issues are created/updated/reopened, deduped by fingerprint.

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
