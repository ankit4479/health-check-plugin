/**
 * Delivery dispatch — routes a report to the configured channel. Console is the
 * fallback and is always printed so a run is never silent.
 */

import type { HealthReport } from "../types.js";
import type { HealthCheckConfig } from "../config.js";
import { renderConsole } from "./console.js";
import { deliverDiscord } from "./discord.js";

export async function deliver(report: HealthReport, config: HealthCheckConfig): Promise<void> {
  // Always echo to the terminal.
  console.log(renderConsole(report, config));

  switch (config.channel.type) {
    case "discord":
      await deliverDiscord(report, config, config.channel);
      break;
    case "console":
      // already printed
      break;
  }
}

export { renderConsole } from "./console.js";
export { buildDiscordEmbeds } from "./discord.js";
