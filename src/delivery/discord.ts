/**
 * Discord delivery — posts the report as rich embeds to a webhook URL. This is the
 * "board": a human sees the scored summary + the critical/high issues in a channel,
 * discusses, and then approves issue creation / healing. Embeds are chunked to stay
 * under Discord's 10-embed / 6000-char limits.
 */

import type { HealthReport, HealthIssue } from "../types.js";
import type { HealthCheckConfig, DiscordChannel } from "../config.js";
import { requireEnv } from "../config.js";
import { classifyBand, bandColor, bandEmoji } from "../scoring.js";

interface Embed {
  title?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
}

export function buildDiscordEmbeds(report: HealthReport, config: HealthCheckConfig): Embed[] {
  const band = classifyBand(report.summary.healthScore, config.scoreBands);
  const s = report.summary;

  const summary: Embed = {
    title: `${bandEmoji(band)} ${config.project} — Health ${s.healthScore}/100`,
    description:
      `**${band.toUpperCase()}** · ${s.totalIssues} issue(s)` +
      (report.scope ? ` · scope: \`${report.scope}\`` : ""),
    color: bandColor(band),
    fields: [
      { name: "Critical", value: String(s.bySeverity.critical), inline: true },
      { name: "High", value: String(s.bySeverity.high), inline: true },
      { name: "Medium", value: String(s.bySeverity.medium), inline: true },
      { name: "Low", value: String(s.bySeverity.low), inline: true },
      { name: "Window", value: `${report.periodHours}h`, inline: true },
    ],
    footer: { text: `generated ${report.generatedAt}` },
  };

  const embeds: Embed[] = [summary];

  const actionable = report.issues.filter((i) => i.severity === "critical" || i.severity === "high");
  if (actionable.length) {
    embeds.push({
      title: "🛠 Action required",
      color: bandColor("critical"),
      description: actionable.slice(0, 10).map(issueLine).join("\n\n").slice(0, 4000),
    });
  }

  const failed = Object.entries(report.collectorStatus).filter(([, st]) => !st.success);
  if (failed.length) {
    embeds.push({
      title: "⚠ Collector failures",
      color: bandColor("warning"),
      description: failed.map(([id, st]) => `\`${id}\`: ${st.error ?? "failed"}`).join("\n").slice(0, 4000),
    });
  }

  return embeds.slice(0, 10);
}

function issueLine(issue: HealthIssue): string {
  const tag = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" }[issue.severity];
  let line = `${tag} **[${issue.source}]** ${issue.title}`;
  if (issue.suggestedFix) line += `\n   _fix:_ ${issue.suggestedFix}`;
  return line;
}

/** POST the report embeds to the configured Discord webhook. */
export async function deliverDiscord(
  report: HealthReport,
  config: HealthCheckConfig,
  channel: DiscordChannel
): Promise<void> {
  const webhook = requireEnv(channel.webhookEnv, "the discord channel");
  const embeds = buildDiscordEmbeds(report, config);

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds }),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook returned ${res.status}: ${await res.text()}`);
  }
}
