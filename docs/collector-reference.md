# Collector Reference

A collector is the bridge between a raw signal and a scored health issue. The runner
(`src/collectors/index.ts`) executes every enabled collector, applies the declarative
`issueWhen` predicate, interpolates the `title`/`message` templates, and emits a
fingerprinted `HealthIssue`. No system-specific logic lives in the runner — all of it
is expressed in config.

This document covers the three built-in collector types and how to add your own.

## How a collector becomes an issue

Each collector returns a `RawResult`:

```ts
interface RawResult {
  rows?: Array<Record<string, unknown>>; // postgres rows / shell output lines
  numeric?: number;                      // shell numeric stdout, http latency ms
  details?: Record<string, unknown>;     // evidence attached to the issue
  fired?: boolean;                        // collector self-decided (overrides issueWhen)
}
```

The runner then:

1. **Evaluates `issueWhen`** against the result. If `fired` is set explicitly (http
   always does this), it wins. Otherwise the predicate decides.
2. **Shapes the issue** if fired: interpolates templates, builds the fingerprint from
   `fingerprintFields` (or the collector `id` if none), attaches a 5-row sample plus
   `details`.
3. **Records collector status** (success/failure + duration). A collector that throws
   becomes its own **low-severity** issue so silent breakage still shows up.

### Template tokens

`title` and `message` support:

| Token | Expands to |
|-------|-----------|
| `{{count}}` | Number of rows in the result. |
| `{{value}}` | The numeric scalar (shell numeric, http latency). |
| `{{field:NAME}}` | `NAME` from the **first** result row. |

### Fingerprinting

The fingerprint is a 16-char SHA-256 of `source + fingerprintFields` values
(normalized: trimmed, lowercased). Use **stable identity** fields — not volatile
counts or timestamps — so "the same problem" produces the same fingerprint across
runs. If `fingerprintFields` is omitted, the collector `id` is used (one stable
fingerprint per collector).

---

## postgres collector

Runs read-only SQL against a configured postgres `dataSource` and returns the rows.
If the query contains `$1`, it's bound to `periodHours`. Pools are created lazily and
reused across collectors sharing a data source.

- Rows feed `issueWhen.rowsAtLeast` (and `always`).
- `fingerprintFields` pull from row columns.
- `title`/`message` template against row count and the first row's fields.

### Example 1 — stuck rows (row-based, dedup by id)

```json
{
  "id": "stuck_jobs",
  "type": "postgres",
  "dataSource": "app_db",
  "description": "Jobs stuck in 'processing' beyond the window",
  "query": "SELECT id, created_at FROM jobs WHERE status = 'processing' AND created_at < now() - ($1 || ' hours')::interval ORDER BY created_at",
  "issueWhen": { "rowsAtLeast": 1 },
  "severity": "high",
  "title": "{{count}} jobs stuck in processing",
  "message": "{{count}} job(s) stuck longer than {{value}}h. Oldest id: {{field:id}}.",
  "fingerprintFields": ["id"]
}
```

### Example 2 — error-rate count (scalar-as-row, `always`)

A `count(*)` returns a single row. Use `always: true` so any returned row fires, then
template the count column.

```json
{
  "id": "error_rate",
  "type": "postgres",
  "dataSource": "app_db",
  "description": "Error-state events in the window",
  "query": "SELECT count(*)::int AS n FROM events WHERE status = 'error' AND created_at > now() - ($1 || ' hours')::interval",
  "issueWhen": { "always": true },
  "severity": "medium",
  "title": "Errors detected in events",
  "message": "{{field:n}} error events in the last window.",
  "fingerprintFields": ["n"]
}
```

> To suppress when the count is zero, filter in SQL (e.g. `HAVING count(*) > 0`) so no
> row is returned, instead of relying on `always`.

### Example 3 — freshness / last-run age (row fires only when stale)

Let SQL decide staleness; emit a row only when the last run is too old. `rowsAtLeast: 1`
then fires.

```json
{
  "id": "pipeline_freshness",
  "type": "postgres",
  "dataSource": "app_db",
  "description": "Alerts when the pipeline has not run recently",
  "query": "SELECT max(finished_at) AS last_run, round(extract(epoch FROM now() - max(finished_at)) / 3600, 1) AS hours_stale FROM pipeline_runs HAVING now() - max(finished_at) > ($1 || ' hours')::interval",
  "issueWhen": { "rowsAtLeast": 1 },
  "severity": "critical",
  "title": "Pipeline stale by {{field:hours_stale}}h",
  "message": "No successful run since {{field:last_run}} ({{field:hours_stale}}h ago).",
  "fingerprintFields": ["last_run"]
}
```

---

## http collector

Probes a URL. It **fires when** the response status differs from `expectStatus`
(default `200`) **or** the request times out (`timeoutMs`, default `10000`). The http
collector sets `fired` itself, so `issueWhen` is not used. Its `numeric` value is
request latency in ms (available as `{{value}}`), and `details` carries `url`,
`status`, `expected`, `latencyMs`, or the timeout/error message.

- `headers` sets static headers.
- `headersFromEnv` maps a header name → env-var name; the env value is injected at
  runtime so secrets stay out of the config file.

### Example 1 — uptime probe

```json
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
}
```

### Example 2 — authenticated downstream dependency

```json
{
  "id": "billing_dependency",
  "type": "http",
  "url": "https://billing.internal/v1/ping",
  "method": "GET",
  "headersFromEnv": { "Authorization": "BILLING_API_TOKEN" },
  "headers": { "Accept": "application/json" },
  "expectStatus": 200,
  "timeoutMs": 8000,
  "severity": "high",
  "title": "Billing dependency probe failed",
  "message": "Downstream billing ping did not return 200 (latency {{value}}ms).",
  "suggestedFix": "Verify the billing service and the BILLING_API_TOKEN secret."
}
```

> `BILLING_API_TOKEN` is read from the environment at runtime and injected as the
> `Authorization` header — the secret never appears in the config.

---

## shell collector

Runs a command and captures stdout, then evaluates it against `issueWhen`.

- If trimmed stdout **parses as a number**, it becomes `numeric` and feeds
  `numericAtLeast` / `numericAtMost` (available as `{{value}}`).
- Otherwise, each **non-empty output line** becomes a row, feeding `rowsAtLeast` /
  `always` (and templatable via `{{count}}` / `{{field:line}}`).
- A non-zero exit with no stdout is treated as a collector failure (low-severity issue).
- `timeoutMs` defaults to `15000`; output is capped at 1 MB.

### Example 1 — disk usage percent (numeric)

```json
{
  "id": "disk_usage",
  "type": "shell",
  "command": "df -h / | tail -1 | awk '{print $5}' | tr -d '%'",
  "issueWhen": { "numericAtLeast": 90 },
  "severity": "high",
  "title": "Root disk usage at {{value}}%",
  "suggestedFix": "Free up disk or expand the volume."
}
```

### Example 2 — kubectl not-ready pod count (numeric threshold)

```json
{
  "id": "unready_pods",
  "type": "shell",
  "command": "kubectl get pods -n prod --no-headers | grep -v Running | grep -c -v Completed || true",
  "issueWhen": { "numericAtLeast": 1 },
  "severity": "high",
  "title": "{{value}} pod(s) not Running in prod",
  "suggestedFix": "Inspect failing pods: kubectl get pods -n prod | grep -v Running"
}
```

> When you want to react to **lines** instead of a number (e.g. list the offending pod
> names), emit non-numeric output and use `issueWhen: { "rowsAtLeast": 1 }`; then
> `{{count}}` is the line count and `{{field:line}}` is the first line.

---

## Adding a custom collector

The three built-ins cover most needs, but the runner is type-dispatched, so adding a
new collector type is a small, contained change. The contract:

**You implement a function returning a `RawResult`** (`{ rows?, numeric?, details?,
fired? }`). Everything downstream — `issueWhen` evaluation, template interpolation,
fingerprinting, status tracking, and the failure-as-low-severity-issue behavior — is
applied by the runner for free.

The pattern, following the existing collectors in `src/collectors/`:

1. Add your config shape to `src/config.ts` (extend `BaseCollector`, add to the
   `CollectorConfig` union, and any new `type` literal).
2. Implement `runMyCollector(col, ctx): Promise<RawResult>` in
   `src/collectors/mytype.ts`. Return:
   - `rows` for list/threshold signals (feeds `rowsAtLeast` / `always` / `{{count}}` /
     `{{field:NAME}}`),
   - `numeric` for scalar thresholds (feeds `numericAtLeast` / `numericAtMost` /
     `{{value}}`),
   - `fired` to self-decide and bypass `issueWhen`,
   - `details` for evidence attached to the issue.
3. Wire it into the `dispatch()` switch in `src/collectors/index.ts`.

```ts
// src/collectors/mytype.ts
import type { CollectorContext, RawResult } from "./index.js";

export async function runMyCollector(
  col: MyCollector,
  ctx: CollectorContext
): Promise<RawResult> {
  const value = await measureSomething(col, ctx.periodHours);
  return { numeric: value, details: { source: col.id, value } };
  // The runner applies issueWhen (e.g. numericAtLeast), templating, and fingerprinting.
}
```

> Look at `src/collectors/index.ts` for the `RawResult` / `CollectorContext`
> interfaces and the `evaluateIssueWhen` / `interpolate` / `shapeIssue` helpers — they
> define exactly what a collector must return and what the runner does with it.

## See also

- [Configuration Reference](./configuration.md) — every collector field documented.
- [Universal Framework](./universal-framework.md) — why collectors are the domain-specific 35%.
- [Operator Guide](./operator-guide.md) — running collectors and reading their output.
