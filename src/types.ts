export type BridgeReadinessState =
  | "ready"
  | "awaiting_authorization"
  | "codex_not_authenticated"
  | "app_server_unavailable"
  | "telegram_token_invalid"
  | "bridge_unhealthy";

export type SessionStatus = "idle" | "running" | "interrupted" | "failed";

export type FailureReason =
  | "bridge_restart"
  | "app_server_lost"
  | "turn_failed"
  | "unknown";

export type RecentProjectSource = "mru" | "pin" | "scan" | "last_success";

export interface ReadinessDetails {
  codexInstalled: boolean;
  codexAuthenticated: boolean;
  appServerAvailable: boolean;
  telegramTokenValid: boolean;
  authorizedUserBound: boolean;
  issues: string[];
  codexVersion?: string;
  codexLoginStatus?: string;
  telegramBotUsername?: string;
  telegramBotId?: string;
  systemdAvailable?: boolean;
}

export interface ReadinessSnapshot {
  state: BridgeReadinessState;
  checkedAt: string;
  details: ReadinessDetails;
  appServerPid?: string | null;
}

export interface AuthorizedUserRow {
  telegramUserId: string;
  telegramUsername: string | null;
  displayName: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface PendingAuthorizationRow {
  telegramUserId: string;
  telegramChatId: string;
  telegramUsername: string | null;
  displayName: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  expired: boolean;
}

export interface ChatBindingRow {
  telegramChatId: string;
  telegramUserId: string;
  activeSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InstallManifest {
  version: string;
  sourceRoot: string | null;
  installedAt: string;
}

export interface RuntimeNotice {
  key: string;
  telegramChatId: string;
  type: "bridge_restart_recovery";
  message: string;
  createdAt: string;
}

export interface SessionRow {
  sessionId: string;
  telegramChatId: string;
  threadId: string | null;
  displayName: string;
  projectName: string;
  projectPath: string;
  status: SessionStatus;
  failureReason: FailureReason | null;
  createdAt: string;
  lastUsedAt: string;
  lastTurnId: string | null;
  lastTurnStatus: string | null;
}

export interface RecentProjectRow {
  projectPath: string;
  projectName: string;
  lastUsedAt: string;
  pinned: boolean;
  lastSessionId: string | null;
  lastSuccessAt: string | null;
  source: RecentProjectSource;
}

export interface ProjectScanCacheRow {
  projectPath: string;
  projectName: string;
  scanRoot: string;
  confidence: number;
  detectedMarkers: string[];
  lastScannedAt: string;
  existsNow: boolean;
}

export interface SessionProjectStatsRow {
  projectPath: string;
  projectName: string;
  sessionCount: number;
  lastUsedAt: string | null;
}

export interface ProjectCandidate {
  projectKey: string;
  projectPath: string;
  projectName: string;
  score: number;
  pinned: boolean;
  hasExistingSession: boolean;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  accessible: boolean;
  fromScan: boolean;
  detectedMarkers: string[];
}

export interface ProjectPickerResult {
  title: string;
  emptyText: string | null;
  primary: ProjectCandidate | null;
  frequent: ProjectCandidate[];
  partial: boolean;
  allRootsFailed: boolean;
  projectMap: Map<string, ProjectCandidate>;
}
