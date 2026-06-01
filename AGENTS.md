# AGENTS.md — health-check-plugin (Codex / agent entrypoint)

This project is a **universal health-check + healer board**. It collects health
signals from any system, scores them 0–100, dedups issues by fingerprint, posts a
report to a chat channel for discussion, and — on approval — opens GitHub issues and
runs safety-gated auto-heals.

The engine is a plain CLI, so it works the same whether driven by Codex, Claude Code,
Gemini CLI, a cron job, or a human. There is nothing agent-specific in the engine —
only this instruction file and the markdown under `skills/`, `agents/`, and
`commands/` differ per agent.

## How to operate it

Run everything through the CLI (`npx tsx src/cli.ts <cmd>`, or `npx health-check <cmd>`
once installed):

| Step | Command | What it does |
|------|---------|--------------|
| Read | `run` | Collect → score → persist → deliver a report. Exit 2 if any critical. |
| Re-render | `report` | Show the latest saved report without re-collecting. |
| **Discuss** | — | Review the report on the channel/board with the user. **Do this before filing.** |
| File | `issues` | Open GitHub issues for actionable findings (dedup by fingerprint). |
| Plan | `plan` | Print an advisory healing plan (JSON). |
| Heal | `heal --approve all\|<indices>` | Execute approved fixes, safety-gated. |
| Verify | `verify` | Show recurring (≥2 runs) vs. resolved issues. |
| Scaffold | `init` | Create a starter `health-check.config.json`. |

`run` flags: `--file-issues`, `--plan`, `--period <hours>`, `--config <path>`.

## Operating rules

1. **Read-only by default.** Running, reporting, and planning never change anything.
   Filing GitHub issues and healing are the only side-effecting steps — both require
   the user's explicit go-ahead.
2. **Discuss before you file.** The board flow is: report → discuss → approve → file.
   Don't open GitHub issues from a report the user hasn't reviewed.
3. **Healing is gated.** A fix runs only if `healing.enabled` is true, its fix type is
   in `healing.allowedFixTypes`, it was approved, and it's under `maxPerRun`. `manual`
   and `github_issue` fix types are never auto-executed. Treat `sql`/`shell` as
   high-risk and confirm the safety gates first.
4. **Everything is config.** What to monitor, how to score, where to deliver, and how
   to heal all live in `health-check.config.json`. To adapt the system to a new
   project, edit that file (see `docs/configuration.md` and `docs/collector-reference.md`) —
   never hardcode anything in `src/`.

## Where things live

- `src/` — the engine (collectors, scoring, fingerprint, github, healing, memory, CLI).
- `health-check.config.json` — your system's definition (collectors, channel, github, healing).
- `.health-check/` — run state: `reports/`, `fingerprint-history.json`, `solutions-log.json`.
- `docs/` — configuration reference, collector reference, the universal framework, operator guide.
- `commands/` — SOP workflows (`daily-cycle`, `triage-report`, `configure-collectors`) you can follow step by step.

Start by reading `docs/operator-guide.md`, then `commands/daily-cycle.md`.
