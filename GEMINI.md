# GEMINI.md — health-check-plugin (Gemini CLI entrypoint)

This project is a **universal health-check + healer board** — a configurable engine
that monitors any system, scores its health 0–100, dedups problems by fingerprint,
reports to a chat channel for discussion, and (on approval) files GitHub issues and
runs safety-gated auto-heals.

The engine is a plain CLI with no agent-specific code. Gemini CLI drives it through
the same commands a human or cron job would use. The instruction layer (this file
plus `commands/` and `docs/`) is what adapts it to your workflow.

## Commands

Invoke via `npx tsx src/cli.ts <cmd>` (or `npx health-check <cmd>` if installed):

- `run` — collect → score → persist → deliver a report. Add `--file-issues` to also
  open GitHub issues, `--plan` to also print a healing plan, `--period <hours>` to
  change the lookback window. Exits with code `2` when a critical issue is present.
- `report` — re-render the latest saved report.
- `issues` — file the latest report's actionable issues to GitHub (dedup by fingerprint).
- `plan` — print an advisory healing plan.
- `heal --approve all|<indices>` — run approved fixes, safety-gated.
- `verify` — list recurring vs. resolved issues across runs.
- `init` — scaffold `health-check.config.json`.

## Rules of operation

1. **Default to read-only.** `run`, `report`, `plan`, and `verify` change nothing.
2. **Discuss before filing.** Show the user the report, talk through it, then run
   `issues` only on their approval. That review step is the "board."
3. **Heal carefully.** Fixes execute only when `healing.enabled`, the fix type is
   allowed, the item is approved, and the run cap isn't exceeded. `manual` and
   `github_issue` are never auto-executed; `sql`/`shell` are high-risk — confirm the
   safety gates first.
4. **Configure, don't hardcode.** All system-specific behavior lives in
   `health-check.config.json`. See `docs/configuration.md` and
   `docs/collector-reference.md` to add or change collectors.

## Start here

- `docs/operator-guide.md` — how to run and schedule it day to day.
- `commands/daily-cycle.md` — the step-by-step operational loop.
- `commands/configure-collectors.md` — how to point it at your system.
