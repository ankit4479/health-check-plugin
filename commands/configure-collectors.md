# SOP: Configure Collectors

How to add or modify collectors in `health-check.config.json` to monitor a new system.

Start from a scaffold if you have none:
```
npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts init
```

## Anatomy of a collector

Collectors live in the `collectors[]` array. Common fields:

| Field | Meaning |
|-------|---------|
| `id` | Stable unique id (also the key healing maps a `fix` back to). |
| `type` | `postgres` \| `http` \| `shell`. |
| `severity` | `critical` \| `high` \| `medium` \| `low`. Drives scoring + GitHub `minSeverity`. |
| `title` | Templated headline. Supports `{{count}}`, `{{value}}`, `{{field:NAME}}`. |
| `message` | Optional longer body, same templating. |
| `issueWhen` | When this collector emits an issue (see below). |
| `fingerprintFields` | Fields whose values form the dedup fingerprint. Keep stable. |
| `suggestedFix` | Human-readable remediation hint (advisory). |
| `fix` | Optional declarative auto-fix action (see below). |

### `issueWhen` predicates

- `{ "rowsAtLeast": N }` — fire when the query returns ≥ N rows (postgres).
- `{ "numericAtLeast": N }` — fire when the first numeric value is ≥ N (shell/http/postgres scalar).
- `{ "numericAtMost": N }` — fire when that value is ≤ N.
- `{ "always": true }` — always emit (use with a count field so the title carries the number).

### Templating

- `{{count}}` — row count returned.
- `{{value}}` — the scalar numeric value (shell stdout, or first numeric column).
- `{{field:NAME}}` — value of column `NAME` from the first row.

### Postgres specifics

- Reference a `dataSources` entry by `dataSource`.
- The query binds **`$1` = `periodHours`**. Use it for the lookback window.
- Keep queries **read-only**. Mutations belong in a `fix`, never the collector.

### Optional `fix` action

```jsonc
"fix": {
  "type": "sql" | "shell" | "http" | "retrigger" | "github_issue" | "manual",
  "command": "...",        // sql/shell/retrigger
  "url": "...",            // http (POST)
  "dataSource": "app_db",  // required for sql
  "estimatedRisk": "low" | "medium" | "high",
  "safetyGates": ["short human-checkable preconditions"]
}
```
`github_issue` and `manual` are never auto-executed. `sql`/`shell` are high-risk —
the healing-agent treats them accordingly and prefers a dry-run first.

---

## Worked example 1 — Postgres stuck-rows collector

Detect rows wedged in a `processing` state past the lookback window, with a bounded
SQL reset as an opt-in fix.

```json
{
  "id": "stuck_orders",
  "type": "postgres",
  "dataSource": "app_db",
  "description": "Orders stuck in 'processing' beyond the window",
  "query": "SELECT id, updated_at FROM orders WHERE status = 'processing' AND updated_at < now() - ($1 || ' hours')::interval",
  "issueWhen": { "rowsAtLeast": 1 },
  "severity": "high",
  "title": "{{count}} orders stuck in processing",
  "message": "{{count}} order(s) exceeded the {{field:updated_at}} cutoff. Oldest id: {{field:id}}.",
  "fingerprintFields": ["id"],
  "suggestedFix": "Reset stuck orders to 'pending' so the worker re-picks them.",
  "fix": {
    "type": "sql",
    "dataSource": "app_db",
    "command": "UPDATE orders SET status = 'pending' WHERE status = 'processing' AND updated_at < now() - interval '1 hour'",
    "estimatedRisk": "medium",
    "safetyGates": ["Bounded row count", "Re-processing is idempotent"]
  }
}
```

Notes: `$1` binds the period; `fingerprintFields: ["id"]` keeps the same stuck row
mapped to the same GitHub issue across runs; the fix is `sql` so it stays gated and
off by default unless `allowedFixTypes` includes `sql`.

## Worked example 2 — HTTP uptime collector

Page a critical when a health endpoint is not returning 200, with a low-risk retrigger.

```json
{
  "id": "checkout_uptime",
  "type": "http",
  "url": "https://api.example.com/health",
  "method": "GET",
  "expectStatus": 200,
  "timeoutMs": 5000,
  "severity": "critical",
  "title": "Checkout /health is not returning 200",
  "fingerprintFields": [],
  "suggestedFix": "Check the checkout service and its upstream dependencies.",
  "fix": {
    "type": "retrigger",
    "command": "echo 'restart command goes here'",
    "estimatedRisk": "low",
    "safetyGates": ["Restart is safe / stateless"]
  }
}
```

Notes: a non-200 (or timeout) emits a `critical`, which forces **exit code 2** for the
cron gate. The `retrigger` fix is the lowest-risk class and a good first candidate for
`allowedFixTypes`. Replace the placeholder `command` with the real restart command.

---

## After editing

- Validate config:
  ```
  ${CLAUDE_PLUGIN_ROOT}/scripts/check-health-config.sh
  ```
- Run once and confirm the new collector fires as expected:
  ```
  npx tsx ${CLAUDE_PLUGIN_ROOT}/src/cli.ts run --period <h>
  ```
- Tune `severity`, `issueWhen` thresholds, and `fingerprintFields` if it is too noisy or
  too quiet, then re-run.
