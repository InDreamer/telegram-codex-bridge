import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { BridgePaths } from "./paths.js";
import type { ActivityStatus } from "./activity/types.js";
import { BridgeService } from "./service.js";
import { BridgeStateStore } from "./state/store.js";
import { buildTurnStatusCard } from "./telegram/ui.js";

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
  const runtimeDir = join(root, "runtime");

  return {
    homeDir: root,
    repoRoot: root,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir: join(root, "logs"),
    runtimeDir,
    cacheDir: join(root, "cache"),
    dbPath: join(root, "state", "bridge.db"),
    envPath: join(root, "config", "bridge.env"),
    servicePath: join(root, "service", "bridge.service"),
    binPath: join(root, "bin", "ctb"),
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
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
    activeItemType: "agentMessage",
    activeItemId: "item-1",
    activeItemLabel: "agentMessage",
    lastActivityAt: "2026-03-10T10:00:05.000Z",
    currentItemStartedAt: "2026-03-10T10:00:00.000Z",
    currentItemDurationSec: 5,
    lastHighValueEventType: "found",
    lastHighValueTitle: "Found: useful result",
    lastHighValueDetail: "useful result",
    latestProgress: null,
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

test("default activity message keeps one bridge-owned message and renders action-plus-result updates", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; text: string }> = [];
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 100;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
        return createFakeTelegramMessage(nextMessageId++, text);
      },
      editMessageText: async (chatId: string, messageId: number, text: string) => {
        edited.push({ chatId, messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-1", "turn-1");

    await (service as any).startRealTurn("chat-1", session, "Do the work");
    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-1",
      turnId: "turn-1"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-1", type: "commandExecution", title: "pnpm test" }
    });
    await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      delta: "$ pnpm test\n26/26 tests passed"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "item-2", type: "fileChange", title: "src/service.ts" }
    });
    await (service as any).handleAppServerNotification("item/fileChange/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      delta: "Updated src/service.ts to enforce Telegram cooldown"
    });
    await (service as any).handleAppServerNotification("codex/event/task_complete", {
      threadId: "thread-1",
      turnId: "turn-1",
      msg: { last_agent_message: "All done." }
    });
    await (service as any).handleAppServerNotification("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" }
    });

    assert.equal(sent.length, 2);
    assert.doesNotMatch(sent[0]?.text ?? "", /状态：|正在执行/u);
    assert.match(sent[0]?.text ?? "", /\/inspect/u);
    assert.equal(sent[1]?.text, "All done.");
    assert.equal(edited.length, 4);
    assert.equal(edited[0]?.messageId, 100);
    assert.match(edited[0]?.text ?? "", /Ran cmd: pnpm test/u);
    assert.match(edited[1]?.text ?? "", /Ran cmd: pnpm test/u);
    assert.match(edited[2]?.text ?? "", /Changed: Updated src\/service\.ts to enforce Telegram cooldown/u);
    assert.match(edited.at(-1)?.text ?? "", /Done: All done\./u);
    assert.doesNotMatch(edited.join("\n"), /状态：|当前活动：|本阶段耗时/u);
    assert.equal((service as any).activeTurn, null);
  } finally {
    await cleanup();
  }
});

test("completed turns fall back to thread history when task_complete is missing", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; text: string }> = [];
  let nextMessageId = 150;
  let resumeCalls = 0;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
        return createFakeTelegramMessage(nextMessageId++, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string) => createFakeTelegramMessage(messageId, text)
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

    await (service as any).startRealTurn("chat-1", session, "Do the work");
    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-fallback",
      turnId: "turn-fallback"
    });
    await (service as any).handleAppServerNotification("turn/completed", {
      threadId: "thread-fallback",
      turn: { id: "turn-fallback", status: "completed" }
    });

    assert.equal(resumeCalls, 1);
    assert.equal(sent.length, 2);
    assert.match(sent[0]?.text ?? "", /\/inspect/u);
    assert.equal(sent[1]?.text, "Recovered from thread history.");
    assert.equal(store.getSessionById(session.sessionId)?.status, "idle");
    assert.equal((service as any).activeTurn, null);
  } finally {
    await cleanup();
  }
});

test("default activity message falls back to a new message when a high-value edit fails", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; text: string }> = [];
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 200;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    let firstEdit = true;
    (service as any).api = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
        return createFakeTelegramMessage(nextMessageId++, text);
      },
      editMessageText: async (chatId: string, messageId: number, text: string) => {
        edited.push({ chatId, messageId, text });
        if (firstEdit) {
          firstEdit = false;
          throw new Error("message can not be edited");
        }

        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-2", "turn-2");

    await (service as any).startRealTurn("chat-1", session, "Do the work");
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-2",
      turnId: "turn-2",
      item: { id: "item-1", type: "commandExecution", title: "pnpm test" }
    });

    const activeTurn = (service as any).activeTurn;
    assert.equal(sent.length, 2);
    assert.equal(edited.length, 1);
    assert.equal(activeTurn.statusCard.messageId, 201);
  } finally {
    await cleanup();
  }
});

test("status card serializes concurrent creation so one turn keeps one message", async () => {
  const { service, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; text: string }> = [];
  let nextMessageId = 800;
  let releaseSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });

  try {
    (service as any).api = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
        await sendGate;
        return createFakeTelegramMessage(nextMessageId++, text);
      }
    };

    const activeTurn: any = {
      sessionId: "session-1",
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      finalMessage: null,
      tracker: {
        getStatus: () => createActivityStatus()
      },
      debugJournal: {
        filePath: null,
        append: async () => {}
      },
      statusCard: null,
      statusCardQueue: Promise.resolve()
    };
    const previousStatus = createActivityStatus({ turnStatus: "starting" });
    const nextStatus = createActivityStatus({ turnStatus: "running" });

    const firstUpdate = (service as any).updateStatusCard(activeTurn, previousStatus, nextStatus);
    const secondUpdate = (service as any).updateStatusCard(activeTurn, previousStatus, nextStatus);

    releaseSend();
    await Promise.all([firstUpdate, secondUpdate]);

    assert.equal(sent.length, 1);
    assert.equal(activeTurn.statusCard?.messageId, 800);
  } finally {
    await cleanup();
  }
});

test("default activity message ignores duration-only drift when no semantic event changed", async () => {
  const { service, cleanup } = await createServiceContext();

  try {
    const previousStatus = createActivityStatus({ currentItemDurationSec: 5 });
    const nextStatus = createActivityStatus({ currentItemDurationSec: 12 });
    const activeTurn = {
      statusCard: {
        messageId: 200,
        lastRenderedText: "before"
      }
    };

    const shouldUpdate = (service as any).shouldUpdateStatusCard(activeTurn, previousStatus, nextStatus, "after");

    assert.equal(shouldUpdate, false);
  } finally {
    await cleanup();
  }
});

test("default activity message ignores commentary and reasoning-only notifications", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 600;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => createFakeTelegramMessage(nextMessageId++, text),
      editMessageText: async (chatId: string, messageId: number, text: string) => {
        edited.push({ chatId, messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-6", "turn-6");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });
    await withMockedNow("2026-03-10T10:00:01.000Z", async () => {
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

    assert.equal(edited.length, 0);

    await withMockedNow("2026-03-10T10:00:12.000Z", async () => {
      await (service as any).handleAppServerNotification("item/agentMessage/delta", {
        threadId: "thread-6",
        turnId: "turn-6",
        itemId: "item-1",
        delta: "drafting..."
      });
      await (service as any).handleAppServerNotification("item/reasoning/summaryTextDelta", {
        threadId: "thread-6",
        turnId: "turn-6",
        itemId: "reason-1",
        delta: "private reasoning"
      });
    });

    assert.equal(edited.length, 0);
  } finally {
    await cleanup();
  }
});

test("default activity message updates on distinct high-value events but suppresses duplicate findings", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 300;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => createFakeTelegramMessage(nextMessageId++, text),
      editMessageText: async (chatId: string, messageId: number, text: string) => {
        edited.push({ chatId, messageId, text });
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-3", "turn-3");

    await (service as any).startRealTurn("chat-1", session, "Do the work");
    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-3",
      turnId: "turn-3"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-3",
      turnId: "turn-3",
      item: { id: "item-1", type: "mcpToolCall" }
    });
    await (service as any).handleAppServerNotification("item/mcpToolCall/progress", {
      threadId: "thread-3",
      turnId: "turn-3",
      itemId: "item-1",
      message: "Searching docs"
    });
    await (service as any).handleAppServerNotification("item/mcpToolCall/progress", {
      threadId: "thread-3",
      turnId: "turn-3",
      itemId: "item-1",
      message: "Searching docs"
    });
    await (service as any).handleAppServerNotification("item/mcpToolCall/progress", {
      threadId: "thread-3",
      turnId: "turn-3",
      itemId: "item-1",
      message: "Reading repo docs"
    });

    assert.equal(edited.length, 2);

    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-3",
      turnId: "turn-3",
      item: { id: "item-2", type: "commandExecution", title: "rg app-server src" }
    });
    await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
      threadId: "thread-3",
      turnId: "turn-3",
      itemId: "item-2",
      delta: "$ rg app-server src\n12 matches"
    });

    assert.equal(edited.length, 4);
    assert.match(edited[0]?.text ?? "", /Found: Searching docs/u);
    assert.match(edited[1]?.text ?? "", /Found: Reading repo docs/u);
    assert.match(edited[2]?.text ?? "", /Ran cmd: rg app-server src/u);
    assert.match(edited[3]?.text ?? "", /Ran cmd: rg app-server src/u);
  } finally {
    await cleanup();
  }
});

test("default activity message enters cooldown on Telegram rate limit without send flood", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; text: string }> = [];
  const edited: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 700;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
        return createFakeTelegramMessage(nextMessageId++, text);
      },
      editMessageText: async (chatId: string, messageId: number, text: string) => {
        edited.push({ chatId, messageId, text });
        throw new Error("Too Many Requests: retry after 60");
      }
    };

    installRunningAppServer(service, "thread-7", "turn-7");

    await withMockedNow("2026-03-10T10:00:00.000Z", async () => {
      await (service as any).startRealTurn("chat-1", session, "Do the work");
    });

    const originalStatusCardMessageId = (service as any).activeTurn.statusCard.messageId;

    await withMockedNow("2026-03-10T10:00:01.000Z", async () => {
      await (service as any).handleAppServerNotification("turn/started", {
        threadId: "thread-7",
        turnId: "turn-7"
      });
    });

    await withMockedNow("2026-03-10T10:00:02.000Z", async () => {
      await (service as any).handleAppServerNotification("item/started", {
        threadId: "thread-7",
        turnId: "turn-7",
        item: { id: "item-1", type: "commandExecution", title: "pnpm test" }
      });
      await (service as any).handleAppServerNotification("item/commandExecution/outputDelta", {
        threadId: "thread-7",
        turnId: "turn-7",
        itemId: "item-1",
        delta: "$ pnpm test\n26/26 tests passed"
      });
    });

    await withMockedNow("2026-03-10T10:00:03.000Z", async () => {
      await (service as any).handleAppServerNotification("item/fileChange/outputDelta", {
        threadId: "thread-7",
        turnId: "turn-7",
        itemId: "item-2",
        delta: "Updated src/service.ts"
      });
    });

    assert.equal(sent.length, 1);
    assert.equal(edited.length, 1);
    assert.equal((service as any).activeTurn.statusCard.messageId, originalStatusCardMessageId);
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
      sendMessage: async (_chatId: string, text: string) => {
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

test("inspect renders structured activity details while running and after completion", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
        return createFakeTelegramMessage(401 + sent.length, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string) => createFakeTelegramMessage(messageId, text)
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
    await (service as any).handleAppServerNotification("item/reasoning/summaryTextDelta", {
      threadId: "thread-4",
      turnId: "turn-4",
      itemId: "reason-1",
      delta: "private reasoning"
    });

    await (service as any).routeCommand("chat-1", "inspect", "");
    assert.match(sent.at(-1) ?? "", /当前任务详情/u);
    assert.match(sent.at(-1) ?? "", /Searching docs/u);
    assert.match(sent.at(-1) ?? "", /pnpm test -> 26\/26 tests passed/u);
    assert.match(sent.at(-1) ?? "", /Updated src\/service\.ts to enforce Telegram cooldown/u);
    assert.match(sent.at(-1) ?? "", /计划概览/u);
    assert.match(sent.at(-1) ?? "", /Collect protocol evidence \(completed\)/u);
    assert.match(sent.at(-1) ?? "", /可选 commentary/u);
    assert.match(sent.at(-1) ?? "", /Checking event mapping against Telegram surface\./u);
    assert.doesNotMatch(sent.at(-1) ?? "", /private reasoning/u);

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
    assert.match(sent.at(-1) ?? "", /最近有用进展：Done: All done\./u);
  } finally {
    await cleanup();
  }
});

test("debug journal write failures do not break inspect or turn progress handling", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];
  const edited: string[] = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string) => {
        sent.push(text);
        return createFakeTelegramMessage(500 + sent.length, text);
      },
      editMessageText: async (_chatId: string, messageId: number, text: string) => {
        edited.push(text);
        return createFakeTelegramMessage(messageId, text);
      }
    };

    installRunningAppServer(service, "thread-5", "turn-5");

    await (service as any).startRealTurn("chat-1", session, "Do the work");
    (service as any).activeTurn.debugJournal = {
      filePath: "/tmp/failing.jsonl",
      append: async () => {
        throw new Error("disk full");
      }
    };

    await (service as any).handleAppServerNotification("turn/started", {
      threadId: "thread-5",
      turnId: "turn-5"
    });
    await (service as any).handleAppServerNotification("item/started", {
      threadId: "thread-5",
      turnId: "turn-5",
      item: { id: "item-1", type: "commandExecution", title: "pnpm test" }
    });

    await (service as any).routeCommand("chat-1", "inspect", "");

    assert.ok(edited.length >= 1);
    assert.match(sent.at(-1) ?? "", /当前任务详情/u);
  } finally {
    await cleanup();
  }
});

test("default activity message uses high-value fallback copy and hides unreadable activity", () => {
  const rendered = buildTurnStatusCard(
    createActivityStatus({
      turnStatus: "starting",
      lastHighValueEventType: null,
      lastHighValueTitle: null,
      lastHighValueDetail: null,
      activeItemType: "other",
      activeItemLabel: "other"
    })
  );

  assert.doesNotMatch(rendered, /状态：|当前活动：|other/u);
  assert.match(rendered, /等待有用进展/u);
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
