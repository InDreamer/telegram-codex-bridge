import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  FailureReason,
  ProjectScanCacheRow,
  ReasoningEffort,
  RecentProjectRow,
  SessionProjectStatsRow,
  SessionRow,
  SessionStatus
} from "../types.js";
import { nowIso } from "../util/time.js";
import {
  type ProjectScanCacheRecord,
  type RecentProjectRecord,
  type SessionProjectStatsRecord,
  type SessionRecord,
  mapProjectScanCache,
  mapRecentProject,
  mapSession,
  mapSessionProjectStats,
  resolveSessionListOptions,
  sessionSelectColumns
} from "./store-records.js";
import { buildInClausePlaceholders } from "./store-shared.js";
import type { StoreAuth } from "./store-auth.js";

interface StoreSessionsDeps {
  auth: Pick<StoreAuth, "getChatBinding" | "setChatBindingActiveSession">;
}

export interface StoreSessions {
  listSessions(telegramChatId: string, limitOrOptions?: number | { archived?: boolean; limit?: number }): SessionRow[];
  getSessionById(sessionId: string): SessionRow | null;
  getSessionByThreadId(threadId: string): SessionRow | null;
  listSessionsWithThreads(): SessionRow[];
  getActiveSession(telegramChatId: string): SessionRow | null;
  createSession(options: {
    telegramChatId: string;
    projectName: string;
    projectPath: string;
    displayName?: string;
    selectedModel?: string | null;
    selectedReasoningEffort?: ReasoningEffort | null;
    planMode?: boolean;
    needsDefaultCollaborationModeReset?: boolean;
    threadId?: string | null;
    lastTurnId?: string | null;
    lastTurnStatus?: string | null;
  }): SessionRow;
  setActiveSession(telegramChatId: string, sessionId: string): void;
  normalizeActiveSession(telegramChatId: string): void;
  archiveSession(sessionId: string): SessionRow | null;
  unarchiveSession(sessionId: string): SessionRow | null;
  renameSession(sessionId: string, displayName: string): void;
  pinProject(options: {
    projectPath: string;
    projectName: string;
    sessionId: string | null;
  }): void;
  isProjectPinned(projectPath: string): boolean;
  getRecentProjectByPath(projectPath: string): RecentProjectRow | null;
  listRecentProjects(): RecentProjectRow[];
  setProjectAlias(options: {
    projectPath: string;
    projectName: string;
    projectAlias: string;
    sessionId: string | null;
  }): void;
  clearProjectAlias(projectPath: string): void;
  listPinnedProjectPaths(): string[];
  listProjectScanCache(): ProjectScanCacheRow[];
  listSessionProjectStats(): SessionProjectStatsRow[];
  upsertProjectScanCandidates(
    candidates: Array<{
      projectPath: string;
      projectName: string;
      scanRoot: string;
      confidence: number;
      detectedMarkers: string[];
      existsNow: boolean;
    }>
  ): void;
  markProjectScanCandidateMissing(projectPath: string): void;
  updateSessionThreadId(sessionId: string, threadId: string): void;
  setSessionSelectedModel(sessionId: string, selectedModel: string | null): void;
  setSessionSelectedReasoningEffort(sessionId: string, selectedReasoningEffort: ReasoningEffort | null): void;
  setSessionPlanMode(sessionId: string, planMode: boolean): void;
  clearSessionDefaultCollaborationModeReset(sessionId: string): void;
  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    options?: {
      failureReason?: FailureReason | null;
      lastTurnId?: string | null;
      lastTurnStatus?: string | null;
    }
  ): void;
  markRunningSessionsFailed(reason: FailureReason): number;
  listRunningSessions(): SessionRow[];
  markRunningSessionsFailedAt(reason: FailureReason, timestamp: string): void;
  markSessionSuccessful(sessionId: string): void;
  rebindSessionsChatIds(telegramChatId: string, previousChatIds: string[]): void;
}

export function createStoreSessions(db: DatabaseSync, deps: StoreSessionsDeps): StoreSessions {
  const getVisibleSessionById = (sessionId: string): SessionRow | null => {
    const row = db
      .prepare(
        `
          SELECT
            ${sessionSelectColumns("s", "rp")}
          FROM session s
          LEFT JOIN recent_project rp ON rp.project_path = s.project_path
          WHERE s.session_id = ? AND s.archived = 0
        `
      )
      .get(sessionId) as SessionRecord | undefined;

    return row ? mapSession(row) : null;
  };

  const selectMostRecentVisibleSessionId = (telegramChatId: string): string | null => {
    const row = db
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
  };

  const getSessionById = (sessionId: string): SessionRow | null => {
    const row = db
      .prepare(
        `
          SELECT
            ${sessionSelectColumns("s", "rp")}
          FROM session s
          LEFT JOIN recent_project rp ON rp.project_path = s.project_path
          WHERE s.session_id = ?
        `
      )
      .get(sessionId) as SessionRecord | undefined;

    return row ? mapSession(row) : null;
  };

  return {
    listSessions(telegramChatId, limitOrOptions) {
      const options = resolveSessionListOptions(limitOrOptions);
      const rows = db
        .prepare(
          `
            SELECT
              ${sessionSelectColumns("s", "rp")}
            FROM session s
            LEFT JOIN recent_project rp ON rp.project_path = s.project_path
            WHERE s.telegram_chat_id = ? AND s.archived = ?
            ORDER BY s.last_used_at DESC, s.created_at DESC
            LIMIT ?
          `
        )
        .all(telegramChatId, options.archived ? 1 : 0, options.limit) as unknown as SessionRecord[];

      return rows.map(mapSession);
    },

    getSessionById,

    getSessionByThreadId(threadId) {
      const row = db
        .prepare(
          `
            SELECT
              ${sessionSelectColumns("s", "rp")}
            FROM session s
            LEFT JOIN recent_project rp ON rp.project_path = s.project_path
            WHERE s.thread_id = ?
          `
        )
        .get(threadId) as SessionRecord | undefined;

      return row ? mapSession(row) : null;
    },

    listSessionsWithThreads() {
      const rows = db
        .prepare(
          `
            SELECT
              ${sessionSelectColumns("s", "rp")}
            FROM session s
            LEFT JOIN recent_project rp ON rp.project_path = s.project_path
            WHERE s.thread_id IS NOT NULL
            ORDER BY s.last_used_at DESC, s.created_at DESC
          `
        )
        .all() as unknown as SessionRecord[];

      return rows.map(mapSession);
    },

    getActiveSession(telegramChatId) {
      const row = db
        .prepare(
          `
            SELECT
              ${sessionSelectColumns("s", "rp")}
            FROM chat_binding cb
            JOIN session s ON s.session_id = cb.active_session_id
            LEFT JOIN recent_project rp ON rp.project_path = s.project_path
            WHERE cb.telegram_chat_id = ? AND s.archived = 0
          `
        )
        .get(telegramChatId) as SessionRecord | undefined;

      return row ? mapSession(row) : null;
    },

    createSession(options) {
      const timestamp = nowIso();
      const sessionId = randomUUID();
      const session: SessionRow = {
        sessionId,
        telegramChatId: options.telegramChatId,
        threadId: options.threadId ?? null,
        selectedModel: options.selectedModel ?? null,
        selectedReasoningEffort: options.selectedReasoningEffort ?? null,
        planMode: options.planMode ?? false,
        needsDefaultCollaborationModeReset: options.needsDefaultCollaborationModeReset ?? false,
        displayName: options.displayName ?? options.projectName,
        projectName: options.projectName,
        projectAlias: null,
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

      db.exec("BEGIN");

      try {
        db
          .prepare(
            `
              INSERT INTO session (
                session_id,
                telegram_chat_id,
                thread_id,
                selected_model,
                selected_reasoning_effort,
                plan_mode,
                pending_default_collaboration_mode_reset,
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
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            session.sessionId,
            session.telegramChatId,
            session.threadId,
            session.selectedModel,
            session.selectedReasoningEffort,
            session.planMode ? 1 : 0,
            session.needsDefaultCollaborationModeReset ? 1 : 0,
            session.displayName,
            session.projectName,
            session.projectPath,
            session.status,
            session.failureReason,
            0,
            null,
            session.createdAt,
            session.lastUsedAt,
            session.lastTurnId,
            session.lastTurnStatus
          );

        deps.auth.setChatBindingActiveSession(session.telegramChatId, session.sessionId, timestamp);

        db
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

        db.exec("COMMIT");
        return session;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    setActiveSession(telegramChatId, sessionId) {
      deps.auth.setChatBindingActiveSession(telegramChatId, sessionId);
    },

    normalizeActiveSession(telegramChatId) {
      const binding = deps.auth.getChatBinding(telegramChatId);
      if (!binding) {
        return;
      }

      const currentVisibleSession = binding.activeSessionId ? getVisibleSessionById(binding.activeSessionId) : null;
      const nextActiveSessionId = currentVisibleSession?.sessionId ?? selectMostRecentVisibleSessionId(telegramChatId);
      deps.auth.setChatBindingActiveSession(telegramChatId, nextActiveSessionId);
    },

    archiveSession(sessionId) {
      const session = getSessionById(sessionId);
      if (!session) {
        return null;
      }

      if (session.status === "running") {
        throw new Error("cannot archive a running session");
      }

      const timestamp = nowIso();
      db.exec("BEGIN");

      try {
        db
          .prepare(
            `
              UPDATE session
              SET archived = 1, archived_at = ?
              WHERE session_id = ?
            `
          )
          .run(timestamp, sessionId);

        this.normalizeActiveSession(session.telegramChatId);

        db.exec("COMMIT");
        return getSessionById(sessionId);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    unarchiveSession(sessionId) {
      const session = getSessionById(sessionId);
      if (!session) {
        return null;
      }

      if (session.status === "running") {
        throw new Error("cannot unarchive a running session");
      }

      const timestamp = nowIso();
      db.exec("BEGIN");

      try {
        db
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
          deps.auth.setChatBindingActiveSession(session.telegramChatId, sessionId, timestamp);
        } else {
          this.normalizeActiveSession(session.telegramChatId);
        }

        db.exec("COMMIT");
        return getSessionById(sessionId);
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    renameSession(sessionId, displayName) {
      db
        .prepare(
          `
            UPDATE session
            SET display_name = ?, last_used_at = ?
            WHERE session_id = ?
          `
        )
        .run(displayName, nowIso(), sessionId);
    },

    pinProject(options) {
      const timestamp = nowIso();
      db
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
    },

    isProjectPinned(projectPath) {
      const row = db
        .prepare("SELECT pinned FROM recent_project WHERE project_path = ?")
        .get(projectPath) as { pinned: number } | undefined;

      return row?.pinned === 1;
    },

    getRecentProjectByPath(projectPath) {
      const row = db
        .prepare("SELECT * FROM recent_project WHERE project_path = ?")
        .get(projectPath) as RecentProjectRecord | undefined;

      return row ? mapRecentProject(row) : null;
    },

    listRecentProjects() {
      const rows = db
        .prepare(
          `
            SELECT *
            FROM recent_project
            ORDER BY last_used_at DESC, project_name ASC
          `
        )
        .all() as unknown as RecentProjectRecord[];

      return rows.map(mapRecentProject);
    },

    setProjectAlias(options) {
      const timestamp = nowIso();
      db
        .prepare(
          `
            INSERT INTO recent_project (
              project_path,
              project_name,
              project_alias,
              last_used_at,
              pinned,
              last_session_id,
              last_success_at,
              source
            )
            VALUES (?, ?, ?, ?, 0, ?, NULL, 'mru')
            ON CONFLICT(project_path) DO UPDATE SET
              project_name = excluded.project_name,
              project_alias = excluded.project_alias,
              last_used_at = excluded.last_used_at,
              last_session_id = COALESCE(excluded.last_session_id, recent_project.last_session_id)
          `
        )
        .run(options.projectPath, options.projectName, options.projectAlias, timestamp, options.sessionId);
    },

    clearProjectAlias(projectPath) {
      db
        .prepare(
          `
            UPDATE recent_project
            SET project_alias = NULL, last_used_at = ?
            WHERE project_path = ?
          `
        )
        .run(nowIso(), projectPath);
    },

    listPinnedProjectPaths() {
      const rows = db
        .prepare("SELECT project_path FROM recent_project WHERE pinned = 1")
        .all() as Array<{ project_path: string }>;

      return rows.map((row) => row.project_path);
    },

    listProjectScanCache() {
      const rows = db
        .prepare(
          `
            SELECT *
            FROM project_scan_cache
            ORDER BY last_scanned_at DESC, confidence DESC, project_name ASC
          `
        )
        .all() as unknown as ProjectScanCacheRecord[];

      return rows.map(mapProjectScanCache);
    },

    listSessionProjectStats() {
      const rows = db
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
    },

    upsertProjectScanCandidates(candidates) {
      const timestamp = nowIso();
      const statement = db.prepare(
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
    },

    markProjectScanCandidateMissing(projectPath) {
      db
        .prepare(
          `
            UPDATE project_scan_cache
            SET exists_now = 0, last_scanned_at = ?
            WHERE project_path = ?
          `
        )
        .run(nowIso(), projectPath);
    },

    updateSessionThreadId(sessionId, threadId) {
      db
        .prepare(
          `
            UPDATE session
            SET thread_id = ?, last_used_at = ?
            WHERE session_id = ?
          `
        )
        .run(threadId, nowIso(), sessionId);
    },

    setSessionSelectedModel(sessionId, selectedModel) {
      db
        .prepare(
          `
            UPDATE session
            SET selected_model = ?, last_used_at = ?
            WHERE session_id = ?
          `
        )
        .run(selectedModel, nowIso(), sessionId);
    },

    setSessionSelectedReasoningEffort(sessionId, selectedReasoningEffort) {
      db
        .prepare(
          `
            UPDATE session
            SET selected_reasoning_effort = ?, last_used_at = ?
            WHERE session_id = ?
          `
        )
        .run(selectedReasoningEffort, nowIso(), sessionId);
    },

    setSessionPlanMode(sessionId, planMode) {
      const session = getSessionById(sessionId);
      if (!session) {
        return;
      }

      const needsDefaultReset = planMode
        ? false
        : session.planMode
          ? true
          : session.needsDefaultCollaborationModeReset;

      db
        .prepare(
          `
            UPDATE session
            SET
              plan_mode = ?,
              pending_default_collaboration_mode_reset = ?,
              last_used_at = ?
            WHERE session_id = ?
          `
        )
        .run(planMode ? 1 : 0, needsDefaultReset ? 1 : 0, nowIso(), sessionId);
    },

    clearSessionDefaultCollaborationModeReset(sessionId) {
      db
        .prepare(
          `
            UPDATE session
            SET pending_default_collaboration_mode_reset = 0
            WHERE session_id = ?
          `
        )
        .run(sessionId);
    },

    updateSessionStatus(sessionId, status, options) {
      db
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
    },

    markRunningSessionsFailed(reason) {
      const info = db
        .prepare(
          `
            UPDATE session
            SET status = 'failed', failure_reason = ?, last_turn_status = 'failed'
            WHERE status = 'running'
          `
        )
        .run(reason);

      return Number(info.changes ?? 0);
    },

    listRunningSessions() {
      const rows = db
        .prepare(
          `
            SELECT
              ${sessionSelectColumns("s", "rp")}
            FROM session s
            LEFT JOIN recent_project rp ON rp.project_path = s.project_path
            WHERE s.status = 'running'
            ORDER BY s.last_used_at DESC, s.created_at DESC
          `
        )
        .all() as unknown as SessionRecord[];

      return rows.map(mapSession);
    },

    markRunningSessionsFailedAt(reason, timestamp) {
      db
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
    },

    markSessionSuccessful(sessionId) {
      const session = getSessionById(sessionId);
      if (!session) {
        return;
      }

      const timestamp = nowIso();
      db.exec("BEGIN");

      try {
        db
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

        db
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

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    rebindSessionsChatIds(telegramChatId, previousChatIds) {
      if (previousChatIds.length === 0) {
        return;
      }

      const placeholders = buildInClausePlaceholders(previousChatIds.length);
      db
        .prepare(
          `
            UPDATE session
            SET telegram_chat_id = ?
            WHERE telegram_chat_id IN (${placeholders})
          `
        )
        .run(telegramChatId, ...previousChatIds);
    }
  };
}
