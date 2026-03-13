import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { BridgeStateStore } from "./store.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

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
