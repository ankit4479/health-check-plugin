/**
 * PostgreSQL collector — runs a read-only query against a configured data source
 * and returns the rows. Connection pools are created lazily and reused across
 * collectors that share a data source. `$1` (if present) is bound to periodHours.
 */

import type { PostgresCollector } from "../config.js";
import { requireEnv } from "../config.js";
import type { CollectorContext, RawResult } from "./index.js";

// `pg` is a CommonJS module; import dynamically so the engine still loads (for
// http/shell-only configs) even if `pg` isn't installed.
export interface PostgresPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}

async function createPool(urlEnv: string, ssl: boolean): Promise<PostgresPool> {
  let pg: { Pool: new (cfg: unknown) => PostgresPool };
  try {
    pg = (await import("pg")) as unknown as { Pool: new (cfg: unknown) => PostgresPool };
  } catch {
    throw new Error(
      "The 'pg' package is required for postgres collectors. Run `npm install pg`."
    );
  }
  const connectionString = requireEnv(urlEnv, "a postgres data source");
  return new pg.Pool({
    connectionString,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
    max: 4,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
}

/** Get-or-create the pool for a named data source. */
export async function getPool(ctx: CollectorContext, dataSourceId: string): Promise<PostgresPool> {
  const existing = ctx.pools.get(dataSourceId);
  if (existing) return existing;

  const ds = ctx.config.dataSources[dataSourceId];
  if (!ds || ds.type !== "postgres") {
    throw new Error(`Data source "${dataSourceId}" is not a postgres source.`);
  }
  const pool = await createPool(ds.urlEnv, ds.ssl ?? false);
  ctx.pools.set(dataSourceId, pool);
  return pool;
}

export async function runPostgresCollector(
  col: PostgresCollector,
  ctx: CollectorContext
): Promise<RawResult> {
  const pool = await getPool(ctx, col.dataSource);
  const params = col.query.includes("$1") ? [ctx.periodHours] : undefined;
  const result = await pool.query(col.query, params);
  return { rows: result.rows };
}

/** Close every pool opened during a run. */
export async function closePools(ctx: CollectorContext): Promise<void> {
  for (const pool of ctx.pools.values()) {
    try {
      await pool.end();
    } catch {
      /* best effort */
    }
  }
  ctx.pools.clear();
}
