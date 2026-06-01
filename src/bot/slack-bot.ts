/**
 * Slack bot — the interactive Slack counterpart, using Bolt in Socket Mode so it
 * needs no public URL (ideal for a 24/7 worker). Posts reports with Block Kit
 * buttons and runs the same approve → file → fix loop from clicks. `@slack/bolt` is
 * an optional dependency, imported dynamically.
 *
 * Requires a Slack app with a bot token (xoxb-…), an app-level token (xapp-…) with
 * `connections:write`, Socket Mode enabled, the `chat:write` scope, and the channel id.
 */

import type { HealthCheckConfig, SlackBotConfig } from "../config.js";
import type { HealthReport } from "../types.js";
import { requireEnv } from "../config.js";
import { buildSlackBlocks } from "../delivery/slack.js";
import { handleAction, reportButtons, type ButtonSpec } from "./actions.js";
import type { BotHandle } from "./discord-bot.js";

// All health buttons get an "hc_" action_id prefix so one handler matches them all.
// The real customId (which may contain ":") is carried in the button's `value`.
function actionBlock(buttons?: ButtonSpec[]): unknown[] {
  if (!buttons?.length) return [];
  return [
    {
      type: "actions",
      elements: buttons.slice(0, 5).map((b) => ({
        type: "button",
        action_id: "hc_" + b.customId.replace(/:/g, "__"),
        text: { type: "plain_text", text: b.label },
        style: b.style === "primary" || b.style === "success" ? "primary" : undefined,
        value: b.customId,
      })),
    },
  ];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function startSlackBot(
  config: HealthCheckConfig,
  botCfg: SlackBotConfig
): Promise<BotHandle> {
  let bolt: any;
  try {
    const mod = "@slack/bolt"; // variable specifier: optional dep, resolved at runtime
    bolt = await import(mod);
  } catch {
    throw new Error("The '@slack/bolt' package is required for the Slack bot. Run `npm install @slack/bolt`.");
  }
  const token = requireEnv(botCfg.botTokenEnv, "the Slack bot");
  const appToken = requireEnv(botCfg.appTokenEnv, "the Slack bot (Socket Mode)");

  const app = new bolt.App({ token, appToken, socketMode: true });

  // One handler for every health button.
  app.action(/^hc_/, async ({ ack, body, action, say }: any) => {
    await ack();
    const customId: string = action?.value ?? "";
    const userName = body?.user?.username ?? body?.user?.name ?? "user";
    try {
      const result = await handleAction(customId, config, userName);
      await say({
        text: result.message,
        blocks: [{ type: "section", text: { type: "mrkdwn", text: result.message } }, ...actionBlock(result.buttons)],
      });
    } catch (err) {
      await say(`⚠️ Action failed: ${(err as Error).message}`);
    }
  });

  await app.start();

  const postReport = async (report: HealthReport): Promise<void> => {
    const actionable = report.issues.filter((i) => i.severity === "critical" || i.severity === "high").length;
    await app.client.chat.postMessage({
      channel: botCfg.channelId,
      text: `${config.project} health ${report.summary.healthScore}/100`,
      blocks: [...buildSlackBlocks(report, config), ...actionBlock(reportButtons(actionable > 0))],
    });
  };

  return {
    postReport,
    stop: async () => {
      await app.stop();
    },
  };
}
