/**
 * Bot action handlers — the bridge between an in-channel button click and the
 * engine. Each button carries a `customId` like `run_now`, `file_all`,
 * `heal_issue:42`. These handlers are platform-agnostic: the Discord and Slack
 * bots both parse the click and call into here, so the approve → file → fix loop
 * behaves identically on either platform.
 *
 * Code fixes are deliberately NOT auto-run here — the button reports that issue #N
 * needs the agent, because writing code requires the LLM, not a button.
 */

import type { HealthCheckConfig } from "../config.js";
import { runCycle } from "../orchestrator.js";
import { syncIssuesToGitHub } from "../github.js";
import { healOpenIssues, matchOpenIssues } from "../healing/issue-heal.js";
import { StateStore } from "../state.js";

export interface ButtonSpec {
  customId: string;
  label: string;
  style: "primary" | "secondary" | "success" | "danger";
}

export interface ActionResult {
  /** Message to post back into the channel after the action runs. */
  message: string;
  /** Follow-up buttons to offer next (e.g. after a report, offer "File issues"). */
  buttons?: ButtonSpec[];
}

/** Buttons offered under a freshly posted report. */
export function reportButtons(hasActionable: boolean): ButtonSpec[] {
  const buttons: ButtonSpec[] = [{ customId: "run_now", label: "🔄 Re-run", style: "secondary" }];
  if (hasActionable) {
    buttons.unshift({ customId: "file_all", label: "🐙 File GitHub issues", style: "primary" });
  }
  return buttons;
}

/** Handle a button click. `userName` is logged for the audit trail. */
export async function handleAction(
  customId: string,
  config: HealthCheckConfig,
  userName: string
): Promise<ActionResult> {
  const store = new StateStore(config.stateDir);

  // run_now → take a fresh reading
  if (customId === "run_now") {
    const { report } = await runCycle(config, { quiet: true });
    const actionable = report.issues.filter((i) => i.severity === "critical" || i.severity === "high").length;
    return {
      message: `🔄 Re-ran (by ${userName}): ${report.summary.healthScore}/100, ${report.summary.totalIssues} issue(s).`,
      buttons: reportButtons(actionable > 0),
    };
  }

  // file_all → create GitHub issues for the latest report (approval #1)
  if (customId === "file_all") {
    if (!config.github.enabled) return { message: "GitHub is not enabled in config." };
    const report = store.latestReport();
    if (!report) return { message: "No report yet — re-run first." };
    const result = await syncIssuesToGitHub(report.issues, config.github);
    const lines = [
      `🐙 Filed by ${userName}: created ${result.created.length}, updated ${result.updated.length}, ` +
        `reopened ${result.reopened.length}, skipped ${result.skipped}.`,
    ];
    for (const c of result.created) lines.push(`  • #${c.number} ${c.title} ${c.url}`);
    // Offer per-issue fix buttons for the ones with an ops fix.
    const matched = await matchOpenIssues(config);
    const fixable = matched.filter((m) => m.path === "ops").slice(0, 4);
    const buttons: ButtonSpec[] = fixable.map((m) => ({
      customId: `heal_issue:${m.issue.number}`,
      label: `🩺 Fix #${m.issue.number}`,
      style: "success",
    }));
    return { message: lines.join("\n"), buttons: buttons.length ? buttons : undefined };
  }

  // heal_issue:<n> → approval #2: remediate that issue
  if (customId.startsWith("heal_issue:")) {
    const number = Number(customId.split(":")[1]);
    const matched = await matchOpenIssues(config);
    const target = matched.find((m) => m.issue.number === number);
    if (!target) return { message: `Issue #${number} not found among open health issues.` };

    if (target.path === "code") {
      return {
        message:
          `🤖 Issue #${number} needs a *code* fix — that requires the healing-agent to write the change ` +
          `and open a PR. Run \`/health-heal-issue\` in your agent, or trigger the agent on this issue.`,
      };
    }
    if (target.path === "manual") {
      return { message: `Issue #${number} has no auto-fix — it needs manual action.` };
    }

    // ops path — execute (the engine posts its own ✅ Resolved + PR/issue links to channels)
    const results = await healOpenIssues(config, { approvedNumbers: [number], onlyNumbers: [number], store });
    const r = results[0];
    return { message: r ? `Heal #${number} (${userName}): ${r.outcome} — ${r.detail}` : `No result for #${number}.` };
  }

  return { message: `Unknown action: ${customId}` };
}
