import type { FailureReason } from "../types.js";

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
  | "webSearch"
  | "agentMessage"
  | "reasoning"
  | "other";

export type ThreadBlockedReason = "waitingOnApproval" | "waitingOnUserInput" | null;

export type HighValueEventType = "ran_cmd" | "found" | "changed" | "blocked" | "done";

export type ActivityErrorState =
  | FailureReason
  | "codex_not_authenticated"
  | "app_server_unavailable"
  | "unknown"
  | null;

export interface ActivityStatus {
  turnStatus: TurnStatus;
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
  planSnapshot: string[];
  completedCommentary: string[];
}

export type MessagePhase = "commentary" | "final_answer";

export interface DebugJournalRecord {
  receivedAt: string;
  threadId: string | null;
  turnId: string | null;
  method: string;
  params: unknown;
}

interface ClassifiedNotificationBase {
  kind:
    | "turn_started"
    | "turn_completed"
    | "thread_status_changed"
    | "thread_archived"
    | "thread_unarchived"
    | "item_started"
    | "item_completed"
    | "progress"
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

export interface TurnStartedNotification extends ClassifiedNotificationBase {
  kind: "turn_started";
}

export interface TurnCompletedNotification extends ClassifiedNotificationBase {
  kind: "turn_completed";
  status: string;
}

export interface ThreadStatusChangedNotification extends ClassifiedNotificationBase {
  kind: "thread_status_changed";
  status: string | null;
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
}

export interface ItemCompletedNotification extends ClassifiedNotificationBase {
  kind: "item_completed";
  itemId: string | null;
  itemType: string | null;
  itemText: string | null;
  itemPhase: MessagePhase | null;
}

export interface ProgressNotification extends ClassifiedNotificationBase {
  kind: "progress";
  itemId: string | null;
  message: string | null;
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
  | TurnStartedNotification
  | TurnCompletedNotification
  | ThreadStatusChangedNotification
  | ThreadArchivedNotification
  | ThreadUnarchivedNotification
  | ItemStartedNotification
  | ItemCompletedNotification
  | ProgressNotification
  | FinalMessageAvailableNotification
  | PlanUpdatedNotification
  | PlanDeltaNotification
  | CommandOutputNotification
  | FileChangeOutputNotification
  | AgentMessageDeltaNotification
  | TurnAbortedNotification
  | ErrorNotification
  | OtherNotification;
