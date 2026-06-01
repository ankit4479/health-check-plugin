/**
 * Delivery dispatch — broadcasts to EVERY configured channel (e.g. Discord AND
 * Slack), not just one. Two broadcast surfaces:
 *   - deliver():        the scored health report (the board)
 *   - deliverOutcome(): a healing/resolution message, including the PR link
 * Console is always printed so a run is never silent, and one channel failing
 * never blocks the others.
 */

import type { HealthReport } from "../types.js";
import type { HealthCheckConfig } from "../config.js";
import { renderConsole } from "./console.js";
import { deliverDiscord, deliverDiscordText } from "./discord.js";
import { deliverSlack, deliverSlackText } from "./slack.js";

export async function deliver(report: HealthReport, config: HealthCheckConfig): Promise<void> {
  // Always echo to the terminal first.
  console.log(renderConsole(report, config));

  await Promise.allSettled(
    config.channels.map(async (channel) => {
      switch (channel.type) {
        case "discord":
          return deliverDiscord(report, config, channel);
        case "slack":
          return deliverSlack(report, config, channel);
        case "console":
          return; // already printed
      }
    })
  ).then(reportFailures);
}

/**
 * Broadcast a healing outcome (resolution + PR link) to all chat channels.
 * `markdown` is rendered as-is on Slack and as plain content on Discord.
 */
export async function deliverOutcome(config: HealthCheckConfig, markdown: string): Promise<void> {
  console.log("\n" + markdown + "\n");
  await Promise.allSettled(
    config.channels.map(async (channel) => {
      switch (channel.type) {
        case "discord":
          return deliverDiscordText(channel, markdown);
        case "slack":
          return deliverSlackText(channel, markdown);
        case "console":
          return;
      }
    })
  ).then(reportFailures);
}

function reportFailures(results: PromiseSettledResult<unknown>[]): void {
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`[delivery] channel failed: ${(r.reason as Error)?.message ?? r.reason}`);
    }
  }
}

export { renderConsole } from "./console.js";
export { buildDiscordEmbeds } from "./discord.js";
export { buildSlackBlocks } from "./slack.js";
