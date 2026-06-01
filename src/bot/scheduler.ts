/**
 * Dependency-free daily scheduler for the bot process. Given a local "HH:MM" (and
 * optional IANA tz), it fires a callback once a day at that time and re-arms itself.
 * Used so the deployed 24/7 bot can ALSO run the health check autonomously — one
 * process that schedules, notifies, and handles approvals.
 */

export interface DailySchedule {
  stop(): void;
}

function msUntilNext(at: string, tz?: string): number {
  const [h, m] = at.split(":").map(Number);
  const now = new Date();

  // Current wall-clock time in the target tz (or local if none).
  const inTz = tz ? new Date(now.toLocaleString("en-US", { timeZone: tz })) : now;
  const target = new Date(inTz);
  target.setHours(h, m, 0, 0);
  if (target.getTime() <= inTz.getTime()) target.setDate(target.getDate() + 1);

  return target.getTime() - inTz.getTime();
}

/** Run `task` every day at `at` (local or `tz`). Returns a handle to stop it. */
export function scheduleDaily(at: string, tz: string | undefined, task: () => void): DailySchedule {
  let timer: ReturnType<typeof setTimeout>;

  const arm = () => {
    const delay = msUntilNext(at, tz);
    timer = setTimeout(() => {
      try {
        task();
      } finally {
        arm(); // re-arm for the next day
      }
    }, delay);
  };

  arm();
  return { stop: () => clearTimeout(timer) };
}
