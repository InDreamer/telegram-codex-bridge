import type {
  ActiveItemType,
  HighValueEventType,
  ActivityRecord,
  ActivityStatus,
  ClassifiedNotification,
  InspectSnapshot,
  ThreadBlockedReason,
  TurnStatus
} from "./types.js";

const DEFAULT_TIMELINE_LIMIT = 100;
const SUMMARY_LIMIT = 5;

interface ActivityTrackerOptions {
  threadId: string;
  turnId: string;
  debugAvailable?: boolean;
  timelineLimit?: number;
}

interface ActivityTrackerState {
  turnStatus: TurnStatus;
  activeItemType: ActiveItemType | null;
  activeItemId: string | null;
  activeItemLabel: string | null;
  lastActivityAt: string | null;
  currentItemStartedAt: string | null;
  lastHighValueEventType: HighValueEventType | null;
  lastHighValueTitle: string | null;
  lastHighValueDetail: string | null;
  latestProgress: string | null;
  threadBlockedReason: ThreadBlockedReason;
  finalMessageAvailable: boolean;
  inspectAvailable: boolean;
  debugAvailable: boolean;
  errorState: ActivityStatus["errorState"];
}

export class ActivityTracker {
  private readonly timelineLimit: number;
  private readonly recentTransitions: ActivityRecord[] = [];
  private readonly recentCommandSummaries: string[] = [];
  private readonly recentFileChangeSummaries: string[] = [];
  private readonly recentMcpSummaries: string[] = [];
  private readonly recentWebSearches: string[] = [];
  private readonly planSnapshot: string[] = [];
  private readonly commentarySnippets: string[] = [];
  private readonly notes: string[] = [];
  private readonly state: ActivityTrackerState;

  constructor(
    private readonly options: ActivityTrackerOptions
  ) {
    this.timelineLimit = options.timelineLimit ?? DEFAULT_TIMELINE_LIMIT;
    this.state = {
      turnStatus: "starting",
      activeItemType: null,
      activeItemId: null,
      activeItemLabel: null,
      lastActivityAt: null,
      currentItemStartedAt: null,
      lastHighValueEventType: null,
      lastHighValueTitle: null,
      lastHighValueDetail: null,
      latestProgress: null,
      threadBlockedReason: null,
      finalMessageAvailable: false,
      inspectAvailable: false,
      debugAvailable: options.debugAvailable ?? true,
      errorState: null
    };
  }

  apply(notification: ClassifiedNotification, receivedAt = new Date().toISOString()): void {
    if (!this.isRelevant(notification)) {
      return;
    }

    switch (notification.kind) {
      case "turn_started":
        this.state.turnStatus = "running";
        this.state.errorState = null;
        this.state.lastActivityAt = receivedAt;
        this.pushTransition(receivedAt, "turn", "turn started");
        return;

      case "turn_completed":
        this.state.turnStatus = mapCompletionStatus(notification.status);
        this.state.activeItemType = null;
        this.state.activeItemId = null;
        this.state.activeItemLabel = null;
        this.state.currentItemStartedAt = null;
        this.state.latestProgress = null;
        this.state.threadBlockedReason = null;
        this.state.lastActivityAt = receivedAt;
        if (this.state.turnStatus === "failed" && this.state.errorState === null) {
          this.state.errorState = "turn_failed";
        }
        if (this.state.turnStatus === "completed" && this.state.lastHighValueEventType !== "done") {
          this.setHighValueEvent("done", "Done: completed", "completed");
        }
        this.pushTransition(receivedAt, "turn", `turn completed (${notification.status})`);
        return;

      case "thread_status_changed": {
        const blockedReason = deriveBlockedReason(notification.activeFlags);
        this.state.threadBlockedReason = blockedReason;
        this.state.lastActivityAt = receivedAt;

        if (blockedReason || notification.status === "blocked") {
          this.state.turnStatus = "blocked";
          this.setHighValueEvent("blocked", `Blocked: ${blockedReason ?? "thread blocked"}`);
        } else if (!isTerminalStatus(this.state.turnStatus)) {
          this.state.turnStatus = "running";
        }

        this.pushTransition(
          receivedAt,
          "thread",
          blockedReason ? `thread blocked (${blockedReason})` : `thread status ${notification.status ?? "running"}`
        );
        return;
      }

      case "item_started": {
        const activeItemType = mapActiveItemType(notification.itemType);
        this.state.activeItemType = activeItemType;
        this.state.activeItemId = notification.itemId;
        this.state.activeItemLabel = notification.label ?? buildItemLabel(activeItemType, notification.itemType);
        this.state.currentItemStartedAt = receivedAt;
        this.state.latestProgress = null;
        this.state.inspectAvailable = true;
        this.state.lastActivityAt = receivedAt;

        if (!this.state.threadBlockedReason && !isTerminalStatus(this.state.turnStatus)) {
          this.state.turnStatus = "running";
        }

        const summary = `${this.state.activeItemLabel ?? "other"} started`;
        this.pushTransition(receivedAt, "item", summary);
        if (activeItemType === "commandExecution") {
          const commandLabel = cleanSummary(this.state.activeItemLabel ?? "command");
          this.setHighValueEvent("ran_cmd", `Ran cmd: ${commandLabel}`);
        }
        return;
      }

      case "item_completed": {
        const completedItemType = mapActiveItemType(notification.itemType);
        if (!notification.itemId || notification.itemId === this.state.activeItemId) {
          this.state.activeItemType = null;
          this.state.activeItemId = null;
          this.state.activeItemLabel = null;
          this.state.currentItemStartedAt = null;
          this.state.latestProgress = null;
        }

        this.state.inspectAvailable = true;
        this.state.lastActivityAt = receivedAt;
        if (!this.state.threadBlockedReason && !isTerminalStatus(this.state.turnStatus)) {
          this.state.turnStatus = "running";
        }

        const summary = `${buildItemLabel(completedItemType, notification.itemType)} completed`;
        this.pushTransition(receivedAt, "item", summary);
        if (completedItemType === "webSearch") {
          this.pushUniqueSummary(this.recentWebSearches, summary);
        }
        return;
      }

      case "progress":
        if (notification.message) {
          this.state.latestProgress = notification.message;
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          if (!this.state.threadBlockedReason && !isTerminalStatus(this.state.turnStatus)) {
            this.state.turnStatus = "running";
          }

          this.pushTransition(receivedAt, "progress", notification.message);
          if (this.state.activeItemType === "mcpToolCall") {
            const summary = cleanSummary(notification.message);
            this.pushUniqueSummary(this.recentMcpSummaries, summary);
            this.setHighValueEvent("found", `Found: ${summary}`);
          } else if (this.state.activeItemType === "webSearch") {
            const summary = cleanSummary(notification.message);
            this.pushUniqueSummary(this.recentWebSearches, summary);
            this.setHighValueEvent("found", `Found: ${summary}`);
          }
        }
        return;

      case "final_message_available":
        this.state.finalMessageAvailable = true;
        this.state.lastActivityAt = receivedAt;
        if (notification.message) {
          const summary = cleanSummary(notification.message);
          this.setHighValueEvent("done", `Done: ${summary}`, summary);
        }
        return;

      case "plan_updated":
        this.state.inspectAvailable = this.state.inspectAvailable || notification.entries.length > 0;
        this.state.lastActivityAt = receivedAt;
        for (const entry of notification.entries) {
          this.pushUniqueSummary(this.planSnapshot, cleanSummary(entry));
        }
        return;

      case "plan_delta":
        if (notification.message) {
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushUniqueSummary(this.planSnapshot, cleanSummary(notification.message));
        }
        return;

      case "command_output":
        if (notification.text) {
          const summary = summarizeCommandOutput(notification.text);
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushTransition(receivedAt, "progress", summary.detail ? `${summary.command} -> ${summary.detail}` : summary.command);
          this.pushUniqueSummary(
            this.recentCommandSummaries,
            summary.detail ? `${summary.command} -> ${summary.detail}` : summary.command
          );
          this.setHighValueEvent("ran_cmd", `Ran cmd: ${summary.command}`, summary.detail);
        }
        return;

      case "file_change_output":
        if (notification.text) {
          const summary = cleanSummary(notification.text);
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushTransition(receivedAt, "progress", summary);
          this.pushUniqueSummary(this.recentFileChangeSummaries, summary);
          this.setHighValueEvent("changed", `Changed: ${summary}`, summary);
        }
        return;

      case "agent_message_delta":
        if (notification.text) {
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushUniqueSummary(this.commentarySnippets, cleanSummary(notification.text));
        }
        return;

      case "turn_aborted":
        this.state.turnStatus = "interrupted";
        this.state.activeItemType = null;
        this.state.activeItemId = null;
        this.state.activeItemLabel = null;
        this.state.currentItemStartedAt = null;
        this.state.latestProgress = null;
        this.state.threadBlockedReason = null;
        this.state.lastActivityAt = receivedAt;
        this.setHighValueEvent("blocked", "Blocked: interrupted");
        this.pushTransition(receivedAt, "turn", "turn interrupted");
        return;

      case "error":
        this.state.turnStatus = "failed";
        this.state.activeItemType = null;
        this.state.activeItemId = null;
        this.state.activeItemLabel = null;
        this.state.currentItemStartedAt = null;
        this.state.latestProgress = null;
        this.state.threadBlockedReason = null;
        this.state.lastActivityAt = receivedAt;
        this.state.errorState = "unknown";
        this.setHighValueEvent("blocked", `Blocked: ${cleanSummary(notification.message ?? "unknown error")}`);
        this.pushTransition(receivedAt, "error", notification.message ?? "error");
        return;

      case "other":
        return;
    }
  }

  getStatus(now = new Date().toISOString()): ActivityStatus {
    return {
      turnStatus: this.state.turnStatus,
      activeItemType: this.state.activeItemType,
      activeItemId: this.state.activeItemId,
      activeItemLabel: this.state.activeItemLabel,
      lastActivityAt: this.state.lastActivityAt,
      currentItemStartedAt: this.state.currentItemStartedAt,
      currentItemDurationSec: this.getCurrentItemDurationSec(now),
      lastHighValueEventType: this.state.lastHighValueEventType,
      lastHighValueTitle: this.state.lastHighValueTitle,
      lastHighValueDetail: this.state.lastHighValueDetail,
      latestProgress: this.state.latestProgress,
      threadBlockedReason: this.state.threadBlockedReason,
      finalMessageAvailable: this.state.finalMessageAvailable,
      inspectAvailable: this.state.inspectAvailable,
      debugAvailable: this.state.debugAvailable,
      errorState: this.state.errorState
    };
  }

  getInspectSnapshot(now = new Date().toISOString()): InspectSnapshot {
    return {
      ...this.getStatus(now),
      recentTransitions: [...this.recentTransitions],
      recentCommandSummaries: [...this.recentCommandSummaries],
      recentFileChangeSummaries: [...this.recentFileChangeSummaries],
      recentMcpSummaries: [...this.recentMcpSummaries],
      recentWebSearches: [...this.recentWebSearches],
      planSnapshot: [...this.planSnapshot],
      commentarySnippets: [...this.commentarySnippets],
      notes: [...this.notes]
    };
  }

  private isRelevant(notification: ClassifiedNotification): boolean {
    if (notification.threadId && notification.threadId !== this.options.threadId) {
      return false;
    }

    if (notification.turnId && notification.turnId !== this.options.turnId) {
      return false;
    }

    return true;
  }

  private getCurrentItemDurationSec(now: string): number | null {
    if (!this.state.currentItemStartedAt) {
      return null;
    }

    const durationMs = Date.parse(now) - Date.parse(this.state.currentItemStartedAt);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return 0;
    }

    return Math.floor(durationMs / 1000);
  }

  private pushTransition(at: string, kind: ActivityRecord["kind"], summary: string): void {
    this.recentTransitions.push({
      at,
      kind,
      turnStatus: this.state.turnStatus,
      activeItemType: this.state.activeItemType,
      summary
    });

    if (this.recentTransitions.length > this.timelineLimit) {
      this.recentTransitions.splice(0, this.recentTransitions.length - this.timelineLimit);
    }
  }

  private pushTypedSummary(itemType: ActiveItemType | null, summary: string): void {
    switch (itemType) {
      case "commandExecution":
        this.pushUniqueSummary(this.recentCommandSummaries, summary);
        return;
      case "fileChange":
        this.pushUniqueSummary(this.recentFileChangeSummaries, summary);
        return;
      case "mcpToolCall":
        this.pushUniqueSummary(this.recentMcpSummaries, summary);
        return;
      case "webSearch":
        this.pushUniqueSummary(this.recentWebSearches, summary);
        return;
      default:
        return;
    }
  }

  private pushUniqueSummary(target: string[], summary: string): void {
    if (target.at(-1) === summary) {
      return;
    }

    target.push(summary);
    if (target.length > SUMMARY_LIMIT) {
      target.splice(0, target.length - SUMMARY_LIMIT);
    }
  }

  private setHighValueEvent(type: HighValueEventType, title: string, detail: string | null = null): void {
    this.state.lastHighValueEventType = type;
    this.state.lastHighValueTitle = title;
    this.state.lastHighValueDetail = detail;
  }
}

function mapCompletionStatus(status: string): TurnStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

function mapActiveItemType(itemType: string | null): ActiveItemType | null {
  switch (itemType) {
    case "plan":
      return "planning";
    case "commandExecution":
      return "commandExecution";
    case "fileChange":
      return "fileChange";
    case "mcpToolCall":
      return "mcpToolCall";
    case "webSearch":
      return "webSearch";
    case "agentMessage":
      return "agentMessage";
    case "reasoning":
      return "reasoning";
    case null:
      return null;
    default:
      return "other";
  }
}

function buildItemLabel(itemType: ActiveItemType | null, rawItemType: string | null): string {
  if (itemType === "planning") {
    return "planning";
  }

  if (itemType) {
    return itemType;
  }

  return rawItemType ?? "other";
}

function deriveBlockedReason(activeFlags: string[]): ThreadBlockedReason {
  if (activeFlags.includes("waitingOnApproval")) {
    return "waitingOnApproval";
  }

  if (activeFlags.includes("waitingOnUserInput")) {
    return "waitingOnUserInput";
  }

  return null;
}

function isTerminalStatus(status: TurnStatus): boolean {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function cleanSummary(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
}

function summarizeCommandOutput(text: string): { command: string; detail: string | null } {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      command: "command",
      detail: null
    };
  }

  const command = lines[0]?.replace(/^[>$#]\s*/u, "") ?? "command";
  const detailCandidate = lines.at(-1) ?? null;
  const detail = detailCandidate && detailCandidate !== lines[0] ? detailCandidate : null;

  return {
    command: cleanSummary(command),
    detail: detail ? cleanSummary(detail) : null
  };
}
