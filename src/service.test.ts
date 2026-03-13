import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { BridgePaths } from "./paths.js";
import type { ActivityStatus } from "./activity/types.js";
import { BridgeService } from "./service.js";
import { BridgeStateStore } from "./state/store.js";
import {
  buildTurnStatusCard,
  encodeCommandListCollapseCallback,
  encodeCommandListExpandCallback
} from "./telegram/ui.js";

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

    assert.equal(sent.every((entry) => entry.parseMode === undefined), true);
    assert.equal(sent.filter((entry) => entry.text.startsWith("Runtime Status")).length, 1);
    assert.equal(sent.filter((entry) => entry.text.startsWith("Plan")).length, 1);
    assert.equal(sent.filter((entry) => entry.text.startsWith("Command")).length, 0);
    assert.equal(sent.filter((entry) => entry.text === "All done.").length, 1);

    const statusTexts = getMessageTexts(sent, edited, 100);
    assert.ok(statusTexts.some((text) => /State: Starting/u.test(text)));
    assert.ok(statusTexts.some((text) => /State: Running/u.test(text)));
    assert.ok(statusTexts.some((text) => /State: Completed/u.test(text)));
    assert.ok(statusTexts.some((text) => /Command: \$ pnpm test/u.test(text)));
    assert.ok(statusTexts.some((text) => /Output: 26\/26 tests passed/u.test(text)));
    assert.equal(statusTexts.some((text) => /Collect protocol evidence/u.test(text)), false);

    const planTexts = getMessageTexts(sent, edited, 101);
    assert.ok(planTexts.some((text) => /Collect protocol evidence \(completed\)/u.test(text)));
    assert.ok(planTexts.some((text) => /Wire inspect renderer \(inProgress\)/u.test(text)));

    assert.equal((service as any).activeTurn, null);
  } finally {
    await cleanup();
  }
});

test("status card expands and collapses command history with Telegram callbacks", async () => {
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
    assert.match(collapsed?.text ?? "", /Latest command/u);
    assert.match(collapsed?.text ?? "", /Command: \$ pnpm test/u);
    assert.doesNotMatch(collapsed?.text ?? "", /pnpm install/u);
    assert.equal(
      collapsed?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data,
      encodeCommandListExpandCallback(session.sessionId)
    );

    await (service as any).handleCallback({
      id: "callback-expand",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 900,
        chat: { id: 1, type: "private" },
        date: 0,
        text: "Runtime Status"
      },
      data: encodeCommandListExpandCallback(session.sessionId)
    });

    const expanded = edited.at(-1);
    assert.match(expanded?.text ?? "", /Commands: 2/u);
    assert.match(expanded?.text ?? "", /1\. Command: \$ pnpm install/u);
    assert.match(expanded?.text ?? "", /2\. Command: \$ pnpm test/u);
    assert.equal(
      expanded?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data,
      encodeCommandListCollapseCallback(session.sessionId)
    );

    await (service as any).handleCallback({
      id: "callback-collapse",
      from: { id: 1, is_bot: false, first_name: "Tester" },
      message: {
        message_id: 900,
        chat: { id: 1, type: "private" },
        date: 0,
        text: "Runtime Status"
      },
      data: encodeCommandListCollapseCallback(session.sessionId)
    });

    const recollapsed = edited.at(-1);
    assert.match(recollapsed?.text ?? "", /Latest command/u);
    assert.doesNotMatch(recollapsed?.text ?? "", /1\. Command: \$ pnpm install/u);
    assert.equal(callbackAnswers.length, 2);
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
    assert.equal(sent.every((entry) => entry.parseMode === undefined), true);
    assert.equal(sent.filter((entry) => entry.text.startsWith("Runtime Status")).length, 1);
    assert.ok(sent.some((entry) => entry.text === "Recovered from thread history."));
    assert.ok(edited.some((entry) => /State: Completed/u.test(entry.text)));
    assert.equal(store.getSessionById(session.sessionId)?.status, "idle");
    assert.equal((service as any).activeTurn, null);
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
    assert.match(activeTurn.statusCard.pendingText ?? "", /State: Running/u);

    await withMockedNow("2026-03-10T10:00:09.000Z", async () => {
      await (service as any).flushRuntimeCardRender(activeTurn, activeTurn.statusCard);
    });

    assert.equal(sent.length, 1);
    assert.equal(edited.length, 2);
    assert.match(activeTurn.statusCard.lastRenderedText, /State: Running/u);
    (service as any).clearRuntimeCardTimer(activeTurn.statusCard);
  } finally {
    await cleanup();
  }
});

test("startRealTurn sends an initial runtime status card immediately", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ chatId: string; messageId: number; text: string }> = [];
  let nextMessageId = 800;

  try {
    const session = authorizeChatWithSession(store, "chat-1");

    (service as any).api = {
      sendMessage: async (chatId: string, text: string, _options?: any) => {
        const messageId = nextMessageId++;
        sent.push({ chatId, messageId, text });
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
    assert.match(sent[0]?.text ?? "", /^Runtime Status/u);
    assert.match(sent[0]?.text ?? "", /State: Starting/u);
    assert.match(sent[0]?.text ?? "", /Use \/inspect for full details/u);
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

    assert.match(edited.at(-1)?.text ?? "", /Progress: Searching docs/u);
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
    assert.match(statusTexts.at(-1) ?? "", /Command: \$ pnpm test/u);
    assert.match(statusTexts.at(-1) ?? "", /Output: 26\/26 tests passed/u);
  } finally {
    await cleanup();
  }
});

test("fragmented commentary waits for a complete sentence before updating the status card", async () => {
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
        delta: "先看项目骨架，再抓入口"
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
      await (service as any).handleAppServerNotification("item/agentMessage/delta", {
        threadId: "thread-6",
        turnId: "turn-6",
        itemId: "item-1",
        delta: "、配置和主要模块。"
      });
    });

    assert.equal(edited.length, 2);
    assert.match(edited.at(-1)?.text ?? "", /Progress: 先看项目骨架，再抓入口、配置和主要模块。/u);
    const inspect = (service as any).activeTurn.tracker.getInspectSnapshot();
    assert.equal(inspect.commentarySnippets.at(-1), "先看项目骨架，再抓入口、配置和主要模块。");
  } finally {
    await cleanup();
  }
});

test("plan card renders the current plan state instead of contradictory history", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string }> = [];
  const edited: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 630;

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

    const planTexts = getMessageTexts(sent, edited, 631);
    assert.match(planTexts.at(-1) ?? "", /Collect protocol evidence \(completed\)/u);
    assert.match(planTexts.at(-1) ?? "", /Wire inspect renderer \(inProgress\)/u);
    assert.doesNotMatch(planTexts.at(-1) ?? "", /Collect protocol evidence \(pending\)/u);
  } finally {
    await cleanup();
  }
});

test("runtime errors create a separate error card without polluting the status card", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: Array<{ messageId: number; text: string }> = [];
  const edited: Array<{ messageId: number; text: string }> = [];
  let nextMessageId = 300;

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
    assert.equal(sent.filter((entry) => entry.text.startsWith("Runtime Status")).length, 1);
    assert.equal(sent.filter((entry) => entry.text.startsWith("Error")).length, 1);

    const statusTexts = getMessageTexts(sent, edited, 300);
    assert.ok(statusTexts.some((text) => /State: Failed/u.test(text)));
    assert.equal(statusTexts.some((text) => /tool crashed/u.test(text)), false);

    const errorTexts = getMessageTexts(sent, edited, 301);
    assert.ok(errorTexts.some((text) => /Title: Runtime error/u.test(text)));
    assert.ok(errorTexts.some((text) => /Detail: tool crashed/u.test(text)));
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
    assert.match(activeTurn.statusCard.pendingText ?? "", /State: Running/u);

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
    assert.match(activeTurn.statusCard.lastRenderedText, /Command: \$ pnpm test/u);
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

test("inspect renders structured activity details while running and after completion", async () => {
  const { service, store, cleanup } = await createServiceContext();
  const sent: string[] = [];

  try {
    const session = authorizeChatWithSession(store, "chat-1");
    store.setActiveSession("chat-1", session.sessionId);

    (service as any).api = {
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        sent.push(text);
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
    await (service as any).handleAppServerNotification("item/reasoning/summaryTextDelta", {
      threadId: "thread-4",
      turnId: "turn-4",
      itemId: "reason-1",
      delta: "private reasoning"
    });

    await (service as any).routeCommand("chat-1", "inspect", "");
    assert.match(sent.at(-1) ?? "", /Task details/u);
    assert.match(sent.at(-1) ?? "", /Session: Project One/u);
    assert.match(sent.at(-1) ?? "", /Project: Project One/u);
    assert.match(sent.at(-1) ?? "", /Status: Running/u);
    assert.match(sent.at(-1) ?? "", /Searching docs/u);
    assert.match(sent.at(-1) ?? "", /pnpm test -> 26\/26 tests passed/u);
    assert.match(sent.at(-1) ?? "", /Updated src\/service\.ts to enforce Telegram cooldown/u);
    assert.match(sent.at(-1) ?? "", /Plan snapshot/u);
    assert.match(sent.at(-1) ?? "", /Collect protocol evidence \(completed\)/u);
    assert.match(sent.at(-1) ?? "", /Commentary snippets/u);
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
    assert.match(sent.at(-1) ?? "", /Status: Completed/u);
    assert.match(sent.at(-1) ?? "", /Latest milestone: Assistant reply: All done\./u);
    assert.match(sent.at(-1) ?? "", /Final answer: ready/u);
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
      sendMessage: async (_chatId: string, text: string, _options?: any) => {
        sent.push(text);
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

    assert.ok(sent.some((text) => /^Runtime Status/u.test(text)));
    assert.equal(sent.some((text) => /^Command/u.test(text)), false);
    assert.ok(edited.some((text) => /Command: \$ pnpm test/u.test(text)));
    assert.ok(edited.some((text) => /State: Running/u.test(text)));
    assert.match(sent.at(-1) ?? "", /Task details/u);
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
    await (service as any).handleAppServerNotification("error", {
      threadId: "thread-trace",
      turnId: "turn-trace",
      message: "Telegram edit failed"
    });

    const statusLog = await readFile(paths.telegramStatusCardLogPath, "utf8");
    const planLog = await readFile(paths.telegramPlanCardLogPath, "utf8");
    const errorLog = await readFile(paths.telegramErrorCardLogPath, "utf8");

    assert.match(statusLog, /"message":"state_transition"/u);
    assert.match(statusLog, /"message":"render_requested"/u);
    assert.match(statusLog, /Checking Telegram session flow rendering\./u);
    assert.match(statusLog, /"renderedText":"Runtime Status/u);

    assert.match(planLog, /"message":"state_transition"/u);
    assert.match(planLog, /Trace plan card \(inProgress\)/u);
    assert.match(planLog, /"renderedText":"Plan/u);

    assert.match(errorLog, /"message":"card_created"/u);
    assert.match(errorLog, /Telegram edit failed/u);
    assert.match(errorLog, /"renderedText":"Error/u);
  } finally {
    await cleanup();
  }
});
