import type { FailureReason } from "../types.js";
import type { PendingInteractionSummary } from "../types.js";
import type { JsonRpcRequestId } from "../codex/app-server.js";

export type StreamBlockKind =
  | "commentary"
  | "tool_summary"
  | "command"
  | "file_change"
  | "plan"
  | "status"
  | "error"
  | "completion";

export interface StreamBlock {
  kind: StreamBlockKind;
  text: string;
  detail?: string | null;
  durationSec?: number | null;
}

export interface StreamSnapshot {
  blocks: StreamBlock[];
  turnStartedAt: string | null;
  activeStatusLine: string | null;
}

export interface TokenUsageSnapshot {
  lastInputTokens: number;
  lastCachedInputTokens: number;
  lastOutputTokens: number;
  lastReasoningOutputTokens: number;
  lastTotalTokens: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalReasoningOutputTokens: number;
  totalTokens: number;
  modelContextWindow: number | null;
}

export type TurnStatus =
  | "idle"
  | "starting"
  | "running"
  | "blocked"
  | "interrupted"
  | "completed"
  | "failed"
  | "unknown";

export type ActiveItemType =
  | "planning"
  | "commandExecution"
  | "fileChange"
  | "mcpToolCall"
  | "collabAgentToolCall"
  | "webSearch"
  | "agentMessage"
  | "reasoning"
  | "other";

export type ThreadBlockedReason = "waitingOnApproval" | "waitingOnUserInput" | null;
export type ThreadRuntimeState = "notLoaded" | "idle" | "active" | "systemError" | null;

export type HighValueEventType = "ran_cmd" | "found" | "changed" | "blocked" | "done";

export type ActivityErrorState =
  | FailureReason
  | "codex_not_authenticated"
  | "app_server_unavailable"
  | "unknown"
  | null;

export interface ActivityStatus {
  turnStatus: TurnStatus;
  threadRuntimeState: ThreadRuntimeState;
  activeItemType: ActiveItemType | null;
  activeItemId: string | null;
  activeItemLabel: string | null;
  lastActivityAt: string | null;
  currentItemStartedAt: string | null;
  currentItemDurationSec: number | null;
  lastHighValueEventType: HighValueEventType | null;
  lastHighValueTitle: string | null;
  lastHighValueDetail: string | null;
  latestProgress: string | null;
  recentStatusUpdates: string[];
  threadBlockedReason: ThreadBlockedReason;
  finalMessageAvailable: boolean;
  inspectAvailable: boolean;
  debugAvailable: boolean;
  errorState: ActivityErrorState;
}

export interface ActivityRecord {
  at: string;
  kind: "turn" | "item" | "progress" | "thread" | "error";
  turnStatus: TurnStatus;
  activeItemType: ActiveItemType | null;
  summary: string;
}

export interface InspectSnapshot extends ActivityStatus {
  recentTransitions: ActivityRecord[];
  recentCommandSummaries: string[];
  recentFileChangeSummaries: string[];
  recentMcpSummaries: string[];
  recentWebSearches: string[];
  recentHookSummaries: string[];
  recentNoticeSummaries: string[];
  planSnapshot: string[];
  agentSnapshot: CollabAgentStateSnapshot[];
  completedCommentary: string[];
  tokenUsage: TokenUsageSnapshot | null;
  latestDiffSummary: string | null;
  terminalInteractionSummary: string | null;
  pendingInteractions: PendingInteractionSummary[];
}

export type MessagePhase = "commentary" | "final_answer";
export type CollabAgentStatus =
  | "pendingInit"
  | "running"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";

export type CollabAgentLabelSource = "nickname" | "threadName" | "fallback";

export interface CollabAgentStateSnapshot {
  threadId: string;
  label: string;
  labelSource: CollabAgentLabelSource;
  status: CollabAgentStatus;
  progress: string | null;
}

export interface CollabAgentStateUpdate {
  threadId: string;
  status: CollabAgentStatus;
  message: string | null;
}

export interface DebugJournalRecord {
  receivedAt: string;
  threadId: string | null;
  turnId: string | null;
  method: string;
  params: unknown;
}

interface ClassifiedNotificationBase {
  kind:
    | "thread_started"
    | "thread_name_updated"
    | "thread_token_usage_updated"
    | "thread_compacted"
    | "turn_started"
    | "turn_completed"
    | "turn_diff_updated"
    | "thread_status_changed"
    | "thread_archived"
    | "thread_unarchived"
    | "item_started"
    | "item_completed"
    | "progress"
    | "hook_started"
    | "hook_completed"
    | "terminal_interaction"
    | "server_request_resolved"
    | "config_warning"
    | "deprecation_notice"
    | "model_rerouted"
    | "skills_changed"
    | "final_message_available"
    | "plan_updated"
    | "plan_delta"
    | "command_output"
    | "file_change_output"
    | "agent_message_delta"
    | "turn_aborted"
    | "error"
    | "other";
  method: string;
  threadId: string | null;
  turnId: string | null;
}

export interface ThreadStartedNotification extends ClassifiedNotificationBase {
  kind: "thread_started";
  agentNickname: string | null;
  agentRole: string | null;
  threadName: string | null;
}

export interface ThreadNameUpdatedNotification extends ClassifiedNotificationBase {
  kind: "thread_name_updated";
  threadName: string | null;
}

export interface ThreadTokenUsageUpdatedNotification extends ClassifiedNotificationBase {
  kind: "thread_token_usage_updated";
  tokenUsage: TokenUsageSnapshot | null;
}

export interface ThreadCompactedNotification extends ClassifiedNotificationBase {
  kind: "thread_compacted";
}

export interface TurnStartedNotification extends ClassifiedNotificationBase {
  kind: "turn_started";
}

export interface TurnCompletedNotification extends ClassifiedNotificationBase {
  kind: "turn_completed";
  status: string;
}

export interface TurnDiffUpdatedNotification extends ClassifiedNotificationBase {
  kind: "turn_diff_updated";
  diff: string | null;
}

export interface ThreadStatusChangedNotification extends ClassifiedNotificationBase {
  kind: "thread_status_changed";
  status: ThreadRuntimeState;
  activeFlags: string[];
}

export interface ThreadArchivedNotification extends ClassifiedNotificationBase {
  kind: "thread_archived";
}

export interface ThreadUnarchivedNotification extends ClassifiedNotificationBase {
  kind: "thread_unarchived";
}

export interface ItemStartedNotification extends ClassifiedNotificationBase {
  kind: "item_started";
  itemId: string | null;
  itemType: string | null;
  label: string | null;
  collabTool: string | null;
  collabAgentStates: CollabAgentStateUpdate[];
}

export interface ItemCompletedNotification extends ClassifiedNotificationBase {
  kind: "item_completed";
  itemId: string | null;
  itemType: string | null;
  itemText: string | null;
  itemPhase: MessagePhase | null;
  collabTool: string | null;
  collabAgentStates: CollabAgentStateUpdate[];
}

export interface ProgressNotification extends ClassifiedNotificationBase {
  kind: "progress";
  itemId: string | null;
  message: string | null;
}

export interface HookRunSummary {
  id: string | null;
  eventName: string | null;
  executionMode: string | null;
  handlerType: string | null;
  scope: string | null;
  status: string | null;
  statusMessage: string | null;
  durationMs: number | null;
  sourcePath: string | null;
  entries: Array<{
    kind: string | null;
    text: string | null;
  }>;
}

export interface HookNotification extends ClassifiedNotificationBase {
  kind: "hook_started" | "hook_completed";
  run: HookRunSummary;
}

export interface TerminalInteractionNotification extends ClassifiedNotificationBase {
  kind: "terminal_interaction";
  itemId: string | null;
  processId: string | null;
  stdin: string | null;
}

export interface ServerRequestResolvedNotification extends ClassifiedNotificationBase {
  kind: "server_request_resolved";
  requestId: JsonRpcRequestId | null;
}

export interface ConfigWarningNotification extends ClassifiedNotificationBase {
  kind: "config_warning";
  summary: string | null;
  detail: string | null;
}

export interface DeprecationNoticeNotification extends ClassifiedNotificationBase {
  kind: "deprecation_notice";
  summary: string | null;
  detail: string | null;
}

export interface ModelReroutedNotification extends ClassifiedNotificationBase {
  kind: "model_rerouted";
  fromModel: string | null;
  toModel: string | null;
  reason: string | null;
}

export interface SkillsChangedNotification extends ClassifiedNotificationBase {
  kind: "skills_changed";
}

export interface FinalMessageAvailableNotification extends ClassifiedNotificationBase {
  kind: "final_message_available";
  message: string | null;
}

export interface PlanUpdatedNotification extends ClassifiedNotificationBase {
  kind: "plan_updated";
  entries: string[];
}

export interface PlanDeltaNotification extends ClassifiedNotificationBase {
  kind: "plan_delta";
  message: string | null;
}

export interface CommandOutputNotification extends ClassifiedNotificationBase {
  kind: "command_output";
  itemId: string | null;
  text: string | null;
}

export interface FileChangeOutputNotification extends ClassifiedNotificationBase {
  kind: "file_change_output";
  itemId: string | null;
  text: string | null;
}

export interface AgentMessageDeltaNotification extends ClassifiedNotificationBase {
  kind: "agent_message_delta";
  itemId: string | null;
  text: string | null;
}

export interface TurnAbortedNotification extends ClassifiedNotificationBase {
  kind: "turn_aborted";
}

export interface ErrorNotification extends ClassifiedNotificationBase {
  kind: "error";
  code: string | null;
  message: string | null;
}

export interface OtherNotification extends ClassifiedNotificationBase {
  kind: "other";
  params: unknown;
}

export type ClassifiedNotification =
  | ThreadStartedNotification
  | ThreadNameUpdatedNotification
  | ThreadTokenUsageUpdatedNotification
  | ThreadCompactedNotification
  | TurnStartedNotification
  | TurnCompletedNotification
  | TurnDiffUpdatedNotification
  | ThreadStatusChangedNotification
  | ThreadArchivedNotification
  | ThreadUnarchivedNotification
  | ItemStartedNotification
  | ItemCompletedNotification
  | ProgressNotification
  | HookNotification
  | TerminalInteractionNotification
  | ServerRequestResolvedNotification
  | ConfigWarningNotification
  | DeprecationNoticeNotification
  | ModelReroutedNotification
  | SkillsChangedNotification
  | FinalMessageAvailableNotification
  | PlanUpdatedNotification
  | PlanDeltaNotification
  | CommandOutputNotification
  | FileChangeOutputNotification
  | AgentMessageDeltaNotification
  | TurnAbortedNotification
  | ErrorNotification
  | OtherNotification;
