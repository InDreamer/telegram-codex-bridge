import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgePaths } from "../paths.js";
import { BridgeStateStore } from "../state/store.js";
import { SessionProjectCoordinator } from "./session-project-coordinator.js";

function createTestPaths(root: string): BridgePaths {
  const logsDir = join(root, "logs");
  const runtimeDir = join(root, "runtime");

  return {
    homeDir: root,
    repoRoot: root,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir,
    telegramSessionFlowLogsDir: join(logsDir, "telegram-session-flow"),
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
    telegramStatusCardLogPath: join(logsDir, "status-card.log"),
    telegramPlanCardLogPath: join(logsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(logsDir, "error-card.log")
  };
}

async function createCoordinatorContext() {
  const root = await mkdtemp(join(tmpdir(), "ctb-session-project-coordinator-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, {
    info: async () => {},
    warn: async () => {},
    error: async () => {}
  });
  const reanchorCalls: Array<{ chatId: string; sessionId: string; reason: string }> = [];
  const sentMessages: Array<{ messageId: number; text: string; html: boolean }> = [];
  const deletedMessages: number[] = [];
  const editedMessages: Array<{ messageId: number; text: string; html: boolean }> = [];
  let nextMessageId = 100;

  const coordinator = new SessionProjectCoordinator({
    logger: { warn: async () => {} },
    paths: { homeDir: root },
    config: { projectScanRoots: [] },
    getStore: () => store,
    getSnapshot: () => null,
    ensureAppServerAvailable: async () => {
      throw new Error("not used");
    },
    registerPendingThreadArchiveOp: () => 0,
    markPendingThreadArchiveCommit: async () => {},
    dropPendingThreadArchiveOp: () => {},
    safeSendMessage: async (_chatId, text) => {
      sentMessages.push({ messageId: nextMessageId, text, html: false });
      nextMessageId += 1;
      return true;
    },
    safeSendMessageResult: async (_chatId, text) => {
      const messageId = nextMessageId;
      sentMessages.push({ messageId, text, html: false });
      nextMessageId += 1;
      return { message_id: messageId };
    },
    safeSendHtmlMessage: async (_chatId, text) => {
      sentMessages.push({ messageId: nextMessageId, text, html: true });
      nextMessageId += 1;
      return true;
    },
    safeSendHtmlMessageResult: async (_chatId, text) => {
      const messageId = nextMessageId;
      sentMessages.push({ messageId, text, html: true });
      nextMessageId += 1;
      return { message_id: messageId };
    },
    safeEditMessageText: async (_chatId, messageId, text) => {
      editedMessages.push({ messageId, text, html: false });
      return { outcome: "edited" };
    },
    safeEditHtmlMessageText: async (_chatId, messageId, text) => {
      editedMessages.push({ messageId, text, html: true });
      return { outcome: "edited" };
    },
    safeDeleteMessage: async (_chatId, messageId) => {
      deletedMessages.push(messageId);
      return { outcome: "deleted" };
    },
    getActiveRuntimeStatusText: () => null,
    reanchorRuntimeAfterBridgeReply: async (chatId, sessionId, reason) => {
      reanchorCalls.push({ chatId, sessionId, reason });
    }
  });

  return {
    coordinator,
    store,
    reanchorCalls,
    sentMessages,
    deletedMessages,
    editedMessages,
    paths,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function authorizeChat(store: BridgeStateStore, chatId: string): void {
  store.upsertPendingAuthorization({
    telegramUserId: "user-1",
    telegramChatId: chatId,
    telegramUsername: "tester",
    displayName: "Tester"
  });

  const candidate = store.listPendingAuthorizations()[0];
  assert.ok(candidate);
  store.confirmPendingAuthorization(candidate);
}

async function createDiscoveredProject(root: string, name: string): Promise<string> {
  const projectPath = join(root, "Repo", name);
  await mkdir(projectPath, { recursive: true });
  await mkdir(join(projectPath, ".git"), { recursive: true });
  return projectPath;
}

test("SessionProjectCoordinator reanchors runtime hubs after project picker creates a new session", async () => {
  const { coordinator, store, reanchorCalls, cleanup } = await createCoordinatorContext();

  try {
    authorizeChat(store, "chat-1");
    (coordinator as any).pickerStates.set("chat-1", {
      picker: {
        projectMap: new Map([["project-1", {
          projectName: "Project One",
          projectPath: "/tmp/project-one",
          displayName: "Project One"
        }]])
      },
      awaitingManualProjectPath: false,
      resolved: false,
      interactiveMessageId: 41
    });

    await coordinator.handleProjectPick("chat-1", 41, "project-1");

    const created = store.getActiveSession("chat-1");
    assert.ok(created);
    assert.deepEqual(reanchorCalls, [{
      chatId: "chat-1",
      sessionId: created.sessionId,
      reason: "session_created"
    }]);
  } finally {
    await cleanup();
  }
});

test("SessionProjectCoordinator reanchors runtime hubs after manual-path confirmation creates a new session", async () => {
  const { coordinator, store, reanchorCalls, cleanup } = await createCoordinatorContext();

  try {
    authorizeChat(store, "chat-1");
    (coordinator as any).pickerStates.set("chat-1", {
      picker: {
        projectMap: new Map([["manual-1", {
          projectName: "Manual Project",
          projectPath: "/tmp/manual-project",
          displayName: "Manual Project"
        }]])
      },
      awaitingManualProjectPath: true,
      resolved: false,
      interactiveMessageId: 52
    });

    await coordinator.confirmManualProject("chat-1", 52, "manual-1");

    const created = store.getActiveSession("chat-1");
    assert.ok(created);
    assert.deepEqual(reanchorCalls, [{
      chatId: "chat-1",
      sessionId: created.sessionId,
      reason: "session_created"
    }]);
  } finally {
    await cleanup();
  }
});

test("handleNew deletes the previous picker and sends a fresh picker message", async () => {
  const {
    coordinator,
    store,
    sentMessages,
    deletedMessages,
    editedMessages,
    paths,
    cleanup
  } = await createCoordinatorContext();

  try {
    authorizeChat(store, "chat-1");
    await createDiscoveredProject(paths.homeDir, "picker-project");

    await coordinator.handleNew("chat-1");
    const firstPickerMessageId = sentMessages[0]?.messageId;
    assert.ok(firstPickerMessageId);

    await coordinator.handleNew("chat-1");

    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[0]?.text ?? "", /选择要新建会话的项目/u);
    assert.match(sentMessages[1]?.text ?? "", /选择要新建会话的项目/u);
    assert.deepEqual(deletedMessages, [firstPickerMessageId]);
    assert.deepEqual(editedMessages, []);
    assert.equal((coordinator as any).pickerStates.get("chat-1")?.interactiveMessageId, sentMessages[1]?.messageId);
  } finally {
    await cleanup();
  }
});

test("returnToProjectPicker deletes the current picker and sends a fresh picker message", async () => {
  const {
    coordinator,
    store,
    sentMessages,
    deletedMessages,
    editedMessages,
    paths,
    cleanup
  } = await createCoordinatorContext();

  try {
    authorizeChat(store, "chat-1");
    await createDiscoveredProject(paths.homeDir, "picker-project");

    await coordinator.handleNew("chat-1");
    const firstPickerMessageId = sentMessages[0]?.messageId;
    assert.ok(firstPickerMessageId);

    await coordinator.enterManualPathMode("chat-1", firstPickerMessageId);
    const currentInteractiveMessageId = (coordinator as any).pickerStates.get("chat-1")?.interactiveMessageId;
    assert.ok(currentInteractiveMessageId);

    await coordinator.returnToProjectPicker("chat-1", currentInteractiveMessageId);

    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[1]?.text ?? "", /选择要新建会话的项目/u);
    assert.deepEqual(deletedMessages, [currentInteractiveMessageId]);
    assert.equal(editedMessages[0]?.messageId, firstPickerMessageId);
    assert.equal((coordinator as any).pickerStates.get("chat-1")?.interactiveMessageId, sentMessages[1]?.messageId);
  } finally {
    await cleanup();
  }
});

test("stale picker message ids expire after a newer picker is sent", async () => {
  const {
    coordinator,
    store,
    sentMessages,
    deletedMessages,
    paths,
    cleanup
  } = await createCoordinatorContext();

  try {
    authorizeChat(store, "chat-1");
    await createDiscoveredProject(paths.homeDir, "picker-project");

    await coordinator.handleNew("chat-1");
    const firstPickerMessageId = sentMessages[0]?.messageId;
    const firstProjectKey = [...((coordinator as any).pickerStates.get("chat-1")?.picker.projectMap.keys() ?? [])][0];
    assert.ok(firstPickerMessageId);
    assert.ok(firstProjectKey);

    await coordinator.handleNew("chat-1");
    const secondPickerMessageId = sentMessages[1]?.messageId;
    assert.ok(secondPickerMessageId);

    await coordinator.handleProjectPick("chat-1", firstPickerMessageId, firstProjectKey);

    assert.equal(store.getActiveSession("chat-1"), null);
    assert.deepEqual(deletedMessages, [firstPickerMessageId]);
    assert.equal(sentMessages.at(-1)?.text, "这个按钮已过期，请重新操作。");
    assert.equal((coordinator as any).pickerStates.get("chat-1")?.interactiveMessageId, secondPickerMessageId);
  } finally {
    await cleanup();
  }
});
