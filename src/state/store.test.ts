import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { BridgeStateStore } from "./store.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

function createTestPaths(root: string): BridgePaths {
  return {
    homeDir: root,
    repoRoot: root,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir: join(root, "logs"),
    runtimeDir: join(root, "runtime"),
    cacheDir: join(root, "cache"),
    debugRuntimeDir: join(root, "runtime", "debug"),
    dbPath: join(root, "state", "bridge.db"),
    envPath: join(root, "config", "bridge.env"),
    servicePath: join(root, "service", "bridge.service"),
    binPath: join(root, "bin", "ctb"),
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(root, "runtime", "telegram-offset.json"),
    bridgeLogPath: join(root, "logs", "bridge.log"),
    bootstrapLogPath: join(root, "logs", "bootstrap.log"),
    appServerLogPath: join(root, "logs", "app-server.log")
  };
}

async function openStore(): Promise<{ paths: BridgePaths; store: BridgeStateStore; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ctb-store-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.debugRuntimeDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  return {
    paths,
    store,
    cleanup: async () => {
      store.close();
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
