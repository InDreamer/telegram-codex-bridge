import type {
  ActivityRecord,
  ActivityStatus,
  ActiveItemType,
  ClassifiedNotification,
  CollabAgentLabelSource,
  CollabAgentStateSnapshot,
  CollabAgentStatus,
  HighValueEventType,
  InspectSnapshot,
  StreamBlock,
  StreamSnapshot,
  ThreadBlockedReason,
  TokenUsageSnapshot,
  TurnStatus
} from "./types.js";
import { normalizeWhitespace, truncateText, normalizeNullableText } from "../util/text.js";
import { isBlockedProgress, BLOCKED_PROGRESS_APPROVAL, BLOCKED_PROGRESS_USER_INPUT } from "../util/blocked-progress.js";

const DEFAULT_TIMELINE_LIMIT = 100;
const SUMMARY_LIMIT = 5;
const STATUS_UPDATE_LIMIT = 3;
const SUBAGENT_LABEL_DISPLAY_LIMIT = 48;
const COMMAND_OUTPUT_LINE_SNAPSHOT_LIMIT = 1024;

interface ActivityTrackerOptions {
  threadId: string;
  turnId: string;
  debugAvailable?: boolean;
  timelineLimit?: number;
}

interface ActivityTrackerState {
  turnStatus: TurnStatus;
  threadRuntimeState: ActivityStatus["threadRuntimeState"];
  activeItemType: ActiveItemType | null;
  activeItemId: string | null;
  activeItemLabel: string | null;
  lastActivityAt: string | null;
  currentItemStartedAt: string | null;
  lastHighValueEventType: HighValueEventType | null;
  lastHighValueTitle: string | null;
  lastHighValueDetail: string | null;
  latestProgress: string | null;
  recentStatusUpdates: string[];
  threadBlockedReason: ThreadBlockedReason;
  finalMessageAvailable: boolean;
  inspectAvailable: boolean;
  debugAvailable: boolean;
  errorState: ActivityStatus["errorState"];
}

interface TrackedSubagent {
  threadId: string;
  fallbackLabel: string;
  agentNickname: string | null;
  agentRole: string | null;
  threadName: string | null;
  status: CollabAgentStatus;
  latestCommentary: string | null;
  latestOperationalProgress: string | null;
  activeItemLabel: string | null;
  lastActivityAt: string | null;
}

interface CommandOutputAccumulator {
  firstNonEmptyLine: string | null;
  lastNonEmptyLine: string | null;
  trailingFragment: string;
}

interface SubagentIdentityUpdate {
  agentNickname?: string | null;
  agentRole?: string | null;
  threadName?: string | null;
}

export interface SubagentIdentityEvent {
  kind: "cached" | "applied";
  threadId: string;
  label: string | null;
  labelSource: CollabAgentLabelSource | null;
  origin: "notification" | "cache_replay" | "backfill";
}

type SubagentIdentityMergeMode = "replace" | "fillMissing";

export class ActivityTracker {
  private readonly timelineLimit: number;
  private readonly recentTransitions: ActivityRecord[] = [];
  private readonly recentCommandSummaries: string[] = [];
  private readonly recentFileChangeSummaries: string[] = [];
  private readonly recentMcpSummaries: string[] = [];
  private readonly recentWebSearches: string[] = [];
  private readonly recentHookSummaries: string[] = [];
  private readonly recentNoticeSummaries: string[] = [];
  private readonly planSnapshot: string[] = [];
  private planDeltaBuffer = "";
  private readonly subagents = new Map<string, TrackedSubagent>();
  private readonly pendingSubagentIdentities = new Map<string, SubagentIdentityUpdate>();
  private readonly subagentIdentityEvents: SubagentIdentityEvent[] = [];
  private readonly completedCommentary: string[] = [];
  private readonly commandOutputBuffers = new Map<string, CommandOutputAccumulator>();
  private readonly state: ActivityTrackerState;
  private readonly streamBlocks: StreamBlock[] = [];
  private turnStartedAt: string | null = null;
  private lastStreamToolSummary: string | null = null;
  private tokenUsage: TokenUsageSnapshot | null = null;
  private latestDiffSummary: string | null = null;
  private terminalInteractionSummary: string | null = null;

  constructor(
    private readonly options: ActivityTrackerOptions
  ) {
    this.timelineLimit = options.timelineLimit ?? DEFAULT_TIMELINE_LIMIT;
    this.state = {
      turnStatus: "starting",
      threadRuntimeState: null,
      activeItemType: null,
      activeItemId: null,
      activeItemLabel: null,
      lastActivityAt: null,
      currentItemStartedAt: null,
      lastHighValueEventType: null,
      lastHighValueTitle: null,
      lastHighValueDetail: null,
      latestProgress: null,
      recentStatusUpdates: [],
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

    if (!this.isRootNotification(notification)) {
      this.applySubagentNotification(notification, receivedAt);
      return;
    }

    switch (notification.kind) {
      case "thread_started":
      case "thread_name_updated":
        return;

      case "thread_token_usage_updated":
        this.tokenUsage = notification.tokenUsage;
        this.state.inspectAvailable = true;
        this.state.lastActivityAt = receivedAt;
        return;

      case "thread_compacted":
        this.state.inspectAvailable = true;
        this.state.lastActivityAt = receivedAt;
        this.pushUniqueSummary(this.recentNoticeSummaries, "上下文已压缩");
        this.pushTransition(receivedAt, "thread", "thread compacted");
        return;

      case "turn_started":
        this.state.turnStatus = "running";
        this.state.errorState = null;
        this.state.lastActivityAt = receivedAt;
        this.turnStartedAt = receivedAt;
        this.planDeltaBuffer = "";
        this.pushTransition(receivedAt, "turn", "turn started");
        this.pushStatusUpdate("Turn started");
        this.pushStreamBlock({ kind: "status", text: "Running" });
        return;

      case "turn_completed":
        this.state.turnStatus = mapCompletionStatus(notification.status);
        this.state.activeItemType = null;
        this.state.activeItemId = null;
        this.state.activeItemLabel = null;
        this.state.currentItemStartedAt = null;
        this.state.latestProgress = null;
        this.state.recentStatusUpdates = [];
        this.state.threadBlockedReason = null;
        this.state.lastActivityAt = receivedAt;
        this.commandOutputBuffers.clear();
        if (this.state.turnStatus === "failed" && this.state.errorState === null) {
          this.state.errorState = "turn_failed";
        }
        if (this.state.turnStatus === "completed" && this.state.lastHighValueEventType !== "done") {
          this.setHighValueEvent("done", "Done: completed", "completed");
        }
        this.pushTransition(receivedAt, "turn", `turn completed (${notification.status})`);
        if (this.state.turnStatus === "completed" && !this.state.finalMessageAvailable) {
          this.pushStatusUpdate("Turn completed");
        }
        {
          const durationSec = this.turnStartedAt ? computeDurationSec(this.turnStartedAt, receivedAt) : null;
          const statusLabel = formatCompletionLabel(this.state.turnStatus);
          this.pushStreamBlock({
            kind: "completion",
            text: statusLabel,
            durationSec
          });
        }
        return;

      case "turn_diff_updated": {
        const summary = summarizeUnifiedDiff(notification.diff);
        if (summary) {
          this.latestDiffSummary = summary;
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
        }
        return;
      }

      case "thread_status_changed": {
        const blockedReason = deriveBlockedReason(notification.activeFlags);
        this.state.threadRuntimeState = notification.status;
        this.state.threadBlockedReason = blockedReason;
        this.state.lastActivityAt = receivedAt;

        if (blockedReason) {
          this.state.turnStatus = "blocked";
          this.setHighValueEvent("blocked", `Blocked: ${blockedReason ?? "thread blocked"}`);
          this.pushStatusUpdate(
            blockedReason === "waitingOnApproval"
              ? BLOCKED_PROGRESS_APPROVAL
              : blockedReason === "waitingOnUserInput"
                ? BLOCKED_PROGRESS_USER_INPUT
                : "Thread blocked"
          );
          this.pushStreamBlock({
            kind: "status",
            text: blockedReason === "waitingOnApproval"
              ? "Blocked: waiting for approval"
              : blockedReason === "waitingOnUserInput"
                ? "Blocked: waiting for user input"
              : "Blocked: thread blocked"
          });
        } else if (notification.status === "active" && !isTerminalStatus(this.state.turnStatus)) {
          this.state.turnStatus = "running";
        }

        this.pushTransition(
          receivedAt,
          "thread",
          blockedReason ? `thread blocked (${blockedReason})` : `thread status ${notification.status ?? "running"}`
        );
        return;
      }

      case "thread_archived":
      case "thread_unarchived":
        return;

      case "item_started": {
        const activeItemType = mapActiveItemType(notification.itemType);
        this.syncCollabAgentStates(notification.collabAgentStates);
        this.state.activeItemType = activeItemType;
        this.state.activeItemId = notification.itemId;
        this.state.activeItemLabel = notification.label ?? buildItemLabel(activeItemType, notification.itemType);
        this.state.currentItemStartedAt = receivedAt;
        this.state.latestProgress = null;
        this.state.inspectAvailable = true;
        this.state.lastActivityAt = receivedAt;
        if (activeItemType === "commandExecution" && notification.itemId) {
          this.commandOutputBuffers.set(
            buildCommandBufferKey(this.options.threadId, notification.itemId),
            createCommandOutputAccumulator()
          );
        }

        if (!this.state.threadBlockedReason && !isTerminalStatus(this.state.turnStatus)) {
          this.state.turnStatus = "running";
        }

        const summary = `${this.state.activeItemLabel ?? "other"} started`;
        this.pushTransition(receivedAt, "item", summary);
        if (activeItemType === "commandExecution") {
          const commandLabel = cleanSummary(this.state.activeItemLabel ?? "command");
          this.setHighValueEvent("ran_cmd", `Ran cmd: ${commandLabel}`);
          if (commandLabel !== "command") {
            this.pushStatusUpdate(`Starting command: ${commandLabel}`);
          }
        }
        return;
      }

      case "item_completed": {
        const completedItemType = mapActiveItemType(notification.itemType);
        const completedLabel = buildItemLabel(completedItemType, notification.itemType);
        this.syncCollabAgentStates(notification.collabAgentStates);
        if (!notification.itemId || notification.itemId === this.state.activeItemId) {
          this.state.activeItemType = null;
          this.state.activeItemId = null;
          this.state.activeItemLabel = null;
          this.state.currentItemStartedAt = null;
          this.state.latestProgress = completedItemType === "agentMessage" ? null : `${completedLabel} completed`;
        }

        this.state.inspectAvailable = true;
        this.state.lastActivityAt = receivedAt;
        if (!this.state.threadBlockedReason && !isTerminalStatus(this.state.turnStatus)) {
          this.state.turnStatus = "running";
        }

        const summary = `${completedLabel} completed`;
        this.pushTransition(receivedAt, "item", summary);
        if (completedItemType === "agentMessage" && notification.itemPhase === "commentary") {
          const commentaryText = normalizeNullableText(notification.itemText);
          if (commentaryText) {
            this.pushUniqueSummary(this.completedCommentary, commentaryText);
          }
        }
        if (notification.itemId) {
          this.commandOutputBuffers.delete(buildCommandBufferKey(this.options.threadId, notification.itemId));
        }
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
          const progressSummaryList =
            this.state.activeItemType === "mcpToolCall" ? this.recentMcpSummaries
            : this.state.activeItemType === "webSearch" ? this.recentWebSearches
            : null;
          if (progressSummaryList) {
            const summary = cleanSummary(notification.message);
            this.pushUniqueSummary(progressSummaryList, summary);
            this.setHighValueEvent("found", `Found: ${summary}`, summary);
            this.pushStatusUpdate(summary);
            this.pushDeduplicatedToolSummary(summary);
          } else {
            this.pushStatusUpdate(cleanSummary(notification.message));
          }
        }
        return;

      case "hook_started":
      case "hook_completed": {
        const summary = summarizeHookRun(notification.run, notification.kind === "hook_completed");
        if (summary) {
          this.pushUniqueSummary(this.recentHookSummaries, summary);
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushTransition(receivedAt, "progress", summary);
        }
        for (const entry of notification.run.entries) {
          const entrySummary = summarizeHookEntry(entry.kind, entry.text);
          if (entrySummary) {
            this.pushUniqueSummary(this.recentNoticeSummaries, entrySummary);
          }
        }
        return;
      }

      case "terminal_interaction": {
        const summary = summarizeTerminalInteraction(notification.stdin);
        this.terminalInteractionSummary = summary;
        this.state.latestProgress = summary;
        this.state.inspectAvailable = true;
        this.state.lastActivityAt = receivedAt;
        this.pushUniqueSummary(this.recentNoticeSummaries, summary);
        this.pushTransition(receivedAt, "progress", summary);
        this.pushStatusUpdate(summary);
        return;
      }

      case "server_request_resolved":
        if (notification.requestId) {
          const summary = `交互已完成：${notification.requestId}`;
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushUniqueSummary(this.recentNoticeSummaries, summary);
          this.pushTransition(receivedAt, "progress", summary);
        }
        return;

      case "config_warning": {
        const summary = summarizeNotice(notification.summary, notification.detail, "配置警告");
        if (summary) {
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushUniqueSummary(this.recentNoticeSummaries, summary);
          this.pushTransition(receivedAt, "progress", summary);
        }
        return;
      }

      case "deprecation_notice": {
        const summary = summarizeNotice(notification.summary, notification.detail, "弃用提示");
        if (summary) {
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushUniqueSummary(this.recentNoticeSummaries, summary);
          this.pushTransition(receivedAt, "progress", summary);
        }
        return;
      }

      case "model_rerouted": {
        const summary = summarizeModelReroute(notification.fromModel, notification.toModel, notification.reason);
        if (summary) {
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.pushUniqueSummary(this.recentNoticeSummaries, summary);
          this.pushTransition(receivedAt, "progress", summary);
          this.pushStatusUpdate(summary);
        }
        return;
      }

      case "skills_changed":
        this.state.inspectAvailable = true;
        this.state.lastActivityAt = receivedAt;
        this.pushUniqueSummary(this.recentNoticeSummaries, "技能列表已刷新");
        this.pushTransition(receivedAt, "progress", "skills changed");
        return;

      case "final_message_available":
        this.state.finalMessageAvailable = true;
        this.state.lastActivityAt = receivedAt;
        if (notification.message) {
          const summary = cleanSummary(notification.message);
          this.setHighValueEvent("done", `Done: ${summary}`, summary);
          this.pushStatusUpdate(summary);
        }
        return;

      case "plan_updated":
        this.state.inspectAvailable = this.state.inspectAvailable || notification.entries.length > 0;
        this.state.lastActivityAt = receivedAt;
        {
          const cleanedEntries = notification.entries
            .map((entry) => cleanSummary(entry))
            .filter((entry) => entry.length > 0);
          this.planDeltaBuffer = cleanedEntries.join("\n");
          this.replaceSummaryList(this.planSnapshot, cleanedEntries);
          this.state.latestProgress = summarizePlanEntries(cleanedEntries);
          if (this.state.latestProgress) {
            this.pushStatusUpdate(this.state.latestProgress);
          }
          if (cleanedEntries.length > 0) {
            this.collapseOrPushPlanBlock(cleanedEntries.join("\n"));
          }
        }
        return;

      case "plan_delta":
        if (notification.message) {
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.planDeltaBuffer += notification.message;
          const entries = extractPlanDeltaEntries(this.planDeltaBuffer);
          if (entries.length === 0) {
            return;
          }
          this.replaceSummaryList(this.planSnapshot, entries);
          const summary = summarizePlanEntries(entries);
          this.state.latestProgress = summary;
          if (summary) {
            this.pushStatusUpdate(summary);
          }
          this.collapseOrPushPlanBlock(entries.join("\n"));
        }
        return;

      case "command_output":
        if (notification.text) {
          const combinedText = notification.itemId
            ? this.appendCommandOutput(buildCommandBufferKey(this.options.threadId, notification.itemId), notification.text)
            : notification.text;
          const summary = summarizeCommandOutput(combinedText);
          const commandLabel = selectConcreteCommandLabel(
            summary.command,
            this.state.activeItemType === "commandExecution" ? this.state.activeItemLabel : null
          );
          const progressSummary = summary.detail ? `${commandLabel} -> ${summary.detail}` : commandLabel;
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.state.latestProgress = progressSummary;
          this.pushTransition(receivedAt, "progress", progressSummary);
          this.pushUniqueSummary(
            this.recentCommandSummaries,
            progressSummary
          );
          this.setHighValueEvent("ran_cmd", `Ran cmd: ${commandLabel}`, summary.detail);
          this.pushStatusUpdate(progressSummary);
          this.pushStreamBlock({
            kind: "command",
            text: `$ ${commandLabel}`,
            detail: summary.detail
          });
        }
        return;

      case "file_change_output":
        if (notification.text) {
          const summary = cleanSummary(notification.text);
          this.state.inspectAvailable = true;
          this.state.lastActivityAt = receivedAt;
          this.state.latestProgress = summary;
          this.pushTransition(receivedAt, "progress", summary);
          this.pushUniqueSummary(this.recentFileChangeSummaries, summary);
          this.setHighValueEvent("changed", `Changed: ${summary}`, summary);
          this.pushStatusUpdate(summary);
          this.pushStreamBlock({ kind: "file_change", text: summary });
        }
        return;

      case "agent_message_delta":
        return;

      case "turn_aborted":
        this.state.turnStatus = "interrupted";
        this.state.activeItemType = null;
        this.state.activeItemId = null;
        this.state.activeItemLabel = null;
        this.state.currentItemStartedAt = null;
        this.state.latestProgress = null;
        this.state.recentStatusUpdates = [];
        this.state.threadBlockedReason = null;
        this.state.lastActivityAt = receivedAt;
        this.commandOutputBuffers.clear();
        this.setHighValueEvent("blocked", "Blocked: interrupted");
        this.pushTransition(receivedAt, "turn", "turn interrupted");
        this.pushStatusUpdate("Turn interrupted");
        return;

      case "error": {
        const errorSummary = cleanSummary(notification.message ?? "unknown error");
        this.state.turnStatus = "failed";
        this.state.activeItemType = null;
        this.state.activeItemId = null;
        this.state.activeItemLabel = null;
        this.state.currentItemStartedAt = null;
        this.state.latestProgress = errorSummary;
        this.state.threadBlockedReason = null;
        this.state.lastActivityAt = receivedAt;
        this.state.errorState = "unknown";
        this.commandOutputBuffers.clear();
        this.setHighValueEvent("blocked", `Blocked: ${errorSummary}`);
        this.pushTransition(receivedAt, "error", notification.message ?? "error");
        this.pushStatusUpdate(errorSummary);
        this.pushStreamBlock({ kind: "error", text: errorSummary });
        return;
      }

      case "other":
        return;
    }
  }

  getStatus(now = new Date().toISOString()): ActivityStatus {
    return {
      turnStatus: this.state.turnStatus,
      threadRuntimeState: this.state.threadRuntimeState,
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
      recentStatusUpdates: [...this.state.recentStatusUpdates],
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
      recentHookSummaries: [...this.recentHookSummaries],
      recentNoticeSummaries: [...this.recentNoticeSummaries],
      planSnapshot: [...this.planSnapshot],
      agentSnapshot: this.getRunningAgentSnapshot(),
      completedCommentary: [...this.completedCommentary],
      tokenUsage: this.tokenUsage ? { ...this.tokenUsage } : null,
      latestDiffSummary: this.latestDiffSummary,
      terminalInteractionSummary: this.terminalInteractionSummary,
      pendingInteractions: []
    };
  }

  getStreamSnapshot(): StreamSnapshot {
    return {
      blocks: [...this.streamBlocks],
      turnStartedAt: this.turnStartedAt,
      activeStatusLine: this.deriveActiveStatusLine()
    };
  }

  drainSubagentIdentityEvents(): SubagentIdentityEvent[] {
    if (this.subagentIdentityEvents.length === 0) {
      return [];
    }

    return this.subagentIdentityEvents.splice(0, this.subagentIdentityEvents.length);
  }

  applyResolvedSubagentIdentity(
    threadId: string,
    identity: SubagentIdentityUpdate,
    receivedAt = new Date().toISOString()
  ): boolean {
    return this.recordSubagentIdentity(threadId, identity, receivedAt, "backfill", "fillMissing");
  }

  private pushStreamBlock(block: StreamBlock): void {
    this.streamBlocks.push(block);
    if (block.kind !== "tool_summary") {
      this.lastStreamToolSummary = null;
    }
  }

  private pushDeduplicatedToolSummary(text: string): void {
    if (this.lastStreamToolSummary === text) {
      return;
    }
    this.lastStreamToolSummary = text;
    this.pushStreamBlock({ kind: "tool_summary", text });
  }

  private collapseOrPushPlanBlock(text: string): void {
    const lastBlock = this.streamBlocks.at(-1);
    if (lastBlock?.kind === "plan") {
      lastBlock.text = text;
      return;
    }
    this.pushStreamBlock({ kind: "plan", text });
  }

  private deriveActiveStatusLine(): string | null {
    if (this.state.threadBlockedReason === "waitingOnApproval") {
      return BLOCKED_PROGRESS_APPROVAL;
    }
    if (this.state.threadBlockedReason === "waitingOnUserInput") {
      return BLOCKED_PROGRESS_USER_INPUT;
    }
    if (this.state.activeItemLabel) {
      return this.state.activeItemLabel;
    }
    if (this.state.latestProgress) {
      return this.state.latestProgress;
    }
    return null;
  }

  private applySubagentNotification(notification: ClassifiedNotification, receivedAt: string): void {
    const threadId = notification.threadId;
    if (!threadId) {
      return;
    }

    switch (notification.kind) {
      case "thread_started": {
        const changed = this.recordSubagentIdentity(threadId, {
          agentNickname: notification.agentNickname,
          agentRole: notification.agentRole,
          threadName: notification.threadName
        }, receivedAt, "notification");
        const subagent = this.subagents.get(threadId);
        if (subagent && changed) {
          subagent.lastActivityAt = receivedAt;
        }
        return;
      }

      case "thread_name_updated": {
        const changed = this.recordSubagentIdentity(threadId, {
          threadName: notification.threadName
        }, receivedAt, "notification");
        const subagent = this.subagents.get(threadId);
        if (subagent && changed) {
          subagent.lastActivityAt = receivedAt;
        }
        return;
      }
    }

    const subagent = this.subagents.get(threadId);
    if (!subagent) {
      return;
    }

    switch (notification.kind) {
      case "turn_started":
        subagent.status = "running";
        subagent.latestCommentary = null;
        subagent.latestOperationalProgress = null;
        subagent.activeItemLabel = null;
        subagent.lastActivityAt = receivedAt;
        return;

      case "turn_completed":
        subagent.status = mapCompletionStatusToAgentStatus(notification.status);
        subagent.lastActivityAt = receivedAt;
        return;

      case "thread_status_changed": {
        const blockedReason = deriveBlockedReason(notification.activeFlags);
        if (notification.status === "systemError") {
          subagent.status = "errored";
        } else if (notification.status === "active" || notification.status === "idle") {
          subagent.status = "running";
          if (isBlockedProgress(subagent.latestOperationalProgress) && !blockedReason) {
            subagent.latestOperationalProgress = null;
          }
        }
        if (blockedReason) {
          subagent.latestOperationalProgress = blockedReason === "waitingOnApproval"
            ? BLOCKED_PROGRESS_APPROVAL
            : BLOCKED_PROGRESS_USER_INPUT;
        }
        subagent.lastActivityAt = receivedAt;
        return;
      }

      case "item_started": {
        this.syncCollabAgentStates(notification.collabAgentStates);
        const activeItemType = mapActiveItemType(notification.itemType);
        subagent.status = "running";
        subagent.latestOperationalProgress = null;
        subagent.activeItemLabel = notification.label ?? buildItemLabel(activeItemType, notification.itemType);
        subagent.lastActivityAt = receivedAt;
        if (activeItemType === "commandExecution" && notification.itemId) {
          this.commandOutputBuffers.set(
            buildCommandBufferKey(threadId, notification.itemId),
            createCommandOutputAccumulator()
          );
        }
        return;
      }

      case "item_completed": {
        this.syncCollabAgentStates(notification.collabAgentStates);
        const completedItemType = mapActiveItemType(notification.itemType);
        if (completedItemType === "agentMessage" && notification.itemPhase === "commentary") {
          const commentaryText = normalizeNullableText(notification.itemText);
          if (commentaryText) {
            subagent.latestCommentary = commentaryText;
          }
        }
        if (notification.itemId) {
          this.commandOutputBuffers.delete(buildCommandBufferKey(threadId, notification.itemId));
        }
        subagent.activeItemLabel = null;
        subagent.lastActivityAt = receivedAt;
        return;
      }

      case "progress":
        if (notification.message) {
          subagent.status = "running";
          subagent.latestOperationalProgress = cleanSummary(notification.message);
          subagent.lastActivityAt = receivedAt;
        }
        return;

      case "plan_updated": {
        const summary = summarizePlanEntries(
          notification.entries
            .map((entry) => cleanSummary(entry))
            .filter((entry) => entry.length > 0)
        );
        if (summary) {
          subagent.status = "running";
          subagent.latestOperationalProgress = summary;
          subagent.lastActivityAt = receivedAt;
        }
        return;
      }

      case "plan_delta":
        if (notification.message) {
          const summary = cleanSummary(notification.message);
          if (summary) {
            subagent.status = "running";
            subagent.latestOperationalProgress = summary;
            subagent.lastActivityAt = receivedAt;
          }
        }
        return;

      case "command_output":
        if (notification.text) {
          const combinedText = notification.itemId
            ? this.appendCommandOutput(buildCommandBufferKey(threadId, notification.itemId), notification.text)
            : notification.text;
          const summary = summarizeCommandOutput(combinedText);
          const commandLabel = selectConcreteCommandLabel(summary.command, subagent.activeItemLabel);
          subagent.status = "running";
          subagent.latestOperationalProgress = cleanSummary(summary.detail ? `${commandLabel} -> ${summary.detail}` : commandLabel);
          subagent.lastActivityAt = receivedAt;
        }
        return;

      case "file_change_output":
        if (notification.text) {
          subagent.status = "running";
          subagent.latestOperationalProgress = cleanSummary(notification.text);
          subagent.lastActivityAt = receivedAt;
        }
        return;

      case "turn_aborted":
        subagent.status = "shutdown";
        subagent.lastActivityAt = receivedAt;
        return;

      case "error":
        subagent.status = "errored";
        subagent.latestOperationalProgress = cleanSummary(notification.message ?? "unknown error");
        subagent.lastActivityAt = receivedAt;
        return;

      case "final_message_available":
      case "agent_message_delta":
      case "thread_token_usage_updated":
      case "thread_compacted":
      case "turn_diff_updated":
      case "hook_started":
      case "hook_completed":
      case "terminal_interaction":
      case "server_request_resolved":
      case "config_warning":
      case "deprecation_notice":
      case "model_rerouted":
      case "skills_changed":
      case "thread_archived":
      case "thread_unarchived":
      case "other":
        return;
    }
  }

  private syncCollabAgentStates(
    states: Array<{
      threadId: string;
      status: CollabAgentStatus;
      message: string | null;
    }>
  ): void {
    for (const state of states) {
      const subagent = this.ensureSubagent(state.threadId);
      subagent.status = state.status;
      if (state.message) {
        subagent.latestOperationalProgress = cleanSummary(state.message);
      }
    }
  }

  private ensureSubagent(threadId: string): TrackedSubagent {
    const existing = this.subagents.get(threadId);
    if (existing) {
      return existing;
    }

    const created: TrackedSubagent = {
      threadId,
      fallbackLabel: buildSubagentLabel(threadId),
      agentNickname: null,
      agentRole: null,
      threadName: null,
      status: "pendingInit",
      latestCommentary: null,
      latestOperationalProgress: null,
      activeItemLabel: null,
      lastActivityAt: null
    };
    this.applyPendingSubagentIdentity(created);
    this.subagents.set(threadId, created);
    return created;
  }

  private getRunningAgentSnapshot(): CollabAgentStateSnapshot[] {
    return [...this.subagents.values()]
      .filter((agent) => agent.status === "pendingInit" || agent.status === "running")
      .map((agent) => {
        const label = this.getSubagentLabel(agent);
        return {
          threadId: agent.threadId,
          label: label.text,
          labelSource: label.source,
          status: agent.status,
          progress: this.getSubagentDisplayProgress(agent)
        };
      });
  }

  private updateSubagentIdentity(
    subagent: TrackedSubagent,
    identity: SubagentIdentityUpdate,
    mergeMode: SubagentIdentityMergeMode = "replace"
  ): boolean {
    return mergeIdentityFields(subagent, identity, mergeMode);
  }

  private getSubagentLabel(subagent: TrackedSubagent): {
    text: string;
    source: CollabAgentLabelSource;
  } {
    if (subagent.agentNickname) {
      return {
        text: truncateText(subagent.agentNickname, SUBAGENT_LABEL_DISPLAY_LIMIT),
        source: "nickname"
      };
    }

    if (subagent.threadName) {
      return {
        text: truncateText(subagent.threadName, SUBAGENT_LABEL_DISPLAY_LIMIT),
        source: "threadName"
      };
    }

    return {
      text: truncateText(subagent.fallbackLabel, SUBAGENT_LABEL_DISPLAY_LIMIT),
      source: "fallback"
    };
  }

  private getSubagentDisplayProgress(subagent: TrackedSubagent): string | null {
    if (isBlockedProgress(subagent.latestOperationalProgress)) {
      return subagent.latestOperationalProgress;
    }

    return subagent.latestCommentary ?? subagent.latestOperationalProgress ?? subagent.activeItemLabel ?? null;
  }

  private isRootNotification(notification: ClassifiedNotification): boolean {
    return !notification.threadId || notification.threadId === this.options.threadId;
  }

  private isRelevant(notification: ClassifiedNotification): boolean {
    if (this.isRootNotification(notification)) {
      if (notification.turnId && notification.turnId !== this.options.turnId) {
        return false;
      }
      return true;
    }

    if (!notification.threadId) {
      return false;
    }

    if (notification.kind === "thread_started" || notification.kind === "thread_name_updated") {
      return true;
    }

    if (!this.subagents.has(notification.threadId)) {
      return false;
    }

    return true;
  }

  private recordSubagentIdentity(
    threadId: string,
    identity: SubagentIdentityUpdate,
    receivedAt: string,
    origin: SubagentIdentityEvent["origin"],
    mergeMode: SubagentIdentityMergeMode = "replace"
  ): boolean {
    const normalized = normalizeSubagentIdentity(identity);
    if (!hasIdentityFields(normalized)) {
      return false;
    }

    const subagent = this.subagents.get(threadId);
    if (subagent) {
      const changed = this.updateSubagentIdentity(subagent, normalized, mergeMode);
      if (changed) {
        subagent.lastActivityAt = receivedAt;
        this.enqueueSubagentIdentityEvent("applied", threadId, subagent, origin);
      }
      return changed;
    }

    const changed = this.mergePendingSubagentIdentity(threadId, normalized, mergeMode);
    if (changed) {
      this.enqueuePendingSubagentIdentityEvent("cached", threadId, normalized, origin);
    }
    return changed;
  }

  private mergePendingSubagentIdentity(
    threadId: string,
    identity: SubagentIdentityUpdate,
    mergeMode: SubagentIdentityMergeMode
  ): boolean {
    const existing = this.pendingSubagentIdentities.get(threadId) ?? {};
    const changed = mergeIdentityFields(existing, identity, mergeMode);

    if (changed) {
      this.pendingSubagentIdentities.set(threadId, existing);
    }
    return changed;
  }

  private applyPendingSubagentIdentity(subagent: TrackedSubagent): void {
    const pending = this.pendingSubagentIdentities.get(subagent.threadId);
    if (!pending) {
      return;
    }

    this.pendingSubagentIdentities.delete(subagent.threadId);
    if (this.updateSubagentIdentity(subagent, pending)) {
      this.enqueueSubagentIdentityEvent("applied", subagent.threadId, subagent, "cache_replay");
    }
  }

  private enqueueSubagentIdentityEvent(
    kind: SubagentIdentityEvent["kind"],
    threadId: string,
    subagent: TrackedSubagent,
    origin: SubagentIdentityEvent["origin"]
  ): void {
    const label = this.getSubagentLabel(subagent);
    this.subagentIdentityEvents.push({
      kind,
      threadId,
      label: label.text,
      labelSource: label.source,
      origin
    });
  }

  private enqueuePendingSubagentIdentityEvent(
    kind: SubagentIdentityEvent["kind"],
    threadId: string,
    identity: SubagentIdentityUpdate,
    origin: SubagentIdentityEvent["origin"]
  ): void {
    const label = getIdentityEventLabel(identity);
    this.subagentIdentityEvents.push({
      kind,
      threadId,
      label: label?.text ?? null,
      labelSource: label?.source ?? null,
      origin
    });
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

  private pushUniqueSummary(target: string[], summary: string): void {
    if (target.at(-1) === summary) {
      return;
    }

    target.push(summary);
    if (target.length > SUMMARY_LIMIT) {
      target.splice(0, target.length - SUMMARY_LIMIT);
    }
  }

  private replaceSummaryList(target: string[], summaries: string[]): void {
    const nextSummaries = summaries.slice(-SUMMARY_LIMIT);
    target.splice(0, target.length, ...nextSummaries);
  }

  private setHighValueEvent(type: HighValueEventType, title: string, detail: string | null = null): void {
    this.state.lastHighValueEventType = type;
    this.state.lastHighValueTitle = title;
    this.state.lastHighValueDetail = detail;
  }

  private pushStatusUpdate(summary: string): void {
    const cleaned = cleanSummary(summary);
    if (!cleaned) {
      return;
    }

    if (this.state.recentStatusUpdates.at(-1) === cleaned) {
      return;
    }

    this.state.recentStatusUpdates.push(cleaned);
    if (this.state.recentStatusUpdates.length > STATUS_UPDATE_LIMIT) {
      this.state.recentStatusUpdates.splice(0, this.state.recentStatusUpdates.length - STATUS_UPDATE_LIMIT);
    }
  }

  private appendCommandOutput(itemId: string, text: string): string {
    const next = appendCommandOutputChunk(
      this.commandOutputBuffers.get(itemId) ?? createCommandOutputAccumulator(),
      text
    );
    this.commandOutputBuffers.set(itemId, next);
    return summarizeCommandOutputAccumulator(next);
  }
}

function createCommandOutputAccumulator(): CommandOutputAccumulator {
  return {
    firstNonEmptyLine: null,
    lastNonEmptyLine: null,
    trailingFragment: ""
  };
}

function appendCommandOutputChunk(
  accumulator: CommandOutputAccumulator,
  text: string
): CommandOutputAccumulator {
  const combined = `${accumulator.trailingFragment}${text}`;
  const endsWithNewline = /\r?\n$/u.test(combined);
  const parts = combined.split(/\r?\n/u);
  const rawTrailingFragment = endsWithNewline ? "" : (parts.pop() ?? "");
  const trailingFragment = truncateText(rawTrailingFragment, COMMAND_OUTPUT_LINE_SNAPSHOT_LIMIT, "");
  const next: CommandOutputAccumulator = {
    firstNonEmptyLine: accumulator.firstNonEmptyLine,
    lastNonEmptyLine: accumulator.lastNonEmptyLine,
    trailingFragment
  };

  for (const part of parts) {
    const normalized = normalizeNullableText(truncateText(part, COMMAND_OUTPUT_LINE_SNAPSHOT_LIMIT, ""));
    if (!normalized) {
      continue;
    }
    if (!next.firstNonEmptyLine) {
      next.firstNonEmptyLine = normalized;
    }
    next.lastNonEmptyLine = normalized;
  }

  const trailingNormalized = normalizeNullableText(trailingFragment);
  if (trailingNormalized) {
    if (!next.firstNonEmptyLine) {
      next.firstNonEmptyLine = trailingNormalized;
    }
    next.lastNonEmptyLine = trailingNormalized;
  }

  return next;
}

function summarizeCommandOutputAccumulator(accumulator: CommandOutputAccumulator): string {
  if (!accumulator.firstNonEmptyLine) {
    return "";
  }

  if (!accumulator.lastNonEmptyLine || accumulator.lastNonEmptyLine === accumulator.firstNonEmptyLine) {
    return accumulator.firstNonEmptyLine;
  }

  return `${accumulator.firstNonEmptyLine}\n${accumulator.lastNonEmptyLine}`;
}

function summarizeUnifiedDiff(diff: string | null): string | null {
  if (!diff) {
    return null;
  }

  let fileCount = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      fileCount++;
    } else if (line.startsWith("+")) {
      additions++;
    } else if (line.startsWith("-")) {
      deletions++;
    }
  }
  const summaryParts = [
    fileCount > 0 ? `${fileCount} 个文件` : null,
    additions > 0 ? `+${additions}` : null,
    deletions > 0 ? `-${deletions}` : null
  ].filter((value): value is string => Boolean(value));
  return summaryParts.length > 0 ? `差异更新：${summaryParts.join(" / ")}` : "差异已更新";
}

function summarizeHookRun(
  run: {
    eventName: string | null;
    handlerType: string | null;
    status: string | null;
    statusMessage: string | null;
    durationMs: number | null;
  },
  completed: boolean
): string | null {
  const parts = [
    run.eventName ? `hook ${run.eventName}` : "hook",
    run.handlerType ? `(${run.handlerType})` : null,
    run.status ?? (completed ? "completed" : "running")
  ].filter((value): value is string => Boolean(value));
  const suffix = run.durationMs !== null ? ` ${run.durationMs}ms` : "";
  const summary = `${parts.join(" ")}${suffix}`.trim();
  if (!summary) {
    return null;
  }

  return run.statusMessage ? `${summary}: ${cleanSummary(run.statusMessage)}` : summary;
}

function summarizeHookEntry(kind: string | null, text: string | null): string | null {
  if (!text) {
    return null;
  }

  const prefix = kind ? `hook ${kind}` : "hook";
  return `${prefix}: ${cleanSummary(text)}`;
}

function summarizeTerminalInteraction(stdin: string | null): string {
  const preview = cleanSummary(stdin ?? "");
  return preview
    ? `终端输入请求未转发到 Telegram：${preview}`
    : "终端输入请求未转发到 Telegram";
}

function summarizeNotice(summary: string | null, detail: string | null, prefix: string): string | null {
  const head = cleanSummary(summary ?? "");
  if (!head) {
    return null;
  }

  const tail = cleanSummary(detail ?? "");
  return tail ? `${prefix}：${head} - ${tail}` : `${prefix}：${head}`;
}

function summarizeModelReroute(
  fromModel: string | null,
  toModel: string | null,
  reason: string | null
): string | null {
  if (!fromModel || !toModel) {
    return null;
  }

  const suffix = reason ? `（${reason}）` : "";
  return `模型已改道：${fromModel} -> ${toModel}${suffix}`;
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
    case "collabAgentToolCall":
      return "collabAgentToolCall";
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
    return "plan";
  }

  if (itemType === "commandExecution") {
    return "command";
  }

  if (itemType === "fileChange") {
    return "file changes";
  }

  if (itemType === "mcpToolCall") {
    return "MCP tool call";
  }

  if (itemType === "collabAgentToolCall") {
    return "agent task";
  }

  if (itemType === "webSearch") {
    return "web search";
  }

  if (itemType === "agentMessage") {
    return "assistant response";
  }

  if (itemType === "reasoning") {
    return "reasoning";
  }

  if (itemType) {
    return "work item";
  }

  return rawItemType ?? "work item";
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
  return truncateText(normalizeWhitespace(value), 240);
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

function selectConcreteCommandLabel(command: string, activeLabel: string | null): string {
  if (command !== "command") {
    return command;
  }

  if (activeLabel && activeLabel !== "command") {
    return cleanSummary(activeLabel);
  }

  return command;
}

function summarizePlanEntries(entries: string[]): string | null {
  if (entries.length === 0) {
    return null;
  }

  const activeEntry = entries.find((entry) => /\(inProgress\)$/u.test(entry))
    ?? entries.find((entry) => /\((pending|todo)\)$/u.test(entry));
  return cleanSummary(activeEntry ?? entries.at(-1) ?? entries[0] ?? "");
}

function extractPlanDeltaEntries(buffer: string): string[] {
  return buffer
    .split(/\r?\n/u)
    .map((entry) => cleanSummary(entry))
    .filter((entry) => entry.length > 0);
}

function normalizeSubagentIdentity(identity: SubagentIdentityUpdate): SubagentIdentityUpdate {
  const normalized: SubagentIdentityUpdate = {};

  if (identity.agentNickname !== undefined) {
    normalized.agentNickname = normalizeNullableText(identity.agentNickname);
  }
  if (identity.agentRole !== undefined) {
    normalized.agentRole = normalizeNullableText(identity.agentRole);
  }
  if (identity.threadName !== undefined) {
    normalized.threadName = normalizeNullableText(identity.threadName);
  }

  return normalized;
}

function hasIdentityFields(identity: SubagentIdentityUpdate): boolean {
  return identity.agentNickname !== undefined || identity.agentRole !== undefined || identity.threadName !== undefined;
}

function getIdentityEventLabel(identity: SubagentIdentityUpdate): {
  text: string;
  source: CollabAgentLabelSource;
} | null {
  if (identity.agentNickname) {
    return {
      text: truncateText(identity.agentNickname, SUBAGENT_LABEL_DISPLAY_LIMIT),
      source: "nickname"
    };
  }

  if (identity.threadName) {
    return {
      text: truncateText(identity.threadName, SUBAGENT_LABEL_DISPLAY_LIMIT),
      source: "threadName"
    };
  }

  return null;
}

function mergeSubagentIdentityValue(
  currentValue: string | null,
  nextValue: string | null | undefined,
  mergeMode: SubagentIdentityMergeMode
): { value: string | null; changed: boolean } {
  if (nextValue === undefined) {
    return { value: currentValue, changed: false };
  }

  if (mergeMode === "fillMissing" && currentValue !== null) {
    return { value: currentValue, changed: false };
  }

  if (currentValue === nextValue) {
    return { value: currentValue, changed: false };
  }

  return { value: nextValue, changed: true };
}

function mergeIdentityFields(
  target: { agentNickname?: string | null; agentRole?: string | null; threadName?: string | null },
  source: SubagentIdentityUpdate,
  mergeMode: SubagentIdentityMergeMode
): boolean {
  let changed = false;
  for (const key of ["agentNickname", "agentRole", "threadName"] as const) {
    const result = mergeSubagentIdentityValue(target[key] ?? null, source[key], mergeMode);
    if (result.changed) {
      target[key] = result.value;
      changed = true;
    }
  }
  return changed;
}

function computeDurationSec(startIso: string, endIso: string): number | null {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return Math.floor(ms / 1000);
}

function formatCompletionLabel(status: TurnStatus): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    default:
      return `Finished (${status})`;
  }
}

function mapCompletionStatusToAgentStatus(status: string): CollabAgentStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "shutdown";
    case "failed":
    case "error":
      return "errored";
    default:
      return "running";
  }
}

function buildSubagentLabel(threadId: string): string {
  return `agent-${threadId.slice(-6)}`;
}

function buildCommandBufferKey(threadId: string, itemId: string): string {
  return `${threadId}:${itemId}`;
}
