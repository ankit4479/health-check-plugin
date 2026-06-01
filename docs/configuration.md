# Configuration Reference

Everything that makes a health check "about your system" lives in a single JSON file:
`health-check.config.json` (in the project root by default). The engine code itself
contains zero knowledge of any particular system — it reads this file, runs the
declared collectors, scores the result, and delivers it.

This document is the complete reference for every field.

## Config resolution

The config path is resolved in this order:

1. The `--config <path>` CLI flag (absolute, or relative to the current working directory).
2. The `HEALTH_CHECK_CONFIG` environment variable.
3. A conventional filename in the working directory: `health-check.config.json`, then `.health-check.config.json`.

If none is found, the CLI throws a clear `ConfigError`. Run `npx health-check init`
to scaffold a starter config from the shipped example.

Defined in `src/config.ts` (`findConfigPath`, `loadConfig`, `validateConfig`).

---

## Top-level fields

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `project` | `string` | **Yes** | — | Human-readable system name. Shown in every report header and Discord embed. Validation fails if missing or non-string. |
| `scope` | `string` | No | _(unset)_ | Free-form label for the environment, tenant, or service being checked (e.g. `"production"`). Surfaced in reports. |
| `periodHours` | `number` | No | `24` | Lookback window passed to collectors. Bound to `$1` in postgres queries; overridable per-run with `--period`. |
| `severityWeights` | `object` | No | see below | Points each severity subtracts from the 100-point score. |
| `scoreBands` | `object` | No | see below | Score thresholds for the `healthy` / `warning` / `degraded` bands. |
| `dataSources` | `object` | No | `{}` | Named data sources collectors connect to. Keyed by an id you choose. |
| `collectors` | `array` | **Yes** | — | The health signals to gather. Must be a **non-empty** array. |
| `channel` | `object` | No | `{ "type": "console" }` | Where the report is delivered. |
| `github` | `object` | No | `{ enabled: false, repoEnv: "HEALTH_GITHUB_REPO" }` | GitHub issue integration. |
| `healing` | `object` | No | `{ enabled: false, requireApproval: true }` | Auto-heal behavior and safety envelope. |
| `stateDir` | `string` | No | `.health-check` | Directory for reports, fingerprint history, and the solutions log. |

### `severityWeights`

Each issue subtracts `weight × count` from a starting score of 100.

| Key | Type | Default | Example |
|-----|------|---------|---------|
| `critical` | `number` | `25` | `25` |
| `high` | `number` | `10` | `10` |
| `medium` | `number` | `3` | `3` |
| `low` | `number` | `0.25` | `0.25` |

```json
"severityWeights": { "critical": 25, "high": 10, "medium": 3, "low": 0.25 }
```

Values you supply are merged over the defaults, so you can override a single weight.

### `scoreBands`

Score thresholds (inclusive lower bounds). Anything below `degraded` is `critical`.

| Key | Type | Default | Meaning |
|-----|------|---------|---------|
| `healthy` | `number` | `90` | `score >= 90` → healthy |
| `warning` | `number` | `70` | `score >= 70` → warning |
| `degraded` | `number` | `50` | `score >= 50` → degraded; below → critical |

```json
"scoreBands": { "healthy": 90, "warning": 70, "degraded": 50 }
```

### `stateDir`

```json
"stateDir": ".health-check"
```

The directory (relative to the working directory) where the engine persists state:

```
.health-check/
  reports/                  one JSON file per run (report-<timestamp>.json)
  fingerprint-history.json  cross-run recurrence + verification state
  solutions-log.json        compounded record of past fix outcomes
```

---

## `dataSources`

A map of `id → data source`. Each id is referenced by a collector's `dataSource`
field. Currently the only supported type is `postgres`. Referential integrity is
validated: a postgres collector pointing at an undeclared data source fails to load.

### postgres data source

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | `"postgres"` | **Yes** | — | Discriminator. |
| `urlEnv` | `string` | **Yes** | — | Name of the **env var** holding the connection string (the secret is never in the config file). |
| `ssl` | `boolean` | No | `false` | When `true`, connects with `ssl: { rejectUnauthorized: false }` — required for managed Postgres with self-signed certs (e.g. DigitalOcean). |

```json
"dataSources": {
  "app_db": { "type": "postgres", "urlEnv": "DATABASE_URL", "ssl": true }
}
```

> The `pg` package is loaded lazily. If you only use `http`/`shell` collectors you
> don't need `pg` installed. Pools are created once per data source and reused
> across collectors, with a 10s connect timeout and a 30s statement timeout.

---

## `collectors`

A non-empty array of collector objects. Every collector shares a set of **common
fields**; each `type` adds its own. See the
[Collector Reference](./collector-reference.md) for deep, example-driven coverage.

### Common fields (all collector types)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | `string` | **Yes** | — | Unique id. Becomes the issue `source`. Duplicate ids fail validation. |
| `type` | `"postgres"` \| `"http"` \| `"shell"` | **Yes** | — | Which built-in collector to run. |
| `severity` | `"critical"` \| `"high"` \| `"medium"` \| `"low"` | **Yes** | — | Severity assigned when this collector fires. |
| `title` | `string` | **Yes** | — | Issue title template. Supports `{{count}}`, `{{value}}`, `{{field:NAME}}`. |
| `message` | `string` | No | _(falls back to `title`)_ | Richer description template; same interpolation tokens. |
| `description` | `string` | No | — | Documentation note about what the collector watches. |
| `fingerprintFields` | `string[]` | No | `[]` (uses `id`) | Row fields combined into the dedup fingerprint. Use stable identity fields, not volatile values. |
| `suggestedFix` | `string` | No | — | Human-readable remediation hint shown in reports and issue bodies. |
| `codeReference` | `string` | No | — | Pointer into your codebase/runbook. |
| `fixType` | `FixType` | No | — | Default fix classification for the healer when there's no `fix` object. |
| `fix` | `object` | No | — | Declarative remediation the healer can execute (safety-gated). See below. |
| `enabled` | `boolean` | No | `true` | Set `false` to skip the collector without deleting it. |

### Per-type fields

**postgres**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `dataSource` | `string` | **Yes** | Id of a declared postgres data source. |
| `query` | `string` | **Yes** | Read-only SQL. If it contains `$1`, that param is bound to `periodHours`. |
| `issueWhen` | `object` | **Yes** | Predicate that turns rows into an issue (see below). |

**http**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `url` | `string` | **Yes** | — | Endpoint to probe. |
| `method` | `"GET"` \| `"POST"` \| `"HEAD"` | No | `GET` | HTTP method. |
| `headers` | `object` | No | — | Static request headers. |
| `headersFromEnv` | `object` | No | — | Header → env-var name; the env value is injected at runtime (secret indirection). |
| `expectStatus` | `number` | No | `200` | Status that means healthy. Anything else fires the issue. |
| `timeoutMs` | `number` | No | `10000` | Request timeout; a timeout fires the issue. |

The http collector does not use `issueWhen` — it fires on status mismatch or timeout.
Its `numeric` value is latency in ms.

**shell**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `command` | `string` | **Yes** | — | Command whose stdout is captured and evaluated. |
| `issueWhen` | `object` | **Yes** | — | Predicate (numeric or row-based) against stdout. |
| `timeoutMs` | `number` | No | `15000` | Command timeout. |

### `issueWhen` predicate

Used by `postgres` and `shell` collectors. Evaluated against the collector's raw result.

| Field | Type | Fires when |
|-------|------|-----------|
| `rowsAtLeast` | `number` | Result row count `>= N`. |
| `numericAtLeast` | `number` | Scalar value `>= N` (shell numeric stdout). |
| `numericAtMost` | `number` | Scalar value `<= N`. |
| `always` | `boolean` | Any non-empty result (rows present **or** a numeric value) — the collector did its own filtering. |

```json
"issueWhen": { "rowsAtLeast": 1 }
```

### `fix` action object

Optional per-collector remediation. Without it, an issue is "manual" only. Execution
is always gated by `healing` config + approval (see [Healing](#healing)).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"sql"` \| `"shell"` \| `"http"` \| `"retrigger"` \| `"github_issue"` \| `"manual"` | **Yes** | How the fix is carried out. `sql`/`shell`/`http`/`retrigger` are executable; `github_issue`/`manual` are never auto-run. |
| `command` | `string` | For `sql`/`shell`/`retrigger` | Statement (sql) or command (shell/retrigger) to run. |
| `url` | `string` | For `http` | URL the fix POSTs to. |
| `dataSource` | `string` | For `sql` | Postgres data source to run the statement against. |
| `safetyGates` | `string[]` | No | Human-readable preconditions a reviewer/agent must confirm before running. Surfaced in the healing plan. |
| `estimatedRisk` | `"low"` \| `"medium"` \| `"high"` | No | Risk hint. Drives execution order (lowest risk first). Defaults by fix type: `retrigger`→low, `shell`/`http`→medium, `sql`→high. |

```json
"fix": {
  "type": "sql",
  "dataSource": "app_db",
  "command": "UPDATE jobs SET status = 'pending' WHERE status = 'processing' AND created_at < now() - interval '1 hour'",
  "estimatedRisk": "medium",
  "safetyGates": ["Bounded row count", "Re-processing is idempotent"]
}
```

---

## `channel`

Where the report is delivered. The console is **always** printed regardless of this
setting, so a run is never silent.

### console

```json
"channel": { "type": "console" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"console"` | **Yes** | Terminal-only delivery. The default if `channel` is omitted. |

### discord

```json
"channel": { "type": "discord", "webhookEnv": "HEALTH_DISCORD_WEBHOOK_URL" }
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | `"discord"` | **Yes** | Posts rich embeds to a Discord webhook. |
| `webhookEnv` | `string` | **Yes** | Env var holding the webhook URL. The report becomes the discussion "board" in that channel. |

---

## `github`

GitHub issue integration with fingerprint-based dedup.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | `boolean` | **Yes** | `false` | Master switch. If `false`, `issues`/`--file-issues` do nothing. |
| `repoEnv` | `string` | **Yes** | — | Env var holding `"owner/repo"`. |
| `tokenEnv` | `string` | No | _(unset)_ | Env var holding a PAT with `repo` scope (REST API). If absent, falls back to the local `gh` CLI. |
| `minSeverity` | `IssueSeverity` | No | `high` | Only file issues at or above this severity; below-threshold issues are skipped. |
| `labels` | `string[]` | No | `["health-check", "automated"]` | Labels applied to created issues. A `severity:<level>` label is always added too. |

```json
"github": {
  "enabled": true,
  "repoEnv": "HEALTH_GITHUB_REPO",
  "tokenEnv": "GITHUB_TOKEN",
  "minSeverity": "high",
  "labels": ["health-check", "automated"]
}
```

**Dedup behavior** (keyed by the `fingerprint:<hash>` marker embedded in issue bodies):
open issue with the same fingerprint → comment "still occurring"; closed issue →
reopen + comment; no match → create.

---

## `healing`

Controls whether and how the engine executes fixes. The default posture is fully
disabled and approval-required.

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | `boolean` | **Yes** | `false` | Master switch. If `false`, every fix is skipped with reason "healing disabled". |
| `requireApproval` | `boolean` | No | `true` | If `true`, only explicitly approved item indices run. Set `false` to allow unattended healing (use with care). |
| `maxPerRun` | `number` | No | `5` | Cap on the number of fixes executed in a single `heal` invocation. |
| `allowedFixTypes` | `FixType[]` | No | `[]` | Whitelist of fix types the healer may execute. A fix type not listed here is skipped. |
| `dryRun` | `boolean` | No | `false` | If `true`, logs what *would* run without executing anything. |

```json
"healing": {
  "enabled": false,
  "requireApproval": true,
  "maxPerRun": 5,
  "allowedFixTypes": ["retrigger"],
  "dryRun": true
}
```

A fix executes only when **all** hold: `healing.enabled` is true **and** the fix type
is in `allowedFixTypes` **and** it's approved (unless `requireApproval` is false) **and**
the run is under `maxPerRun`. `github_issue` and `manual` fix types are never executable.

---

## Complete annotated example

```jsonc
{
  // System name shown in every report — REQUIRED.
  "project": "my-system",
  // Optional environment/tenant label.
  "scope": "production",
  // Default lookback window (hours); bound to $1 in postgres queries.
  "periodHours": 24,

  // Points each severity subtracts from a 100-point score.
  "severityWeights": { "critical": 25, "high": 10, "medium": 3, "low": 0.25 },
  // Score band thresholds (below "degraded" => critical).
  "scoreBands": { "healthy": 90, "warning": 70, "degraded": 50 },

  // Named data sources; secrets live in env vars, never here.
  "dataSources": {
    "app_db": { "type": "postgres", "urlEnv": "DATABASE_URL", "ssl": true }
  },

  // The health signals to gather (non-empty array, REQUIRED).
  "collectors": [
    {
      "id": "stuck_jobs",
      "type": "postgres",
      "dataSource": "app_db",
      "description": "Jobs stuck in 'processing' for over the window",
      "query": "SELECT id, created_at FROM jobs WHERE status = 'processing' AND created_at < now() - ($1 || ' hours')::interval",
      "issueWhen": { "rowsAtLeast": 1 },
      "severity": "high",
      "title": "{{count}} jobs stuck in processing",
      "message": "{{count}} job(s) stuck longer than the window. Oldest id: {{field:id}}.",
      "fingerprintFields": ["id"],
      "suggestedFix": "Re-run the processor or reset stuck rows to 'pending'.",
      "fix": {
        "type": "sql",
        "dataSource": "app_db",
        "command": "UPDATE jobs SET status = 'pending' WHERE status = 'processing' AND created_at < now() - interval '1 hour'",
        "estimatedRisk": "medium",
        "safetyGates": ["Bounded row count", "Re-processing is idempotent"]
      }
    },
    {
      "id": "api_uptime",
      "type": "http",
      "url": "https://api.example.com/health",
      "method": "GET",
      "expectStatus": 200,
      "timeoutMs": 5000,
      "severity": "critical",
      "title": "API /health is not returning 200",
      "suggestedFix": "Check the API service and its upstream dependencies."
    },
    {
      "id": "disk_usage",
      "type": "shell",
      "command": "df -h / | tail -1 | awk '{print $5}' | tr -d '%'",
      "issueWhen": { "numericAtLeast": 90 },
      "severity": "high",
      "title": "Root disk usage at {{value}}%",
      "suggestedFix": "Free up disk or expand the volume."
    }
  ],

  // Delivery target; console is always printed regardless.
  "channel": { "type": "discord", "webhookEnv": "HEALTH_DISCORD_WEBHOOK_URL" },

  // GitHub issue integration with fingerprint dedup.
  "github": {
    "enabled": true,
    "repoEnv": "HEALTH_GITHUB_REPO",
    "tokenEnv": "GITHUB_TOKEN",
    "minSeverity": "high",
    "labels": ["health-check", "automated"]
  },

  // Auto-heal safety envelope (disabled + dry-run by default).
  "healing": {
    "enabled": false,
    "requireApproval": true,
    "maxPerRun": 5,
    "allowedFixTypes": ["retrigger"],
    "dryRun": true
  },

  // Where run state is persisted.
  "stateDir": ".health-check"
}
```

> JSONC comments above are for illustration. `health-check.config.json` must be
> **strict JSON** — remove comments before saving.

## See also

- [Collector Reference](./collector-reference.md) — the three built-in collectors in depth.
- [Operator Guide](./operator-guide.md) — running, scheduling, the board flow, and troubleshooting.
- [Universal Framework](./universal-framework.md) — the design philosophy and lifecycle.
