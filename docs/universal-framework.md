# The Universal Framework

The health-check plugin is built on a deliberate split: **~65% of it is a generic core**
that never changes, and **~35% is domain-specific** and lives entirely in config and
pluggable collectors. That split is what lets the same engine watch a data pipeline, a
web app, a SaaS backend, an ML system, a CI/CD setup, or raw infrastructure — without
touching its code.

This document explains the philosophy, what can use it, and the lifecycle.

## The 65 / 35 split

### Generic core (~65%) — identical for every system

| Capability | Where it lives | What it does |
|------------|----------------|--------------|
| **Scoring** | `src/scoring.ts` | `score = 100 − Σ(weight × count)`, clamped to `[0,100]`, classified into bands. Deterministic. |
| **Fingerprint dedup** | `src/fingerprint.ts` | Stable 16-char hash identifying "the same issue" across runs and against GitHub. |
| **Conversation / board flow** | delivery + skills | Report → discuss → approve. The engine never re-raises what's already raised. |
| **GitHub integration** | `src/github.ts` | Fingerprint-based dedup: open→comment, closed→reopen, none→create; honors `minSeverity`. |
| **Healing framework** | `src/healing/` | Plan generation, risk ordering, and a strict safety envelope around execution. |
| **Memory / recurrence** | `src/memory.ts`, `src/state.ts` | Cross-run fingerprint history, recurrence counts, fix-verification, compounded solutions log. |
| **Delivery** | `src/delivery/` | Console always; Discord (or any `ChannelAdapter`) optionally. |

None of these contain knowledge of any particular system. They operate on generic
`HealthIssue` / `HealthReport` shapes.

### Domain-specific layer (~35%) — all in config

| Decision | Expressed as |
|----------|--------------|
| **Which collectors run** | `collectors[]` in config. |
| **What they query/probe** | `query` / `url` / `command` per collector. |
| **Severity rules** | `severity` + `issueWhen` thresholds + `severityWeights`. |
| **Fix actions** | per-collector `fix` objects (`type`, `command`/`url`, `safetyGates`, `estimatedRisk`). |

Adapting the engine to a new system means writing a `health-check.config.json` — not
editing code. (For a signal the three built-ins can't reach, you add one collector
function; see [Adding a custom collector](./collector-reference.md#adding-a-custom-collector).)

## What can use it

Because "what to watch" is pure config, the same engine fits very different domains:

| System type | Example collectors |
|-------------|--------------------|
| **Data pipelines** | postgres: stuck rows, error-rate, freshness/last-run-age; shell: queue depth. |
| **Web apps** | http: uptime / `/health`; postgres: 5xx-rate, slow-query count. |
| **SaaS backends** | http: per-tenant probes; postgres: failed-webhook count, billing sync lag. |
| **ML systems** | postgres: training-job failures, drift-metric thresholds; shell: model-registry checks. |
| **CI/CD** | http: runner availability; shell: failed-build count, flaky-test rate. |
| **Infrastructure** | shell: disk %, `kubectl` not-ready pods, cert expiry; http: load-balancer health. |

A single config can mix all three collector types across all of these.

## The lifecycle

Every run flows through the same pipeline (`src/orchestrator.ts`), and each phase is
also exposed individually so an agent can drive the board interactively.

```
collect ─► score ─► fingerprint / dedup ─► deliver to board ─► discuss
   ▲                                                              │
   │                                                              ▼
compound to memory ◄─ verify next run ◄─ safety-gated heal ◄─ GitHub issues ◄─ approve
```

1. **Collect** — run every enabled collector; gather rows / numerics / status.
2. **Score** — `100 − Σ(weight × count)`; assign a band (healthy / warning / degraded / critical).
3. **Fingerprint / dedup** — hash each issue's identity so recurrence is detectable and
   nothing is double-counted.
4. **Deliver to board** — print to console always; post embeds to Discord if configured.
5. **Discuss** — a human reads the board, decides what matters. (No action is forced.)
6. **Approve** — the human picks which findings to track / fix.
7. **GitHub issues** — file approved findings, deduped by the embedded
   `fingerprint:<hash>` marker (open→comment, closed→reopen, none→create).
8. **Safety-gated heal** — execute only fixes that pass every gate: healing enabled,
   fix type allowed, approved, under the per-run cap, and not in dry-run.
9. **Verify next run** — the next cycle marks previously-seen issues as resolved
   (gone) or persisting (still present), and counts new ones.
10. **Compound to memory** — fix outcomes land in the solutions log; future plans cite
    prior attempts, so the system gets smarter over time.

## Works with any LLM CLI

The engine is a **plain CLI** (`npx health-check <cmd>`) with no dependency on any
particular AI tool. The agent layer is just **markdown skills** that call that CLI.
That means the same system runs identically under Claude Code, Codex, Gemini CLI, a
cron job, or a human at a terminal — the LLM is an optional, swappable driver on top of
a deterministic core, not a requirement baked into it.

## See also

- [Configuration Reference](./configuration.md) — how the domain layer is expressed.
- [Collector Reference](./collector-reference.md) — the built-in collectors and custom ones.
- [Operator Guide](./operator-guide.md) — running the lifecycle day to day.
