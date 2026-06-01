# SOP: Daily Health Cycle

The full operational loop, run by the health-check-agent (steps 1–4, 6–7) and the
healing-agent (step 5). All commands run via the CLI:
`npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts <cmd>` (or `npx health-check <cmd>`).

## 1. Run — collect, score, deliver

```
npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts run
```

Optional:
- `--period <h>` override the lookback window (default `periodHours` from config).
- `--file-issues` file issues in the same pass (skip only if the user wants discuss-first; usually they do — prefer step 4).
- `--plan` also print an advisory healing plan.

This collects every collector, scores 0-100, persists the report, and delivers it
(console always; Discord if `channel.type` is `discord`). **Exit code 2 = at least one
critical issue** — the CI/cron gate.

## 2. Review the report on the channel / board

Read the rendered report and the trailer line:
`Resolved since last run: N · persisting: N · new: N`.

To re-render the latest saved report without re-collecting:
```
npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts report
```

See `triage-report.md` for how to read severity, bands, recurrence, and collector failures.

## 3. Discuss + decide

With the user, decide per finding: **create-issue**, **ignore**, or **heal**.
Lead with criticals. Factor in recurrence (`consecutiveRuns`) and whether a collector
failed to run at all. Not every signal deserves an issue.

## 4. File approved findings to GitHub

After approval:
```
npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts issues
```

Files the latest report's issues to GitHub. Dedup is automatic via a 16-char
fingerprint in the issue body: open issue → comment, closed → reopen, none → create.
Requires `github.enabled: true` and `github.minSeverity` satisfied. Output reports
created / updated / reopened / skipped counts.

## 5. (Optional) Plan + heal safe auto-fixes

Healing-agent only, and only after explicit per-item approval.

```
npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts plan                 # advisory JSON plan
npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts heal --approve 0,2    # named indices
npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts heal --approve all    # whole plan, only if approved out loud
```

Gates (all must pass): `healing.enabled` true, fixType in `allowedFixTypes`, approved,
under `maxPerRun`. `dryRun: true` logs what *would* run. `manual` / `github_issue` are
never auto-executable. Prefer a dry-run first for any new fix; treat `sql`/`shell` as high-risk.

## 6. Verify on the next run

On the following cycle, confirm resolution:
```
npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts verify
```

Shows active vs. recurring (`>=2` consecutive runs) issues. A fix that "succeeded" but
the issue still appears next run is **not** resolved — reopen the discussion.

## 7. Record learnings

The healing executor compounds every fix outcome to memory automatically. Beyond that,
note for next cycle: which findings were ignored on purpose (so they are not re-litigated),
which fixes worked, and any collector that needs tuning (too noisy, wrong threshold,
or failed to run). Feed threshold changes back via `configure-collectors.md`.
