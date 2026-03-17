import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { BridgeStateStore, StateStoreOpenError, readStateStoreFailure } from "./store.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

function createCapturingLogger() {
  const warnEntries: Array<{ message: string; meta?: unknown }> = [];
  const errorEntries: Array<{ message: string; meta?: unknown }> = [];

  const logger: Logger = {
    info: async () => {},
    warn: async (message: string, meta?: unknown) => {
      warnEntries.push({ message, meta });
    },
    error: async (message: string, meta?: unknown) => {
      errorEntries.push({ message, meta });
    }
  };

  return { logger, warnEntries, errorEntries };
}

function createTestPaths(root: string): BridgePaths {
  const logsDir = join(root, "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(root, "runtime");

  return {
    homeDir: root,
    repoRoot: root,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir,
    telegramSessionFlowLogsDir,
    runtimeDir,
    cacheDir: join(root, "cache"),
    dbPath: join(root, "state", "bridge.db"),
    stateStoreFailurePath: join(root, "state", "state-store-open-failure.json"),
    envPath: join(root, "config", "bridge.env"),
    servicePath: join(root, "service", "bridge.service"),
    launchAgentPath: join(root, "LaunchAgents", "bridge.plist"),
    binPath: join(root, "bin", "ctb"),
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log"),
    telegramStatusCardLogPath: join(telegramSessionFlowLogsDir, "status-card.log"),
    telegramPlanCardLogPath: join(telegramSessionFlowLogsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(telegramSessionFlowLogsDir, "error-card.log")
  };
}

async function openStore(): Promise<{ paths: BridgePaths; store: BridgeStateStore; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ctb-store-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  return {
    paths,
    store,
    cleanup: async () => {
      try {
        store.close();
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        if (nodeError.code !== "ERR_INVALID_STATE") {
          throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function seedLegacyStore(): Promise<{ paths: BridgePaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ctb-store-legacy-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const db = new DatabaseSync(paths.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE authorized_user (
      telegram_user_id TEXT PRIMARY KEY,
      telegram_username TEXT NULL,
      display_name TEXT NULL,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE pending_authorization (
      telegram_user_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      telegram_username TEXT NULL,
      display_name TEXT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE chat_binding (
      telegram_chat_id TEXT PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      active_session_id TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE session (
      session_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      thread_id TEXT NULL,
      display_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      last_turn_id TEXT NULL,
      last_turn_status TEXT NULL
    );

    CREATE TABLE recent_project (
      project_path TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT NULL,
      last_success_at TEXT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE project_scan_cache (
      project_path TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      scan_root TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      detected_markers TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL,
      exists_now INTEGER NOT NULL
    );

    CREATE TABLE bootstrap_state (
      key TEXT PRIMARY KEY,
      readiness_state TEXT NOT NULL,
      details_json TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      app_server_pid TEXT NULL
    );

    CREATE TABLE runtime_notice (
      key TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  db.prepare(
    `
      INSERT INTO authorized_user (
        telegram_user_id,
        telegram_username,
        display_name,
        first_seen_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
    `
  ).run("user-legacy", "legacy", "Legacy User", "2026-03-10T10:00:00.000Z", "2026-03-10T10:00:00.000Z");

  db.prepare(
    `
      INSERT INTO chat_binding (
        telegram_chat_id,
        telegram_user_id,
        active_session_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
    `
  ).run("chat-legacy", "user-legacy", "session-legacy", "2026-03-10T10:00:00.000Z", "2026-03-10T10:00:00.000Z");

  db.prepare(
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
        created_at,
        last_used_at,
        last_turn_id,
        last_turn_status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    "session-legacy",
    "chat-legacy",
    "thread-legacy",
    "Legacy Session",
    "Legacy Project",
    "/tmp/legacy-project",
    "idle",
    null,
    "2026-03-10T10:00:00.000Z",
    "2026-03-10T10:00:00.000Z",
    null,
    "completed"
  );

  db.close();

  return {
    paths,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function createEmptyPaths(): Promise<{ paths: BridgePaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ctb-store-empty-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  return {
    paths,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("confirmPendingAuthorization migrates sessions, active session, and notices to rebound chat", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-1",
      telegramChatId: "chat-old",
      telegramUsername: "old_name",
      displayName: "Old Name"
    });
    const [initialCandidate] = store.listPendingAuthorizations();
    assert.ok(initialCandidate);
    store.confirmPendingAuthorization(initialCandidate);

    const firstSession = store.createSession({
      telegramChatId: "chat-old",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const secondSession = store.createSession({
      telegramChatId: "chat-old",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });
    store.setActiveSession("chat-old", firstSession.sessionId);
    store.updateSessionStatus(secondSession.sessionId, "running");
    store.markRunningSessionsFailedWithNotices("bridge_restart");

    store.upsertPendingAuthorization({
      telegramUserId: "user-1",
      telegramChatId: "chat-new",
      telegramUsername: "new_name",
      displayName: "New Name"
    });
    const [rebindCandidate] = store.listPendingAuthorizations();
    assert.ok(rebindCandidate);
    store.confirmPendingAuthorization(rebindCandidate);

    const newBinding = store.getChatBinding("chat-new");
    assert.ok(newBinding);
    assert.equal(newBinding.activeSessionId, firstSession.sessionId);
    assert.equal(store.getChatBinding("chat-old"), null);

    const reboundSessions = store.listSessions("chat-new", 10);
    assert.equal(reboundSessions.length, 2);
    assert.deepEqual(
      new Set(reboundSessions.map((session) => session.sessionId)),
      new Set([firstSession.sessionId, secondSession.sessionId])
    );
    assert.equal(store.listSessions("chat-old", 10).length, 0);

    const activeSession = store.getActiveSession("chat-new");
    assert.equal(activeSession?.sessionId, firstSession.sessionId);

    const notices = store.listRuntimeNotices("chat-new");
    assert.equal(notices.length, 1);
    assert.equal(notices[0]?.telegramChatId, "chat-new");
    assert.equal(store.listRuntimeNotices("chat-old").length, 0);
    assert.equal(store.countRuntimeNotices(), 1);
  } finally {
    await cleanup();
  }
});

test("open fails closed and writes a failure marker for obviously corrupt databases", async () => {
  const { paths, cleanup } = await createEmptyPaths();
  const { logger, errorEntries } = createCapturingLogger();

  try {
    await mkdir(paths.stateRoot, { recursive: true });
    await writeFile(paths.dbPath, "not a sqlite database", "utf8");

    await assert.rejects(
      () => BridgeStateStore.open(paths, logger),
      /state store open failed|file is not a database|sqlite/u
    );

    const marker = await readStateStoreFailure(paths);
    assert.ok(marker);
    assert.equal(marker?.classification, "integrity_failure");
    assert.equal(marker?.dbPath, paths.dbPath);
    const dbContent = await readFile(paths.dbPath, "utf8");
    assert.equal(dbContent, "not a sqlite database");
    assert.ok(errorEntries.some((entry) => entry.message === "state store open failed"));
  } finally {
    await cleanup();
  }
});

test("open writes a transient failure marker and does not rotate the database for transient integrity-check errors", async () => {
  const { paths, cleanup } = await createEmptyPaths();
  const { logger, errorEntries } = createCapturingLogger();
  const db = new DatabaseSync(paths.dbPath);
  db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)");
  db.close();

  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function patchedPrepare(sql: string) {
    if (sql === "PRAGMA integrity_check") {
      const error = new Error("database is locked");
      (error as NodeJS.ErrnoException).code = "ERR_SQLITE_ERROR";
      throw error;
    }
    return originalPrepare.call(this, sql);
  };

  try {
    await assert.rejects(
      () => BridgeStateStore.open(paths, logger),
      /database is locked/u
    );

    const files = await import("node:fs/promises").then(({ readdir }) => readdir(paths.stateRoot));
    assert.equal(files.some((name) => /^bridge\.db\.corrupt\./u.test(name)), false);
    const marker = await readStateStoreFailure(paths);
    assert.ok(marker);
    assert.equal(marker?.classification, "transient_open_failure");
    assert.ok(errorEntries.some((entry) => entry.message === "state store open failed"));
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    await cleanup();
  }
});

test("open writes a transient failure marker when ENOENT persists after the retry path", async () => {
  const { paths, cleanup } = await createEmptyPaths();
  const { logger } = createCapturingLogger();
  const originalOpenInitializedStore = (BridgeStateStore as any).openInitializedStore;
  const enoent = new Error("no such file or directory");
  (enoent as NodeJS.ErrnoException).code = "ENOENT";

  (BridgeStateStore as any).openInitializedStore = () => {
    throw enoent;
  };

  try {
    await assert.rejects(
      () => BridgeStateStore.open(paths, logger),
      (error: unknown) => {
        assert.ok(error instanceof StateStoreOpenError);
        assert.equal(error.failure.classification, "transient_open_failure");
        assert.equal(error.failure.stage, "open_db");
        return true;
      }
    );

    const marker = await readStateStoreFailure(paths);
    assert.ok(marker);
    assert.equal(marker?.classification, "transient_open_failure");
    assert.equal(marker?.stage, "open_db");
  } finally {
    (BridgeStateStore as any).openInitializedStore = originalOpenInitializedStore;
    await cleanup();
  }
});

test("open preserves the classified state-store error when writing the failure marker also fails", async () => {
  const { paths, cleanup } = await createEmptyPaths();
  const { logger, warnEntries } = createCapturingLogger();
  const originalOpenInitializedStore = (BridgeStateStore as any).openInitializedStore;
  const blockerPath = join(paths.stateRoot, "marker-parent-file");
  const enoent = new Error("no such file or directory");
  (enoent as NodeJS.ErrnoException).code = "ENOENT";

  (BridgeStateStore as any).openInitializedStore = () => {
    throw enoent;
  };

  try {
    await writeFile(blockerPath, "not a directory", "utf8");
    paths.stateStoreFailurePath = join(blockerPath, "failure.json");

    await assert.rejects(
      () => BridgeStateStore.open(paths, logger),
      (error: unknown) => {
        assert.ok(error instanceof StateStoreOpenError);
        assert.equal(error.failure.classification, "transient_open_failure");
        assert.equal(error.failure.stage, "open_db");
        assert.match(error.failure.error, /no such file or directory/u);
        return true;
      }
    );

    assert.ok(warnEntries.some((entry) => entry.message === "state store failure marker write failed"));
  } finally {
    (BridgeStateStore as any).openInitializedStore = originalOpenInitializedStore;
    await cleanup();
  }
});

test("open classifies malformed schema failures separately from integrity corruption", async () => {
  const { paths, cleanup } = await createEmptyPaths();
  const { logger } = createCapturingLogger();
  const db = new DatabaseSync(paths.dbPath);
  db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)");
  db.close();

  const originalPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function patchedPrepare(sql: string) {
    if (sql === "PRAGMA integrity_check") {
      throw new Error("malformed database schema (session)");
    }
    return originalPrepare.call(this, sql);
  };

  try {
    await assert.rejects(
      () => BridgeStateStore.open(paths, logger),
      (error: unknown) => {
        assert.ok(error instanceof StateStoreOpenError);
        assert.equal(error.failure.classification, "schema_failure");
        assert.equal(error.failure.stage, "verify_integrity");
        return true;
      }
    );

    const marker = await readStateStoreFailure(paths);
    assert.ok(marker);
    assert.equal(marker?.classification, "schema_failure");
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    await cleanup();
  }
});

test("open clears a stale state-store failure marker after a successful open", async () => {
  const { paths, cleanup } = await createEmptyPaths();

  try {
    await writeFile(paths.stateStoreFailurePath, JSON.stringify({
      detectedAt: "2026-03-14T08:00:00.000Z",
      dbPath: paths.dbPath,
      stage: "verify_integrity",
      classification: "transient_open_failure",
      error: "database is locked",
      recommendedAction: "retry"
    }, null, 2));

    const store = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.equal(await readStateStoreFailure(paths), null);
    } finally {
      store.close();
    }
  } finally {
    await cleanup();
  }
});

test("confirmPendingAuthorization keeps first-time authorization behavior unchanged", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-2",
      telegramChatId: "chat-fresh",
      telegramUsername: null,
      displayName: null
    });
    const [candidate] = store.listPendingAuthorizations();
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const binding = store.getChatBinding("chat-fresh");
    assert.ok(binding);
    assert.equal(binding.activeSessionId, null);
    assert.equal(store.listSessions("chat-fresh").length, 0);
    assert.equal(store.countRuntimeNotices(), 0);
  } finally {
    await cleanup();
  }
});

test("archiveSession hides archived sessions by default and reassigns the active session", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-archive",
      telegramChatId: "chat-archive",
      telegramUsername: "archiver",
      displayName: "Archiver"
    });
    const [candidate] = store.listPendingAuthorizations();
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const firstSession = store.createSession({
      telegramChatId: "chat-archive",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const secondSession = store.createSession({
      telegramChatId: "chat-archive",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });

    store.setActiveSession("chat-archive", firstSession.sessionId);
    store.archiveSession(firstSession.sessionId);

    const visibleSessions = store.listSessions("chat-archive", { archived: false, limit: 10 });
    assert.equal(visibleSessions.length, 1);
    assert.equal(visibleSessions[0]?.sessionId, secondSession.sessionId);

    const archivedSessions = store.listSessions("chat-archive", { archived: true, limit: 10 });
    assert.equal(archivedSessions.length, 1);
    assert.equal(archivedSessions[0]?.sessionId, firstSession.sessionId);
    assert.equal(archivedSessions[0]?.archived, true);
    assert.ok(archivedSessions[0]?.archivedAt);
    assert.equal(archivedSessions[0]?.lastUsedAt, firstSession.lastUsedAt);

    const activeSession = store.getActiveSession("chat-archive");
    assert.equal(activeSession?.sessionId, secondSession.sessionId);
  } finally {
    await cleanup();
  }
});

test("unarchiveSession restores a session and makes it active when no active session remains", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-unarchive",
      telegramChatId: "chat-unarchive",
      telegramUsername: "restorer",
      displayName: "Restorer"
    });
    const [candidate] = store.listPendingAuthorizations();
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const session = store.createSession({
      telegramChatId: "chat-unarchive",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    store.archiveSession(session.sessionId);
    assert.equal(store.getActiveSession("chat-unarchive"), null);

    store.unarchiveSession(session.sessionId);

    const visibleSessions = store.listSessions("chat-unarchive", { archived: false, limit: 10 });
    assert.equal(visibleSessions.length, 1);
    assert.equal(visibleSessions[0]?.sessionId, session.sessionId);
    assert.equal(visibleSessions[0]?.archived, false);
    assert.equal(visibleSessions[0]?.archivedAt, null);
    assert.equal(visibleSessions[0]?.lastUsedAt, session.lastUsedAt);

    const activeSession = store.getActiveSession("chat-unarchive");
    assert.equal(activeSession?.sessionId, session.sessionId);
  } finally {
    await cleanup();
  }
});

test("open migrates legacy session rows to include archive metadata", async () => {
  const { paths, cleanup } = await seedLegacyStore();

  let store: BridgeStateStore | null = null;

  try {
    store = await BridgeStateStore.open(paths, testLogger);
    const sessions = store.listSessions("chat-legacy", { archived: false, limit: 10 });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.sessionId, "session-legacy");
    assert.equal(sessions[0]?.archived, false);
    assert.equal(sessions[0]?.archivedAt, null);

    const archivedSessions = store.listSessions("chat-legacy", { archived: true, limit: 10 });
    assert.equal(archivedSessions.length, 0);
  } finally {
    store?.close();
    await cleanup();
  }
});

test("archiveSession rejects running sessions even when called directly", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-running",
      telegramChatId: "chat-running",
      telegramUsername: "runner",
      displayName: "Runner"
    });
    const [candidate] = store.listPendingAuthorizations();
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const session = store.createSession({
      telegramChatId: "chat-running",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionStatus(session.sessionId, "running");

    assert.throws(() => store.archiveSession(session.sessionId), /running session/i);
  } finally {
    await cleanup();
  }
});

test("open normalizes archived active-session pointers to the newest visible session", async () => {
  const { paths, store, cleanup } = await openStore();
  let reopenedStore: BridgeStateStore | null = null;

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-normalize",
      telegramChatId: "chat-normalize",
      telegramUsername: "normalizer",
      displayName: "Normalizer"
    });
    const [candidate] = store.listPendingAuthorizations();
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const archivedSession = store.createSession({
      telegramChatId: "chat-normalize",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const visibleSession = store.createSession({
      telegramChatId: "chat-normalize",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });

    store.archiveSession(archivedSession.sessionId);
    store.setActiveSession("chat-normalize", archivedSession.sessionId);
    store.close();

    reopenedStore = await BridgeStateStore.open(paths, testLogger);
    const activeSession = reopenedStore.getActiveSession("chat-normalize");
    assert.equal(activeSession?.sessionId, visibleSession.sessionId);
  } finally {
    reopenedStore?.close();
    await cleanup();
  }
});

test("getSessionByThreadId returns archived and visible sessions for diagnostics", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-thread-lookup",
      telegramChatId: "chat-thread-lookup",
      telegramUsername: "lookup",
      displayName: "Lookup"
    });
    const [candidate] = store.listPendingAuthorizations();
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const visibleSession = store.createSession({
      telegramChatId: "chat-thread-lookup",
      projectName: "Visible Project",
      projectPath: "/tmp/visible-project"
    });
    store.updateSessionThreadId(visibleSession.sessionId, "thread-visible");

    const archivedSession = store.createSession({
      telegramChatId: "chat-thread-lookup",
      projectName: "Archived Project",
      projectPath: "/tmp/archived-project"
    });
    store.updateSessionThreadId(archivedSession.sessionId, "thread-archived");
    store.archiveSession(archivedSession.sessionId);

    assert.equal(store.getSessionByThreadId("thread-visible")?.sessionId, visibleSession.sessionId);
    assert.equal(store.getSessionByThreadId("thread-archived")?.sessionId, archivedSession.sessionId);
    assert.equal(store.getSessionByThreadId("thread-missing"), null);
  } finally {
    await cleanup();
  }
});

test("saveFinalAnswerView keeps only the 50 most recent answers per chat", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-final-answer-limit",
      telegramChatId: "chat-final-answer-limit",
      telegramUsername: "viewer",
      displayName: "Viewer"
    });
    const [candidate] = store.listPendingAuthorizations();
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const session = store.createSession({
      telegramChatId: "chat-final-answer-limit",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionThreadId(session.sessionId, "thread-final-answer-limit");

    for (let index = 0; index < 55; index += 1) {
      store.saveFinalAnswerView({
        answerId: `answer-${index}`,
        telegramChatId: "chat-final-answer-limit",
        telegramMessageId: 1000 + index,
        sessionId: session.sessionId,
        threadId: "thread-final-answer-limit",
        turnId: `turn-${index}`,
        previewHtml: `<b>Preview ${index}</b>`,
        pages: [`Page ${index}`]
      });
    }

    const views = store.listFinalAnswerViews("chat-final-answer-limit");
    assert.equal(views.length, 50);
    assert.equal(views.at(0)?.answerId, "answer-54");
    assert.equal(views.at(-1)?.answerId, "answer-5");
    assert.equal(store.getFinalAnswerView("answer-0", "chat-final-answer-limit"), null);
    assert.equal(store.getFinalAnswerView("answer-54", "chat-final-answer-limit")?.telegramMessageId, 1054);
  } finally {
    await cleanup();
  }
});

test("confirmPendingAuthorization migrates persisted final answers to the rebound chat", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-final-answer-rebind",
      telegramChatId: "chat-old-final-answer",
      telegramUsername: "viewer_old",
      displayName: "Viewer Old"
    });
    const [initialCandidate] = store.listPendingAuthorizations();
    assert.ok(initialCandidate);
    store.confirmPendingAuthorization(initialCandidate);

    const session = store.createSession({
      telegramChatId: "chat-old-final-answer",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionThreadId(session.sessionId, "thread-final-answer-rebind");

    store.saveFinalAnswerView({
      answerId: "answer-rebind",
      telegramChatId: "chat-old-final-answer",
      telegramMessageId: 77,
      sessionId: session.sessionId,
      threadId: "thread-final-answer-rebind",
      turnId: "turn-final-answer-rebind",
      previewHtml: "<b>Preview</b>",
      pages: ["Page 1", "Page 2"]
    });

    store.upsertPendingAuthorization({
      telegramUserId: "user-final-answer-rebind",
      telegramChatId: "chat-new-final-answer",
      telegramUsername: "viewer_new",
      displayName: "Viewer New"
    });
    const [rebindCandidate] = store.listPendingAuthorizations();
    assert.ok(rebindCandidate);
    store.confirmPendingAuthorization(rebindCandidate);

    assert.equal(store.getFinalAnswerView("answer-rebind", "chat-old-final-answer"), null);
    const migrated = store.getFinalAnswerView("answer-rebind", "chat-new-final-answer");
    assert.ok(migrated);
    assert.equal(migrated?.telegramChatId, "chat-new-final-answer");
    assert.equal(migrated?.telegramMessageId, 77);
  } finally {
    await cleanup();
  }
});

test("clearAuthorization removes persisted final answers", async () => {
  const { store, cleanup } = await openStore();

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-final-answer-clear",
      telegramChatId: "chat-final-answer-clear",
      telegramUsername: "viewer",
      displayName: "Viewer"
    });
    const [candidate] = store.listPendingAuthorizations();
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const session = store.createSession({
      telegramChatId: "chat-final-answer-clear",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionThreadId(session.sessionId, "thread-final-answer-clear");
    store.saveFinalAnswerView({
      answerId: "answer-clear",
      telegramChatId: "chat-final-answer-clear",
      telegramMessageId: 88,
      sessionId: session.sessionId,
      threadId: "thread-final-answer-clear",
      turnId: "turn-final-answer-clear",
      previewHtml: "<b>Preview</b>",
      pages: ["Page 1"]
    });

    store.clearAuthorization();

    assert.equal(store.listFinalAnswerViews("chat-final-answer-clear").length, 0);
    assert.equal(store.getFinalAnswerView("answer-clear", "chat-final-answer-clear"), null);
  } finally {
    await cleanup();
  }
});

test("open migrates legacy stores so pending interactions can be persisted", async () => {
  const { paths, cleanup } = await seedLegacyStore();

  try {
    const store = await BridgeStateStore.open(paths, testLogger);
    try {
      const saved = store.createPendingInteraction({
        telegramChatId: "chat-legacy",
        sessionId: "session-legacy",
        threadId: "thread-legacy",
        turnId: "turn-legacy",
        requestId: JSON.stringify(7),
        requestMethod: "item/commandExecution/requestApproval",
        interactionKind: "approval",
        promptJson: JSON.stringify({ kind: "approval", title: "Approval" })
      });

      assert.equal(saved.requestMethod, "item/commandExecution/requestApproval");
      assert.equal(store.listUnresolvedPendingInteractions().length, 1);
    } finally {
      store.close();
    }
  } finally {
    await cleanup();
  }
});

test("pending interactions persist lifecycle state and survive reopen", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionThreadId(session.sessionId, "thread-1");

    const created = store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: JSON.stringify("server-1"),
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: JSON.stringify({
        kind: "questionnaire",
        title: "Need answers",
        questions: [{ id: "environment" }]
      })
    });

    store.setPendingInteractionMessageId(created.interactionId, 7001);
    store.markPendingInteractionAwaitingText(
      created.interactionId,
      JSON.stringify({
        answers: {},
        awaitingQuestionId: "environment"
      })
    );

    const awaiting = store.getPendingInteraction(created.interactionId, "chat-1");
    assert.equal(awaiting?.telegramMessageId, 7001);
    assert.equal(awaiting?.state, "awaiting_text");

    store.markPendingInteractionPending(
      created.interactionId,
      JSON.stringify({
        answers: {
          environment: {
            answers: ["staging"]
          }
        }
      })
    );
    store.markPendingInteractionAnswered(
      created.interactionId,
      JSON.stringify({
        answers: {
          environment: {
            answers: ["staging"]
          }
        }
      })
    );

    const answered = store.getPendingInteraction(created.interactionId, "chat-1");
    assert.equal(answered?.state, "answered");
    assert.ok(answered?.resolvedAt);
    assert.equal(store.listPendingInteractionsByChat("chat-1", ["answered"]).length, 1);

    store.close();
    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      const reloaded = reopened.getPendingInteraction(created.interactionId, "chat-1");
      assert.equal(reloaded?.state, "answered");
      assert.equal(reloaded?.telegramMessageId, 7001);
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("pending interactions persist canceled terminal state and exclude it from unresolved listings", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionThreadId(session.sessionId, "thread-1");

    const created = store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-2",
      requestId: JSON.stringify("server-cancel"),
      requestMethod: "item/commandExecution/requestApproval",
      interactionKind: "approval",
      promptJson: JSON.stringify({
        kind: "approval",
        title: "Need approval"
      })
    });

    store.markPendingInteractionCanceled(
      created.interactionId,
      JSON.stringify({ decision: "cancel" }),
      "user_canceled_interaction"
    );

    const canceled = store.getPendingInteraction(created.interactionId, "chat-1");
    assert.equal(canceled?.state, "canceled");
    assert.equal(canceled?.errorReason, "user_canceled_interaction");
    assert.ok(canceled?.resolvedAt);
    assert.equal(store.listPendingInteractionsByChat("chat-1", ["canceled"]).length, 1);
    assert.equal(store.listUnresolvedPendingInteractions().length, 0);

    store.close();
    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      const reloaded = reopened.getPendingInteraction(created.interactionId, "chat-1");
      assert.equal(reloaded?.state, "canceled");
      assert.equal(reloaded?.errorReason, "user_canceled_interaction");
      assert.equal(reopened.listUnresolvedPendingInteractions().length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("markPendingInteractionExpired persists expired terminal state", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionThreadId(session.sessionId, "thread-1");

    const created = store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-expired",
      requestId: JSON.stringify("server-expired"),
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: JSON.stringify({
        kind: "questionnaire",
        title: "Need answers"
      })
    });

    store.markPendingInteractionExpired(created.interactionId, "turn_completed");

    const expired = store.getPendingInteraction(created.interactionId, "chat-1");
    assert.equal(expired?.state, "expired");
    assert.equal(expired?.errorReason, "turn_completed");
    assert.ok(expired?.resolvedAt);

    store.close();
    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      const reloaded = reopened.getPendingInteraction(created.interactionId, "chat-1");
      assert.equal(reloaded?.state, "expired");
      assert.equal(reloaded?.errorReason, "turn_completed");
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("markRunningSessionsFailedWithNotices also fails unresolved pending interactions", async () => {
  const { store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionThreadId(session.sessionId, "thread-1");
    store.updateSessionStatus(session.sessionId, "running", {
      lastTurnId: "turn-1",
      lastTurnStatus: "running"
    });

    const interaction = store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: JSON.stringify("server-2"),
      requestMethod: "item/commandExecution/requestApproval",
      interactionKind: "approval",
      promptJson: JSON.stringify({ kind: "approval", title: "Approval" })
    });
    const canceled = store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: JSON.stringify("server-3"),
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: JSON.stringify({ kind: "questionnaire", title: "Questions" })
    });
    store.markPendingInteractionCanceled(canceled.interactionId, null, "user_canceled_interaction");

    store.markRunningSessionsFailedWithNotices("bridge_restart");

    const failed = store.getPendingInteraction(interaction.interactionId, "chat-1");
    assert.equal(failed?.state, "failed");
    assert.equal(failed?.errorReason, "bridge_restart");
    const stillCanceled = store.getPendingInteraction(canceled.interactionId, "chat-1");
    assert.equal(stillCanceled?.state, "canceled");
    assert.equal(stillCanceled?.errorReason, "user_canceled_interaction");
  } finally {
    await cleanup();
  }
});

test("selected model and reasoning effort persist on sessions and survive reopen", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-model",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      selectedModel: "gpt-5",
      selectedReasoningEffort: "medium"
    });

    assert.equal(store.getSessionById(session.sessionId)?.selectedModel, "gpt-5");
    assert.equal(store.getSessionById(session.sessionId)?.selectedReasoningEffort, "medium");

    store.setSessionSelectedModel(session.sessionId, "gpt-5-codex");
    store.setSessionSelectedReasoningEffort(session.sessionId, "high");
    assert.equal(store.getSessionById(session.sessionId)?.selectedModel, "gpt-5-codex");
    assert.equal(store.getSessionById(session.sessionId)?.selectedReasoningEffort, "high");

    store.close();
    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.equal(reopened.getSessionById(session.sessionId)?.selectedModel, "gpt-5-codex");
      assert.equal(reopened.getSessionById(session.sessionId)?.selectedReasoningEffort, "high");
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("session plan mode defaults off, updates, and survives reopen", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-plan-mode",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    assert.equal((store.getSessionById(session.sessionId) as any)?.planMode, false);

    (store as any).setSessionPlanMode(session.sessionId, true);
    assert.equal((store.getSessionById(session.sessionId) as any)?.planMode, true);

    store.close();
    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.equal((reopened.getSessionById(session.sessionId) as any)?.planMode, true);
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("runtime card preferences default to no optional fields", async () => {
  const { store, cleanup } = await openStore();

  try {
    assert.deepEqual(store.getRuntimeCardPreferences().fields, []);
  } finally {
    await cleanup();
  }
});

test("createSession persists seeded thread and last-turn metadata", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-seeded-session",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      threadId: "thread-seeded",
      lastTurnId: "turn-seeded",
      lastTurnStatus: "completed"
    });

    assert.equal(store.getSessionById(session.sessionId)?.threadId, "thread-seeded");
    assert.equal(store.getSessionById(session.sessionId)?.lastTurnId, "turn-seeded");
    assert.equal(store.getSessionById(session.sessionId)?.lastTurnStatus, "completed");

    store.close();
    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.equal(reopened.getSessionById(session.sessionId)?.threadId, "thread-seeded");
      assert.equal(reopened.getSessionById(session.sessionId)?.lastTurnId, "turn-seeded");
      assert.equal(reopened.getSessionById(session.sessionId)?.lastTurnStatus, "completed");
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("project aliases persist on recent projects and are exposed on session lookups", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-project-alias",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    store.setProjectAlias({
      projectPath: session.projectPath,
      projectName: session.projectName,
      projectAlias: "Alias One",
      sessionId: session.sessionId
    });

    assert.equal(store.getRecentProjectByPath(session.projectPath)?.projectAlias, "Alias One");
    assert.equal(store.getSessionById(session.sessionId)?.projectAlias, "Alias One");
    assert.equal(store.listSessions("chat-project-alias")[0]?.projectAlias, "Alias One");

    store.clearProjectAlias(session.projectPath);
    assert.equal(store.getSessionById(session.sessionId)?.projectAlias, null);

    store.setProjectAlias({
      projectPath: session.projectPath,
      projectName: session.projectName,
      projectAlias: "Alias Two",
      sessionId: session.sessionId
    });

    store.close();
    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.equal(reopened.getRecentProjectByPath(session.projectPath)?.projectAlias, "Alias Two");
      assert.equal(reopened.getSessionById(session.sessionId)?.projectAlias, "Alias Two");
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("open migrates legacy session rows to include selected model column", async () => {
  const { paths, cleanup } = await seedLegacyStore();
  let store: BridgeStateStore | null = null;

  try {
    store = await BridgeStateStore.open(paths, testLogger);
    assert.equal(store.getSessionById("session-legacy")?.selectedModel, null);

    store.setSessionSelectedModel("session-legacy", "gpt-5");
    assert.equal(store.getSessionById("session-legacy")?.selectedModel, "gpt-5");
  } finally {
    store?.close();
    await cleanup();
  }
});

test("open migrates legacy recent projects to include project aliases", async () => {
  const { paths, cleanup } = await seedLegacyStore();
  let store: BridgeStateStore | null = null;

  try {
    store = await BridgeStateStore.open(paths, testLogger);
    assert.equal(store.getRecentProjectByPath("/tmp/legacy-project"), null);

    store.setProjectAlias({
      projectPath: "/tmp/legacy-project",
      projectName: "Legacy Project",
      projectAlias: "Legacy Alias",
      sessionId: "session-legacy"
    });
    assert.equal(store.getSessionById("session-legacy")?.projectAlias, "Legacy Alias");
  } finally {
    store?.close();
    await cleanup();
  }
});

test("listPendingInteractionsByRequest returns only unresolved rows for the exact stored request id", async () => {
  const { store, cleanup } = await openStore();

  try {
    const session = store.createSession({
      telegramChatId: "chat-request-id",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.updateSessionThreadId(session.sessionId, "thread-request-id");

    const pending = store.createPendingInteraction({
      telegramChatId: "chat-request-id",
      sessionId: session.sessionId,
      threadId: "thread-request-id",
      turnId: "turn-1",
      requestId: "\"server-1\"",
      requestMethod: "item/commandExecution/requestApproval",
      interactionKind: "approval",
      promptJson: JSON.stringify({ kind: "approval", title: "Need approval" })
    });
    const awaitingText = store.createPendingInteraction({
      telegramChatId: "chat-request-id",
      sessionId: session.sessionId,
      threadId: "thread-request-id",
      turnId: "turn-1",
      requestId: "\"server-1\"",
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: JSON.stringify({ kind: "questionnaire", title: "Need input" })
    });
    const answered = store.createPendingInteraction({
      telegramChatId: "chat-request-id",
      sessionId: session.sessionId,
      threadId: "thread-request-id",
      turnId: "turn-1",
      requestId: "\"server-1\"",
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: JSON.stringify({ kind: "questionnaire", title: "Answered" })
    });
    const otherRequest = store.createPendingInteraction({
      telegramChatId: "chat-request-id",
      sessionId: session.sessionId,
      threadId: "thread-request-id",
      turnId: "turn-1",
      requestId: "\"server-2\"",
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: JSON.stringify({ kind: "questionnaire", title: "Other request" })
    });

    store.markPendingInteractionAwaitingText(awaitingText.interactionId, JSON.stringify({ awaitingQuestionId: "q1" }));
    store.markPendingInteractionAnswered(answered.interactionId, JSON.stringify({ decision: "accept" }));

    const matching = store.listPendingInteractionsByRequest("thread-request-id", "\"server-1\"");
    assert.deepEqual(
      matching.map((row) => row.interactionId).sort(),
      [awaitingText.interactionId, pending.interactionId].sort()
    );
    assert.equal(matching.some((row) => row.interactionId === answered.interactionId), false);
    assert.equal(matching.some((row) => row.interactionId === otherRequest.interactionId), false);
  } finally {
    await cleanup();
  }
});

test("runtime card preferences persist across reopen and default when missing", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    assert.deepEqual(store.getRuntimeCardPreferences().fields, []);

    store.setRuntimeCardPreferences(["thread_id", "turn_id"]);
    store.close();

    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.deepEqual(reopened.getRuntimeCardPreferences().fields, ["thread_id", "turn_id"]);
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("runtime card preferences preserve an explicit empty selection", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    store.setRuntimeCardPreferences([]);
    store.close();

    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.deepEqual(reopened.getRuntimeCardPreferences().fields, []);
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("runtime card preferences lazily migrate legacy runtime field ids to v4 cli ids and keep bridge extensions", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    store.close();

    const db = new DatabaseSync(paths.dbPath);
    db.prepare(
      `
        INSERT OR REPLACE INTO runtime_card_preferences (
          key,
          fields_json,
          updated_at
        )
        VALUES ('global', ?, ?)
      `
    ).run(
      JSON.stringify([
        "project_path",
        "model_reasoning",
        "thread_id",
        "model-name",
        "current_step",
        "final_answer_ready"
      ]),
      "2026-03-16T09:00:00.000Z"
    );
    db.close();

    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.deepEqual(reopened.getRuntimeCardPreferences().fields, [
        "current-dir",
        "model-with-reasoning",
        "session-id",
        "model-name",
        "current_step",
        "final_answer_ready"
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});

test("turn input source records persist across reopen", async () => {
  const { paths, store, cleanup } = await openStore();

  try {
    store.saveTurnInputSource({
      threadId: "thread-voice",
      turnId: "turn-voice",
      sourceKind: "voice",
      transcript: "打开日志"
    });
    store.close();

    const reopened = await BridgeStateStore.open(paths, testLogger);
    try {
      assert.deepEqual(reopened.getTurnInputSource("thread-voice", "turn-voice"), {
        threadId: "thread-voice",
        turnId: "turn-voice",
        sourceKind: "voice",
        transcript: "打开日志",
        createdAt: reopened.getTurnInputSource("thread-voice", "turn-voice")?.createdAt ?? ""
      });
    } finally {
      reopened.close();
    }
  } finally {
    await cleanup();
  }
});
