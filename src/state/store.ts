import { rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import type {
  AuthorizedUserRow,
  ChatBindingRow,
  FailureReason,
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
  type: "bridge_restart_recovery";
  message: string;
  created_at: string;
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

    CREATE INDEX IF NOT EXISTS idx_pending_authorization_last_seen
      ON pending_authorization(last_seen_at DESC);

    CREATE INDEX IF NOT EXISTS idx_session_chat_id
      ON session(telegram_chat_id);
  `;
}

const CURRENT_SCHEMA_VERSION = 2;

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
    let recoveredFromCorruption = false;
    let dbPath = paths.dbPath;

    try {
      const db = new DatabaseSync(dbPath);
      initializeDatabase(db);
      verifyIntegrity(db);
      const store = new BridgeStateStore(db, logger, recoveredFromCorruption);
      store.normalizeAllActiveSessions();
      return store;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const db = new DatabaseSync(dbPath);
        initializeDatabase(db);
        const store = new BridgeStateStore(db, logger, recoveredFromCorruption);
        store.normalizeAllActiveSessions();
        return store;
      }

      recoveredFromCorruption = true;
      const corruptPath = `${dbPath}.corrupt.${new Date().toISOString().replaceAll(":", "-")}`;

      try {
        await rename(dbPath, corruptPath);
      } catch {
        await logger.error("failed to rotate corrupt database", { dbPath, corruptPath });
      }

      await logger.error("state store corruption detected; created fresh database", {
        dbPath,
        corruptPath,
        error: `${error}`
      });

      dbPath = paths.dbPath;
      const db = new DatabaseSync(dbPath);
      initializeDatabase(db);
      const store = new BridgeStateStore(db, logger, recoveredFromCorruption);
      store.normalizeAllActiveSessions();
      store.writeReadinessSnapshot({
        state: "bridge_unhealthy",
        checkedAt: nowIso(),
        appServerPid: null,
        details: {
          codexInstalled: false,
          codexAuthenticated: false,
          appServerAvailable: false,
          telegramTokenValid: false,
          authorizedUserBound: false,
          issues: ["state store corruption recovered"]
        }
      });
      return store;
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
  }): SessionRow {
    const timestamp = nowIso();
    const sessionId = randomUUID();
    const session: SessionRow = {
      sessionId,
      telegramChatId: options.telegramChatId,
      threadId: null,
      displayName: options.displayName ?? options.projectName,
      projectName: options.projectName,
      projectPath: options.projectPath,
      status: "idle",
      failureReason: null,
      archived: false,
      archivedAt: null,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      lastTurnId: null,
      lastTurnStatus: null
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(
          session.sessionId,
          session.telegramChatId,
          session.threadId,
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

  listNoticeChatIds(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT telegram_chat_id FROM runtime_notice ORDER BY telegram_chat_id ASC")
      .all() as Array<{ telegram_chat_id: string }>;

    return rows.map((row) => row.telegram_chat_id);
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

function verifyIntegrity(db: DatabaseSync): void {
  const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (result.integrity_check !== "ok") {
    throw new Error(`sqlite integrity check failed: ${result.integrity_check}`);
  }
}
