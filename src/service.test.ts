import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { BridgePaths } from "./paths.js";
import { BridgeService } from "./service.js";
import { BridgeStateStore } from "./state/store.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

const testConfig: BridgeConfig = {
  telegramBotToken: "test-token",
  codexBin: "codex",
  telegramApiBaseUrl: "https://api.telegram.org",
  telegramPollTimeoutSeconds: 20,
  telegramPollIntervalMs: 1500
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

async function createServiceContext(): Promise<{
  service: BridgeService;
  store: BridgeStateStore;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ctb-service-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  const service = new BridgeService(paths, testConfig);

  (service as any).store = store;
  (service as any).logger = testLogger;

  return {
    service,
    store,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

function seedRuntimeNotice(store: BridgeStateStore, chatId: string): void {
  const session = store.createSession({
    telegramChatId: chatId,
    projectName: "Project One",
    projectPath: "/tmp/project-one"
  });
  store.updateSessionStatus(session.sessionId, "running");
  store.markRunningSessionsFailedWithNotices("bridge_restart");
}

test("flushRuntimeNotices clears notices after a successful Telegram delivery", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const delivered: string[] = [];

  try {
    seedRuntimeNotice(store, "chat-1");
    (service as any).api = {
      sendMessage: async (chatId: string, text: string) => {
        delivered.push(`${chatId}:${text}`);
      }
    };

    await (service as any).flushRuntimeNotices("chat-1");

    assert.equal(delivered.length, 1);
    assert.equal(store.listRuntimeNotices("chat-1").length, 0);
    assert.equal(store.countRuntimeNotices(), 0);
  } finally {
    await cleanup();
  }
});

test("flushRuntimeNotices retains notices after a failed delivery and retries later", async () => {
  const { service, store, cleanup } = await createServiceContext();
  let attempts = 0;

  try {
    seedRuntimeNotice(store, "chat-1");
    (service as any).api = {
      sendMessage: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("telegram down");
        }
      }
    };

    await (service as any).flushRuntimeNotices("chat-1");
    assert.equal(store.listRuntimeNotices("chat-1").length, 1);
    assert.equal(store.countRuntimeNotices(), 1);

    await (service as any).flushRuntimeNotices("chat-1");
    assert.equal(store.listRuntimeNotices("chat-1").length, 0);
    assert.equal(store.countRuntimeNotices(), 0);
    assert.equal(attempts, 2);
  } finally {
    await cleanup();
  }
});

test("handleProjectPick clears picker state after a successful selection", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const chatId = "chat-1";
  const delivered: string[] = [];
  const candidate = {
    projectKey: "project-1",
    projectPath: "/tmp/project-one",
    projectName: "Project One",
    score: 100,
    pinned: false,
    hasExistingSession: false,
    lastUsedAt: null,
    lastSuccessAt: null,
    accessible: true,
    fromScan: false,
    detectedMarkers: []
  };

  try {
    (service as any).api = {
      sendMessage: async (targetChatId: string, text: string) => {
        delivered.push(`${targetChatId}:${text}`);
      }
    };

    (service as any).pickerStates.set(chatId, {
      picker: {
        title: "选择项目",
        emptyText: null,
        primary: candidate,
        frequent: [],
        partial: false,
        allRootsFailed: false,
        projectMap: new Map([[candidate.projectKey, candidate]])
      },
      awaitingManualProjectPath: false,
      resolved: false
    });

    await (service as any).handleProjectPick(chatId, candidate.projectKey);

    assert.equal(store.listSessions(chatId).length, 1);
    assert.deepEqual(delivered, [`${chatId}:当前项目：Project One`]);
    assert.equal((service as any).pickerStates.has(chatId), false);
  } finally {
    await cleanup();
  }
});

test("confirmManualProject creates a session and clears picker state", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const chatId = "chat-1";
  const delivered: string[] = [];
  const candidate = {
    projectKey: "project-1",
    projectPath: "/tmp/project-one",
    projectName: "Project One",
    score: 100,
    pinned: false,
    hasExistingSession: false,
    lastUsedAt: null,
    lastSuccessAt: null,
    accessible: true,
    fromScan: false,
    detectedMarkers: []
  };

  try {
    (service as any).api = {
      sendMessage: async (targetChatId: string, text: string) => {
        delivered.push(`${targetChatId}:${text}`);
      }
    };

    (service as any).pickerStates.set(chatId, {
      picker: {
        title: "选择项目",
        emptyText: null,
        primary: candidate,
        frequent: [],
        partial: false,
        allRootsFailed: false,
        projectMap: new Map([[candidate.projectKey, candidate]])
      },
      awaitingManualProjectPath: true,
      resolved: false
    });

    await (service as any).confirmManualProject(chatId, candidate.projectKey);

    const [session] = store.listSessions(chatId);
    assert.equal(store.listSessions(chatId).length, 1);
    assert.equal(session?.projectName, candidate.projectName);
    assert.equal(session?.projectPath, candidate.projectPath);
    assert.deepEqual(delivered, [`${chatId}:当前项目：Project One`]);
    assert.equal((service as any).pickerStates.has(chatId), false);
  } finally {
    await cleanup();
  }
});
