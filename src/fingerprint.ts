/**
 * Fingerprint dedup — a deterministic hash that identifies "the same issue" across
 * runs and against existing GitHub issues, so the system never re-raises a problem
 * it already raised. The fingerprint is embedded in GitHub issue bodies as
 * `fingerprint:<hash>` and searched on the next run.
 */

import { createHash } from "node:crypto";

/**
 * Build a stable fingerprint from a collector id plus the fields that define the
 * issue's identity (NOT volatile values like counts or timestamps). Two issues
 * with the same source + same key fields produce the same fingerprint.
 */
export function buildFingerprint(source: string, keyParts: Array<string | number | null | undefined>): string {
  const normalized = keyParts
    .map((p) => (p === null || p === undefined ? "" : String(p).trim().toLowerCase()))
    .join("|");
  return createHash("sha256").update(`${source}::${normalized}`).digest("hex").slice(0, 16);
}

/** The marker embedded in a GitHub issue body so future runs can find it. */
export function fingerprintMarker(fingerprint: string): string {
  return `<!-- fingerprint:${fingerprint} -->`;
}

/** Extract a fingerprint from a GitHub issue body (or null if absent). */
export function parseFingerprint(body: string): string | null {
  const m = body.match(/fingerprint:([a-f0-9]{16})/);
  return m ? m[1] : null;
}
