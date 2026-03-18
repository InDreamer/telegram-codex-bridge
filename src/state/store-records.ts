import type {
  AuthorizedUserRow,
  ChatBindingRow,
  FailureReason,
  PendingAuthorizationRow,
  ProjectScanCacheRow,
  RecentProjectRow,
  RecentProjectSource,
  ReasoningEffort,
  SessionProjectStatsRow,
  SessionRow,
  SessionStatus
} from "../types.js";

const PENDING_AUTH_TTL_MS = 24 * 60 * 60 * 1000;

export interface PendingAuthorizationRecord {
  telegram_user_id: string;
  telegram_chat_id: string;
  telegram_username: string | null;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface AuthorizedUserRecord {
  telegram_user_id: string;
  telegram_username: string | null;
  display_name: string | null;
  first_seen_at: string;
  updated_at: string;
}

export interface ChatBindingRecord {
  telegram_chat_id: string;
  telegram_user_id: string;
  active_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SessionRecord {
  session_id: string;
  telegram_chat_id: string;
  thread_id: string | null;
  selected_model: string | null;
  selected_reasoning_effort: ReasoningEffort | null;
  plan_mode?: number;
  pending_default_collaboration_mode_reset?: number;
  display_name: string;
  project_name: string;
  project_alias?: string | null;
  project_path: string;
  status: SessionStatus;
  failure_reason: FailureReason | null;
  archived: number;
  archived_at: string | null;
  created_at: string;
  last_used_at: string;
  last_turn_id: string | null;
  last_turn_status: string | null;
}

export interface RecentProjectRecord {
  project_path: string;
  project_name: string;
  project_alias: string | null;
  last_used_at: string;
  pinned: number;
  last_session_id: string | null;
  last_success_at: string | null;
  source: RecentProjectSource;
}

export interface ProjectScanCacheRecord {
  project_path: string;
  project_name: string;
  scan_root: string;
  confidence: number;
  detected_markers: string;
  last_scanned_at: string;
  exists_now: number;
}

export interface SessionProjectStatsRecord {
  project_path: string;
  project_name: string;
  session_count: number;
  last_used_at: string | null;
}

function isExpired(lastSeenAt: string): boolean {
  return Date.now() - Date.parse(lastSeenAt) > PENDING_AUTH_TTL_MS;
}

export function mapPendingAuthorization(record: PendingAuthorizationRecord): PendingAuthorizationRow {
  return {
    telegramUserId: record.telegram_user_id,
    telegramChatId: record.telegram_chat_id,
    telegramUsername: record.telegram_username,
    displayName: record.display_name,
    firstSeenAt: record.first_seen_at,
    lastSeenAt: record.last_seen_at,
    expired: isExpired(record.last_seen_at)
  };
}

export function mapAuthorizedUser(record: AuthorizedUserRecord): AuthorizedUserRow {
  return {
    telegramUserId: record.telegram_user_id,
    telegramUsername: record.telegram_username,
    displayName: record.display_name,
    firstSeenAt: record.first_seen_at,
    updatedAt: record.updated_at
  };
}

export function mapChatBinding(record: ChatBindingRecord): ChatBindingRow {
  return {
    telegramChatId: record.telegram_chat_id,
    telegramUserId: record.telegram_user_id,
    activeSessionId: record.active_session_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}

export function mapSession(record: SessionRecord): SessionRow {
  return {
    sessionId: record.session_id,
    telegramChatId: record.telegram_chat_id,
    threadId: record.thread_id,
    selectedModel: record.selected_model,
    selectedReasoningEffort: record.selected_reasoning_effort,
    planMode: record.plan_mode === 1,
    needsDefaultCollaborationModeReset: record.pending_default_collaboration_mode_reset === 1,
    displayName: record.display_name,
    projectName: record.project_name,
    projectAlias: record.project_alias ?? null,
    projectPath: record.project_path,
    status: record.status,
    failureReason: record.failure_reason,
    archived: record.archived === 1,
    archivedAt: record.archived_at,
    createdAt: record.created_at,
    lastUsedAt: record.last_used_at,
    lastTurnId: record.last_turn_id,
    lastTurnStatus: record.last_turn_status
  };
}

export function mapRecentProject(record: RecentProjectRecord): RecentProjectRow {
  return {
    projectPath: record.project_path,
    projectName: record.project_name,
    projectAlias: record.project_alias,
    lastUsedAt: record.last_used_at,
    pinned: record.pinned === 1,
    lastSessionId: record.last_session_id,
    lastSuccessAt: record.last_success_at,
    source: record.source
  };
}

export function mapProjectScanCache(record: ProjectScanCacheRecord): ProjectScanCacheRow {
  return {
    projectPath: record.project_path,
    projectName: record.project_name,
    scanRoot: record.scan_root,
    confidence: record.confidence,
    detectedMarkers: JSON.parse(record.detected_markers) as string[],
    lastScannedAt: record.last_scanned_at,
    existsNow: record.exists_now === 1
  };
}

export function mapSessionProjectStats(record: SessionProjectStatsRecord): SessionProjectStatsRow {
  return {
    projectPath: record.project_path,
    projectName: record.project_name,
    sessionCount: Number(record.session_count),
    lastUsedAt: record.last_used_at
  };
}

export function sessionSelectColumns(sessionAlias: string, recentAlias: string): string {
  return [
    `${sessionAlias}.session_id AS session_id`,
    `${sessionAlias}.telegram_chat_id AS telegram_chat_id`,
    `${sessionAlias}.thread_id AS thread_id`,
    `${sessionAlias}.selected_model AS selected_model`,
    `${sessionAlias}.selected_reasoning_effort AS selected_reasoning_effort`,
    `${sessionAlias}.plan_mode AS plan_mode`,
    `${sessionAlias}.pending_default_collaboration_mode_reset AS pending_default_collaboration_mode_reset`,
    `${sessionAlias}.display_name AS display_name`,
    `${sessionAlias}.project_name AS project_name`,
    `${recentAlias}.project_alias AS project_alias`,
    `${sessionAlias}.project_path AS project_path`,
    `${sessionAlias}.status AS status`,
    `${sessionAlias}.failure_reason AS failure_reason`,
    `${sessionAlias}.archived AS archived`,
    `${sessionAlias}.archived_at AS archived_at`,
    `${sessionAlias}.created_at AS created_at`,
    `${sessionAlias}.last_used_at AS last_used_at`,
    `${sessionAlias}.last_turn_id AS last_turn_id`,
    `${sessionAlias}.last_turn_status AS last_turn_status`
  ].join(",\n            ");
}

export function choosePreferredActiveSessionId(
  bindings: Array<Pick<ChatBindingRow, "activeSessionId" | "updatedAt">>
): string | null {
  const preferred = bindings
    .filter((binding) => binding.activeSessionId !== null)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

  return preferred?.activeSessionId ?? null;
}

export function resolveSessionListOptions(
  limitOrOptions?: number | { archived?: boolean; limit?: number }
): {
  archived: boolean;
  limit: number;
} {
  if (typeof limitOrOptions === "number") {
    return {
      archived: false,
      limit: limitOrOptions
    };
  }

  return {
    archived: limitOrOptions?.archived ?? false,
    limit: limitOrOptions?.limit ?? 10
  };
}
