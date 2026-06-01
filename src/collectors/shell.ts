/**
 * Shell collector — runs a command, captures stdout, and evaluates it against
 * `issueWhen`. If the trimmed stdout parses as a number it feeds numeric predicates
 * (e.g. disk %, queue depth, error count); otherwise non-empty output with
 * `issueWhen.always` fires the issue. Bridges to CLIs the engine doesn't natively
 * speak (kubectl, df, redis-cli, custom scripts).
 */

import { exec } from "node:child_process";
import type { ShellCollector } from "../config.js";
import type { CollectorContext, RawResult } from "./index.js";

function execCapture(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    exec(command, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        reject(new Error(stderr?.trim() || err.message));
        return;
      }
      resolvePromise(stdout.toString());
    });
  });
}

export async function runShellCollector(
  col: ShellCollector,
  _ctx: CollectorContext
): Promise<RawResult> {
  const timeoutMs = col.timeoutMs ?? 15_000;
  const stdout = (await execCapture(col.command, timeoutMs)).trim();

  const asNumber = Number(stdout);
  if (!Number.isNaN(asNumber) && stdout !== "") {
    return { numeric: asNumber, details: { command: col.command, stdout } };
  }

  // Non-numeric: treat each non-empty output line as a row for `rowsAtLeast`/`always`.
  const lines = stdout ? stdout.split("\n").filter((l) => l.trim() !== "") : [];
  return {
    rows: lines.map((line) => ({ line })),
    details: { command: col.command, stdout: stdout.slice(0, 2000) },
  };
}
