import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import type {
  AuthorizedUserRow,
  ChatBindingRow,
  FailureReason,
  FinalAnswerViewRow,
  PendingInteractionKind,
  PendingInteractionRow,
  PendingInteractionState,
  PendingAuthorizationRow,
  ProjectScanCacheRow,
  ReadinessSnapshot,
  RecentProjectRow,
  RecentProjectSource,
  RuntimeNotice,
  SessionProjectStatsRow,
  SessionRow,
  SessionStatus
} from "../types.js";

const PENDING_AUTH_TTL_MS = 24 * 60 * 60 * 1000;

export type StateStoreOpenStage =
  | "open_db"
  | "initialize_schema"
  | "verify_integrity"
  | "normalize_active_sessions";

export type StateStoreFailureClassification =
  | "transient_open_failure"
  | "integrity_failure"
  | "schema_failure";

export interface StateStoreFailureRecord {
  detectedAt: string;
  dbPath: string;
  stage: StateStoreOpenStage;
  classification: StateStoreFailureClassification;
  error: string;
  recommendedAction: string;
}

export class StateStoreOpenError extends Error {
  readonly failure: StateStoreFailureRecord;

  constructor(failure: StateStoreFailureRecord) {
    super(`state store open failed (${failure.classification} at ${failure.stage}): ${failure.error}`);
    this.name = "StateStoreOpenError";
    this.failure = failure;
  }
}

interface PendingAuthorizationRecord {
  telegram_user_id: string;
  telegram_chat_id: string;
  telegram_username: string | null;
  display_name: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface AuthorizedUserRecord {
  telegram_user_id: string;
  telegram_username: string | null;
  display_name: string | null;
  first_seen_at: string;
  updated_at: string;
}

interface ReadinessRecord {
  readiness_state: ReadinessSnapshot["state"];
  details_json: string;
  checked_at: string;
  app_server_pid: string | null;
}

interface ChatBindingRecord {
  telegram_chat_id: string;
  telegram_user_id: string;
  active_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRecord {
  session_id: string;
  telegram_chat_id: string;
  thread_id: string | null;
  selected_model: string | null;
  display_name: string;
  project_name: string;
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

interface RecentProjectRecord {
  project_path: string;
  project_name: string;
  last_used_at: string;
  pinned: number;
  last_session_id: string | null;
  last_success_at: string | null;
  source: RecentProjectSource;
}

interface ProjectScanCacheRecord {
  project_path: string;
  project_name: string;
  scan_root: string;
  confidence: number;
  detected_markers: string;
  last_scanned_at: string;
  exists_now: number;
}

interface SessionProjectStatsRecord {
  project_path: string;
  project_name: string;
  session_count: number;
  last_used_at: string | null;
}

interface RuntimeNoticeRecord {
  key: string;
  telegram_chat_id: string;
  type: "bridge_restart_recovery" | "app_server_notice";
  message: string;
  created_at: string;
}

interface FinalAnswerViewRecord {
  answer_id: string;
  telegram_chat_id: string;
  telegram_message_id: number | null;
  session_id: string;
  thread_id: string;
  turn_id: string;
  preview_html: string;
  pages_json: string;
  created_at: string;
}

interface PendingInteractionRecord {
  interaction_id: string;
  telegram_chat_id: string;
  session_id: string;
  thread_id: string;
  turn_id: string;
  request_id: string;
  request_method: string;
  interaction_kind: PendingInteractionKind;
  state: PendingInteractionState;
  prompt_json: string;
  response_json: string | null;
  telegram_message_id: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  error_reason: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isExpired(lastSeenAt: string): boolean {
  return Date.now() - Date.parse(lastSeenAt) > PENDING_AUTH_TTL_MS;
}

function mapPending(record: PendingAuthorizationRecord): PendingAuthorizationRow {
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

function mapAuthorizedUser(record: AuthorizedUserRecord): AuthorizedUserRow {
  return {
    telegramUserId: record.telegram_user_id,
    telegramUsername: record.telegram_username,
    displayName: record.display_name,
    firstSeenAt: record.first_seen_at,
    updatedAt: record.updated_at
  };
}

function mapChatBinding(record: ChatBindingRecord): ChatBindingRow {
  return {
    telegramChatId: record.telegram_chat_id,
    telegramUserId: record.telegram_user_id,
    activeSessionId: record.active_session_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
}

function mapSession(record: SessionRecord): SessionRow {
  return {
    sessionId: record.session_id,
    telegramChatId: record.telegram_chat_id,
    threadId: record.thread_id,
    selectedModel: record.selected_model,
    displayName: record.display_name,
    projectName: record.project_name,
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

function mapRecentProject(record: RecentProjectRecord): RecentProjectRow {
  return {
    projectPath: record.project_path,
    projectName: record.project_name,
    lastUsedAt: record.last_used_at,
    pinned: record.pinned === 1,
    lastSessionId: record.last_session_id,
    lastSuccessAt: record.last_success_at,
    source: record.source
  };
}

function mapProjectScanCache(record: ProjectScanCacheRecord): ProjectScanCacheRow {
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

function mapSessionProjectStats(record: SessionProjectStatsRecord): SessionProjectStatsRow {
  return {
    projectPath: record.project_path,
    projectName: record.project_name,
    sessionCount: Number(record.session_count),
    lastUsedAt: record.last_used_at
  };
}

function mapRuntimeNotice(record: RuntimeNoticeRecord): RuntimeNotice {
  return {
    key: record.key,
    telegramChatId: record.telegram_chat_id,
    type: record.type,
    message: record.message,
    createdAt: record.created_at
  };
}

function mapFinalAnswerView(record: FinalAnswerViewRecord): FinalAnswerViewRow {
  return {
    answerId: record.answer_id,
    telegramChatId: record.telegram_chat_id,
    telegramMessageId: record.telegram_message_id,
    sessionId: record.session_id,
    threadId: record.thread_id,
    turnId: record.turn_id,
    previewHtml: record.preview_html,
    pages: JSON.parse(record.pages_json) as string[],
    createdAt: record.created_at
  };
}

function mapPendingInteraction(record: PendingInteractionRecord): PendingInteractionRow {
  return {
    interactionId: record.interaction_id,
    telegramChatId: record.telegram_chat_id,
    sessionId: record.session_id,
    threadId: record.thread_id,
    turnId: record.turn_id,
    requestId: record.request_id,
    requestMethod: record.request_method,
    interactionKind: record.interaction_kind,
    state: record.state,
    promptJson: record.prompt_json,
    responseJson: record.response_json,
    telegramMessageId: record.telegram_message_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    resolvedAt: record.resolved_at,
    errorReason: record.error_reason
  };
}

function choosePreferredActiveSessionId(bindings: ChatBindingRecord[]): string | null {
  const preferred = bindings
    .filter((binding) => binding.active_session_id !== null)
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0];

  return preferred?.active_session_id ?? null;
}

function initialSchema(): string {
  return `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authorized_user (
      telegram_user_id TEXT PRIMARY KEY,
      telegram_username TEXT NULL,
      display_name TEXT NULL,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_authorization (
      telegram_user_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      telegram_username TEXT NULL,
      display_name TEXT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_binding (
      telegram_chat_id TEXT PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      active_session_id TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session (
      session_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      thread_id TEXT NULL,
      selected_model TEXT NULL,
      display_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      last_turn_id TEXT NULL,
      last_turn_status TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_project (
      project_path TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT NULL,
      last_success_at TEXT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_scan_cache (
      project_path TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      scan_root TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      detected_markers TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL,
      exists_now INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bootstrap_state (
      key TEXT PRIMARY KEY,
      readiness_state TEXT NOT NULL,
      details_json TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      app_server_pid TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_notice (
      key TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS final_answer_view (
      answer_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      telegram_message_id INTEGER NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      preview_html TEXT NOT NULL,
      pages_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_interaction (
      interaction_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_method TEXT NOT NULL,
      interaction_kind TEXT NOT NULL,
      state TEXT NOT NULL,
      prompt_json TEXT NOT NULL,
      response_json TEXT NULL,
      telegram_message_id INTEGER NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT NULL,
      error_reason TEXT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pending_authorization_last_seen
      ON pending_authorization(last_seen_at DESC);

    CREATE INDEX IF NOT EXISTS idx_session_chat_id
      ON session(telegram_chat_id);

    CREATE INDEX IF NOT EXISTS idx_final_answer_view_chat_created_at
      ON final_answer_view(telegram_chat_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pending_interaction_chat_state
      ON pending_interaction(telegram_chat_id, state, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pending_interaction_turn
      ON pending_interaction(thread_id, turn_id, created_at DESC);
  `;
}

const CURRENT_SCHEMA_VERSION = 5;

function listColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  return listColumns(db, tableName).includes(columnName);
}

function getAppliedMigrations(db: DatabaseSync): Set<number> {
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number | bigint }>;

  return new Set(rows.map((row) => Number(row.version)));
}

function recordMigration(db: DatabaseSync, version: number): void {
  db.prepare(
    `
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `
  ).run(version, nowIso());
}

function applyMigrations(db: DatabaseSync): void {
  db.exec(
    `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `
  );

  const applied = getAppliedMigrations(db);

  if (!applied.has(1)) {
    // Version 1 is the historical bootstrap schema used before explicit migrations existed.
    db.exec(initialSchema());
    recordMigration(db, 1);
  }

  if (!applied.has(2)) {
    if (!hasColumn(db, "session", "archived")) {
      db.exec("ALTER TABLE session ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }

    if (!hasColumn(db, "session", "archived_at")) {
      db.exec("ALTER TABLE session ADD COLUMN archived_at TEXT NULL");
    }

    recordMigration(db, 2);
  }

  if (!applied.has(3)) {
    db.exec(
      `
        CREATE TABLE IF NOT EXISTS final_answer_view (
          answer_id TEXT PRIMARY KEY,
          telegram_chat_id TEXT NOT NULL,
          telegram_message_id INTEGER NULL,
          session_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          preview_html TEXT NOT NULL,
          pages_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
      `
    );
    db.exec(
      `
        CREATE INDEX IF NOT EXISTS idx_final_answer_view_chat_created_at
          ON final_answer_view(telegram_chat_id, created_at DESC)
      `
    );

    recordMigration(db, 3);
  }

  if (!applied.has(4)) {
    db.exec(
      `
        CREATE TABLE IF NOT EXISTS pending_interaction (
          interaction_id TEXT PRIMARY KEY,
          telegram_chat_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          request_method TEXT NOT NULL,
          interaction_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          prompt_json TEXT NOT NULL,
          response_json TEXT NULL,
          telegram_message_id INTEGER NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT NULL,
          error_reason TEXT NULL
        )
      `
    );
    db.exec(
      `
        CREATE INDEX IF NOT EXISTS idx_pending_interaction_chat_state
          ON pending_interaction(telegram_chat_id, state, created_at DESC)
      `
    );
    db.exec(
      `
        CREATE INDEX IF NOT EXISTS idx_pending_interaction_turn
          ON pending_interaction(thread_id, turn_id, created_at DESC)
      `
    );

    recordMigration(db, 4);
  }

  if (!applied.has(5)) {
    if (!hasColumn(db, "session", "selected_model")) {
      db.exec("ALTER TABLE session ADD COLUMN selected_model TEXT NULL");
    }

    recordMigration(db, 5);
  }
}

function resolveSessionListOptions(limitOrOptions?: number | { archived?: boolean; limit?: number }): {
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

export class BridgeStateStore {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly logger: Logger,
    readonly recoveredFromCorruption: boolean
  ) {}

  static async open(paths: BridgePaths, logger: Logger): Promise<BridgeStateStore> {
    try {
      const store = this.openInitializedStore(paths.dbPath, logger, false);
      await clearStateStoreFailure(paths);
      return store;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        try {
          // First-run installs may be missing the state directory even though creating a new DB is safe.
          await mkdir(dirname(paths.dbPath), { recursive: true });
          const store = this.openInitializedStore(paths.dbPath, logger, false);
          await clearStateStoreFailure(paths);
          return store;
        } catch (retryError) {
          const failure = buildStateStoreFailure(paths.dbPath, getFailureStage(retryError), retryError);
          await persistStateStoreFailure(paths, failure, logger);
          await logStateStoreOpenFailure(logger, failure);
          throw new StateStoreOpenError(failure);
        }
      }

      // Any non-ENOENT failure must preserve the existing database and stop the service cold.
      const failure = buildStateStoreFailure(paths.dbPath, getFailureStage(error), error);
      await persistStateStoreFailure(paths, failure, logger);
      await logStateStoreOpenFailure(logger, failure);
      throw new StateStoreOpenError(failure);
    }
  }

  private static openInitializedStore(
    dbPath: string,
    logger: Logger,
    recoveredFromCorruption: boolean
  ): BridgeStateStore {
    const db = withFailureStage("open_db", () => new DatabaseSync(dbPath));

    try {
      withFailureStage("initialize_schema", () => initializeDatabase(db));
      withFailureStage("verify_integrity", () => verifyIntegrity(db));
      const store = new BridgeStateStore(db, logger, recoveredFromCorruption);
      withFailureStage("normalize_active_sessions", () => store.normalizeAllActiveSessions());
      return store;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Ignore close failures while surfacing the original open error.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private normalizeAllActiveSessions(): void {
    const bindings = this.listChatBindings();
    for (const binding of bindings) {
      this.normalizeActiveSession(binding.telegramChatId);
    }
  }

  getAuthorizedUser(): AuthorizedUserRow | null {
    const row = this.db
      .prepare("SELECT * FROM authorized_user ORDER BY updated_at DESC LIMIT 1")
      .get() as AuthorizedUserRecord | undefined;

    return row ? mapAuthorizedUser(row) : null;
  }

  getChatBinding(telegramChatId: string): ChatBindingRow | null {
    const row = this.db
      .prepare("SELECT * FROM chat_binding WHERE telegram_chat_id = ?")
      .get(telegramChatId) as ChatBindingRecord | undefined;

    return row ? mapChatBinding(row) : null;
  }

  listChatBindings(): ChatBindingRow[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_binding ORDER BY updated_at DESC, created_at DESC")
      .all() as unknown as ChatBindingRecord[];

    return rows.map(mapChatBinding);
  }

  listPendingAuthorizations(options?: { includeExpired?: boolean }): PendingAuthorizationRow[] {
    const includeExpired = options?.includeExpired ?? false;
    const rows = this.db
      .prepare(
        "SELECT * FROM pending_authorization ORDER BY last_seen_at DESC, first_seen_at DESC"
      )
      .all() as unknown as PendingAuthorizationRecord[];

    return rows
      .map(mapPending)
      .filter((row) => includeExpired || !row.expired);
  }

  upsertPendingAuthorization(candidate: {
    telegramUserId: string;
    telegramChatId: string;
    telegramUsername: string | null;
    displayName: string | null;
  }): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO pending_authorization (
            telegram_user_id,
            telegram_chat_id,
            telegram_username,
            display_name,
            first_seen_at,
            last_seen_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(telegram_user_id) DO UPDATE SET
            telegram_chat_id = excluded.telegram_chat_id,
            telegram_username = excluded.telegram_username,
            display_name = excluded.display_name,
            last_seen_at = excluded.last_seen_at
        `
      )
      .run(
        candidate.telegramUserId,
        candidate.telegramChatId,
        candidate.telegramUsername,
        candidate.displayName,
        timestamp,
        timestamp
      );
  }

  confirmPendingAuthorization(candidate: PendingAuthorizationRow): void {
    if (candidate.expired) {
      throw new Error("pending authorization candidate expired; ask the user to message the bot again");
    }

    const timestamp = nowIso();
    const previousSnapshot = this.getReadinessSnapshot();
    this.db.exec("BEGIN");

    try {
      const existingBindings = this.db
        .prepare(
          `
            SELECT *
            FROM chat_binding
            WHERE telegram_user_id = ?
            ORDER BY updated_at DESC, created_at DESC
          `
        )
        .all(candidate.telegramUserId) as unknown as ChatBindingRecord[];
      const previousChatIds = existingBindings.map((binding) => binding.telegram_chat_id);
      const migratedActiveSessionId = choosePreferredActiveSessionId(existingBindings);

      this.db
        .prepare(
          `
            INSERT OR REPLACE INTO authorized_user (
              telegram_user_id,
              telegram_username,
              display_name,
              first_seen_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(
          candidate.telegramUserId,
          candidate.telegramUsername,
          candidate.displayName,
          candidate.firstSeenAt,
          timestamp
        );

      if (previousChatIds.length > 0) {
        const placeholders = previousChatIds.map(() => "?").join(", ");
        // Rebind keeps prior sessions reachable by moving all user-owned chat data to the new chat id.
        this.db
          .prepare(
            `
              UPDATE session
              SET telegram_chat_id = ?
              WHERE telegram_chat_id IN (${placeholders})
            `
          )
          .run(candidate.telegramChatId, ...previousChatIds);

        this.db
          .prepare(
            `
              UPDATE runtime_notice
              SET telegram_chat_id = ?
              WHERE telegram_chat_id IN (${placeholders})
            `
          )
          .run(candidate.telegramChatId, ...previousChatIds);

        this.db
          .prepare(
            `
              UPDATE final_answer_view
              SET telegram_chat_id = ?
              WHERE telegram_chat_id IN (${placeholders})
            `
          )
          .run(candidate.telegramChatId, ...previousChatIds);

        if (appliedTableExists(this.db, "pending_interaction")) {
          this.db
            .prepare(
              `
                UPDATE pending_interaction
                SET telegram_chat_id = ?
                WHERE telegram_chat_id IN (${placeholders})
              `
            )
            .run(candidate.telegramChatId, ...previousChatIds);
        }

        this.db
          .prepare(
            `
              DELETE FROM chat_binding
              WHERE telegram_user_id = ?
            `
          )
          .run(candidate.telegramUserId);
      }

      this.db
        .prepare(
          `
            INSERT OR REPLACE INTO chat_binding (
              telegram_chat_id,
              telegram_user_id,
              active_session_id,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(
          candidate.telegramChatId,
          candidate.telegramUserId,
          migratedActiveSessionId,
          timestamp,
          timestamp
        );

      this.normalizeActiveSession(candidate.telegramChatId);

      this.db.prepare("DELETE FROM pending_authorization").run();

      if (previousSnapshot) {
        const nextState =
          previousSnapshot.details.codexAuthenticated &&
          previousSnapshot.details.telegramTokenValid &&
          previousSnapshot.details.appServerAvailable
            ? "ready"
            : previousSnapshot.state === "awaiting_authorization"
              ? "ready"
              : previousSnapshot.state;

        this.writeReadinessSnapshot({
          ...previousSnapshot,
          state: nextState,
          checkedAt: timestamp,
          details: {
            ...previousSnapshot.details,
            authorizedUserBound: true
          }
        });
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearAuthorization(): void {
    const previousSnapshot = this.getReadinessSnapshot();
    this.db.exec("BEGIN");

    try {
      this.db.prepare("DELETE FROM authorized_user").run();
      this.db.prepare("DELETE FROM chat_binding").run();
      this.db.prepare("DELETE FROM pending_authorization").run();
      this.db.prepare("DELETE FROM final_answer_view").run();
      if (appliedTableExists(this.db, "pending_interaction")) {
        this.db.prepare("DELETE FROM pending_interaction").run();
      }

      if (previousSnapshot) {
        this.writeReadinessSnapshot({
          ...previousSnapshot,
          state: "awaiting_authorization",
          checkedAt: nowIso(),
          details: {
            ...previousSnapshot.details,
            authorizedUserBound: false
          }
        });
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markRunningSessionsFailed(reason: FailureReason): number {
    const info = this.db
      .prepare(
        `
          UPDATE session
          SET status = 'failed', failure_reason = ?, last_turn_status = 'failed'
          WHERE status = 'running'
        `
      )
      .run(reason);

    return Number(info.changes ?? 0);
  }

  markRunningSessionsFailedWithNotices(reason: FailureReason): RuntimeNotice[] {
    const runningSessions = this.db
      .prepare("SELECT * FROM session WHERE status = 'running'")
      .all() as unknown as SessionRecord[];

    if (runningSessions.length === 0) {
      return [];
    }

    const timestamp = nowIso();
    this.db.exec("BEGIN");

    try {
      this.db
        .prepare(
          `
            UPDATE session
            SET
              status = 'failed',
              failure_reason = ?,
              last_turn_status = 'failed',
              last_used_at = ?
            WHERE status = 'running'
          `
        )
        .run(reason, timestamp);

      const insertNotice = this.db.prepare(
        `
          INSERT OR REPLACE INTO runtime_notice (
            key,
            telegram_chat_id,
            type,
            message,
            created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `
      );

      const notices = runningSessions.map((session) => {
        const notice: RuntimeNotice = {
          key: `restart:${session.session_id}:${timestamp}`,
          telegramChatId: session.telegram_chat_id,
          type: "bridge_restart_recovery",
          message: "桥接服务已重启，正在运行的操作状态未知，请查看会话状态后重新发起。",
          createdAt: timestamp
        };

        insertNotice.run(notice.key, notice.telegramChatId, notice.type, notice.message, notice.createdAt);
        return notice;
      });

      if (appliedTableExists(this.db, "pending_interaction")) {
        const sessionIds = runningSessions.map((session) => session.session_id);
        const placeholders = sessionIds.map(() => "?").join(", ");
        this.db
          .prepare(
            `
              UPDATE pending_interaction
              SET
                state = 'failed',
                updated_at = ?,
                resolved_at = COALESCE(resolved_at, ?),
                error_reason = COALESCE(error_reason, 'bridge_restart')
              WHERE state IN ('pending', 'awaiting_text')
                AND session_id IN (${placeholders})
            `
          )
          .run(timestamp, timestamp, ...sessionIds);
      }

      this.db.exec("COMMIT");
      return notices;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSessions(telegramChatId: string, limitOrOptions?: number | { archived?: boolean; limit?: number }): SessionRow[] {
    const options = resolveSessionListOptions(limitOrOptions);
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM session
          WHERE telegram_chat_id = ? AND archived = ?
          ORDER BY last_used_at DESC, created_at DESC
          LIMIT ?
        `
      )
      .all(telegramChatId, options.archived ? 1 : 0, options.limit) as unknown as SessionRecord[];

    return rows.map(mapSession);
  }

  getSessionById(sessionId: string): SessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM session WHERE session_id = ?")
      .get(sessionId) as SessionRecord | undefined;

    return row ? mapSession(row) : null;
  }

  getSessionByThreadId(threadId: string): SessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM session WHERE thread_id = ?")
      .get(threadId) as SessionRecord | undefined;

    return row ? mapSession(row) : null;
  }

  listSessionsWithThreads(): SessionRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM session
          WHERE thread_id IS NOT NULL
          ORDER BY last_used_at DESC, created_at DESC
        `
      )
      .all() as unknown as SessionRecord[];

    return rows.map(mapSession);
  }

  getActiveSession(telegramChatId: string): SessionRow | null {
    const row = this.db
      .prepare(
        `
          SELECT s.*
          FROM chat_binding cb
          JOIN session s ON s.session_id = cb.active_session_id
          WHERE cb.telegram_chat_id = ? AND s.archived = 0
        `
      )
      .get(telegramChatId) as SessionRecord | undefined;

    return row ? mapSession(row) : null;
  }

  createSession(options: {
    telegramChatId: string;
    projectName: string;
    projectPath: string;
    displayName?: string;
    selectedModel?: string | null;
    threadId?: string | null;
    lastTurnId?: string | null;
    lastTurnStatus?: string | null;
  }): SessionRow {
    const timestamp = nowIso();
    const sessionId = randomUUID();
    const session: SessionRow = {
      sessionId,
      telegramChatId: options.telegramChatId,
      threadId: options.threadId ?? null,
      selectedModel: options.selectedModel ?? null,
      displayName: options.displayName ?? options.projectName,
      projectName: options.projectName,
      projectPath: options.projectPath,
      status: "idle",
      failureReason: null,
      archived: false,
      archivedAt: null,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastTurnId: options.lastTurnId ?? null,
      lastTurnStatus: options.lastTurnStatus ?? null
    };

    this.db.exec("BEGIN");

    try {
      this.db
        .prepare(
          `
            INSERT INTO session (
              session_id,
              telegram_chat_id,
              thread_id,
              selected_model,
              display_name,
              project_name,
              project_path,
              status,
              failure_reason,
              archived,
              archived_at,
              created_at,
              last_used_at,
              last_turn_id,
              last_turn_status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          session.sessionId,
          session.telegramChatId,
          session.threadId,
          session.selectedModel,
          session.displayName,
          session.projectName,
          session.projectPath,
          session.status,
          session.failureReason,
          session.archived ? 1 : 0,
          session.archivedAt,
          session.createdAt,
          session.lastUsedAt,
          session.lastTurnId,
          session.lastTurnStatus
        );

      this.db
        .prepare(
          `
            UPDATE chat_binding
            SET active_session_id = ?, updated_at = ?
            WHERE telegram_chat_id = ?
          `
        )
        .run(session.sessionId, timestamp, session.telegramChatId);

      this.db
        .prepare(
          `
            INSERT INTO recent_project (
              project_path,
              project_name,
              last_used_at,
              pinned,
              last_session_id,
              last_success_at,
              source
            )
            VALUES (?, ?, ?, 0, ?, NULL, 'mru')
            ON CONFLICT(project_path) DO UPDATE SET
              project_name = excluded.project_name,
              last_used_at = excluded.last_used_at,
              last_session_id = excluded.last_session_id,
              source = CASE
                WHEN recent_project.pinned = 1 THEN recent_project.source
                ELSE 'mru'
              END
          `
        )
        .run(session.projectPath, session.projectName, session.lastUsedAt, session.sessionId);

      this.db.exec("COMMIT");
      return session;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  setActiveSession(telegramChatId: string, sessionId: string): void {
    this.db
      .prepare(
        `
          UPDATE chat_binding
          SET active_session_id = ?, updated_at = ?
          WHERE telegram_chat_id = ?
        `
      )
      .run(sessionId, nowIso(), telegramChatId);
  }

  private getVisibleSessionById(sessionId: string): SessionRow | null {
    const row = this.db
      .prepare("SELECT * FROM session WHERE session_id = ? AND archived = 0")
      .get(sessionId) as SessionRecord | undefined;

    return row ? mapSession(row) : null;
  }

  private selectMostRecentVisibleSessionId(telegramChatId: string): string | null {
    const row = this.db
      .prepare(
        `
          SELECT session_id
          FROM session
          WHERE telegram_chat_id = ? AND archived = 0
          ORDER BY last_used_at DESC, created_at DESC
          LIMIT 1
        `
      )
      .get(telegramChatId) as { session_id: string } | undefined;

    return row?.session_id ?? null;
  }

  private normalizeActiveSession(telegramChatId: string): void {
    const binding = this.getChatBinding(telegramChatId);
    if (!binding) {
      return;
    }

    // Archived sessions must never remain active in the Telegram UX.
    const currentVisibleSession = binding.activeSessionId ? this.getVisibleSessionById(binding.activeSessionId) : null;
    const nextActiveSessionId = currentVisibleSession?.sessionId ?? this.selectMostRecentVisibleSessionId(telegramChatId);

    this.db
      .prepare(
        `
          UPDATE chat_binding
          SET active_session_id = ?, updated_at = ?
          WHERE telegram_chat_id = ?
        `
      )
      .run(nextActiveSessionId, nowIso(), telegramChatId);
  }

  archiveSession(sessionId: string): SessionRow | null {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    if (session.status === "running") {
      throw new Error("cannot archive a running session");
    }

    const timestamp = nowIso();
    this.db.exec("BEGIN");

    try {
      this.db
        .prepare(
          `
            UPDATE session
            SET archived = 1, archived_at = ?
            WHERE session_id = ?
          `
        )
        .run(timestamp, sessionId);

      this.normalizeActiveSession(session.telegramChatId);

      this.db.exec("COMMIT");
      return this.getSessionById(sessionId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  unarchiveSession(sessionId: string): SessionRow | null {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    if (session.status === "running") {
      throw new Error("cannot unarchive a running session");
    }

    const timestamp = nowIso();
    this.db.exec("BEGIN");

    try {
      this.db
        .prepare(
          `
            UPDATE session
            SET archived = 0, archived_at = NULL
            WHERE session_id = ?
          `
        )
        .run(sessionId);

      const activeSession = this.getActiveSession(session.telegramChatId);
      if (!activeSession) {
        this.db
          .prepare(
            `
              UPDATE chat_binding
              SET active_session_id = ?, updated_at = ?
              WHERE telegram_chat_id = ?
            `
          )
          .run(sessionId, timestamp, session.telegramChatId);
      } else {
        this.normalizeActiveSession(session.telegramChatId);
      }

      this.db.exec("COMMIT");
      return this.getSessionById(sessionId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  renameSession(sessionId: string, displayName: string): void {
    this.db
      .prepare(
        `
          UPDATE session
          SET display_name = ?, last_used_at = ?
          WHERE session_id = ?
        `
      )
      .run(displayName, nowIso(), sessionId);
  }

  pinProject(options: {
    projectPath: string;
    projectName: string;
    sessionId: string | null;
  }): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO recent_project (
            project_path,
            project_name,
            last_used_at,
            pinned,
            last_session_id,
            last_success_at,
            source
          )
          VALUES (?, ?, ?, 1, ?, NULL, 'pin')
          ON CONFLICT(project_path) DO UPDATE SET
            project_name = excluded.project_name,
            last_used_at = excluded.last_used_at,
            pinned = 1,
            last_session_id = excluded.last_session_id,
            source = 'pin'
        `
      )
      .run(options.projectPath, options.projectName, timestamp, options.sessionId);
  }

  isProjectPinned(projectPath: string): boolean {
    const row = this.db
      .prepare("SELECT pinned FROM recent_project WHERE project_path = ?")
      .get(projectPath) as { pinned: number } | undefined;

    return row?.pinned === 1;
  }

  listRecentProjects(): RecentProjectRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM recent_project
          ORDER BY last_used_at DESC, project_name ASC
        `
      )
      .all() as unknown as RecentProjectRecord[];

    return rows.map(mapRecentProject);
  }

  listPinnedProjectPaths(): string[] {
    const rows = this.db
      .prepare("SELECT project_path FROM recent_project WHERE pinned = 1")
      .all() as Array<{ project_path: string }>;

    return rows.map((row) => row.project_path);
  }

  listProjectScanCache(): ProjectScanCacheRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM project_scan_cache
          ORDER BY last_scanned_at DESC, confidence DESC, project_name ASC
        `
      )
      .all() as unknown as ProjectScanCacheRecord[];

    return rows.map(mapProjectScanCache);
  }

  listSessionProjectStats(): SessionProjectStatsRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            project_path,
            project_name,
            COUNT(*) AS session_count,
            MAX(last_used_at) AS last_used_at
          FROM session
          GROUP BY project_path, project_name
        `
      )
      .all() as unknown as SessionProjectStatsRecord[];

    return rows.map(mapSessionProjectStats);
  }

  upsertProjectScanCandidates(
    candidates: Array<{
      projectPath: string;
      projectName: string;
      scanRoot: string;
      confidence: number;
      detectedMarkers: string[];
      existsNow: boolean;
    }>
  ): void {
    const timestamp = nowIso();
    const statement = this.db.prepare(
      `
        INSERT INTO project_scan_cache (
          project_path,
          project_name,
          scan_root,
          confidence,
          detected_markers,
          last_scanned_at,
          exists_now
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_path) DO UPDATE SET
          project_name = excluded.project_name,
          scan_root = excluded.scan_root,
          confidence = excluded.confidence,
          detected_markers = excluded.detected_markers,
          last_scanned_at = excluded.last_scanned_at,
          exists_now = excluded.exists_now
      `
    );

    for (const candidate of candidates) {
      statement.run(
        candidate.projectPath,
        candidate.projectName,
        candidate.scanRoot,
        candidate.confidence,
        JSON.stringify(candidate.detectedMarkers),
        timestamp,
        candidate.existsNow ? 1 : 0
      );
    }
  }

  markProjectScanCandidateMissing(projectPath: string): void {
    this.db
      .prepare(
        `
          UPDATE project_scan_cache
          SET exists_now = 0, last_scanned_at = ?
          WHERE project_path = ?
        `
      )
      .run(nowIso(), projectPath);
  }

  updateSessionThreadId(sessionId: string, threadId: string): void {
    this.db
      .prepare(
        `
          UPDATE session
          SET thread_id = ?, last_used_at = ?
          WHERE session_id = ?
        `
      )
      .run(threadId, nowIso(), sessionId);
  }

  setSessionSelectedModel(sessionId: string, selectedModel: string | null): void {
    this.db
      .prepare(
        `
          UPDATE session
          SET selected_model = ?, last_used_at = ?
          WHERE session_id = ?
        `
      )
      .run(selectedModel, nowIso(), sessionId);
  }

  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    options?: {
      failureReason?: FailureReason | null;
      lastTurnId?: string | null;
      lastTurnStatus?: string | null;
    }
  ): void {
    this.db
      .prepare(
        `
          UPDATE session
          SET
            status = ?,
            failure_reason = ?,
            last_turn_id = ?,
            last_turn_status = ?,
            last_used_at = ?
          WHERE session_id = ?
        `
      )
      .run(
        status,
        options?.failureReason ?? null,
        options?.lastTurnId ?? null,
        options?.lastTurnStatus ?? null,
        nowIso(),
        sessionId
      );
  }

  markSessionSuccessful(sessionId: string): void {
    const session = this.getSessionById(sessionId);
    if (!session) {
      return;
    }

    const timestamp = nowIso();
    this.db.exec("BEGIN");

    try {
      this.db
        .prepare(
          `
            UPDATE session
            SET
              status = 'idle',
              failure_reason = NULL,
              last_turn_status = 'completed',
              last_used_at = ?
            WHERE session_id = ?
          `
        )
        .run(timestamp, sessionId);

      this.db
        .prepare(
          `
            INSERT INTO recent_project (
              project_path,
              project_name,
              last_used_at,
              pinned,
              last_session_id,
              last_success_at,
              source
            )
            VALUES (?, ?, ?, ?, ?, ?, 'last_success')
            ON CONFLICT(project_path) DO UPDATE SET
              project_name = excluded.project_name,
              last_used_at = excluded.last_used_at,
              last_session_id = excluded.last_session_id,
              last_success_at = excluded.last_success_at,
              source = CASE
                WHEN recent_project.pinned = 1 THEN recent_project.source
                ELSE 'last_success'
              END
          `
        )
        .run(
          session.projectPath,
          session.projectName,
          timestamp,
          this.isProjectPinned(session.projectPath) ? 1 : 0,
          sessionId,
          timestamp
        );

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listRuntimeNotices(telegramChatId: string): RuntimeNotice[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM runtime_notice
          WHERE telegram_chat_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(telegramChatId) as unknown as RuntimeNoticeRecord[];

    return rows.map(mapRuntimeNotice);
  }

  countRuntimeNotices(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_notice")
      .get() as { count: number | bigint } | undefined;

    return Number(row?.count ?? 0);
  }

  clearRuntimeNotice(key: string): void {
    this.db.prepare("DELETE FROM runtime_notice WHERE key = ?").run(key);
  }

  createRuntimeNotice(options: {
    key?: string;
    telegramChatId: string;
    type: RuntimeNotice["type"];
    message: string;
  }): RuntimeNotice {
    const notice: RuntimeNotice = {
      key: options.key ?? `notice:${randomUUID()}`,
      telegramChatId: options.telegramChatId,
      type: options.type,
      message: options.message,
      createdAt: nowIso()
    };

    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO runtime_notice (
            key,
            telegram_chat_id,
            type,
            message,
            created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(notice.key, notice.telegramChatId, notice.type, notice.message, notice.createdAt);

    return notice;
  }

  listNoticeChatIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT telegram_chat_id FROM runtime_notice ORDER BY telegram_chat_id ASC")
      .all() as Array<{ telegram_chat_id: string }>;

    return rows.map((row) => row.telegram_chat_id);
  }

  saveFinalAnswerView(options: {
    answerId?: string;
    telegramChatId: string;
    telegramMessageId?: number | null;
    sessionId: string;
    threadId: string;
    turnId: string;
    previewHtml: string;
    pages: string[];
  }): FinalAnswerViewRow {
    const answerId = options.answerId ?? randomUUID();
    const createdAt = nowIso();

    this.db.exec("BEGIN");

    try {
      this.db
        .prepare(
          `
            INSERT OR REPLACE INTO final_answer_view (
              answer_id,
              telegram_chat_id,
              telegram_message_id,
              session_id,
              thread_id,
              turn_id,
              preview_html,
              pages_json,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          answerId,
          options.telegramChatId,
          options.telegramMessageId ?? null,
          options.sessionId,
          options.threadId,
          options.turnId,
          options.previewHtml,
          JSON.stringify(options.pages),
          createdAt
        );

      this.db
        .prepare(
          `
            DELETE FROM final_answer_view
            WHERE answer_id IN (
              SELECT answer_id
              FROM final_answer_view
              WHERE telegram_chat_id = ?
              ORDER BY created_at DESC, rowid DESC
              LIMIT -1 OFFSET 50
            )
          `
        )
        .run(options.telegramChatId);

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    const saved = this.getFinalAnswerView(answerId, options.telegramChatId);
    if (!saved) {
      throw new Error(`persisted final answer view missing after save: ${answerId}`);
    }

    return saved;
  }

  getFinalAnswerView(answerId: string, telegramChatId: string): FinalAnswerViewRow | null {
    const row = this.db
      .prepare(
        `
          SELECT *
          FROM final_answer_view
          WHERE answer_id = ? AND telegram_chat_id = ?
        `
      )
      .get(answerId, telegramChatId) as FinalAnswerViewRecord | undefined;

    return row ? mapFinalAnswerView(row) : null;
  }

  listFinalAnswerViews(telegramChatId: string): FinalAnswerViewRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM final_answer_view
          WHERE telegram_chat_id = ?
          ORDER BY created_at DESC, rowid DESC
        `
      )
      .all(telegramChatId) as unknown as FinalAnswerViewRecord[];

    return rows.map(mapFinalAnswerView);
  }

  setFinalAnswerMessageId(answerId: string, telegramMessageId: number): void {
    this.db
      .prepare(
        `
          UPDATE final_answer_view
          SET telegram_message_id = ?
          WHERE answer_id = ?
        `
      )
      .run(telegramMessageId, answerId);
  }

  deleteFinalAnswerView(answerId: string): void {
    this.db.prepare("DELETE FROM final_answer_view WHERE answer_id = ?").run(answerId);
  }

  createPendingInteraction(options: {
    interactionId?: string;
    telegramChatId: string;
    sessionId: string;
    threadId: string;
    turnId: string;
    requestId: string;
    requestMethod: string;
    interactionKind: PendingInteractionKind;
    state?: PendingInteractionState;
    promptJson: string;
    responseJson?: string | null;
    telegramMessageId?: number | null;
    errorReason?: string | null;
  }): PendingInteractionRow {
    const interactionId = options.interactionId ?? randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO pending_interaction (
            interaction_id,
            telegram_chat_id,
            session_id,
            thread_id,
            turn_id,
            request_id,
            request_method,
            interaction_kind,
            state,
            prompt_json,
            response_json,
            telegram_message_id,
            created_at,
            updated_at,
            resolved_at,
            error_reason
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        `
      )
      .run(
        interactionId,
        options.telegramChatId,
        options.sessionId,
        options.threadId,
        options.turnId,
        options.requestId,
        options.requestMethod,
        options.interactionKind,
        options.state ?? "pending",
        options.promptJson,
        options.responseJson ?? null,
        options.telegramMessageId ?? null,
        timestamp,
        timestamp,
        options.errorReason ?? null
      );

    return {
      interactionId,
      telegramChatId: options.telegramChatId,
      sessionId: options.sessionId,
      threadId: options.threadId,
      turnId: options.turnId,
      requestId: options.requestId,
      requestMethod: options.requestMethod,
      interactionKind: options.interactionKind,
      state: options.state ?? "pending",
      promptJson: options.promptJson,
      responseJson: options.responseJson ?? null,
      telegramMessageId: options.telegramMessageId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: null,
      errorReason: options.errorReason ?? null
    } as PendingInteractionRow;
  }

  getPendingInteraction(interactionId: string, telegramChatId?: string): PendingInteractionRow | null {
    const row = telegramChatId
      ? this.db
        .prepare(
          `
            SELECT *
            FROM pending_interaction
            WHERE interaction_id = ? AND telegram_chat_id = ?
          `
        )
        .get(interactionId, telegramChatId)
      : this.db
        .prepare(
          `
            SELECT *
            FROM pending_interaction
            WHERE interaction_id = ?
          `
        )
        .get(interactionId);

    return row ? mapPendingInteraction(row as unknown as PendingInteractionRecord) : null;
  }

  listPendingInteractionsByRequest(threadId: string, requestId: string): PendingInteractionRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM pending_interaction
          WHERE thread_id = ?
            AND request_id = ?
            AND state IN ('pending', 'awaiting_text')
          ORDER BY created_at DESC, interaction_id DESC
        `
      )
      .all(threadId, requestId) as unknown as PendingInteractionRecord[];

    return rows.map(mapPendingInteraction);
  }

  listPendingInteractionsByChat(
    telegramChatId: string,
    states?: PendingInteractionState[]
  ): PendingInteractionRow[] {
    const rows = states && states.length > 0
      ? this.db
        .prepare(
          `
            SELECT *
            FROM pending_interaction
            WHERE telegram_chat_id = ?
              AND state IN (${states.map(() => "?").join(", ")})
            ORDER BY created_at DESC, interaction_id DESC
          `
        )
        .all(telegramChatId, ...states)
      : this.db
        .prepare(
          `
            SELECT *
            FROM pending_interaction
            WHERE telegram_chat_id = ?
            ORDER BY created_at DESC, interaction_id DESC
          `
        )
        .all(telegramChatId);

    return (rows as unknown as PendingInteractionRecord[]).map(mapPendingInteraction);
  }

  listPendingInteractionsByTurn(threadId: string, turnId: string): PendingInteractionRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM pending_interaction
          WHERE thread_id = ? AND turn_id = ?
          ORDER BY created_at DESC, interaction_id DESC
        `
      )
      .all(threadId, turnId) as unknown as PendingInteractionRecord[];

    return rows.map(mapPendingInteraction);
  }

  listUnresolvedPendingInteractions(): PendingInteractionRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT *
          FROM pending_interaction
          WHERE state IN ('pending', 'awaiting_text')
          ORDER BY created_at ASC, interaction_id ASC
        `
      )
      .all() as unknown as PendingInteractionRecord[];

    return rows.map(mapPendingInteraction);
  }

  listPendingInteractionsForRunningSessions(): PendingInteractionRow[] {
    const rows = this.db
      .prepare(
        `
          SELECT pi.*
          FROM pending_interaction pi
          INNER JOIN session s
            ON s.session_id = pi.session_id
          WHERE s.status = 'running'
            AND pi.state IN ('pending', 'awaiting_text')
          ORDER BY pi.created_at ASC, pi.interaction_id ASC
        `
      )
      .all() as unknown as PendingInteractionRecord[];

    return rows.map(mapPendingInteraction);
  }

  setPendingInteractionMessageId(interactionId: string, messageId: number): void {
    this.db
      .prepare(
        `
          UPDATE pending_interaction
          SET telegram_message_id = ?, updated_at = ?
          WHERE interaction_id = ?
        `
      )
      .run(messageId, nowIso(), interactionId);
  }

  savePendingInteractionDraftResponse(
    interactionId: string,
    state: PendingInteractionState,
    responseJson: string | null
  ): void {
    if (state !== "pending" && state !== "awaiting_text") {
      throw new Error("draft interaction state must be pending or awaiting_text");
    }

    this.db
      .prepare(
        `
          UPDATE pending_interaction
          SET
            state = ?,
            response_json = ?,
            updated_at = ?,
            resolved_at = NULL,
            error_reason = NULL
          WHERE interaction_id = ?
        `
      )
      .run(state, responseJson, nowIso(), interactionId);
  }

  markPendingInteractionAwaitingText(interactionId: string, responseJson?: string | null): void {
    this.savePendingInteractionDraftResponse(interactionId, "awaiting_text", responseJson ?? null);
  }

  markPendingInteractionPending(interactionId: string, responseJson?: string | null): void {
    this.savePendingInteractionDraftResponse(interactionId, "pending", responseJson ?? null);
  }

  markPendingInteractionAnswered(interactionId: string, responseJson: string): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          UPDATE pending_interaction
          SET
            state = 'answered',
            response_json = ?,
            updated_at = ?,
            resolved_at = ?,
            error_reason = NULL
          WHERE interaction_id = ?
        `
      )
      .run(responseJson, timestamp, timestamp, interactionId);
  }

  markPendingInteractionCanceled(
    interactionId: string,
    responseJson?: string | null,
    reason?: string | null
  ): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          UPDATE pending_interaction
          SET
            state = 'canceled',
            response_json = ?,
            updated_at = ?,
            resolved_at = ?,
            error_reason = ?
          WHERE interaction_id = ?
        `
      )
      .run(responseJson ?? null, timestamp, timestamp, reason ?? null, interactionId);
  }

  markPendingInteractionFailed(interactionId: string, reason: string): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          UPDATE pending_interaction
          SET
            state = 'failed',
            updated_at = ?,
            resolved_at = ?,
            error_reason = ?
          WHERE interaction_id = ?
        `
      )
      .run(timestamp, timestamp, reason, interactionId);
  }

  markPendingInteractionExpired(interactionId: string, reason: string): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          UPDATE pending_interaction
          SET
            state = 'expired',
            updated_at = ?,
            resolved_at = COALESCE(resolved_at, ?),
            error_reason = COALESCE(error_reason, ?)
          WHERE interaction_id = ?
        `
      )
      .run(timestamp, timestamp, reason, interactionId);
  }

  expirePendingInteractionsForTurn(threadId: string, turnId: string, reason: string): number {
    const timestamp = nowIso();
    const info = this.db
      .prepare(
        `
          UPDATE pending_interaction
          SET
            state = 'expired',
            updated_at = ?,
            resolved_at = COALESCE(resolved_at, ?),
            error_reason = COALESCE(error_reason, ?)
          WHERE thread_id = ?
            AND turn_id = ?
            AND state IN ('pending', 'awaiting_text')
        `
      )
      .run(timestamp, timestamp, reason, threadId, turnId);

    return Number(info.changes ?? 0);
  }

  writeReadinessSnapshot(snapshot: ReadinessSnapshot): void {
    this.db
      .prepare(
        `
          INSERT OR REPLACE INTO bootstrap_state (
            key,
            readiness_state,
            details_json,
            checked_at,
            app_server_pid
          )
          VALUES (?, ?, ?, ?, ?)
        `
      )
      .run(
        "bootstrap",
        snapshot.state,
        JSON.stringify(snapshot.details),
        snapshot.checkedAt,
        snapshot.appServerPid ?? null
      );
  }

  getReadinessSnapshot(): ReadinessSnapshot | null {
    const row = this.db
      .prepare(
        `
          SELECT readiness_state, details_json, checked_at, app_server_pid
          FROM bootstrap_state
          WHERE key = 'bootstrap'
        `
      )
      .get() as ReadinessRecord | undefined;

    if (!row) {
      return null;
    }

    return {
      state: row.readiness_state,
      checkedAt: row.checked_at,
      details: JSON.parse(row.details_json) as ReadinessSnapshot["details"],
      appServerPid: row.app_server_pid
    };
  }
}

function initializeDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);

  const applied = getAppliedMigrations(db);
  if (!applied.has(CURRENT_SCHEMA_VERSION)) {
    throw new Error(`schema migrations incomplete; expected version ${CURRENT_SCHEMA_VERSION}`);
  }
}

function appliedTableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `
    )
    .get(tableName) as { name: string } | undefined;

  return Boolean(row?.name);
}

function verifyIntegrity(db: DatabaseSync): void {
  const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (result.integrity_check !== "ok") {
    throw new Error(`sqlite integrity check failed: ${result.integrity_check}`);
  }
}

function isCorruptionLikeError(error: unknown): boolean {
  const message = `${error}`.toLowerCase();
  return message.includes("sqlite integrity check failed")
    || message.includes("database disk image is malformed")
    || message.includes("file is not a database");
}

function isSchemaLikeError(error: unknown): boolean {
  const message = `${error}`.toLowerCase();
  return message.includes("schema migrations incomplete")
    || message.includes("malformed database schema")
    || message.includes("no such table")
    || message.includes("no such column")
    || message.includes("table ") && message.includes("already exists");
}

function recommendedActionForClassification(classification: StateStoreFailureClassification): string {
  switch (classification) {
    case "integrity_failure":
      return "Do not replace the database. Copy bridge.db for offline inspection, run integrity_check manually, and restore from a known-good backup if needed.";
    case "schema_failure":
      return "Do not replace the database. Inspect migration/state-store logs, verify the running binary version, and fix the schema issue before restarting.";
    case "transient_open_failure":
    default:
      return "Retry service start after checking for transient filesystem or locking issues. Do not rotate or delete the database.";
  }
}

function classifyStateStoreFailure(error: unknown): StateStoreFailureClassification {
  if (isSchemaLikeError(error)) {
    return "schema_failure";
  }

  if (isCorruptionLikeError(error)) {
    return "integrity_failure";
  }

  return "transient_open_failure";
}

function getFailureStage(error: unknown): StateStoreOpenStage {
  const stage = (error as { stateStoreOpenStage?: StateStoreOpenStage }).stateStoreOpenStage;
  return stage ?? "open_db";
}

function withFailureStage<T>(stage: StateStoreOpenStage, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    (error as { stateStoreOpenStage?: StateStoreOpenStage }).stateStoreOpenStage = stage;
    throw error;
  }
}

function buildStateStoreFailure(
  dbPath: string,
  stage: StateStoreOpenStage,
  error: unknown
): StateStoreFailureRecord {
  const classification = classifyStateStoreFailure(error);
  return {
    detectedAt: nowIso(),
    dbPath,
    stage,
    classification,
    error: `${error}`,
    recommendedAction: recommendedActionForClassification(classification)
  };
}

async function writeStateStoreFailure(paths: BridgePaths, failure: StateStoreFailureRecord): Promise<void> {
  await mkdir(dirname(paths.stateStoreFailurePath), { recursive: true });
  await writeFile(paths.stateStoreFailurePath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
}

async function persistStateStoreFailure(
  paths: BridgePaths,
  failure: StateStoreFailureRecord,
  logger: Logger
): Promise<void> {
  try {
    await writeStateStoreFailure(paths, failure);
  } catch (markerError) {
    await logger.warn("state store failure marker write failed", {
      dbPath: failure.dbPath,
      markerPath: paths.stateStoreFailurePath,
      error: `${markerError}`
    }).catch(() => {});
  }
}

async function logStateStoreOpenFailure(logger: Logger, failure: StateStoreFailureRecord): Promise<void> {
  await logger.error("state store open failed", { ...failure }).catch(() => {});
}

async function clearStateStoreFailure(paths: BridgePaths): Promise<void> {
  try {
    await unlink(paths.stateStoreFailurePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function readStateStoreFailure(paths: BridgePaths): Promise<StateStoreFailureRecord | null> {
  try {
    const content = await readFile(paths.stateStoreFailurePath, "utf8");
    return JSON.parse(content) as StateStoreFailureRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
