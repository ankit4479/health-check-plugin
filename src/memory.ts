/**
 * Memory layer — tracks every issue fingerprint across runs so the system can:
 *  - detect recurrence (how many consecutive runs an issue has persisted),
 *  - verify fixes (an issue present last run and absent now is "resolved"),
 *  - compound knowledge (record fix outcomes in the solutions log).
 *
 * This is what turns a one-shot checker into a healer board with memory.
 */

import type { HealthReport, FingerprintHistory, VerificationResult, CompoundEntry } from "./types.js";
import type { StateStore } from "./state.js";

/**
 * Fold a new report into fingerprint history. Returns the verification result
 * (which previously-seen issues resolved vs. persist) computed against the prior
 * state, then persists the updated history.
 */
export function updateFingerprintHistory(
  store: StateStore,
  report: HealthReport
): VerificationResult {
  const history = store.loadFingerprints();
  const now = report.generatedAt;
  const currentFps = new Set(report.issues.map((i) => i.fingerprint));

  // Snapshot which previously-active fingerprints existed before this run.
  const priorActive = Object.values(history).filter((h) => h.consecutiveRuns > 0);

  // Mark resolved: previously active, not present now.
  const resolved: FingerprintHistory[] = [];
  for (const h of priorActive) {
    if (!currentFps.has(h.fingerprint)) {
      resolved.push({ ...h });
      h.consecutiveRuns = 0;
    }
  }

  // Upsert current issues.
  const persisting: FingerprintHistory[] = [];
  let newCount = 0;
  for (const issue of report.issues) {
    const existing = history[issue.fingerprint];
    if (existing) {
      const wasActive = existing.consecutiveRuns > 0;
      existing.lastSeen = now;
      existing.occurrenceCount += 1;
      existing.consecutiveRuns += 1;
      existing.severityHistory.push(issue.severity);
      existing.title = issue.title;
      if (wasActive) persisting.push({ ...existing });
    } else {
      history[issue.fingerprint] = {
        fingerprint: issue.fingerprint,
        source: issue.source,
        title: issue.title,
        firstSeen: now,
        lastSeen: now,
        occurrenceCount: 1,
        consecutiveRuns: 1,
        severityHistory: [issue.severity],
        decisions: [],
      };
      newCount += 1;
    }
  }

  store.saveFingerprints(history);
  return { resolved, persisting, newIssues: newCount };
}

/** How many consecutive runs this issue has been present (1 = first sighting). */
export function recurrenceOf(store: StateStore, fingerprint: string): number {
  return store.loadFingerprints()[fingerprint]?.consecutiveRuns ?? 0;
}

/** Record a fix outcome into the compounding solutions log. */
export function compoundFix(store: StateStore, entry: CompoundEntry): void {
  store.appendSolution(entry);
  const history = store.loadFingerprints();
  const h = history[entry.fingerprint];
  if (h) {
    h.decisions.push({ date: entry.date, decision: "approved", humanNotes: entry.approach });
    store.saveFingerprints(history);
  }
}
