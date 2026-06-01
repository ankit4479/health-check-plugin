/**
 * State persistence — the engine keeps a small amount of durable state in a local
 * directory (default `.health-check/`): the latest reports, fingerprint history
 * (for recurrence detection + verification), and the solutions log (compounded
 * knowledge of past fixes). All files are plain JSON so they're inspectable and
 * portable across agents.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { HealthReport, FingerprintHistory, CompoundEntry } from "./types.js";

export class StateStore {
  readonly dir: string;
  private readonly reportsDir: string;
  private readonly fingerprintsPath: string;
  private readonly solutionsPath: string;

  constructor(stateDir = ".health-check") {
    this.dir = resolve(process.cwd(), stateDir);
    this.reportsDir = join(this.dir, "reports");
    this.fingerprintsPath = join(this.dir, "fingerprint-history.json");
    this.solutionsPath = join(this.dir, "solutions-log.json");
    mkdirSync(this.reportsDir, { recursive: true });
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  saveReport(report: HealthReport): string {
    const stamp = report.generatedAt.replace(/[:.]/g, "-");
    const path = join(this.reportsDir, `report-${stamp}.json`);
    writeFileSync(path, JSON.stringify(report, null, 2));
    return path;
  }

  latestReport(): HealthReport | null {
    if (!existsSync(this.reportsDir)) return null;
    const files = readdirSync(this.reportsDir)
      .filter((f) => f.startsWith("report-") && f.endsWith(".json"))
      .sort();
    if (files.length === 0) return null;
    return JSON.parse(readFileSync(join(this.reportsDir, files[files.length - 1]), "utf8"));
  }

  // ── Fingerprint history ──────────────────────────────────────────────────────

  loadFingerprints(): Record<string, FingerprintHistory> {
    if (!existsSync(this.fingerprintsPath)) return {};
    try {
      return JSON.parse(readFileSync(this.fingerprintsPath, "utf8"));
    } catch {
      return {};
    }
  }

  saveFingerprints(history: Record<string, FingerprintHistory>): void {
    writeFileSync(this.fingerprintsPath, JSON.stringify(history, null, 2));
  }

  // ── Solutions log (compounded knowledge) ─────────────────────────────────────

  loadSolutions(): CompoundEntry[] {
    if (!existsSync(this.solutionsPath)) return [];
    try {
      return JSON.parse(readFileSync(this.solutionsPath, "utf8"));
    } catch {
      return [];
    }
  }

  appendSolution(entry: CompoundEntry): void {
    const solutions = this.loadSolutions();
    solutions.push(entry);
    writeFileSync(this.solutionsPath, JSON.stringify(solutions, null, 2));
  }
}
