import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { BridgePaths } from "./paths.js";
import type { ActivityStatus } from "./activity/types.js";
import { ActivityTracker } from "./activity/tracker.js";
import { classifyNotification } from "./codex/notification-classifier.js";
import { BridgeService } from "./service.js";
import { BridgeStateStore } from "./state/store.js";
import { buildTurnStatusCard } from "./telegram/ui.js";
import type { ReadinessSnapshot } from "./types.js";

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

function createCapturingLogger() {
  const info: Array<{ message: string; meta?: unknown }> = [];
  const warn: Array<{ message: string; meta?: unknown }> = [];
  const error: Array<{ message: string; meta?: unknown }> = [];

  const logger: Logger = {
    info: async (message: string, meta?: unknown) => {
      info.push({ message, meta });
    },
    warn: async (message: string, meta?: unknown) => {
      warn.push({ message, meta });
    },
    error: async (message: string, meta?: unknown) => {
      error.push({ message, meta });
    }
  };

  return { logger, info, warn, error };
}

function createFakeTelegramMessage(messageId: number, text: string) {
  return {
    message_id: messageId,
    chat: {
      id: 1,
      type: "private" as const
    },
    date: 0,
    text
  };
}

function getMessageTexts(
  sent: Array<{ messageId: number; text: string }>,
  edited: Array<{ messageId: number; text: string }>,
  messageId: number
): string[] {
  return [
    ...sent.filter((entry) => entry.messageId === messageId).map((entry) => entry.text),
    ...edited.filter((entry) => entry.messageId === messageId).map((entry) => entry.text)
  ];
}

async function withMockedNow<T>(nowIso: string, callback: () => Promise<T>): Promise<T> {
  const RealDate = Date;
  const fixedTime = Date.parse(nowIso);

  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value ?? fixedTime);
    }

    static now(): number {
      return fixedTime;
    }

    static parse(text: string): number {
      return RealDate.parse(text);
    }

    static UTC(...args: Parameters<typeof Date.UTC>): number {
      return RealDate.UTC(...args);
    }
  }

  globalThis.Date = MockDate as unknown as DateConstructor;
  try {
    return await callback();
  } finally {
    globalThis.Date = RealDate;
  }
}

function createActivityStatus(overrides: Partial<ActivityStatus> = {}): ActivityStatus {
  return {
    turnStatus: "running",
    threadRuntimeState: "active",
    activeItemType: "agentMessage",
    activeItemId: "item-1",
    activeItemLabel: "assistant response",
    lastActivityAt: "2026-03-10T10:00:05.000Z",
    currentItemStartedAt: "2026-03-10T10:00:00.000Z",
    currentItemDurationSec: 5,
    lastHighValueEventType: "found",
    lastHighValueTitle: "Found: useful result",
    lastHighValueDetail: "useful result",
    latestProgress: null,
    recentStatusUpdates: [],
    threadBlockedReason: null,
    finalMessageAvailable: false,
    inspectAvailable: true,
    debugAvailable: true,
    errorState: null,
    ...overrides
  };
}

function createSession(store: BridgeStateStore, telegramChatId: string) {
  return store.createSession({
    telegramChatId,
    projectName: "Project One",
    projectPath: "/tmp/project-one"
  });
}

function installRunningAppServer(
  service: BridgeService,
  threadId: string,
  turnId: string,
  resumeThread: (threadId: string) => Promise<unknown> = async () => ({
    thread: { id: threadId, turns: [] }
  })
): void {
  (service as any).appServer = {
    isRunning: true,
    startThread: async () => ({ thread: { id: threadId } }),
    startTurn: async () => ({ turn: { id: turnId, status: "inProgress" } }),
    resumeThread
  };
}

function seedRuntimeNotice(store: BridgeStateStore, chatId: string): void {
  const session = createSession(store, chatId);
  store.updateSessionStatus(session.sessionId, "running");
  store.markRunningSessionsFailedWithNotices("bridge_restart");
}

function authorizeChat(store: BridgeStateStore, chatId: string): void {
  store.upsertPendingAuthorization({
    telegramUserId: "user-1",
    telegramChatId: chatId,
    telegramUsername: "tester",
    displayName: "Tester"
  });

  const candidate = store.listPendingAuthorizations()[0];
  if (!candidate) {
    throw new Error("expected pending authorization candidate");
  }

  store.confirmPendingAuthorization(candidate);
}

function authorizeChatWithSession(store: BridgeStateStore, chatId: string) {
  authorizeChat(store, chatId);
  return createSession(store, chatId);
}

function createReadinessSnapshot(
  overrides: Omit<Partial<ReadinessSnapshot>, "details"> & {
    details?: Partial<ReadinessSnapshot["details"]>;
  } = {}
): ReadinessSnapshot {
  const detailOverrides = (overrides.details ?? {}) as Partial<ReadinessSnapshot["details"]>;
  return {
    state: overrides.state ?? "ready",
    checkedAt: overrides.checkedAt ?? "2026-03-14T10:00:00.000Z",
    details: {
      codexInstalled: true,
      codexAuthenticated: true,
      appServerAvailable: true,
      telegramTokenValid: true,
      authorizedUserBound: false,
      issues: [],
      nodeVersion: "v25.8.1",
      nodeVersionSupported: true,
      codexVersion: "codex-cli 0.114.0",
      codexVersionSupported: true,
      serviceManager: "none",
      serviceManagerHealth: "warning",
      stateRootWritable: true,
      configRootWritable: true,
      installRootWritable: true,
      capabilityCheckPassed: true,
      capabilityCheckSource: "cache",
      ...detailOverrides
    },
    appServerPid: overrides.appServerPid ?? null
  };
}

test("flushRuntimeNotices clears notices after a successful Telegram delivery", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const delivered: string[] = [];

  try {
    seedRuntimeNotice(store, "chat-1");
    (service as any).api = {
      sendMessage: async (chatId: string, text: string, _options?: any) => {
        delivered.push(`${chatId}:${text}`);
        return createFakeTelegramMessage(1, text);
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

test("BridgeService.run refuses to enter the poll loop when readiness is bridge_unhealthy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-service-run-test-"));
  const paths = createTestPaths(root);
  let telegramApiCreated = false;
  let pollerCreated = false;
  let pollerRan = false;

  try {
    await Promise.all([
      mkdir(paths.installRoot, { recursive: true }),
      mkdir(paths.stateRoot, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.configRoot, { recursive: true }),
      mkdir(paths.cacheDir, { recursive: true })
    ]);

    const service = new BridgeService(paths, testConfig, {
      probeReadiness: async () => ({
        snapshot: createReadinessSnapshot({
          state: "bridge_unhealthy",
          details: {
            issues: ["Node v24.9.0 does not satisfy required range >=25.0.0"]
          }
        }),
        appServer: null
      }),
      createTelegramApi: () => {
        telegramApiCreated = true;
        throw new Error("telegram api should not be created");
      },
      createPoller: () => {
        pollerCreated = true;
        return {
          run: async () => {
            pollerRan = true;
          },
          stop: () => {}
        } as any;
      }
    } as any);

    await assert.rejects(
      service.run(),
      /service will not enter run loop/u
    );
    assert.equal(telegramApiCreated, false);
    assert.equal(pollerCreated, false);
    assert.equal(pollerRan, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run fails closed and records bootstrap diagnostics when the state store cannot be opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-service-test-"));
  const paths = createTestPaths(root);

  try {
    await Promise.all([
      mkdir(paths.installRoot, { recursive: true }),
      mkdir(paths.stateRoot, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.configRoot, { recursive: true })
    ]);
    await writeFile(paths.dbPath, "not a sqlite database", "utf8");

    const service = new BridgeService(paths, testConfig);

    await assert.rejects(
      service.run(),
      /state store open|sqlite|database/u
    );

    const bootstrapLog = await readFile(paths.bootstrapLogPath, "utf8");
    assert.match(bootstrapLog, /state store open prevented service startup/u);
    assert.match(bootstrapLog, /integrity_failure/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive command archives the active session, switches active session, and mirrors to app-server", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];
  const archivedThreadIds: string[] = [];

  try {
    authorizeChat(store, "chat-1");
    const archivedSession = createSession(store, "chat-1");
    store.renameSession(archivedSession.sessionId, "Session Alpha");
    store.updateSessionThreadId(archivedSession.sessionId, "thread-archive");

    const fallbackSession = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });
    store.renameSession(fallbackSession.sessionId, "Session Beta");
    store.setActiveSession("chat-1", archivedSession.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(sent.length, text);
      }
    };
    (service as any).appServer = {
      isRunning: true,
      archiveThread: async (threadId: string) => {
        archivedThreadIds.push(threadId);
      }
    };

    await (service as any).routeCommand("chat-1", "archive", "");

    assert.deepEqual(archivedThreadIds, ["thread-archive"]);
    assert.equal(store.getActiveSession("chat-1")?.sessionId, fallbackSession.sessionId);
    assert.equal(store.listSessions("chat-1").length, 1);
    assert.equal(store.listSessions("chat-1", { archived: true, limit: 10 })[0]?.sessionId, archivedSession.sessionId);
    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.equal(
      sent.at(-1)?.text,
      [
        "<b>已归档当前会话：</b> Project One",
        "<b>当前会话：</b> Session Beta",
        "<b>当前项目：</b> Project Two"
      ].join("\n")
    );
  } finally {
    await cleanup();
  }
});

test("sessions archived and unarchive command expose and restore archived sessions", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];
  const unarchivedThreadIds: string[] = [];

  try {
    authorizeChat(store, "chat-1");
    const session = createSession(store, "chat-1");
    store.renameSession(session.sessionId, "Session Alpha");
    store.updateSessionThreadId(session.sessionId, "thread-unarchive");
    store.archiveSession(session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(sent.length, text);
      }
    };
    (service as any).appServer = {
      isRunning: true,
      unarchiveThread: async (threadId: string) => {
        unarchivedThreadIds.push(threadId);
      }
    };

    await (service as any).routeCommand("chat-1", "sessions", "archived");
    assert.match(sent.at(-1)?.text ?? "", /^已归档会话/u);
    assert.match(sent.at(-1)?.text ?? "", /Session Alpha/u);
    assert.equal(sent.at(-1)?.parseMode, undefined);

    await (service as any).routeCommand("chat-1", "unarchive", "1");

    assert.deepEqual(unarchivedThreadIds, ["thread-unarchive"]);
    assert.equal(store.getActiveSession("chat-1")?.sessionId, session.sessionId);
    assert.equal(store.listSessions("chat-1")[0]?.sessionId, session.sessionId);
    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.equal(sent.at(-1)?.text, "<b>已恢复会话：</b> Project One");
  } finally {
    await cleanup();
  }
});

test("archive command compensates remote state when local archive persistence fails", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];
  const archivedThreadIds: string[] = [];
  const unarchivedThreadIds: string[] = [];

  try {
    authorizeChat(store, "chat-1");
    const session = createSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-compensate");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
        return createFakeTelegramMessage(sent.length, text);
      }
    };
    (service as any).appServer = {
      isRunning: true,
      archiveThread: async (threadId: string) => {
        archivedThreadIds.push(threadId);
      },
      unarchiveThread: async (threadId: string) => {
        unarchivedThreadIds.push(threadId);
      }
    };

    const originalArchiveSession = store.archiveSession.bind(store);
    (store as any).archiveSession = () => {
      throw new Error("db write failed");
    };

    await (service as any).routeCommand("chat-1", "archive", "");

    assert.deepEqual(archivedThreadIds, ["thread-compensate"]);
    assert.deepEqual(unarchivedThreadIds, ["thread-compensate"]);
    assert.equal(sent.at(-1), "当前无法归档这个会话，请稍后重试。");

    (store as any).archiveSession = originalArchiveSession;
  } finally {
    await cleanup();
  }
});

test("unarchive command compensates remote state when local unarchive persistence fails", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];
  const archivedThreadIds: string[] = [];
  const unarchivedThreadIds: string[] = [];

  try {
    authorizeChat(store, "chat-1");
    const session = createSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-unarchive-compensate");
    store.archiveSession(session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
        return createFakeTelegramMessage(sent.length, text);
      }
    };
    (service as any).appServer = {
      isRunning: true,
      archiveThread: async (threadId: string) => {
        archivedThreadIds.push(threadId);
      },
      unarchiveThread: async (threadId: string) => {
        unarchivedThreadIds.push(threadId);
      }
    };

    const originalUnarchiveSession = store.unarchiveSession.bind(store);
    (store as any).unarchiveSession = () => {
      throw new Error("db write failed");
    };

    await (service as any).routeCommand("chat-1", "unarchive", "1");

    assert.deepEqual(unarchivedThreadIds, ["thread-unarchive-compensate"]);
    assert.deepEqual(archivedThreadIds, ["thread-unarchive-compensate"]);
    assert.equal(sent.at(-1), "当前无法恢复这个会话，请稍后重试。");

    (store as any).unarchiveSession = originalUnarchiveSession;
  } finally {
    await cleanup();
  }
});

test("thread archived notification confirms a pending archive operation", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];
  const { logger, info } = createCapturingLogger();

  try {
    authorizeChat(store, "chat-1");
    const session = createSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-confirm-archive");
    (service as any).logger = logger;

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
        return createFakeTelegramMessage(sent.length, text);
      }
    };
    (service as any).appServer = {
      isRunning: true,
      archiveThread: async () => {}
    };

    await (service as any).routeCommand("chat-1", "archive", "");
    assert.equal((service as any).pendingThreadArchiveOps.size, 1);

    await (service as any).handleAppServerNotification("thread/archived", {
      threadId: "thread-confirm-archive"
    });

    assert.equal((service as any).pendingThreadArchiveOps.size, 0);
    assert.ok(info.some((entry) => entry.message === "thread archive op confirmed"));
  } finally {
    await cleanup();
  }
});

test("thread archive notifications are written to the active turn debug journal before archive reconciliation returns", async () => {
  const { service, store, cleanup } = await createServiceContext();

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => createFakeTelegramMessage(800 + text.length, text),
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) =>
        createFakeTelegramMessage(messageId, text)
    };

    installRunningAppServer(service, "thread-debug", "turn-debug");

    await (service as any).startRealTurn("chat-1", session, "Track archive notifications");
    const debugFilePath = (service as any).activeTurn.debugJournal.filePath;

    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-debug",
      turnId: "turn-debug"
    });
    await (service as any).handleAppServerNotification("thread/archived", {
      threadId: "thread-other"
    });
    await (service as any).handleAppServerNotification("thread/unarchived", {
      threadId: "thread-other"
    });

    const debugJournal = await readFile(debugFilePath, "utf8");

    assert.match(debugJournal, /"method":"thread\/archived"/u);
    assert.match(debugJournal, /"method":"thread\/unarchived"/u);
  } finally {
    await cleanup();
  }
});

test("conflicting thread archive notification clears the pending op and keeps local state unchanged", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];
  const { logger, warn } = createCapturingLogger();

  try {
    authorizeChat(store, "chat-1");
    const session = createSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-conflict");
    (service as any).logger = logger;

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
        return createFakeTelegramMessage(sent.length, text);
      }
    };
    (service as any).appServer = {
      isRunning: true,
      archiveThread: async () => {}
    };

    await (service as any).routeCommand("chat-1", "archive", "");
    assert.equal(store.getSessionByThreadId("thread-conflict")?.archived, true);

    await (service as any).handleAppServerNotification("thread/unarchived", {
      threadId: "thread-conflict"
    });

    assert.equal((service as any).pendingThreadArchiveOps.size, 0);
    assert.equal(store.getSessionByThreadId("thread-conflict")?.archived, true);
    assert.ok(warn.some((entry) => entry.message === "thread archive op conflicted"));
  } finally {
    await cleanup();
  }
});

test("unsolicited thread archive notification logs drift and does not mutate local session state", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const { logger, warn } = createCapturingLogger();

  try {
    authorizeChat(store, "chat-1");
    const session = createSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-unsolicited");
    (service as any).logger = logger;

    await (service as any).handleAppServerNotification("thread/archived", {
      threadId: "thread-unsolicited"
    });

    assert.equal(store.getSessionByThreadId("thread-unsolicited")?.archived, false);
    assert.ok(warn.some((entry) => entry.message === "thread archive drift observed"));
  } finally {
    await cleanup();
  }
});

test("rapid archive then unarchive on the same thread keeps both pending archive ops ordered until matching notifications arrive", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];
  const { logger, info, warn } = createCapturingLogger();

  try {
    authorizeChat(store, "chat-1");
    const session = createSession(store, "chat-1");
    store.renameSession(session.sessionId, "Session Alpha");
    store.updateSessionThreadId(session.sessionId, "thread-rapid-toggle");
    (service as any).logger = logger;

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
        return createFakeTelegramMessage(sent.length, text);
      }
    };
    (service as any).appServer = {
      isRunning: true,
      archiveThread: async () => {},
      unarchiveThread: async () => {}
    };

    await (service as any).routeCommand("chat-1", "archive", "");
    await (service as any).routeCommand("chat-1", "unarchive", "1");

    await (service as any).handleAppServerNotification("thread/archived", {
      threadId: "thread-rapid-toggle"
    });
    await (service as any).handleAppServerNotification("thread/unarchived", {
      threadId: "thread-rapid-toggle"
    });

    assert.equal(store.getSessionByThreadId("thread-rapid-toggle")?.archived, false);
    assert.equal(warn.some((entry) => entry.message === "thread archive op conflicted"), false);
    assert.equal(warn.some((entry) => entry.message === "thread archive drift observed"), false);
    assert.equal(info.filter((entry) => entry.message === "thread archive op confirmed").length, 2);
  } finally {
    await cleanup();
  }
});

test("runtime cards keep command activity on the status message and final answer separate", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: string;
    replyMarkup?: any;
  }> = [];
  const edited: Array<{
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: string;
    replyMarkup?: any;
  }> = [];
  let nextMessageId = 100;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string, options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ chatId, messageId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (chatId: string, messageId: number, text: string, options?: any) => {
        edited.push({ chatId, messageId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-1", "turn-1");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-1",
        turnId: "turn-1"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/plan/updated", {
        threadId: "thread-1",
        turnId: "turn-1",
        plan: [
          { step: "Collect protocol evidence", status: "completed" },
          { step: "Wire inspect renderer", status: "inProgress" }
        ]
      });
    });
    await withMockedNow("2026-03-10T10:00:09.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "item-1", type: "commandExecution", title: "pnpm test" }
      });
    });
    await withMockedNow("2026-03-10T10:00:12.000Z", async () => {
      await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "$ pnpm test\n26/26 tests passed"
      });
    });
    await withMockedNow("2026-03-10T10:00:15.000Z", async () => {
      await (service as any).handleAppServerNotification("codex/event/task_complete", {
        threadId: "thread-1",
        turnId: "turn-1",
        msg: { last_agent_message: "All done." }
      });
      await (service as any).handleAppServerNotification("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" }
      });
    });

    assert.equal(
      sent.filter((entry) => entry.text.startsWith("<b>Runtime Status</b>"))
        .every((entry) => entry.parseMode === "HTML"),
      true
    );
    assert.equal(sent.some((entry) => entry.text === "All done." && entry.parseMode === "HTML"), true);
    assert.equal(sent.filter((entry) => entry.text.startsWith("<b>Runtime Status</b>")).length, 1);
    assert.equal(sent.filter((entry) => entry.text.startsWith("Plan")).length, 0);
    assert.equal(sent.filter((entry) => entry.text.startsWith("Command")).length, 0);

    const statusTexts = getMessageTexts(sent, edited, 100);
    assert.ok(statusTexts.some((text) => /<b>State:<\/b> Starting/u.test(text)));
    assert.ok(statusTexts.some((text) => /<b>State:<\/b> Running/u.test(text)));
    assert.ok(statusTexts.some((text) => /<b>State:<\/b> Completed/u.test(text)));
    assert.ok(statusTexts.some((text) => /<b>Progress:<\/b>\npnpm test -&gt; 26\/26 tests passed/u.test(text)));
    assert.equal(statusTexts.some((text) => /Command: /u.test(text)), false);
    assert.equal(statusTexts.some((text) => /Output: /u.test(text)), false);
    assert.equal(statusTexts.some((text) => /Collect protocol evidence/u.test(text)), false);
    assert.ok(
      [...sent, ...edited].some((entry) =>
        entry.messageId === 100 &&
        entry.replyMarkup?.inline_keyboard?.[0]?.[0]?.text === "当前计划：Wire inspect renderer"
      )
    );

    assert.equal((service as any).activeTurn, null);
  } finally {
    await cleanup();
  }
});

test("status card removes command toggles and treats old command callbacks as expired", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string; replyMarkup?: any }> = [];
  const edited: Array<{ messageId: number; text: string; replyMarkup?: any }> = [];
  const callbackAnswers: Array<string | undefined> = [];
  let nextMessageId = 900;

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "1",
      telegramChatId: "1",
      telegramUsername: "tester",
      displayName: "Tester"
    });
    const candidate = store.listPendingAuthorizations()[0];
    if (!candidate) {
      throw new Error("expected pending authorization candidate");
    }
    store.confirmPendingAuthorization(candidate);
    const session = createSession(store, "1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, options?: any) => {
        edited.push({ messageId, text, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      answerCallbackQuery: async (_callbackQueryId: string, text?: string) => {
        callbackAnswers.push(text);
      }
    };

    installRunningAppServer(service, "thread-expand", "turn-expand");

    await (service as any).startRealTurn("1", session, "Run both commands");
    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-expand",
      turnId: "turn-expand"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-expand",
      turnId: "turn-expand",
      item: { id: "cmd-1", type: "commandExecution", title: "pnpm install" }
    });
    await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
      threadId: "thread-expand",
      turnId: "turn-expand",
      itemId: "cmd-1",
      delta: "$ pnpm install\nDependencies installed"
    });
    await (service as any).handleAppServerNotification("item/completed", {
      threadId: "thread-expand",
      turnId: "turn-expand",
      item: { id: "cmd-1", type: "commandExecution" }
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-expand",
      turnId: "turn-expand",
      item: { id: "cmd-2", type: "commandExecution", title: "pnpm test" }
    });
    await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
      threadId: "thread-expand",
      turnId: "turn-expand",
      itemId: "cmd-2",
      delta: "$ pnpm test\n26/26 tests passed"
    });
    await (service as any).handleAppServerNotification("item/completed", {
      threadId: "thread-expand",
      turnId: "turn-expand",
      item: { id: "cmd-2", type: "commandExecution" }
    });
    await (service as any).handleAppServerNotification("turn/completed", {
      threadId: "thread-expand",
      turn: { id: "turn-expand", status: "completed" }
    });

    const collapsed = edited.at(-1);
    assert.doesNotMatch(collapsed?.text ?? "", /Latest command/u);
    assert.doesNotMatch(collapsed?.text ?? "", /Command: \$ pnpm test/u);
    assert.doesNotMatch(collapsed?.text ?? "", /Earlier commands/u);
    assert.equal(collapsed?.replyMarkup, undefined);

    const editCountBeforeCallbacks = edited.length;

    await (service as any).handleCallback({
      id: "callback-expand",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 900,
        chat: { id: 1, type: "private" },
        date: 0,
        text: "Runtime Status"
      },
      data: `v1:cmd:expand:${session.sessionId}`
    });

    assert.equal(callbackAnswers.at(-1), "这个按钮已过期，请重新操作。");
    assert.equal(edited.length, editCountBeforeCallbacks);

    await (service as any).handleCallback({
      id: "callback-collapse",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 900,
        chat: { id: 1, type: "private" },
        date: 0,
        text: "Runtime Status"
      },
      data: `v1:cmd:collapse:${session.sessionId}`
    });

    assert.equal(callbackAnswers.at(-1), "这个按钮已过期，请重新操作。");
    assert.equal(edited.length, editCountBeforeCallbacks);
  } finally {
    await cleanup();
  }
});

test("completed turns fall back to thread history when task_complete is missing", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; messageId: number; text: string; parseMode?: string }> = [];
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 150;
  let resumeCalls = 0;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string, options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ chatId, messageId, text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ chatId, messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-fallback", "turn-fallback", async (threadId: string) => {
      resumeCalls += 1;
      assert.equal(threadId, "thread-fallback");
      return {
        thread: {
          id: "thread-fallback",
          turns: [
            {
              id: "turn-fallback",
              items: [
                {
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Recovered from thread history."
                }
              ]
            }
          ]
        }
      };
    });

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-fallback",
        turnId: "turn-fallback"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/completed", {
        threadId: "thread-fallback",
        turn: { id: "turn-fallback", status: "completed" }
      });
    });

    assert.equal(resumeCalls, 1);
    assert.equal(
      sent.filter((entry) => entry.text.startsWith("<b>Runtime Status</b>"))
        .every((entry) => entry.parseMode === "HTML"),
      true
    );
    assert.equal(sent.filter((entry) => entry.text.startsWith("<b>Runtime Status</b>")).length, 1);
    assert.ok(sent.some((entry) => entry.text === "Recovered from thread history." && entry.parseMode === "HTML"));
    assert.ok(edited.some((entry) => /<b>State:<\/b> Completed/u.test(entry.text)));
    assert.equal(store.getSessionById(session.sessionId)?.status, "idle");
    assert.equal((service as any).activeTurn, null);
  } finally {
    await cleanup();
  }
});

test("completed turns send the final answer with Telegram HTML formatting", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; messageId: number; text: string; parseMode?: string }> = [];
  let nextMessageId = 300;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string, options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ chatId, messageId, text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) =>
        createFakeTelegramMessage(messageId, text)
    };

    installRunningAppServer(service, "thread-final-html", "turn-final-html");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Format the final answer");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-final-html",
        turnId: "turn-final-html"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("codex/event/task_complete", {
        threadId: "thread-final-html",
        turnId: "turn-final-html",
        msg: {
          last_agent_message: [
            "# Summary",
            "",
            "- **Status**: `ok`",
            "- Link: [Docs](https://example.com/docs)",
            "",
            "```ts",
            "console.log(\"hi\")",
            "```"
          ].join("\n")
        }
      });
      await (service as any).handleAppServerNotification("turn/completed", {
        threadId: "thread-final-html",
        turn: { id: "turn-final-html", status: "completed" }
      });
    });

    const finalAnswer = sent.find((entry) => entry.parseMode === "HTML" && entry.text.includes("<b>Summary</b>"));
    assert.ok(finalAnswer);
    assert.equal(finalAnswer?.text.includes("<b>Summary</b>"), true);
    assert.equal(finalAnswer?.text.includes("• <b>Status</b>: <code>ok</code>"), true);
    assert.equal(
      finalAnswer?.text.includes("<a href=\"https://example.com/docs\">Docs</a>"),
      true
    );
    assert.equal(
      finalAnswer?.text.includes("<pre><code class=\"language-ts\">console.log(\"hi\")</code></pre>"),
      true
    );
  } finally {
    await cleanup();
  }
});

test("long final answers send one collapsible preview and persist the rendered pages", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: string;
    replyMarkup?: any;
  }> = [];
  const edited: Array<{
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: string;
    replyMarkup?: any;
  }> = [];
  const callbackAnswers: Array<string | undefined> = [];
  let nextMessageId = 950;

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "1",
      telegramChatId: "1",
      telegramUsername: "tester",
      displayName: "Tester"
    });
    const candidate = store.listPendingAuthorizations()[0];
    if (!candidate) {
      throw new Error("expected pending authorization candidate");
    }
    store.confirmPendingAuthorization(candidate);
    const session = createSession(store, "1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string, options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ chatId, messageId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (chatId: string, messageId: number, text: string, options?: any) => {
        edited.push({ chatId, messageId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      answerCallbackQuery: async (_callbackQueryId: string, text?: string) => {
        callbackAnswers.push(text);
      }
    };

    installRunningAppServer(service, "thread-final-collapsible", "turn-final-collapsible");

    const longFinalAnswer = Array.from({ length: 18 }, (_, index) =>
      `Paragraph ${index + 1}: ${"alpha beta gamma delta ".repeat(35).trim()}`
    ).join("\n\n");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("1", session, "Summarize the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-final-collapsible",
        turnId: "turn-final-collapsible"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("codex/event/task_complete", {
        threadId: "thread-final-collapsible",
        turnId: "turn-final-collapsible",
        msg: { last_agent_message: longFinalAnswer }
      });
      await (service as any).handleAppServerNotification("turn/completed", {
        threadId: "thread-final-collapsible",
        turn: { id: "turn-final-collapsible", status: "completed" }
      });
    });

    const finalMessages = sent.filter((entry) => entry.parseMode === "HTML" && !entry.text.startsWith("<b>Runtime Status</b>"));
    assert.equal(finalMessages.length, 1);
    assert.match(finalMessages[0]?.text ?? "", /已折叠/u);
    assert.equal(finalMessages[0]?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "展开全文");

    const views = store.listFinalAnswerViews("1");
    assert.equal(views.length, 1);
    assert.ok(views[0]?.telegramMessageId);
    assert.ok((views[0]?.pages.length ?? 0) > 1);

    await (service as any).handleCallback({
      id: "callback-final-open",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: finalMessages[0]!.messageId,
        chat: { id: 1, type: "private" },
        date: 0,
        text: finalMessages[0]!.text
      },
      data: `v1:final:open:${views[0]!.answerId}`
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.equal(edited.at(-1)?.messageId, finalMessages[0]?.messageId);
    assert.match(edited.at(-1)?.text ?? "", /第 1\/\d+ 页/u);
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "下一页");
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[1]?.text, "收起");

    await (service as any).handleCallback({
      id: "callback-final-next",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: finalMessages[0]!.messageId,
        chat: { id: 1, type: "private" },
        date: 0,
        text: edited.at(-1)?.text
      },
      data: `v1:final:page:${views[0]!.answerId}:2`
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.match(edited.at(-1)?.text ?? "", /第 2\/\d+ 页/u);
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "上一页");

    await (service as any).handleCallback({
      id: "callback-final-close",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: finalMessages[0]!.messageId,
        chat: { id: 1, type: "private" },
        date: 0,
        text: edited.at(-1)?.text
      },
      data: `v1:final:close:${views[0]!.answerId}`
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.match(edited.at(-1)?.text ?? "", /已折叠/u);
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "展开全文");
  } finally {
    await cleanup();
  }
});

test("persisted final answer callbacks work without an active turn", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const edited: Array<{ messageId: number; text: string; parseMode?: string; replyMarkup?: any }> = [];
  const callbackAnswers: Array<string | undefined> = [];

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "1",
      telegramChatId: "1",
      telegramUsername: "tester",
      displayName: "Tester"
    });
    const candidate = store.listPendingAuthorizations()[0];
    if (!candidate) {
      throw new Error("expected pending authorization candidate");
    }
    store.confirmPendingAuthorization(candidate);
    const session = createSession(store, "1");
    store.updateSessionThreadId(session.sessionId, "thread-persisted-final-answer");
    const view = store.saveFinalAnswerView({
      answerId: "answer-persisted-final-answer",
      telegramChatId: "1",
      telegramMessageId: 1234,
      sessionId: session.sessionId,
      threadId: "thread-persisted-final-answer",
      turnId: "turn-persisted-final-answer",
      previewHtml: "<b>Preview</b>\n\n<i>已折叠，点击“展开全文”查看剩余内容。</i>",
      pages: [
        "Expanded page one",
        "<i>第 2/2 页</i>\n\nExpanded page two"
      ]
    });

    (service as any).api = {
      editMessageText: async (_chatId: string, messageId: number, text: string, options?: any) => {
        edited.push({ messageId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      answerCallbackQuery: async (_callbackQueryId: string, text?: string) => {
        callbackAnswers.push(text);
      }
    };

    await (service as any).handleCallback({
      id: "callback-persisted-final-open",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 1234,
        chat: { id: 1, type: "private" },
        date: 0,
        text: view.previewHtml
      },
      data: `v1:final:open:${view.answerId}`
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.equal(edited.at(-1)?.messageId, 1234);
    assert.equal(edited.at(-1)?.text, "Expanded page one");
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "下一页");
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[1]?.text, "收起");

    await (service as any).handleCallback({
      id: "callback-persisted-final-page",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 1234,
        chat: { id: 1, type: "private" },
        date: 0,
        text: edited.at(-1)?.text
      },
      data: `v1:final:page:${view.answerId}:2`
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.equal(edited.at(-1)?.text, "<i>第 2/2 页</i>\n\nExpanded page two");
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "上一页");
  } finally {
    await cleanup();
  }
});

test("runtime card edit failures retry the same message instead of sending a replacement", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; messageId: number; text: string }> = [];
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 200;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    let firstEdit = true;
    (service as any).api = {
      sendMessage: async (chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ chatId, messageId, text });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ chatId, messageId, text });
        if (firstEdit) {
          firstEdit = false;
          throw new Error("message can not be edited");
        }

        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-2", "turn-2");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-2",
        turnId: "turn-2"
      });
    });

    const activeTurn = (service as any).activeTurn;
    assert.equal(sent.length, 1);
    assert.equal(edited.length, 1);
    assert.equal(activeTurn.statusCard.messageId, 200);
    assert.match(activeTurn.statusCard.pendingText ?? "", /<b>State:<\/b> Running/u);

    await withMockedNow("2026-03-10T10:00:09.000Z", async () => {
      await (service as any).flushRuntimeCardRender(activeTurn, activeTurn.statusCard);
    });

    assert.equal(sent.length, 1);
    assert.equal(edited.length, 2);
    assert.match(activeTurn.statusCard.lastRenderedText, /<b>State:<\/b> Running/u);
    (service as any).clearRuntimeCardTimer(activeTurn.statusCard);
  } finally {
    await cleanup();
  }
});

test("startRealTurn sends an initial runtime status card immediately", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; messageId: number; text: string; parseMode?: string; replyMarkup?: any }> = [];
  let nextMessageId = 800;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ chatId, messageId, text, parseMode: _options?.parseMode, replyMarkup: _options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-8", "turn-8");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });

    assert.equal(sent.length, 1);
    assert.match(sent[0]?.text ?? "", /^<b>Runtime Status<\/b>/u);
    assert.match(sent[0]?.text ?? "", /<b>State:<\/b> Starting/u);
    assert.match(sent[0]?.text ?? "", /Use \/inspect for full details/u);
    assert.equal(sent[0]?.parseMode, "HTML");
    assert.equal(sent[0]?.replyMarkup, undefined);
    assert.equal((service as any).activeTurn.statusCard.messageId, 800);
  } finally {
    await cleanup();
  }
});

test("status card refreshes when tool progress changes without commentary", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string }> = [];
  const edited: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 610;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-progress", "turn-progress");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-progress",
        turnId: "turn-progress"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-progress",
        turnId: "turn-progress",
        item: { id: "mcp-1", type: "mcpToolCall" }
      });
    });
    await withMockedNow("2026-03-10T10:00:09.000Z", async () => {
      await (service as any).handleAppServerNotification("item/mcpToolCall/progress", {
        threadId: "thread-progress",
        turnId: "turn-progress",
        itemId: "mcp-1",
        message: "Searching docs"
      });
    });

    assert.match(edited.at(-1)?.text ?? "", /<b>Progress:<\/b>\nSearching docs/u);
  } finally {
    await cleanup();
  }
});

test("status card accumulates fragmented command output before rendering command summaries", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string }> = [];
  const edited: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 620;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-command-fragments", "turn-command-fragments");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-command-fragments",
        turnId: "turn-command-fragments"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-command-fragments",
        turnId: "turn-command-fragments",
        item: { id: "cmd-1", type: "commandExecution", title: "pnpm test" }
      });
    });
    await withMockedNow("2026-03-10T10:00:09.000Z", async () => {
      await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
        threadId: "thread-command-fragments",
        turnId: "turn-command-fragments",
        itemId: "cmd-1",
        delta: "$ pnpm test\n"
      });
    });
    await withMockedNow("2026-03-10T10:00:12.000Z", async () => {
      await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
        threadId: "thread-command-fragments",
        turnId: "turn-command-fragments",
        itemId: "cmd-1",
        delta: "26/26 tests passed"
      });
    });

    const statusTexts = getMessageTexts(sent, edited, 620);
    assert.match(statusTexts.at(-1) ?? "", /<b>Progress:<\/b>\npnpm test -&gt; 26\/26 tests passed/u);
    assert.doesNotMatch(statusTexts.at(-1) ?? "", /Command: \$ pnpm test/u);
    assert.doesNotMatch(statusTexts.at(-1) ?? "", /Output: 26\/26 tests passed/u);
  } finally {
    await cleanup();
  }
});

test("status card updates only when completed commentary arrives", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string }> = [];
  const edited: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 600;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-6", "turn-6");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-6",
        turnId: "turn-6"
      });
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-6",
        turnId: "turn-6",
        item: { id: "item-1", type: "agentMessage" }
      });
    });

    assert.equal(sent.length, 1);
    assert.equal(edited.length, 1);

    await withMockedNow("2026-03-10T10:00:09.000Z", async () => {
      await (service as any).handleAppServerNotification("item/agentMessage/delta", {
        threadId: "thread-6",
        turnId: "turn-6",
        itemId: "item-1",
        delta: "先看项目骨架，再抓入口、配置和主要模块。"
      });
    });

    assert.equal(sent.length, 1);
    assert.equal(edited.length, 1);

    await withMockedNow("2026-03-10T10:00:12.000Z", async () => {
      await (service as any).handleAppServerNotification("item/reasoning/summaryTextDelta", {
        threadId: "thread-6",
        turnId: "turn-6",
        itemId: "reason-1",
        delta: "private reasoning"
      });
    });

    assert.equal(edited.length, 1);

    await withMockedNow("2026-03-10T10:00:15.000Z", async () => {
      await (service as any).handleAppServerNotification("item/completed", {
        threadId: "thread-6",
        turnId: "turn-6",
        item: {
          id: "item-1",
          type: "agentMessage",
          phase: "commentary",
          text: "先看项目骨架，再抓入口、配置和主要模块。"
        }
      });
    });

    assert.equal(edited.length, 2);
    assert.match(edited.at(-1)?.text ?? "", /<b>Progress:<\/b>\n先看项目骨架，再抓入口、配置和主要模块。/u);
    const inspect = (service as any).activeTurn.tracker.getInspectSnapshot();
    assert.equal(inspect.completedCommentary.at(-1), "先看项目骨架，再抓入口、配置和主要模块。");
  } finally {
    await cleanup();
  }
});

test("status card keeps commentary progress visible when structured thread status becomes blocked", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string }> = [];
  const edited: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 605;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-6b", "turn-6b");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-6b",
        turnId: "turn-6b"
      });
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-6b",
        turnId: "turn-6b",
        item: { id: "commentary-1", type: "agentMessage" }
      });
    });

    await withMockedNow("2026-03-10T10:00:15.000Z", async () => {
      await (service as any).handleAppServerNotification("item/completed", {
        threadId: "thread-6b",
        turnId: "turn-6b",
        item: {
          id: "commentary-1",
          type: "agentMessage",
          phase: "commentary",
          text: "先确认 Codex 当前运行阶段，再决定下一步。"
        }
      });
    });

    await withMockedNow("2026-03-10T10:00:18.000Z", async () => {
      await (service as any).handleAppServerNotification("thread/status/changed", {
        threadId: "thread-6b",
        turnId: "turn-6b",
        status: {
          type: "active",
          activeFlags: ["waitingOnApproval"]
        }
      });
    });

    const latest = edited.at(-1)?.text ?? "";
    assert.match(latest, /<b>State:<\/b> Blocked/u);
    assert.match(latest, /<b>Blocked on:<\/b> approval/u);
    assert.match(latest, /<b>Progress:<\/b>\n先确认 Codex 当前运行阶段，再决定下一步。/u);
  } finally {
    await cleanup();
  }
});

test("status card expands the current plan inline and keeps only the latest plan snapshot", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string; parseMode?: string; replyMarkup?: any }> = [];
  const edited: Array<{ messageId: number; text: string; parseMode?: string; replyMarkup?: any }> = [];
  const callbackAnswers: Array<string | undefined> = [];
  let nextMessageId = 630;

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "1",
      telegramChatId: "chat-1",
      telegramUsername: "tester",
      displayName: "Tester"
    });
    const candidate = store.listPendingAuthorizations()[0];
    if (!candidate) {
      throw new Error("expected pending authorization candidate");
    }
    store.confirmPendingAuthorization(candidate);
    const session = createSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text, parseMode: _options?.parseMode, replyMarkup: _options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ messageId, text, parseMode: _options?.parseMode, replyMarkup: _options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      answerCallbackQuery: async (_callbackQueryId: string, text?: string) => {
        callbackAnswers.push(text);
      }
    };

    installRunningAppServer(service, "thread-plan", "turn-plan");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-plan",
        turnId: "turn-plan"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/plan/updated", {
        threadId: "thread-plan",
        turnId: "turn-plan",
        plan: [
          { step: "Collect protocol evidence", status: "pending" },
          { step: "Wire inspect renderer", status: "pending" }
        ]
      });
    });

    const collapsed = edited.at(-1) ?? sent.at(-1);
    assert.equal(collapsed?.parseMode, "HTML");
    assert.equal(collapsed?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "当前计划：Collect protocol evidence");
    assert.doesNotMatch(collapsed?.text ?? "", /<b>Current Plan:<\/b>/u);

    await withMockedNow("2026-03-10T10:00:07.000Z", async () => {
      await (service as any).handleCallback({
        id: "callback-plan-expand",
        from: { id: 1, is_bot: false, first_name: "Tester" },
        message: {
          message_id: 630,
          chat: { id: 1, type: "private" },
          date: 0,
          text: "<b>Runtime Status</b>"
        },
        data: `v1:plan:expand:${session.sessionId}`
      });
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.match(edited.at(-1)?.text ?? "", /<b>Current Plan:<\/b>/u);
    assert.match(edited.at(-1)?.text ?? "", /1\. Collect protocol evidence \(pending\)/u);
    assert.match(edited.at(-1)?.text ?? "", /2\. Wire inspect renderer \(pending\)/u);
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "收起当前计划");

    await withMockedNow("2026-03-10T10:00:09.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/plan/updated", {
        threadId: "thread-plan",
        turnId: "turn-plan",
        plan: [
          { step: "Collect protocol evidence", status: "completed" },
          { step: "Wire inspect renderer", status: "inProgress" }
        ]
      });
    });

    assert.match(edited.at(-1)?.text ?? "", /1\. Collect protocol evidence \(completed\)/u);
    assert.match(edited.at(-1)?.text ?? "", /2\. Wire inspect renderer \(inProgress\)/u);
    assert.doesNotMatch(edited.at(-1)?.text ?? "", /Collect protocol evidence \(pending\)/u);

    await withMockedNow("2026-03-10T10:00:12.000Z", async () => {
      await (service as any).handleCallback({
        id: "callback-plan-collapse",
        from: { id: 1, is_bot: false, first_name: "Tester" },
        message: {
          message_id: 630,
          chat: { id: 1, type: "private" },
          date: 0,
          text: "<b>Runtime Status</b>"
        },
        data: `v1:plan:collapse:${session.sessionId}`
      });
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.doesNotMatch(edited.at(-1)?.text ?? "", /<b>Current Plan:<\/b>/u);
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "当前计划：Wire inspect renderer");
  } finally {
    await cleanup();
  }
});

test("status card shows running subagents behind an agent button and expands their progress inline", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string; parseMode?: string; replyMarkup?: any }> = [];
  const edited: Array<{ messageId: number; text: string; parseMode?: string; replyMarkup?: any }> = [];
  const callbackAnswers: Array<string | undefined> = [];
  let nextMessageId = 730;

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "1",
      telegramChatId: "chat-1",
      telegramUsername: "tester",
      displayName: "Tester"
    });
    const candidate = store.listPendingAuthorizations()[0];
    if (!candidate) {
      throw new Error("expected pending authorization candidate");
    }
    store.confirmPendingAuthorization(candidate);
    const session = createSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text, parseMode: _options?.parseMode, replyMarkup: _options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ messageId, text, parseMode: _options?.parseMode, replyMarkup: _options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      answerCallbackQuery: async (_callbackQueryId: string, text?: string) => {
        callbackAnswers.push(text);
      }
    };

    installRunningAppServer(service, "thread-agent-main", "turn-agent-main");

    await withMockedNow("2026-03-10T11:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T11:00:01.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-agent-main",
        turnId: "turn-agent-main"
      });
    });
    await withMockedNow("2026-03-10T11:00:02.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-agent-main",
        turnId: "turn-agent-main",
        item: {
          id: "collab-1",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          receiverThreadIds: ["thread-agent-sub-1"],
          agentsStates: {
            "thread-agent-sub-1": {
              status: "pendingInit",
              message: "Booting"
            }
          }
        }
      });
    });

    const collapsed = edited.at(-1) ?? sent.at(-1);
    assert.equal(collapsed?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "Agent：1 个运行中");

    await withMockedNow("2026-03-10T11:00:03.000Z", async () => {
      await (service as any).handleCallback({
        id: "callback-agent-expand",
        from: { id: 1, is_bot: false, first_name: "Tester" },
        message: {
          message_id: 730,
          chat: { id: 1, type: "private" },
          date: 0,
          text: "<b>Runtime Status</b>"
        },
        data: `v1:agent:expand:${session.sessionId}`
      });
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.match(edited.at(-1)?.text ?? "", /<b>Agents:<\/b>/u);
    assert.match(edited.at(-1)?.text ?? "", /Booting/u);
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "收起 Agent");

    await withMockedNow("2026-03-10T11:00:04.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-agent-sub-1",
        turnId: "turn-agent-sub-1"
      });
    });
    await withMockedNow("2026-03-10T11:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-agent-sub-1",
        turnId: "turn-agent-sub-1",
        item: {
          id: "cmd-agent-sub-1",
          type: "commandExecution",
          title: "rg plan"
        }
      });
    });
    await withMockedNow("2026-03-10T11:00:08.500Z", async () => {
      await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
        threadId: "thread-agent-sub-1",
        turnId: "turn-agent-sub-1",
        itemId: "cmd-agent-sub-1",
        delta: "$ rg plan\n2 matches"
      });
    });

    assert.match(edited.at(-1)?.text ?? "", /rg plan -&gt; 2 matches/u);

    await withMockedNow("2026-03-10T11:00:12.000Z", async () => {
      await (service as any).handleCallback({
        id: "callback-agent-collapse",
        from: { id: 1, is_bot: false, first_name: "Tester" },
        message: {
          message_id: 730,
          chat: { id: 1, type: "private" },
          date: 0,
          text: "<b>Runtime Status</b>"
        },
        data: `v1:agent:collapse:${session.sessionId}`
      });
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.doesNotMatch(edited.at(-1)?.text ?? "", /<b>Agents:<\/b>/u);
    assert.equal(edited.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "Agent：1 个运行中");
  } finally {
    await cleanup();
  }
});

test("status card clears stale subagent blocker text after the subagent resumes", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string; parseMode?: string; replyMarkup?: any }> = [];
  const edited: Array<{ messageId: number; text: string; parseMode?: string; replyMarkup?: any }> = [];
  const callbackAnswers: Array<string | undefined> = [];
  let nextMessageId = 740;

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "1",
      telegramChatId: "chat-1",
      telegramUsername: "tester",
      displayName: "Tester"
    });
    const candidate = store.listPendingAuthorizations()[0];
    if (!candidate) {
      throw new Error("expected pending authorization candidate");
    }
    store.confirmPendingAuthorization(candidate);
    const session = createSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, options?: any) => {
        edited.push({ messageId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(messageId, text);
      },
      answerCallbackQuery: async (_callbackQueryId: string, text?: string) => {
        callbackAnswers.push(text);
      }
    };

    installRunningAppServer(service, "thread-agent-main-2", "turn-agent-main-2");

    await withMockedNow("2026-03-10T11:20:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T11:20:01.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-agent-main-2",
        turnId: "turn-agent-main-2"
      });
    });
    await withMockedNow("2026-03-10T11:20:02.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-agent-main-2",
        turnId: "turn-agent-main-2",
        item: {
          id: "collab-2",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          receiverThreadIds: ["thread-agent-sub-resume"],
          agentsStates: {
            "thread-agent-sub-resume": {
              status: "pendingInit",
              message: "Booting"
            }
          }
        }
      });
    });

    await withMockedNow("2026-03-10T11:20:03.000Z", async () => {
      await (service as any).handleCallback({
        id: "callback-agent-expand-2",
        from: { id: 1, is_bot: false, first_name: "Tester" },
        message: {
          message_id: 740,
          chat: { id: 1, type: "private" },
          date: 0,
          text: "<b>Runtime Status</b>"
        },
        data: `v1:agent:expand:${session.sessionId}`
      });
    });

    await withMockedNow("2026-03-10T11:20:05.000Z", async () => {
      await (service as any).handleAppServerNotification("thread/status/changed", {
        threadId: "thread-agent-sub-resume",
        status: {
          type: "active",
          activeFlags: ["waitingOnApproval"]
        }
      });
    });
    assert.match(edited.at(-1)?.text ?? "", /Waiting for approval/u);

    await withMockedNow("2026-03-10T11:20:08.000Z", async () => {
      await (service as any).handleAppServerNotification("thread/status/changed", {
        threadId: "thread-agent-sub-resume",
        status: {
          type: "active",
          activeFlags: []
        }
      });
    });
    await withMockedNow("2026-03-10T11:20:10.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-agent-sub-resume",
        turnId: "turn-agent-sub-resume",
        item: {
          id: "cmd-agent-sub-resume",
          type: "commandExecution",
          title: "rg resume"
        }
      });
    });

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.match(edited.at(-1)?.text ?? "", /rg resume/u);
    assert.doesNotMatch(edited.at(-1)?.text ?? "", /Waiting for approval/u);
  } finally {
    await cleanup();
  }
});

test("runtime errors create a separate error card without polluting the status card", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string; parseMode?: string }> = [];
  const edited: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 300;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ messageId, text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-3", "turn-3");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-3",
        turnId: "turn-3"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("error", {
        threadId: "thread-3",
        turnId: "turn-3",
        message: "tool crashed"
      });
    });

    assert.equal(sent.length, 2);
    assert.equal(sent.filter((entry) => entry.text.startsWith("<b>Runtime Status</b>")).length, 1);
    assert.equal(sent.filter((entry) => entry.text.startsWith("<b>Error</b>")).length, 1);

    const statusTexts = getMessageTexts(sent, edited, 300);
    assert.ok(statusTexts.some((text) => /<b>State:<\/b> Failed/u.test(text)));
    assert.equal(statusTexts.some((text) => /tool crashed/u.test(text)), false);

    const errorTexts = getMessageTexts(sent, edited, 301);
    assert.equal(sent.find((entry) => entry.messageId === 301)?.parseMode, "HTML");
    assert.ok(errorTexts.some((text) => /<b>Title:<\/b> Runtime error/u.test(text)));
    assert.ok(errorTexts.some((text) => /<b>Detail:<\/b> tool crashed/u.test(text)));
  } finally {
    await cleanup();
  }
});

test("runtime card rate limits keep the same message and retry later without replacement spam", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; messageId: number; text: string }> = [];
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 700;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    let firstEdit = true;
    (service as any).api = {
      sendMessage: async (chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ chatId, messageId, text });
        return createFakeTelegramMessage(messageId, text);
      },
      editMessageText: async (chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push({ chatId, messageId, text });
        if (firstEdit) {
          firstEdit = false;
          throw new Error("Too Many Requests: retry after 60");
        }

        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-7", "turn-7");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });

    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-7",
        turnId: "turn-7"
      });
    });

    const activeTurn = (service as any).activeTurn;
    assert.equal(sent.length, 1);
    assert.equal(edited.length, 1);
    assert.equal(activeTurn.statusCard.messageId, 700);
    assert.match(activeTurn.statusCard.pendingText ?? "", /<b>State:<\/b> Running/u);

    await withMockedNow("2026-03-10T10:00:10.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-7",
        turnId: "turn-7",
        item: { id: "cmd-rate-limited", type: "commandExecution", title: "pnpm test" }
      });
    });

    assert.equal(sent.length, 1);
    assert.equal(edited.length, 1);

    await withMockedNow("2026-03-10T10:01:05.000Z", async () => {
      await (service as any).flushRuntimeCardRender(activeTurn, activeTurn.statusCard);
    });

    assert.equal(sent.length, 1);
    assert.equal(edited.length, 2);
    assert.match(activeTurn.statusCard.lastRenderedText, /<b>State:<\/b> Running/u);
    assert.doesNotMatch(activeTurn.statusCard.lastRenderedText, /Command: \$ pnpm test/u);
    (service as any).clearRuntimeCardTimer(activeTurn.statusCard);
  } finally {
    await cleanup();
  }
});

test("inspect returns an honest fallback when the active session has no activity snapshot", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        sent.push(text);
        return createFakeTelegramMessage(400, text);
      }
    };

    await (service as any).routeCommand("chat-1", "inspect", "");

    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /没有可用的活动详情/u);
  } finally {
    await cleanup();
  }
});

test("inspect falls back to thread history for completed sessions without a live activity snapshot", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];
  let readCalls = 0;

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-inspect-history");
    store.updateSessionStatus(session.sessionId, "idle", {
      lastTurnId: "turn-inspect-history",
      lastTurnStatus: "completed"
    });

    (service as any).appServer = {
      isRunning: true,
      readThread: async (threadId: string, includeTurns: boolean) => {
        readCalls += 1;
        assert.equal(threadId, "thread-inspect-history");
        assert.equal(includeTurns, true);
        return {
          thread: {
            id: threadId,
            turns: [
              {
                id: "turn-inspect-history",
                status: "completed",
                items: [
                  {
                    id: "cmd-1",
                    type: "commandExecution",
                    command: "pnpm test",
                    cwd: "/tmp/project-one",
                    status: "completed",
                    exitCode: 0,
                    durationMs: 1400,
                    aggregatedOutput: "$ pnpm test\n26/26 tests passed",
                    commandActions: []
                  },
                  {
                    id: "patch-1",
                    type: "fileChange",
                    status: "completed",
                    changes: [
                      {
                        path: "src/service.ts",
                        kind: "modified",
                        diff: "@@"
                      }
                    ]
                  },
                  {
                    id: "mcp-1",
                    type: "mcpToolCall",
                    server: "docs-server",
                    tool: "search_docs",
                    status: "completed",
                    arguments: { query: "inspect renderer" },
                    result: { content: ["Matched 4 docs"] },
                    error: null
                  },
                  {
                    id: "web-1",
                    type: "webSearch",
                    query: "telegram html inspect",
                    action: { type: "search", query: "telegram html inspect", queries: ["telegram html inspect"] }
                  },
                  {
                    id: "plan-1",
                    type: "plan",
                    text: "整理 inspect 输出层次"
                  },
                  {
                    id: "commentary-1",
                    type: "agentMessage",
                    phase: "commentary",
                    text: "Checking which details belong in Telegram."
                  },
                  {
                    id: "final-1",
                    type: "agentMessage",
                    phase: "final_answer",
                    text: "Inspect improved."
                  }
                ]
              }
            ]
          }
        };
      }
    };

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(402, text);
      }
    };

    await withMockedNow("2026-03-10T10:00:10.000Z", async () => {
      await (service as any).routeCommand("chat-1", "inspect", "");
    });

    assert.equal(readCalls, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.parseMode, "HTML");
    assert.match(sent[0]?.text ?? "", /^<b>当前任务详情<\/b>/u);
    assert.match(sent[0]?.text ?? "", /最近一次执行的历史记录/u);
    assert.match(sent[0]?.text ?? "", /pnpm test/u);
    assert.match(sent[0]?.text ?? "", /26\/26 tests passed/u);
    assert.match(sent[0]?.text ?? "", /src\/service\.ts/u);
    assert.match(sent[0]?.text ?? "", /docs-server/u);
    assert.match(sent[0]?.text ?? "", /telegram html inspect/u);
    assert.match(sent[0]?.text ?? "", /整理 inspect 输出层次/u);
    assert.match(sent[0]?.text ?? "", /Checking which details belong in Telegram\./u);
  } finally {
    await cleanup();
  }
});

test("inspect prefers thread history when cached completed activity is too thin", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];
  let readCalls = 0;

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-thin-history");
    store.updateSessionStatus(session.sessionId, "idle", {
      lastTurnId: "turn-thin-history",
      lastTurnStatus: "completed"
    });

    const tracker = new ActivityTracker({
      threadId: "thread-thin-history",
      turnId: "turn-thin-history"
    });
    tracker.apply(classifyNotification("turn/started", {
      threadId: "thread-thin-history",
      turnId: "turn-thin-history"
    }), "2026-03-10T10:00:00.000Z");
    tracker.apply(classifyNotification("turn/completed", {
      threadId: "thread-thin-history",
      turn: {
        id: "turn-thin-history",
        status: "completed"
      }
    }), "2026-03-10T10:00:03.000Z");

    (service as any).setRecentActivity(session.sessionId, {
      tracker,
      debugFilePath: null,
      statusCard: null
    });

    (service as any).appServer = {
      isRunning: true,
      readThread: async (threadId: string, includeTurns: boolean) => {
        readCalls += 1;
        assert.equal(threadId, "thread-thin-history");
        assert.equal(includeTurns, true);
        return {
          thread: {
            id: threadId,
            turns: [
              {
                id: "turn-thin-history",
                status: "completed",
                items: [
                  {
                    id: "cmd-1",
                    type: "commandExecution",
                    command: "pnpm test",
                    cwd: "/tmp/project-one",
                    status: "completed",
                    exitCode: 0,
                    durationMs: 1200,
                    aggregatedOutput: "$ pnpm test\n26/26 tests passed",
                    commandActions: []
                  }
                ]
              }
            ]
          }
        };
      }
    };

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(403, text);
      }
    };

    await (service as any).routeCommand("chat-1", "inspect", "");

    assert.equal(readCalls, 1);
    assert.equal(sent[0]?.parseMode, "HTML");
    assert.match(sent[0]?.text ?? "", /最近一次执行的历史记录/u);
    assert.match(sent[0]?.text ?? "", /26\/26 tests passed/u);
  } finally {
    await cleanup();
  }
});

test("inspect refuses to show a different turn when thread history is missing the requested turn", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];
  const { logger, warn } = createCapturingLogger();

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-missing-history-turn");
    store.updateSessionStatus(session.sessionId, "idle", {
      lastTurnId: "turn-missing-history-turn",
      lastTurnStatus: "completed"
    });
    (service as any).logger = logger;
    (service as any).appServer = {
      isRunning: true,
      readThread: async () => ({
        thread: {
          id: "thread-missing-history-turn",
          turns: [
            {
              id: "turn-someone-else",
              status: "completed",
              items: [
                {
                  id: "cmd-1",
                  type: "commandExecution",
                  command: "rm -rf nope",
                  status: "completed"
                }
              ]
            }
          ]
        }
      })
    };
    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
        return createFakeTelegramMessage(405, text);
      }
    };

    await (service as any).routeCommand("chat-1", "inspect", "");

    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? "", /没有可用的活动详情/u);
    assert.doesNotMatch(sent[0] ?? "", /rm -rf nope/u);
    assert.ok(warn.some((entry) => entry.message === "inspect history turn missing"));
  } finally {
    await cleanup();
  }
});

test("inspect falls back to the thin live snapshot when history misses the requested turn", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];
  const { logger, warn } = createCapturingLogger();

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.updateSessionThreadId(session.sessionId, "thread-thin-missing-history");
    store.updateSessionStatus(session.sessionId, "idle", {
      lastTurnId: "turn-thin-missing-history",
      lastTurnStatus: "completed"
    });
    const tracker = new ActivityTracker({
      threadId: "thread-thin-missing-history",
      turnId: "turn-thin-missing-history"
    });
    tracker.apply(classifyNotification("turn/started", {
      threadId: "thread-thin-missing-history",
      turnId: "turn-thin-missing-history"
    }), "2026-03-10T10:00:00.000Z");
    tracker.apply(classifyNotification("turn/completed", {
      threadId: "thread-thin-missing-history",
      turn: {
        id: "turn-thin-missing-history",
        status: "completed"
      }
    }), "2026-03-10T10:00:03.000Z");
    (service as any).setRecentActivity(session.sessionId, {
      tracker,
      debugFilePath: null,
      statusCard: null
    });
    (service as any).logger = logger;
    (service as any).appServer = {
      isRunning: true,
      readThread: async () => ({
        thread: {
          id: "thread-thin-missing-history",
          turns: [
            {
              id: "turn-someone-else",
              status: "completed",
              items: [
                {
                  id: "cmd-1",
                  type: "commandExecution",
                  command: "wrong turn output",
                  status: "completed"
                }
              ]
            }
          ]
        }
      })
    };
    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(406, text);
      }
    };

    await (service as any).routeCommand("chat-1", "inspect", "");

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.parseMode, "HTML");
    assert.match(sent[0]?.text ?? "", /^<b>当前任务详情<\/b>/u);
    assert.doesNotMatch(sent[0]?.text ?? "", /最近一次执行的历史记录/u);
    assert.doesNotMatch(sent[0]?.text ?? "", /wrong turn output/u);
    assert.ok(warn.some((entry) => entry.message === "inspect history turn missing"));
  } finally {
    await cleanup();
  }
});

test("inspect falls back to plain text when Telegram rejects the HTML message", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    installRunningAppServer(service, "thread-inspect-fallback", "turn-inspect-fallback");

    await (service as any).startRealTurn("chat-1", session, "Do the work");
    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-inspect-fallback",
      turnId: "turn-inspect-fallback"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-inspect-fallback",
      turnId: "turn-inspect-fallback",
      item: { id: "cmd-1", type: "commandExecution", title: "pnpm test" }
    });

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        if (options?.parseMode === "HTML") {
          throw new Error("message is too long");
        }
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(404, text);
      }
    };

    await (service as any).routeCommand("chat-1", "inspect", "");

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.parseMode, undefined);
    assert.match(sent[0]?.text ?? "", /^当前任务详情/u);
    assert.doesNotMatch(sent[0]?.text ?? "", /<b>/u);
    assert.match(sent[0]?.text ?? "", /最近命令/u);
  } finally {
    await cleanup();
  }
});

test("where command returns the active session with bridge and Codex identifiers", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.renameSession(session.sessionId, "Session Alpha");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(450, text);
      }
    };

    await (service as any).routeCommand("chat-1", "where", "");

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.parseMode, "HTML");
    assert.equal(
      sent[0]?.text,
      [
        "<b>当前会话</b>",
        "<b>会话名：</b> Session Alpha",
        "<b>项目：</b> Project One",
        "<b>路径：</b> /tmp/project-one",
        "<b>状态：</b> 空闲",
        `<b>Bridge 会话 ID：</b> ${session.sessionId}`,
        "<b>Codex 线程 ID：</b> 尚未创建（首次发送任务后生成）",
        "<b>最近 Turn ID：</b> 暂无"
      ].join("\n")
    );
  } finally {
    await cleanup();
  }
});

test("where command includes the current Codex thread and latest turn identifiers when present", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.renameSession(session.sessionId, "Session Alpha");
    store.updateSessionThreadId(session.sessionId, "thread-where");
    store.updateSessionStatus(session.sessionId, "idle", {
      lastTurnId: "turn-where",
      lastTurnStatus: "completed"
    });

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(451, text);
      }
    };

    await (service as any).routeCommand("chat-1", "where", "");

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.parseMode, "HTML");
    assert.equal(
      sent[0]?.text,
      [
        "<b>当前会话</b>",
        "<b>会话名：</b> Session Alpha",
        "<b>项目：</b> Project One",
        "<b>路径：</b> /tmp/project-one",
        "<b>状态：</b> 空闲",
        `<b>Bridge 会话 ID：</b> ${session.sessionId}`,
        "<b>Codex 线程 ID：</b> thread-where",
        "<b>最近 Turn ID：</b> turn-where",
        "<b>上次结果：</b> 上次已完成"
      ].join("\n")
    );
  } finally {
    await cleanup();
  }
});

test("status command renders structured fields with Telegram HTML", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.writeReadinessSnapshot({
      state: "ready",
      checkedAt: "2026-03-10T10:00:00.000Z",
      details: {
        codexInstalled: true,
        codexAuthenticated: true,
        appServerAvailable: true,
        telegramTokenValid: true,
        authorizedUserBound: true,
        issues: []
      },
      appServerPid: "1234"
    });

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(452, text);
      }
    };

    await (service as any).routeCommand("chat-1", "status", "");

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.parseMode, "HTML");
    assert.match(sent[0]?.text ?? "", /^<b>服务状态<\/b>/u);
    assert.match(sent[0]?.text ?? "", /<b>当前会话：<\/b> Project One \/ Project One \/ 空闲/u);
    assert.match(sent[0]?.text ?? "", /<b>最近检查：<\/b> 2026-03-10T10:00:00\.000Z/u);
    assert.equal(store.getActiveSession("chat-1")?.sessionId, session.sessionId);
  } finally {
    await cleanup();
  }
});

test("structured project and session replies use Telegram HTML parse mode", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];

  try {
    authorizeChat(store, "chat-1");
    const firstSession = await withMockedNow("2026-03-10T09:00:00.000Z", async () => createSession(store, "chat-1"));
    const secondSession = await withMockedNow("2026-03-10T09:05:00.000Z", async () => store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project <Two>",
      projectPath: "/tmp/project-two"
    }));
    store.setActiveSession("chat-1", firstSession.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(900 + sent.length, text);
      }
    };

    await (service as any).routeCommand("chat-1", "use", "1");
    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.equal(sent.at(-1)?.text, "<b>已切换到项目：</b> Project &lt;Two&gt;");

    await (service as any).routeCommand("chat-1", "rename", "Session <Bravo>");
    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.equal(sent.at(-1)?.text, "<b>当前会话已重命名为：</b> Session &lt;Bravo&gt;");

    await (service as any).routeCommand("chat-1", "pin", "");
    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.equal(sent.at(-1)?.text, "<b>已收藏项目：</b> Project &lt;Two&gt;");

    assert.equal(store.getActiveSession("chat-1")?.sessionId, secondSession.sessionId);
  } finally {
    await cleanup();
  }
});

test("manual path confirmation replies use Telegram HTML and preserve inline buttons", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string; replyMarkup?: any }> = [];
  const paths = (service as any).paths as BridgePaths;

  try {
    authorizeChat(store, "chat-1");
    const projectPath = join(paths.homeDir, "Repo", "manual-project");
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, "package.json"), '{ "name": "manual-project" }\n', "utf8");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup });
        return createFakeTelegramMessage(950 + sent.length, text);
      }
    };

    await (service as any).showProjectPicker("chat-1");
    await (service as any).enterManualPathMode("chat-1");
    await (service as any).handleManualPathInput("chat-1", projectPath);

    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.match(sent.at(-1)?.text ?? "", /<b>项目：<\/b> manual-project/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>路径：<\/b> /u);
    assert.equal(sent.at(-1)?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "确认进入项目");
  } finally {
    await cleanup();
  }
});

test("inspect renders structured activity details while running and after completion", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(401 + sent.length, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => createFakeTelegramMessage(messageId, text)
    };

    installRunningAppServer(service, "thread-4", "turn-4");

    await (service as any).startRealTurn("chat-1", session, "Do the work");
    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-4",
      turnId: "turn-4"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-4",
      turnId: "turn-4",
      item: { id: "item-1", type: "commandExecution", title: "pnpm test" }
    });
    await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
      threadId: "thread-4",
      turnId: "turn-4",
      itemId: "item-1",
      delta: "$ pnpm test\n26/26 tests passed"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-4",
      turnId: "turn-4",
      item: { id: "item-2", type: "fileChange", title: "src/service.ts" }
    });
    await (service as any).handleAppServerNotification("item/fileChange/outputDelta", {
      threadId: "thread-4",
      turnId: "turn-4",
      itemId: "item-2",
      delta: "Updated src/service.ts to enforce Telegram cooldown"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-4",
      turnId: "turn-4",
      item: { id: "item-3", type: "mcpToolCall" }
    });
    await (service as any).handleAppServerNotification("item/mcpToolCall/progress", {
      threadId: "thread-4",
      turnId: "turn-4",
      itemId: "item-3",
      message: "Searching docs"
    });
    await (service as any).handleAppServerNotification("turn/plan/updated", {
      threadId: "thread-4",
      turnId: "turn-4",
      plan: [
        { step: "Collect protocol evidence", status: "completed" },
        { step: "Wire inspect renderer", status: "inProgress" }
      ]
    });
    await (service as any).handleAppServerNotification("item/agentMessage/delta", {
      threadId: "thread-4",
      turnId: "turn-4",
      itemId: "item-4",
      delta: "Checking event mapping against Telegram surface."
    });
    await (service as any).handleAppServerNotification("item/completed", {
      threadId: "thread-4",
      turnId: "turn-4",
      item: {
        id: "item-4",
        type: "agentMessage",
        phase: "commentary",
        text: "Checking event mapping against Telegram surface."
      }
    });
    await (service as any).handleAppServerNotification("item/reasoning/summaryTextDelta", {
      threadId: "thread-4",
      turnId: "turn-4",
      itemId: "reason-1",
      delta: "private reasoning"
    });

    await (service as any).routeCommand("chat-1", "inspect", "");
    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.match(sent.at(-1)?.text ?? "", /<b>当前任务详情<\/b>/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>会话：<\/b> Project One/u);
    assert.doesNotMatch(sent.at(-1)?.text ?? "", /<b>项目：<\/b> Project One/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>状态：<\/b> 执行中/u);
    assert.match(sent.at(-1)?.text ?? "", /Searching docs/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>最近命令<\/b>/u);
    assert.match(sent.at(-1)?.text ?? "", /1\. <b>命令：<\/b> \$ pnpm test/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>状态：<\/b> 进行中/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>结果：<\/b> 26\/26 tests passed/u);
    assert.match(sent.at(-1)?.text ?? "", /Updated src\/service\.ts to enforce Telegram cooldown/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>当前计划<\/b>/u);
    assert.match(sent.at(-1)?.text ?? "", /Collect protocol evidence \(completed\)/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>补充说明<\/b>/u);
    assert.match(sent.at(-1)?.text ?? "", /Checking event mapping against Telegram surface\./u);
    assert.doesNotMatch(sent.at(-1)?.text ?? "", /private reasoning/u);

    await (service as any).handleAppServerNotification("codex/event/task_complete", {
      threadId: "thread-4",
      turnId: "turn-4",
      msg: { last_agent_message: "All done." }
    });
    await (service as any).handleAppServerNotification("turn/completed", {
      threadId: "thread-4",
      turn: { id: "turn-4", status: "completed" }
    });

    await (service as any).routeCommand("chat-1", "inspect", "");
    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.match(sent.at(-1)?.text ?? "", /<b>状态：<\/b> 已完成/u);
    assert.match(sent.at(-1)?.text ?? "", /1\. <b>命令：<\/b> \$ pnpm test/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>状态：<\/b> 已完成/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>最近结论：<\/b> 最终答复已生成/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>最终答复：<\/b> 已就绪/u);
  } finally {
    await cleanup();
  }
});

test("debug journal write failures do not break inspect or turn progress handling", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ text: string; parseMode?: string }> = [];
  const edited: string[] = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, options?: any) => {
        sent.push({ text, parseMode: options?.parseMode });
        return createFakeTelegramMessage(500 + sent.length, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => {
        edited.push(text);
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-5", "turn-5");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    (service as any).activeTurn.debugJournal = {
      filePath: "/tmp/failing.jsonl",
      append: async () => {
        throw new Error("disk full");
      }
    };

    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-5",
        turnId: "turn-5"
      });
    });
    await withMockedNow("2026-03-10T10:00:06.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-5",
        turnId: "turn-5",
        item: { id: "item-1", type: "commandExecution", title: "pnpm test" }
      });
    });

    await (service as any).routeCommand("chat-1", "inspect", "");

    assert.ok(sent.some((entry) => /^<b>Runtime Status<\/b>/u.test(entry.text)));
    assert.equal(sent.some((entry) => /^Command/u.test(entry.text)), false);
    assert.equal(edited.some((text) => /Command: \$ pnpm test/u.test(text)), false);
    assert.ok(edited.some((text) => /<b>State:<\/b> Running/u.test(text)));
    assert.equal(sent.at(-1)?.parseMode, "HTML");
    assert.match(sent.at(-1)?.text ?? "", /<b>当前任务详情<\/b>/u);
    assert.match(sent.at(-1)?.text ?? "", /<b>最近命令<\/b>/u);
    assert.match(sent.at(-1)?.text ?? "", /1\. <b>命令：<\/b> \$ pnpm test/u);
  } finally {
    await cleanup();
  }
});

test("default activity message renders structured English state without leaking raw unreadable labels", () => {
  const rendered = buildTurnStatusCard(
    createActivityStatus({
      turnStatus: "starting",
      lastHighValueEventType: null,
      lastHighValueTitle: null,
      lastHighValueDetail: null,
      activeItemType: null,
      activeItemLabel: null
    }),
    {
      sessionName: "Session Alpha",
      projectName: "Project One"
    }
  );

  assert.match(rendered, /Session: Session Alpha/u);
  assert.match(rendered, /Project: Project One/u);
  assert.match(rendered, /Status: Starting/u);
  assert.match(rendered, /Current step: Waiting for first activity/u);
  assert.doesNotMatch(rendered, /状态：|当前活动：|\n.*other/u);
});

test("flushRuntimeNotices retains notices after a failed delivery and retries later", async () => {
  const { service, store, cleanup } = await createServiceContext();
  let attempts = 0;

  try {
    seedRuntimeNotice(store, "chat-1");
    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("telegram down");
        }

        return createFakeTelegramMessage(10 + attempts, text);
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

test("runtime card flow writes dedicated per-surface trace logs with rendered content", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const paths = (service as any).paths as BridgePaths;

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => createFakeTelegramMessage(700 + text.length, text),
      editMessageText: async (_chatId: string, messageId: number, text: string, _options?: any) => createFakeTelegramMessage(messageId, text)
    };

    installRunningAppServer(service, "thread-trace", "turn-trace");

    await (service as any).startRealTurn("chat-1", session, "Trace runtime cards");
    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-trace",
      turnId: "turn-trace"
    });
    await (service as any).handleAppServerNotification("turn/plan/updated", {
      threadId: "thread-trace",
      turnId: "turn-trace",
      plan: [
        { step: "Trace status card", status: "completed" },
        { step: "Trace plan card", status: "inProgress" }
      ]
    });
    await (service as any).handleAppServerNotification("item/agentMessage/delta", {
      threadId: "thread-trace",
      turnId: "turn-trace",
      itemId: "msg-1",
      delta: "Checking Telegram session flow rendering."
    });
    await (service as any).handleAppServerNotification("item/completed", {
      threadId: "thread-trace",
      turnId: "turn-trace",
      item: {
        id: "msg-1",
        type: "agentMessage",
        phase: "commentary",
        text: "Checking Telegram session flow rendering."
      }
    });
    await (service as any).handleAppServerNotification("error", {
      threadId: "thread-trace",
      turnId: "turn-trace",
      message: "Telegram edit failed"
    });

    const statusLog = await readFile(paths.telegramStatusCardLogPath, "utf8");
    const errorLog = await readFile(paths.telegramErrorCardLogPath, "utf8");

    assert.match(statusLog, /"message":"state_transition"/u);
    assert.match(statusLog, /"message":"render_requested"/u);
    assert.match(statusLog, /Checking Telegram session flow rendering\./u);
    assert.match(statusLog, /当前计划：Trace plan card/u);
    assert.match(statusLog, /Trace plan card \(inProgress\)/u);
    assert.match(statusLog, /"renderedText":"<b>Runtime Status/u);

    assert.match(errorLog, /"message":"card_created"/u);
    assert.match(errorLog, /Telegram edit failed/u);
    assert.match(errorLog, /"renderedText":"<b>Error/u);
  } finally {
    await cleanup();
  }
});
