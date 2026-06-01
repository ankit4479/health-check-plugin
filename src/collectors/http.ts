/**
 * HTTP collector — probes an endpoint and fires an issue when the response status
 * doesn't match `expectStatus` (default 200) or the request times out. Useful for
 * uptime, webhook receivers, downstream-dependency health, and synthetic checks.
 */

import type { HttpCollector } from "../config.js";
import type { CollectorContext, RawResult } from "./index.js";

export async function runHttpCollector(
  col: HttpCollector,
  _ctx: CollectorContext
): Promise<RawResult> {
  const expect = col.expectStatus ?? 200;
  const timeoutMs = col.timeoutMs ?? 10_000;

  const headers: Record<string, string> = { ...(col.headers ?? {}) };
  for (const [header, envName] of Object.entries(col.headersFromEnv ?? {})) {
    const v = process.env[envName];
    if (v) headers[header] = v;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const res = await fetch(col.url, {
      method: col.method ?? "GET",
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const ok = res.status === expect;
    return {
      fired: !ok,
      numeric: latencyMs,
      details: { url: col.url, status: res.status, expected: expect, latencyMs },
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const aborted = (err as Error).name === "AbortError";
    return {
      fired: true,
      numeric: latencyMs,
      details: {
        url: col.url,
        error: aborted ? `timeout after ${timeoutMs}ms` : (err as Error).message,
        latencyMs,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
