/**
 * Slack delivery — posts the report and healing outcomes to a Slack incoming
 * webhook using Block Kit. Mirrors the Discord adapter so a project can run both at
 * once; the engine broadcasts every report and every resolution (with PR links) to
 * all configured channels.
 */

import type { HealthReport, HealthIssue } from "../types.js";
import type { HealthCheckConfig, SlackChannel } from "../config.js";
import { requireEnv } from "../config.js";
import { classifyBand, bandEmoji } from "../scoring.js";

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: Array<{ type: string; text: string }>;
}

export function buildSlackBlocks(report: HealthReport, config: HealthCheckConfig): SlackBlock[] {
  const band = classifyBand(report.summary.healthScore, config.scoreBands);
  const s = report.summary;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${bandEmoji(band)} ${config.project} — Health ${s.healthScore}/100` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Band:*\n${band}` },
        { type: "mrkdwn", text: `*Issues:*\n${s.totalIssues}` },
        { type: "mrkdwn", text: `*Critical / High:*\n${s.bySeverity.critical} / ${s.bySeverity.high}` },
        { type: "mrkdwn", text: `*Window:*\n${report.periodHours}h` },
      ],
    },
  ];

  const actionable = report.issues.filter((i) => i.severity === "critical" || i.severity === "high");
  if (actionable.length) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "*🛠 Action required*\n" + actionable.slice(0, 10).map(slackIssueLine).join("\n").slice(0, 2900) },
    });
  }

  return blocks;
}

function slackIssueLine(issue: HealthIssue): string {
  const tag = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" }[issue.severity];
  let line = `${tag} *[${issue.source}]* ${issue.title}`;
  if (issue.suggestedFix) line += ` — _${issue.suggestedFix}_`;
  return line;
}

async function postToSlack(webhook: string, payload: unknown): Promise<void> {
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Slack webhook returned ${res.status}: ${await res.text()}`);
  }
}

export async function deliverSlack(
  report: HealthReport,
  config: HealthCheckConfig,
  channel: SlackChannel
): Promise<void> {
  const webhook = requireEnv(channel.webhookEnv, "the slack channel");
  await postToSlack(webhook, { blocks: buildSlackBlocks(report, config) });
}

/** Post a healing/resolution message (incl. PR link) to Slack. */
export async function deliverSlackText(channel: SlackChannel, markdown: string): Promise<void> {
  const webhook = requireEnv(channel.webhookEnv, "the slack channel");
  await postToSlack(webhook, {
    blocks: [{ type: "section", text: { type: "mrkdwn", text: markdown } }],
  });
}
