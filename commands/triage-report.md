# SOP: Triage a Health Report

How to read a report and decide **create-issue vs. ignore vs. heal**.

## The score

```
score = 100 − Σ(severityWeight × count)        clamped to [0, 100]
```

Default severity weights (configurable in `severityWeights`):

| Severity | Weight | One issue drops the score by |
|----------|--------|------------------------------|
| critical | 25     | 25 |
| high     | 10     | 10 |
| medium   | 3      | 3  |
| low      | 0.25   | 0.25 |

So a single critical alone takes the score to 75 (warning). Two criticals → 50.
Use the weights to sanity-check: if the score dropped a lot, a high-weight issue appeared.

## The bands

Read from `scoreBands`; defaults:

| Band      | Range   | Meaning |
|-----------|---------|---------|
| healthy   | ≥ 90    | Nominal. No action usually needed. |
| warning   | ≥ 70    | One or two real issues. Discuss, likely file. |
| degraded  | ≥ 50    | Multiple issues or a critical. Act this cycle. |
| critical  | < 50    | Systemic. Stop and triage immediately. |

**Exit code 2** is emitted whenever any `critical`-severity issue exists, independent
of the numeric band. That is the cron/CI gate.

## Severity weighting in practice

- Lead triage with `critical`, then `high`. These dominate both the score and the risk.
- `medium` is the bulk-noise tier — worth filing when recurring, easy to over-file.
- `low` barely moves the score; treat as informational unless it recurs and clusters.

## Recurrence (`consecutiveRuns`)

From `verify` / the fingerprint history. A finding's `consecutiveRuns` counts how many
runs in a row it has appeared.

- `1` — new or one-off. Could be transient; consider waiting one cycle before filing.
- `>= 2` — **recurring**. This is real. A recurring medium often outranks a one-off high.
- High `consecutiveRuns` with no action = an issue everyone is ignoring. Either file it or
  consciously decide to suppress (and write that decision down).

## Collector failures

A collector that **failed to run** (bad query, unreachable HTTP, shell error) is not the
same as "healthy." It means you are **blind** on that signal. Treat an unknown signal as
a risk:
- Fix the collector (see `configure-collectors.md`) before trusting the score.
- Do not report "all clear" while a collector is failing — say which signal is dark.

## Decision matrix: create-issue / ignore / heal

| Situation | Decision |
|-----------|----------|
| critical or high severity, real evidence | **create-issue** (file via `issues`), and consider **heal** if it has a safe `fix` |
| recurring (`>=2`) at any severity | **create-issue** — it is not going away on its own |
| one-off `low`/`medium`, no downstream impact | **ignore** this cycle; revisit if it recurs |
| has a `fix` action, gates hold, fixType in `allowedFixTypes`, approved | **heal** (healing-agent) — then `create-issue` only if heal fails |
| collector failed to run | neither — **fix the collector first** |
| known/accepted condition | **ignore**, but record the suppression so it is not re-triaged |

Filing is idempotent (fingerprint dedup), so when unsure between file and ignore for a
recurring item, prefer file — a duplicate just comments on the existing issue.
