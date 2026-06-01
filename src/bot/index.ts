/**
 * Bot runtime — the 24/7 process. Starts whichever bots are configured (Discord
 * and/or Slack), and if `bot.runAt` is set, runs the health check on that daily
 * schedule and posts the report (with buttons) to every bot channel. This single
 * process is the autonomous mode: it schedules, notifies, and handles approvals.
 *
 * Deploy it on any always-on host (a small VPS, Railway, Render, Fly.io, a
 * container). The CLI/webhook mode needs no hosting; the bot does.
 */

import type { HealthCheckConfig } from "../config.js";
import { runCycle } from "../orchestrator.js";
import { startDiscordBot, type BotHandle } from "./discord-bot.js";
import { startSlackBot } from "./slack-bot.js";
import { scheduleDaily, type DailySchedule } from "./scheduler.js";

export interface BotRuntime {
  handles: BotHandle[];
  schedule?: DailySchedule;
  stop(): Promise<void>;
}

export async function startBot(config: HealthCheckConfig): Promise<BotRuntime> {
  const botCfg = config.bot;
  if (!botCfg?.enabled) {
    throw new Error("bot.enabled is false in config — nothing to start.");
  }
  if (!botCfg.discord && !botCfg.slack) {
    throw new Error("Configure bot.discord and/or bot.slack to start the bot.");
  }

  const handles: BotHandle[] = [];
  if (botCfg.discord) {
    handles.push(await startDiscordBot(config, botCfg.discord));
    console.log("[bot] Discord bot connected.");
  }
  if (botCfg.slack) {
    handles.push(await startSlackBot(config, botCfg.slack));
    console.log("[bot] Slack bot connected (Socket Mode).");
  }

  // Autonomous self-scheduling: run the check daily and post to every bot channel.
  let schedule: DailySchedule | undefined;
  if (botCfg.runAt) {
    const runAndPost = async () => {
      try {
        const { report } = await runCycle(config, { quiet: true });
        for (const h of handles) await h.postReport(report);
        console.log(`[bot] scheduled run posted: ${report.summary.healthScore}/100`);
      } catch (err) {
        console.error(`[bot] scheduled run failed: ${(err as Error).message}`);
      }
    };
    schedule = scheduleDaily(botCfg.runAt, botCfg.tz, () => void runAndPost());
    console.log(`[bot] self-scheduled daily at ${botCfg.runAt}${botCfg.tz ? ` ${botCfg.tz}` : ""}.`);
  }

  return {
    handles,
    schedule,
    stop: async () => {
      schedule?.stop();
      for (const h of handles) await h.stop();
    },
  };
}
