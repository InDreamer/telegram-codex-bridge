export const CONSOLE_API_VERSION = "2026-05-01.phase3" as const;

export const CONSOLE_OPAQUE_ID_PREFIXES = {
  project: "prj",
  session: "ses",
  message: "msg",
  run: "run",
  approval: "apr",
  artifact: "art"
} as const;

export type ConsoleOpaqueIdKind = keyof typeof CONSOLE_OPAQUE_ID_PREFIXES;
type ConsoleOpaqueIdPrefix<K extends ConsoleOpaqueIdKind> = (typeof CONSOLE_OPAQUE_ID_PREFIXES)[K];
export type ConsoleOpaqueIdFor<K extends ConsoleOpaqueIdKind> = `${ConsoleOpaqueIdPrefix<K>}_${string}`;

export type ConsoleProjectId = ConsoleOpaqueIdFor<"project">;
export type ConsoleSessionId = ConsoleOpaqueIdFor<"session">;
export type ConsoleMessageId = ConsoleOpaqueIdFor<"message">;
export type ConsoleRunId = ConsoleOpaqueIdFor<"run">;
export type ConsoleApprovalId = ConsoleOpaqueIdFor<"approval">;
export type ConsoleArtifactId = ConsoleOpaqueIdFor<"artifact">;

export type ConsoleCapabilityState = "enabled" | "disabled" | "degraded";

export interface ConsoleCapability {
  state: ConsoleCapabilityState;
  reason?: string;
  ownerAction?: string;
}

export interface ConsoleCapabilities {
  archiveProject: ConsoleCapability;
  createSession: ConsoleCapability;
  sendMessage: ConsoleCapability;
  answerApproval: ConsoleCapability;
  uploadFiles: ConsoleCapability;
  streamEvents: ConsoleCapability;
  fetchArtifacts: ConsoleCapability;
}

export interface ConsoleDegradedState {
  code: string;
  title: string;
  body: string;
  ownerAction?: string;
  since?: string;
}

export interface ConsoleBootstrap {
  apiVersion: typeof CONSOLE_API_VERSION;
  generatedAt: string;
  viewer: ConsoleViewer;
  capabilities: ConsoleCapabilities;
  projects: ConsoleProject[];
  activeProjectId?: ConsoleProjectId;
  activeSessionId?: ConsoleSessionId;
  commands: ConsoleCommandSummary[];
  models: ConsoleSelectorOption[];
  modes: ConsoleSelectorOption[];
  degradedStates: ConsoleDegradedState[];
}

export interface ConsoleViewer {
  role: "owner";
  displayName?: string;
}

export interface ConsoleCommandSummary {
  name: string;
  label: string;
  enabled: boolean;
}

export interface ConsoleSelectorOption {
  value: string;
  label: string;
  enabled: boolean;
}

export interface ConsoleProject {
  projectId: ConsoleProjectId;
  title: string;
  branch?: string;
  hint?: string;
  archived: boolean;
  sessionCount: number;
  activeSessionId?: ConsoleSessionId;
  lastActivityAt?: string;
}

export interface ConsoleArchiveProjectRequest {
  projectId: ConsoleProjectId;
}

export interface ConsoleCreateSessionRequest {
  projectId: ConsoleProjectId;
  title?: string;
}

export type ConsoleSessionStatus =
  | "empty"
  | "idle"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "archived";

export interface ConsoleSessionSummary {
  sessionId: ConsoleSessionId;
  projectId: ConsoleProjectId;
  title: string;
  status: ConsoleSessionStatus;
  archived: boolean;
  createdAt: string;
  lastActivityAt?: string;
  lastMessagePreview?: string;
  activeRunId?: ConsoleRunId;
  pendingApprovalCount: number;
  artifactCount: number;
}

export interface ConsoleSessionDetail extends ConsoleSessionSummary {
  messages: ConsoleMessage[];
  activeRun?: ConsoleRunState;
  diffs: ConsoleDiffSummary[];
  approvals: ConsoleApprovalRequest[];
  artifacts: ConsoleArtifactSummary[];
  eventsUrl: `/api/sessions/${ConsoleSessionId}/events`;
}

export type ConsoleMessageRole = "user" | "assistant" | "system";
export type ConsoleMessageFormat = "plain_text" | "markdown";
export type ConsoleMessageStatus = "pending" | "streaming" | "complete" | "failed";

export interface ConsoleMessage {
  messageId: ConsoleMessageId;
  sessionId: ConsoleSessionId;
  role: ConsoleMessageRole;
  text: string;
  format: ConsoleMessageFormat;
  status: ConsoleMessageStatus;
  createdAt: string;
  updatedAt?: string;
  runId?: ConsoleRunId;
  approvalIds?: ConsoleApprovalId[];
  artifactIds?: ConsoleArtifactId[];
}

export type ConsoleRunStatus =
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface ConsoleRunState {
  runId: ConsoleRunId;
  sessionId: ConsoleSessionId;
  title: string;
  status: ConsoleRunStatus;
  progressLabel?: string;
  progressPercent?: number;
  steps: ConsoleRunStep[];
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
}

export type ConsoleRunStepState = "pending" | "active" | "done" | "failed" | "skipped";

export interface ConsoleRunStep {
  order: number;
  label: string;
  state: ConsoleRunStepState;
  summary?: string;
}

export interface ConsoleDiffSummary {
  sessionId: ConsoleSessionId;
  runId?: ConsoleRunId;
  title: string;
  status: "preview" | "applied" | "discarded";
  totals: ConsoleDiffTotals;
  files: ConsoleDiffFileSummary[];
}

export interface ConsoleDiffTotals {
  changedFiles: number;
  added: number;
  removed: number;
}

export interface ConsoleDiffFileSummary {
  displayName: string;
  status: "created" | "modified" | "deleted" | "renamed";
  added: number;
  removed: number;
}

export type ConsoleApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ConsoleApprovalKind = "command" | "file_change" | "network" | "external_action" | "other";
export type ConsoleApprovalAnswer = "approve" | "deny";

export interface ConsoleApprovalRequest {
  approvalId: ConsoleApprovalId;
  sessionId: ConsoleSessionId;
  runId?: ConsoleRunId;
  title: string;
  body: string;
  kind: ConsoleApprovalKind;
  status: ConsoleApprovalStatus;
  requestedAt: string;
  expiresAt?: string;
  options: ConsoleApprovalOption[];
}

export interface ConsoleApprovalOption {
  answer: ConsoleApprovalAnswer;
  label: string;
  style: "primary" | "secondary" | "danger";
}

export interface ConsoleApprovalAnswerRequest {
  answer: ConsoleApprovalAnswer;
  scope?: "single" | "all_pending_in_session";
  reason?: string;
}

export interface ConsoleApprovalAnswerResult {
  approvalId: ConsoleApprovalId;
  sessionId: ConsoleSessionId;
  status: "approved" | "denied";
  answeredAt: string;
}

export type ConsoleArtifactKind = "changed_file" | "generated_file" | "diff" | "run_summary" | "attachment";
export type ConsoleArtifactStatus = "pending" | "ready" | "failed";

export interface ConsoleArtifactSummary {
  artifactId: ConsoleArtifactId;
  sessionId: ConsoleSessionId;
  runId?: ConsoleRunId;
  kind: ConsoleArtifactKind;
  status: ConsoleArtifactStatus;
  title: string;
  displayName: string;
  mediaType?: string;
  sizeBytes?: number;
  url: `/api/artifacts/${ConsoleArtifactId}`;
  files?: ConsoleArtifactFileSummary[];
}

export interface ConsoleArtifactFileSummary {
  displayName: string;
  status: "created" | "modified" | "deleted" | "generated";
  added?: number;
  removed?: number;
}

export interface ConsoleArtifactDetail extends ConsoleArtifactSummary {
  textPreview?: string;
}

export interface ConsoleSendMessageRequest {
  text: string;
  model?: string;
  mode?: string;
  attachmentArtifactIds?: ConsoleArtifactId[];
}

export interface ConsoleSendMessageResult {
  accepted: true;
  sessionId: ConsoleSessionId;
  message: ConsoleMessage;
  run?: ConsoleRunState;
  warnings?: ConsoleApiError[];
}

export const CONSOLE_EVENT_TYPES = [
  "message.created",
  "message.updated",
  "run.started",
  "run.updated",
  "run.completed",
  "run.failed",
  "diff.updated",
  "approval.requested",
  "approval.answered",
  "artifact.created",
  "artifact.updated",
  "session.created",
  "session.updated",
  "session.archived",
  "error"
] as const;

export type ConsoleEventType = (typeof CONSOLE_EVENT_TYPES)[number];

interface ConsoleEventBase {
  type: ConsoleEventType;
  sequence: number;
  createdAt: string;
}

export type ConsoleEvent =
  | (ConsoleEventBase & {
      type: "message.created" | "message.updated";
      sessionId: ConsoleSessionId;
      message: ConsoleMessage;
    })
  | (ConsoleEventBase & {
      type: "run.started" | "run.updated" | "run.completed" | "run.failed";
      sessionId: ConsoleSessionId;
      run: ConsoleRunState;
    })
  | (ConsoleEventBase & {
      type: "diff.updated";
      sessionId: ConsoleSessionId;
      diff: ConsoleDiffSummary;
    })
  | (ConsoleEventBase & {
      type: "approval.requested" | "approval.answered";
      sessionId: ConsoleSessionId;
      approval: ConsoleApprovalRequest;
    })
  | (ConsoleEventBase & {
      type: "artifact.created" | "artifact.updated";
      sessionId: ConsoleSessionId;
      artifact: ConsoleArtifactSummary;
    })
  | (ConsoleEventBase & {
      type: "session.created" | "session.updated" | "session.archived";
      session: ConsoleSessionSummary;
    })
  | (ConsoleEventBase & {
      type: "error";
      sessionId?: ConsoleSessionId;
      error: ConsoleApiError;
    });

export interface ConsoleApiError {
  code:
    | "bad_request"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "capability_disabled"
    | "conflict"
    | "rate_limited"
    | "bridge_unavailable"
    | "internal_error";
  message: string;
  retryable: boolean;
  capability?: keyof ConsoleCapabilities;
}

export function isConsoleOpaqueId<K extends ConsoleOpaqueIdKind>(
  kind: K,
  value: unknown
): value is ConsoleOpaqueIdFor<K> {
  if (typeof value !== "string") {
    return false;
  }

  const prefix = CONSOLE_OPAQUE_ID_PREFIXES[kind];
  const pattern = new RegExp(`^${prefix}_(?=[A-Za-z0-9_-]{6,128}$)(?=.*[A-Za-z])(?=.*\\d)[A-Za-z0-9][A-Za-z0-9_-]*$`);
  const rawIdMarker = /\b(?:telegram|feishu|callback|chat|open_id|union_id|tenant|pid|process|raw)\b/i;
  return pattern.test(value) && !rawIdMarker.test(value);
}

export function assertConsoleOpaqueId<K extends ConsoleOpaqueIdKind>(
  kind: K,
  value: unknown,
  fieldName = "id"
): ConsoleOpaqueIdFor<K> {
  if (!isConsoleOpaqueId(kind, value)) {
    throw new TypeError(`${fieldName} must be an opaque ${kind} console id`);
  }
  return value as ConsoleOpaqueIdFor<K>;
}

const unsafeConsoleStringPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "absolute local path", pattern: /(^|[\s"'(])(?:\/(?:home|tmp|var|etc|root|Users)\/|[A-Za-z]:\\)/ },
  {
    label: "secret-bearing string",
    pattern: /\b(?:token|authorization|bearer|api[_-]?key|secret|password)\s*[:=]|\b(?:sk|xox[baprs])-[A-Za-z0-9_-]{8,}/i
  },
  {
    label: "platform-specific identifier",
    pattern:
      /\b(?:(?:telegram|feishu)[_-]?(?:chat|message|user|open|union|tenant)?[_-]?id|chat[_-]?id|callback[_-]?data|open[_-]?id|union[_-]?id|tenant[_-]?key)\b/i
  },
  { label: "process identifier", pattern: /\b(?:pid|process[_-]?id)\s*[:=]?\s*\d{2,}\b/i },
  { label: "terminal escape sequence", pattern: /\x1b\[[0-9;?]*[ -/]*[@-~]/ },
  { label: "raw numeric identifier", pattern: /^-?\d{8,}$/ }
];

export function assertConsoleSafeString(value: string, fieldName = "value"): string {
  for (const { label, pattern } of unsafeConsoleStringPatterns) {
    if (pattern.test(value)) {
      throw new TypeError(`${fieldName} contains ${label}`);
    }
  }
  return value;
}
