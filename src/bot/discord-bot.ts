/**
 * Discord bot — the interactive, 24/7 counterpart to the one-way webhook. It posts
 * reports with buttons and runs the approve → file → fix loop from clicks inside the
 * channel. `discord.js` is an optional dependency, imported dynamically so the core
 * CLI works without it.
 *
 * Requires a Discord application + bot token (NOT a webhook URL), the bot invited to
 * your server with "Send Messages" + "Read Message History", and the channel id.
 */

import type { HealthCheckConfig, DiscordBotConfig } from "../config.js";
import type { HealthReport } from "../types.js";
import { requireEnv } from "../config.js";
import { buildDiscordEmbeds } from "../delivery/discord.js";
import { handleAction, reportButtons, type ButtonSpec } from "./actions.js";

export interface BotHandle {
  postReport(report: HealthReport): Promise<void>;
  stop(): Promise<void>;
}

// Loosely-typed discord.js handles (the dep is optional, so we don't import types).
/* eslint-disable @typescript-eslint/no-explicit-any */
export async function startDiscordBot(
  config: HealthCheckConfig,
  botCfg: DiscordBotConfig
): Promise<BotHandle> {
  let djs: any;
  try {
    const mod = "discord.js"; // variable specifier: optional dep, resolved at runtime
    djs = await import(mod);
  } catch {
    throw new Error("The 'discord.js' package is required for the Discord bot. Run `npm install discord.js`.");
  }
  const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events } = djs;
  const token = requireEnv(botCfg.botTokenEnv, "the Discord bot");

  const styleMap: Record<ButtonSpec["style"], number> = {
    primary: ButtonStyle.Primary,
    secondary: ButtonStyle.Secondary,
    success: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
  };

  const rows = (buttons?: ButtonSpec[]) => {
    if (!buttons?.length) return [];
    const row = new ActionRowBuilder();
    for (const b of buttons.slice(0, 5)) {
      row.addComponents(new ButtonBuilder().setCustomId(b.customId).setLabel(b.label).setStyle(styleMap[b.style]));
    }
    return [row];
  };

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on(Events.InteractionCreate, async (interaction: any) => {
    if (!interaction.isButton()) return;
    await interaction.deferReply();
    try {
      const result = await handleAction(interaction.customId, config, interaction.user?.username ?? "user");
      await interaction.editReply({ content: result.message.slice(0, 2000), components: rows(result.buttons) });
    } catch (err) {
      await interaction.editReply({ content: `⚠️ Action failed: ${(err as Error).message}`.slice(0, 2000) });
    }
  });

  await new Promise<void>((resolveReady, reject) => {
    client.once(Events.ClientReady, () => resolveReady());
    client.login(token).catch(reject);
  });

  const postReport = async (report: HealthReport): Promise<void> => {
    const channel = await client.channels.fetch(botCfg.channelId);
    if (!channel?.isTextBased()) throw new Error(`Discord channel ${botCfg.channelId} is not text-based.`);
    const actionable = report.issues.filter((i) => i.severity === "critical" || i.severity === "high").length;
    await channel.send({
      embeds: buildDiscordEmbeds(report, config),
      components: rows(reportButtons(actionable > 0)),
    });
  };

  return {
    postReport,
    stop: async () => {
      await client.destroy();
    },
  };
}
