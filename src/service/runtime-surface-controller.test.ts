import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActivityStatus, InspectSnapshot } from "../activity/types.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import type { TelegramInlineKeyboardMarkup, TelegramMessage } from "../telegram/api.js";
import { BridgeStateStore } from "../state/store.js";
import { RuntimeSurfaceController } from "./runtime-surface-controller.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

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

function createInspectSnapshot(overrides: Partial<InspectSnapshot> = {}): InspectSnapshot {
  return {
    ...createActivityStatus(),
    recentTransitions: [],
    recentCommandSummaries: [],
    recentFileChangeSummaries: [],
    recentMcpSummaries: [],
    recentWebSearches: [],
    recentHookSummaries: [],
    recentNoticeSummaries: [],
    planSnapshot: [],
    proposedPlanSnapshot: [],
    agentSnapshot: [],
    completedCommentary: [],
    tokenUsage: null,
    latestDiffSummary: null,
    terminalInteractionSummary: null,
    pendingInteractions: [],
    answeredInteractions: [],
    ...overrides
  };
}

function createStatusCard(messageId = 0) {
  return {
    surface: "status" as const,
    key: "status",
    parseMode: "HTML" as const,
    messageId,
    lastRenderedText: "",
    lastRenderedReplyMarkupKey: null,
    lastRenderedAtMs: null,
    rateLimitUntilAtMs: null,
    pendingText: null,
    pendingReplyMarkup: null,
    pendingReason: null,
    timer: null,
    commandItems: new Map(),
    commandOrder: [],
    planExpanded: false,
    agentsExpanded: false,
    needsReanchorOnActive: false
  };
}

function getOnlyDraftToken(controller: RuntimeSurfaceController): string {
  const [token] = [...((controller as unknown as {
    runtimePreferenceDrafts: Map<string, unknown>;
  }).runtimePreferenceDrafts.keys())];
  assert.ok(token);
  return token;
}

async function createControllerContext(options: {
  safeSendHtmlMessageResult?: (
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<TelegramMessage | null>;
  safeEditHtmlMessageText?: (
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<{ outcome: "edited" } | { outcome: "rate_limited"; retryAfterMs: number } | { outcome: "failed" }>;
  backfillSubagentIdentities?: (activeTurn: unknown, agentEntries: unknown[]) => Promise<boolean>;
  listActiveTurns?: () => unknown[];
  initialSentMessageId?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctb-runtime-surface-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  const sentHtml: Array<{ chatId: string; messageId: number; html: string; replyMarkup?: unknown }> = [];
  const editedHtml: Array<{ chatId: string; messageId: number; html: string; replyMarkup?: unknown }> = [];
  const callbackAnswers: Array<string | undefined> = [];
  const refreshReasons: string[] = [];
  const deletedMessages: number[] = [];
  const traceEvents: string[] = [];
  let nextMessageId = options.initialSentMessageId ?? 1000;

  const controller = new RuntimeSurfaceController({
    logger: testLogger,
    getStore: () => store,
    listActiveTurns: () => (options.listActiveTurns?.() ?? []) as never[],
    getActiveInspectActivity: () => null,
    getRecentActivity: () => null,
    getHistoricalInspectPayload: async () => null,
    buildPendingInteractionSummaries: () => [],
    buildAnsweredInteractionSummaries: () => [],
    safeSendMessage: async () => true,
    safeSendHtmlMessage: async () => true,
    safeSendHtmlMessageResult: async (chatId, html, replyMarkup) => {
      if (options.safeSendHtmlMessageResult) {
        return await options.safeSendHtmlMessageResult(chatId, html, replyMarkup);
      }
      const messageId = nextMessageId++;
      sentHtml.push(replyMarkup
        ? { chatId, messageId, html, replyMarkup }
        : { chatId, messageId, html });
      return createFakeTelegramMessage(messageId, html);
    },
    safeSendMessageResult: async (chatId, text) => createFakeTelegramMessage(nextMessageId++, `${chatId}:${text}`),
    safeEditHtmlMessageText: async (chatId, messageId, html, replyMarkup) => {
      editedHtml.push(replyMarkup
        ? { chatId, messageId, html, replyMarkup }
        : { chatId, messageId, html });
      if (options.safeEditHtmlMessageText) {
        return await options.safeEditHtmlMessageText(chatId, messageId, html, replyMarkup);
      }
      return { outcome: "edited" };
    },
    safeEditMessageText: async () => ({ outcome: "edited" }),
    safeDeleteMessage: async (_chatId, messageId) => {
      deletedMessages.push(messageId);
      return true;
    },
    safeAnswerCallbackQuery: async (_callbackQueryId, text) => {
      callbackAnswers.push(text);
    },
    getUiLanguage: () => "zh",
    getRuntimeCardContext: () => ({
      sessionName: "Session Alpha",
      projectName: "Project One"
    }),
    buildRuntimeStatusLine: () => [],
    runtimeTraceSink: {
      logRuntimeCardEvent: async (_activeTurn, _surface, event) => {
        traceEvents.push(event);
      }
    },
    backfillSubagentIdentities: async (activeTurn, agentEntries) =>
      await (options.backfillSubagentIdentities?.(activeTurn, agentEntries) ?? Promise.resolve(false)),
    refreshActiveRuntimeStatusCard: async (_chatId, reason) => {
      refreshReasons.push(reason);
    }
  });

  return {
    controller,
    store,
    sentHtml,
    editedHtml,
    callbackAnswers,
    refreshReasons,
    deletedMessages,
    traceEvents,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("RuntimeSurfaceController saves runtime preferences and refreshes the active card", async () => {
  const { controller, store, sentHtml, editedHtml, callbackAnswers, refreshReasons, cleanup } =
    await createControllerContext();

  try {
    await controller.handleRuntime("chat-1");

    const token = getOnlyDraftToken(controller);
    const messageId = sentHtml[0]?.messageId ?? 0;

    await controller.handleRuntimePreferencesToggleCallback(
      "runtime-toggle",
      "chat-1",
      messageId,
      token,
      "model-name"
    );
    await controller.handleRuntimePreferencesSaveCallback("runtime-save", "chat-1", messageId, token);

    assert.deepEqual(store.getRuntimeCardPreferences().fields, ["model-name"]);
    assert.equal(callbackAnswers.at(-1), "已保存。");
    assert.deepEqual(refreshReasons, ["runtime_preferences_saved"]);
    assert.match(editedHtml.at(-1)?.html ?? "", /模型名/u);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController runtime preference callbacks expire after save closes the draft", async () => {
  const { controller, sentHtml, callbackAnswers, cleanup } = await createControllerContext();

  try {
    await controller.handleRuntime("chat-1");

    const token = getOnlyDraftToken(controller);
    const messageId = sentHtml[0]?.messageId ?? 0;

    await controller.handleRuntimePreferencesToggleCallback(
      "runtime-toggle",
      "chat-1",
      messageId,
      token,
      "model-name"
    );
    await controller.handleRuntimePreferencesSaveCallback("runtime-save", "chat-1", messageId, token);
    await controller.handleRuntimePreferencesToggleCallback(
      "runtime-toggle-expired",
      "chat-1",
      messageId,
      token,
      "current-dir"
    );

    assert.equal(callbackAnswers.at(-1), "这个按钮已过期，请重新发送 /runtime。");
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController retries failed edits on the same status message instead of sending a replacement", async () => {
  let firstEdit = true;
  const { controller, editedHtml, sentHtml, cleanup } = await createControllerContext({
    safeEditHtmlMessageText: async () => {
      if (firstEdit) {
        firstEdit = false;
        return { outcome: "failed" };
      }
      return { outcome: "edited" };
    }
  });

  try {
    const inspect = createInspectSnapshot();
    const activeTurn = {
      sessionId: "session-1",
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(200),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    };

    await controller.requestRuntimeCardRender(
      activeTurn as never,
      activeTurn.statusCard as never,
      "<b>运行状态</b>\n<b>状态</b> · Running",
      undefined,
      { reason: "turn_started" }
    );

    assert.equal(sentHtml.length, 0);
    assert.equal(editedHtml.length, 1);
    assert.equal(editedHtml[0]?.messageId, 200);
    assert.match(activeTurn.statusCard.pendingText ?? "", /Running/u);

    await controller.flushRuntimeCardRender(activeTurn as never, activeTurn.statusCard as never);

    assert.equal(sentHtml.length, 0);
    assert.equal(editedHtml.length, 2);
    assert.equal(editedHtml[1]?.messageId, 200);
    assert.match(activeTurn.statusCard.lastRenderedText, /Running/u);
    controller.clearRuntimeCardTimer(activeTurn.statusCard as never);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController reanchors the status card after blocked work resumes active", async () => {
  const activeTurns: unknown[] = [];
  const { controller, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    initialSentMessageId: 1001
  });

  try {
    const inspect = createInspectSnapshot();
    const activeTurn = {
      sessionId: "session-1",
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => createActivityStatus()
      },
      statusCard: {
        ...createStatusCard(1000),
        needsReanchorOnActive: true
      },
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    };
    activeTurns.push(activeTurn);

    await controller.syncRuntimeCards(
      activeTurn as never,
      null,
      createActivityStatus({ turnStatus: "blocked" }),
      createActivityStatus({ turnStatus: "running" }),
      { reason: "thread_status_changed" }
    );

    assert.equal(sentHtml.length, 1);
    assert.equal(activeTurn.statusCard.messageId, sentHtml[0]?.messageId);
    assert.deepEqual(deletedMessages, [1000]);
    assert.equal(activeTurn.statusCard.needsReanchorOnActive, false);
  } finally {
    await cleanup();
  }
});
