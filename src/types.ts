/**
 * Core type system for the universal health-check + healer-board engine.
 *
 * Design: ~65% of this is generic (issues, scoring, fingerprinting, conversation,
 * healing, memory, channel adapters) and stays identical for any system. The
 * domain-specific 35% (which collectors exist, what they fetch, how raw data maps
 * to issues) is expressed entirely through CONFIG and pluggable collectors — not
 * hardcoded here. That is why `source` is a free-form string keyed by collector id,
 * not a fixed enum.
 */

export type IssueSeverity = "critical" | "high" | "medium" | "low";

/** Numeric weight each severity subtracts from the 100-point health score. */
export type SeverityWeights = Record<IssueSeverity, number>;

/**
 * A single health problem surfaced by a collector. `source` is the collector id
 * that produced it (e.g. "postgres:stuck_rows", "http:uptime", "shell:disk").
 */
export interface HealthIssue {
  /** Stable within a run; `fingerprint` is what dedups across runs. */
  id: string;
  /** Collector id that produced this issue. */
  source: string;
  severity: IssueSeverity;
  title: string;
  description: string;
  /** Deterministic hash used to dedup the same issue across runs and against GitHub. */
  fingerprint: string;
  /** Arbitrary structured evidence the collector attached. */
  details: Record<string, unknown>;
  rootCause?: string;
  suggestedFix?: string;
  /** Pointer into the user's codebase/runbook, if known. */
  codeReference?: string;
}

/** Lower-signal observations that are recorded but never raised as issues. */
export type NoteCategory = "backlog" | "info";

export interface HealthNote {
  id: string;
  category: NoteCategory;
  title: string;
  description: string;
  details: Record<string, unknown>;
}

/** Per-collector execution result (success/failure + timing), for reliability tracking. */
export interface CollectorStatus {
  success: boolean;
  durationMs: number;
  error?: string;
}

/**
 * The full output of one health-check run. This is what gets persisted,
 * delivered to the channel, and fed into issue creation + healing.
 */
export interface HealthReport {
  generatedAt: string;
  /** Lookback window the collectors were asked to consider. */
  periodHours: number;
  /** Optional free-form scope label (tenant, environment, service). */
  scope?: string;
  summary: {
    totalIssues: number;
    bySeverity: Record<IssueSeverity, number>;
    /** 0-100, computed by the scoring engine. */
    healthScore: number;
  };
  issues: HealthIssue[];
  notes: HealthNote[];
  /** Keyed by collector id. */
  collectorStatus: Record<string, CollectorStatus>;
}

// ── GitHub Integration ───────────────────────────────────────────────────────

export interface GitHubIssueInfo {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
  createdAt: string;
  severity: IssueSeverity;
  source: string;
}

// ── Conversation / Approval (the "board") ────────────────────────────────────

export type SessionStatus = "active" | "approved" | "timed_out" | "deferred" | "closed";
export type ApprovalAction = "fix_all" | "fix_critical_high" | "fix_selected" | "discuss" | "skip";

export interface ConversationSession {
  id: string;
  reportId: string;
  channelId: string;
  threadId: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityAt: string;
  /** Indices (into report.issues) the human approved for action. */
  approvedItems: number[];
  timeoutRemindedAt?: string;
}

export interface ApprovalItem {
  index: number;
  issue: HealthIssue;
  approved: boolean;
  humanNotes?: string;
}

export interface ApprovalManifest {
  sessionId: string;
  action: ApprovalAction;
  items: ApprovalItem[];
  confirmedAt?: string;
}

// ── Healing ──────────────────────────────────────────────────────────────────

/** How a fix is carried out. Extensible via config; these are the built-ins. */
export type FixType = "sql" | "shell" | "http" | "github_issue" | "retrigger" | "manual";
export type FixOutcome = "pending" | "success" | "failure" | "skipped";

export interface FixAttempt {
  date: string;
  fixType: FixType;
  approach: string;
  outcome: FixOutcome;
  prNumber?: number;
  prUrl?: string;
  failureReason?: string;
  verifiedOn?: string;
}

export interface HealingPlanItem {
  index: number;
  issue: HealthIssue;
  fixType: FixType;
  confidence: "high" | "medium" | "low";
  rationale: string;
  estimatedRisk: "low" | "medium" | "high";
  /** Human-readable safety conditions that must hold before executing. */
  safetyGates: string[];
  previousAttempts: FixAttempt[];
}

export interface HealingPlan {
  id: string;
  reportId: string;
  generatedAt: string;
  items: HealingPlanItem[];
  /** Order in which to execute item indices (lowest risk first). */
  executionOrder: number[];
  safetyNotes: string[];
}

// ── Memory / Compounding ─────────────────────────────────────────────────────

export interface FingerprintDecision {
  date: string;
  decision: "approved" | "deferred" | "skipped" | "auto_resolved";
  humanNotes?: string;
}

/** Cross-run history for one fingerprint — drives recurrence detection. */
export interface FingerprintHistory {
  fingerprint: string;
  source: string;
  title: string;
  firstSeen: string;
  lastSeen: string;
  occurrenceCount: number;
  consecutiveRuns: number;
  severityHistory: IssueSeverity[];
  decisions: FingerprintDecision[];
}

/** A documented fix outcome — the compounding knowledge base. */
export interface CompoundEntry {
  date: string;
  fingerprint: string;
  source: string;
  title: string;
  severity: IssueSeverity;
  rootCause: string;
  fixType: FixType;
  approach: string;
  outcome: FixOutcome;
  verified: boolean;
  preventionGuidance?: string;
  tags?: string[];
}

export interface VerificationResult {
  resolved: FingerprintHistory[];
  persisting: FingerprintHistory[];
  newIssues: number;
}

// ── Channel Adapter (chat delivery + interaction) ────────────────────────────

export interface ButtonAction {
  customId: string;
  label: string;
  style: "primary" | "secondary" | "success" | "danger";
}

export interface IncomingMessage {
  id: string;
  channelId: string;
  threadId?: string;
  authorId: string;
  authorName: string;
  content: string;
  isBot: boolean;
  timestamp: string;
}

/**
 * Pluggable chat backend (Discord, Slack, console, …). The engine never talks to
 * a chat platform directly — it goes through this interface so the same report
 * flow works on any channel, or none.
 */
export interface ChannelAdapter {
  name: string;
  sendMessage(channelId: string, content: string): Promise<string>;
  sendEmbeds?(channelId: string, embeds: unknown[]): Promise<string>;
  sendMessageWithButtons?(channelId: string, content: string, buttons: ButtonAction[]): Promise<string>;
  startThread?(messageId: string, name: string): Promise<string>;
  onMessage?(handler: (msg: IncomingMessage) => void): void;
  onButtonClick?(handler: (customId: string, userId: string, messageId: string) => void): void;
}
