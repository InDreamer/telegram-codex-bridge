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
import type { TelegramDeleteResult, TelegramEditResult } from "./runtime-surface-state.js";
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
  ) => Promise<TelegramEditResult>;
  safeDeleteMessage?: (chatId: string, messageId: number) => Promise<TelegramDeleteResult>;
  backfillSubagentIdentities?: (activeTurn: unknown, agentEntries: unknown[]) => Promise<boolean>;
  listActiveTurns?: () => unknown[];
  initialSentMessageId?: number;
  getUiLanguage?: () => "zh" | "en";
  buildRuntimeStatusLine?: (sessionId: string, inspect: InspectSnapshot) => string[];
  buildPendingInteractionSummaries?: (activeSession: { sessionId: string }) => Array<{ id: string }>;
  handleRecoveryHubVisible?: (chatId: string) => void;
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
    buildPendingInteractionSummaries: (activeSession) => options.buildPendingInteractionSummaries?.(activeSession as never) as never[] ?? [],
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
      if (options.safeDeleteMessage) {
        return await options.safeDeleteMessage(_chatId, messageId);
      }
      deletedMessages.push(messageId);
      return { outcome: "deleted" };
    },
    safeAnswerCallbackQuery: async (_callbackQueryId, text) => {
      callbackAnswers.push(text);
    },
    getUiLanguage: () => options.getUiLanguage?.() ?? "zh",
    getRuntimeCardContext: () => ({
      sessionName: "Session Alpha",
      projectName: "Project One"
    }),
    buildRuntimeStatusLine: (sessionId, inspect) => options.buildRuntimeStatusLine?.(sessionId, inspect) ?? [],
    runtimeTraceSink: {
      logRuntimeCardEvent: async (_activeTurn, _surface, event) => {
        traceEvents.push(event);
      }
    },
    backfillSubagentIdentities: async (activeTurn, agentEntries) =>
      await (options.backfillSubagentIdentities?.(activeTurn, agentEntries) ?? Promise.resolve(false)),
    handleRecoveryHubVisible: (chatId) => {
      options.handleRecoveryHubVisible?.(chatId);
    },
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

test("RuntimeSurfaceController falls back to a fresh summary when runtime preference save cannot edit the panel", async () => {
  let editCount = 0;
  const { controller, store, sentHtml, editedHtml, callbackAnswers, refreshReasons, cleanup } =
    await createControllerContext({
      safeEditHtmlMessageText: async () => {
        editCount += 1;
        if (editCount < 2) {
          return { outcome: "edited" };
        }
        return { outcome: "failed" };
      }
    });

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
    assert.equal(editedHtml.at(-1)?.messageId, messageId);
    assert.equal(sentHtml.length, 2);
    assert.match(sentHtml.at(-1)?.html ?? "", /模型名/u);
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

test("RuntimeSurfaceController keeps hub focus stable while background sessions update", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const sessionOne = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const sessionTwo = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });
    store.setActiveSession("chat-1", sessionOne.sessionId);

    activeTurns.push(
      {
        sessionId: sessionOne.sessionId,
        chatId: "chat-1",
        threadId: "thread-1",
        turnId: "turn-1",
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot(),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      },
      {
        sessionId: sessionTwo.sessionId,
        chatId: "chat-1",
        threadId: "thread-2",
        turnId: "turn-2",
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot(),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      }
    );

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", sessionOne.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { liveHubs: Map<number, { focusedSessionId: string | null; callbackVersion: number }> }>;
    }).runtimeHubStates;
    const hubState = runtimeHubStates.get("chat-1")?.liveHubs.get(0);
    assert.ok(hubState);
    assert.equal(hubState.focusedSessionId, sessionOne.sessionId);
    const initialCallbackVersion = hubState.callbackVersion;
    assert.equal(sentHtml.length, 1);

    await controller.refreshLiveRuntimeHubs("chat-1", "runtime_progress", sessionTwo.sessionId);

    assert.equal(hubState.focusedSessionId, sessionOne.sessionId);
    assert.equal(hubState.callbackVersion, initialCallbackVersion);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController commits hub focus changes when Telegram reports the edit as unchanged", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, editedHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    safeEditHtmlMessageText: async () => ({ outcome: "unchanged" })
  });

  try {
    const sessionOne = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const sessionTwo = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });
    store.setActiveSession("chat-1", sessionOne.sessionId);

    activeTurns.push(
      {
        sessionId: sessionOne.sessionId,
        chatId: "chat-1",
        threadId: "thread-1",
        turnId: "turn-1",
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot(),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      },
      {
        sessionId: sessionTwo.sessionId,
        chatId: "chat-1",
        threadId: "thread-2",
        turnId: "turn-2",
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot(),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      }
    );

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", sessionOne.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, {
        liveHubs: Map<number, {
          token: string;
          messageId: number;
          callbackVersion: number;
          focusedSessionId: string | null;
          visibleState: { focusedSessionId: string | null; callbackVersion: number };
        }>;
      }>;
    }).runtimeHubStates;
    const hubState = runtimeHubStates.get("chat-1")?.liveHubs.get(0);
    assert.ok(hubState);

    await controller.handleHubSelectCallback(
      "callback-hub-select",
      "chat-1",
      hubState!.messageId,
      hubState!.token,
      hubState!.visibleState.callbackVersion,
      1
    );

    const committedHubState = runtimeHubStates.get("chat-1")?.liveHubs.get(0);
    assert.equal(sentHtml.length, 1);
    assert.equal(editedHtml.length, 1);
    assert.equal(deletedMessages.length, 0);
    assert.equal(committedHubState?.messageId, sentHtml[0]?.messageId ?? 0);
    assert.equal(committedHubState?.visibleState.focusedSessionId, sessionTwo.sessionId);
    assert.equal((committedHubState?.visibleState.callbackVersion ?? 0) > 0, true);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController serializes refresh and reanchor hub operations to the latest state", async () => {
  const activeTurns: unknown[] = [];
  let inspect = createInspectSnapshot({ completedCommentary: ["initial progress"] });
  let resolveEdit!: () => void;
  let editStarted = false;
  let firstEditPending = true;
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    safeEditHtmlMessageText: async () => {
      if (!firstEditPending) {
        return { outcome: "edited" };
      }

      firstEditPending = false;
      editStarted = true;
      await new Promise<void>((resolve) => {
        resolveEdit = resolve;
      });
      return { outcome: "edited" };
    }
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);

    activeTurns.push({
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const firstMessageId = sentHtml[0]?.messageId ?? 0;
    assert.ok(firstMessageId > 0);

    inspect = createInspectSnapshot({ completedCommentary: ["first queued update"] });
    const refreshPromise = controller.refreshLiveRuntimeHubs("chat-1", "runtime_progress", session.sessionId);

    while (!editStarted) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    inspect = createInspectSnapshot({ completedCommentary: ["latest queued update"] });
    const reanchorPromise = controller.reanchorRuntimeAfterBridgeReply(null, "chat-1", "language_changed", session.sessionId);

    resolveEdit();
    await Promise.all([refreshPromise, reanchorPromise]);

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, {
        liveHubs: Map<number, {
          messageId: number;
          lastRenderedText: string;
        }>;
      }>;
    }).runtimeHubStates;
    const hubState = runtimeHubStates.get("chat-1")?.liveHubs.get(0);
    assert.ok(hubState);
    assert.equal(sentHtml.length, 2);
    assert.equal(hubState?.messageId, sentHtml[1]?.messageId ?? 0);
    assert.equal(deletedMessages.at(-1), firstMessageId);
    assert.match(sentHtml[1]?.html ?? "", /latest queued update/u);
    assert.match(hubState?.lastRenderedText ?? "", /latest queued update/u);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController treats delete not found as terminal retained cleanup", async () => {
  const activeTurns: unknown[] = [];
  const deleteAttempts: number[] = [];
  const { controller, store, sentHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    safeDeleteMessage: async (_chatId, messageId) => {
      deleteAttempts.push(messageId);
      return { outcome: "not_found" };
    }
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);

    activeTurns.push({
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => createInspectSnapshot(),
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const messageId = sentHtml[0]?.messageId ?? 0;
    activeTurns.length = 0;
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, session.sessionId);

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { retainedMessages: Array<{ messageId: number }> }>;
    }).runtimeHubStates;
    const chatState = runtimeHubStates.get("chat-1");
    assert.deepEqual(deleteAttempts, [messageId]);
    assert.deepEqual(chatState?.retainedMessages ?? [], []);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController keeps the last completed hub visible until terminal handoff completes", async () => {
  const activeTurns: Array<{
    sessionId: string;
    chatId: string;
    threadId: string;
    turnId: string;
    tracker: {
      getInspectSnapshot: () => InspectSnapshot;
      getStatus: () => ActivityStatus;
    };
    statusCard: ReturnType<typeof createStatusCard>;
    latestStatusProgressText: null;
    latestPlanFingerprint: string;
    latestAgentFingerprint: string;
    subagentIdentityBackfillStates: Map<string, "pending" | "resolved" | "exhausted">;
    errorCards: never[];
    nextErrorCardId: number;
    surfaceQueue: Promise<void>;
  }> = [];
  let inspect = createInspectSnapshot({ completedCommentary: ["running progress"] });
  let status = createActivityStatus();
  const { controller, store, sentHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);

    const activeTurn = {
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => status
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    };
    activeTurns.push(activeTurn);

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const initialMessageId = sentHtml[0]?.messageId ?? 0;
    assert.ok(initialMessageId > 0);

    inspect = createInspectSnapshot({
      turnStatus: "completed",
      completedCommentary: ["completed progress"]
    });
    status = createActivityStatus({ turnStatus: "completed", finalMessageAvailable: true });
    await controller.syncRuntimeCards(activeTurn as never, { kind: "turn_completed", status: "completed" } as never, createActivityStatus(), status, {
      force: true,
      reason: "turn_completed"
    });

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { liveHubs: Map<number, { messageId: number }> }>;
    }).runtimeHubStates;
    assert.equal(runtimeHubStates.get("chat-1")?.liveHubs.get(0)?.messageId, initialMessageId);

    activeTurns.length = 0;
    await controller.completeTerminalRuntimeHandoff("chat-1", session.sessionId);
    assert.equal(runtimeHubStates.get("chat-1")?.liveHubs.size ?? 0, 0);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController hub header shows the total running session count", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const sessionOne = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const sessionTwo = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });
    store.setActiveSession("chat-1", sessionOne.sessionId);

    activeTurns.push(
      {
        sessionId: sessionOne.sessionId,
        chatId: "chat-1",
        threadId: "thread-1",
        turnId: "turn-1",
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot(),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      },
      {
        sessionId: sessionTwo.sessionId,
        chatId: "chat-1",
        threadId: "thread-2",
        turnId: "turn-2",
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot(),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      }
    );

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", sessionOne.sessionId, undefined, {
      forcePreferredFocus: true
    });

    assert.match(sentHtml[0]?.html ?? "", /<b>Hub：<\/b> 1\/1 · 2 个会话/u);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController reuses a retained hub message when deletion fails", async () => {
  const activeTurns: unknown[] = [];
  const deleteAttempts: number[] = [];
  const { controller, store, sentHtml, editedHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    safeDeleteMessage: async (_chatId, messageId) => {
      deleteAttempts.push(messageId);
      return { outcome: "failed" };
    }
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);

    activeTurns.push({
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => createInspectSnapshot(),
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const messageId = sentHtml[0]?.messageId ?? 0;
    activeTurns.length = 0;

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, session.sessionId);

    assert.deepEqual(deleteAttempts, [messageId]);
    assert.equal(editedHtml.length, 0);

    const nextSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });
    store.setActiveSession("chat-1", nextSession.sessionId);

    activeTurns.push({
      sessionId: nextSession.sessionId,
      chatId: "chat-1",
      threadId: "thread-2",
      turnId: "turn-2",
      tracker: {
        getInspectSnapshot: () => createInspectSnapshot(),
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", nextSession.sessionId, undefined, {
      forcePreferredFocus: true
    });

    assert.equal(sentHtml.length, 1);
    assert.equal(editedHtml.length, 1);
    assert.equal(editedHtml[0]?.messageId, messageId);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController retains the superseded hub when fallback resend cannot delete it", async () => {
  const activeTurns: unknown[] = [];
  const deleteAttempts: number[] = [];
  let inspect = createInspectSnapshot();
  const { controller, store, sentHtml, editedHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    safeEditHtmlMessageText: async () => ({ outcome: "failed" }),
    safeDeleteMessage: async (_chatId, messageId) => {
      deleteAttempts.push(messageId);
      return { outcome: "failed" };
    }
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);

    activeTurns.push({
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const originalMessageId = sentHtml[0]?.messageId ?? 0;
    inspect = createInspectSnapshot({
      completedCommentary: ["updated progress"]
    });
    await controller.refreshLiveRuntimeHubs("chat-1", "test_refresh", session.sessionId);

    const replacementMessageId = sentHtml[1]?.messageId ?? 0;
    assert.ok(originalMessageId > 0);
    assert.ok(replacementMessageId > 0);
    assert.notEqual(replacementMessageId, originalMessageId);
    assert.equal(editedHtml.length, 1);
    assert.deepEqual(deleteAttempts, [originalMessageId]);

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, {
        liveHubs: Map<number, { messageId: number }>;
        retainedMessages: Array<{ messageId: number }>;
      }>;
    }).runtimeHubStates;
    const chatState = runtimeHubStates.get("chat-1");
    assert.ok(chatState);
    assert.equal(chatState?.liveHubs.get(0)?.messageId, replacementMessageId);
    assert.deepEqual(chatState?.retainedMessages.map((entry) => entry.messageId), [originalMessageId]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController excludes terminal sessions from the hub session count", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, editedHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const sessionOne = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const sessionTwo = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });
    store.setActiveSession("chat-1", sessionTwo.sessionId);

    activeTurns.push(
      {
        sessionId: sessionOne.sessionId,
        chatId: "chat-1",
        threadId: "thread-1",
        turnId: "turn-1",
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot(),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      },
      {
        sessionId: sessionTwo.sessionId,
        chatId: "chat-1",
        threadId: "thread-2",
        turnId: "turn-2",
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot(),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      }
    );

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", sessionTwo.sessionId, undefined, {
      forcePreferredFocus: true
    });
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, sessionOne.sessionId);

    assert.match(sentHtml[0]?.html ?? "", /<b>Hub：<\/b> 1\/1 · 2 个会话/u);
    assert.match(editedHtml.at(-1)?.html ?? "", /<b>Hub：<\/b> 1\/1 · 1 个会话/u);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController reanchors and localizes the recovery hub after bridge replies", async () => {
  const activeTurns: unknown[] = [];
  let language: "zh" | "en" = "zh";
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    getUiLanguage: () => language
  });

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-1",
      telegramChatId: "chat-1",
      telegramUsername: "tester",
      displayName: "Tester"
    });
    const candidate = store.listPendingAuthorizations()[0];
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const sessionOne = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const sessionTwo = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two"
    });
    store.setActiveSession("chat-1", sessionOne.sessionId);
    store.updateSessionStatus(sessionOne.sessionId, "failed", { failureReason: "bridge_restart" });
    store.updateSessionStatus(sessionTwo.sessionId, "failed", { failureReason: "bridge_restart" });

    const delivered = await controller.sendRecoveryHub("chat-1", [sessionOne.sessionId, sessionTwo.sessionId]);
    assert.equal(delivered, true);
    assert.match(sentHtml[0]?.html ?? "", /恢复后会话/u);

    language = "en";
    store.setActiveSession("chat-1", sessionTwo.sessionId);
    await controller.reanchorRuntimeAfterBridgeReply(null, "chat-1", "language_changed");

    assert.equal(sentHtml.length, 2);
    assert.match(sentHtml[1]?.html ?? "", /Recovered Session/u);
    assert.match(sentHtml[1]?.html ?? "", /Input target:/u);
    assert.match(sentHtml[1]?.html ?? "", /current input/u);
    assert.deepEqual(deletedMessages, [sentHtml[0]?.messageId ?? 0]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController retries recovery hub delivery after a transient send failure", async () => {
  let failSend = true;
  const recoveryHubVisibleChats: string[] = [];
  const { controller, store, cleanup } = await createControllerContext({
    safeSendHtmlMessageResult: async (_chatId, html) => {
      if (failSend) {
        return null;
      }

      return createFakeTelegramMessage(1700, html);
    },
    handleRecoveryHubVisible: (chatId) => {
      recoveryHubVisibleChats.push(chatId);
    }
  });

  try {
    store.upsertPendingAuthorization({
      telegramUserId: "user-1",
      telegramChatId: "chat-1",
      telegramUsername: "tester",
      displayName: "Tester"
    });
    const candidate = store.listPendingAuthorizations()[0];
    assert.ok(candidate);
    store.confirmPendingAuthorization(candidate);

    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);
    store.updateSessionStatus(session.sessionId, "failed", { failureReason: "bridge_restart" });

    const delivered = await controller.sendRecoveryHub("chat-1", [session.sessionId]);
    assert.equal(delivered, false);

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, {
        recoveryHub: {
          messageId: number;
          pendingText: string | null;
          timer: ReturnType<typeof setTimeout> | null;
        } | null;
      }>;
    }).runtimeHubStates;
    const recoveryHub = runtimeHubStates.get("chat-1")?.recoveryHub;
    assert.ok(recoveryHub);
    assert.equal(recoveryHub?.messageId, 0);
    assert.ok(recoveryHub?.pendingText);
    assert.notEqual(recoveryHub?.timer, null);
    assert.deepEqual(recoveryHubVisibleChats, []);

    failSend = false;
    await (controller as any).flushHubRender(recoveryHub);
    assert.equal(recoveryHub?.messageId, 1700);
    assert.deepEqual(recoveryHubVisibleChats, ["chat-1"]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController does not reanchor another session past pending interaction controls", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    buildPendingInteractionSummaries: (session) => session.sessionId === blockedSessionId
      ? [{ id: "pending-1" }]
      : []
  });
  let blockedSessionId = "";

  try {
    const blockedSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Blocked Project",
      projectPath: "/tmp/project-blocked"
    });
    const finishedSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Finished Project",
      projectPath: "/tmp/project-finished"
    });
    blockedSessionId = blockedSession.sessionId;
    store.setActiveSession("chat-1", blockedSession.sessionId);

    activeTurns.push({
      sessionId: blockedSession.sessionId,
      chatId: "chat-1",
      threadId: "thread-blocked",
      turnId: "turn-blocked",
      tracker: {
        getInspectSnapshot: () => createInspectSnapshot(),
        getStatus: () => createActivityStatus({
          turnStatus: "blocked",
          threadBlockedReason: "waitingOnApproval"
        })
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", blockedSession.sessionId, undefined, {
      forcePreferredFocus: true
    });

    assert.equal(sentHtml.length, 1);
    await controller.reanchorRuntimeAfterBridgeReply(null, "chat-1", "final_answer_sent", finishedSession.sessionId);

    assert.equal(sentHtml.length, 1);
    assert.deepEqual(deletedMessages, []);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController reanchors the main hub for a finished background session", async () => {
  const activeTurns: Array<{
    sessionId: string;
    chatId: string;
    threadId: string;
    turnId: string;
    tracker: {
      getInspectSnapshot: () => InspectSnapshot;
      getStatus: () => ActivityStatus;
    };
    statusCard: ReturnType<typeof createStatusCard>;
    latestStatusProgressText: null;
    latestPlanFingerprint: string;
    latestAgentFingerprint: string;
    subagentIdentityBackfillStates: Map<string, "pending" | "resolved" | "exhausted">;
    errorCards: never[];
    nextErrorCardId: number;
    surfaceQueue: Promise<void>;
  }> = [];
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const sessions = await Promise.all(
      Array.from({ length: 7 }, (_, index) => store.createSession({
        telegramChatId: "chat-1",
        projectName: `Project ${index + 1}`,
        projectPath: `/tmp/project-${index + 1}`
      }))
    );
    const activeInputSession = sessions[5];
    const finishedBackgroundSession = sessions[6];
    assert.ok(activeInputSession);
    assert.ok(finishedBackgroundSession);
    store.setActiveSession("chat-1", activeInputSession.sessionId);

    for (const [index, session] of sessions.entries()) {
      activeTurns.push({
        sessionId: session.sessionId,
        chatId: "chat-1",
        threadId: `thread-${index + 1}`,
        turnId: `turn-${index + 1}`,
        tracker: {
          getInspectSnapshot: () => createInspectSnapshot({
            completedCommentary: [`progress ${index + 1}`]
          }),
          getStatus: () => createActivityStatus()
        },
        statusCard: createStatusCard(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
        subagentIdentityBackfillStates: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      });
    }

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", activeInputSession.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const mainHubMessageId = sentHtml[0]?.messageId ?? 0;
    const secondaryHubMessageId = sentHtml[1]?.messageId ?? 0;
    assert.ok(mainHubMessageId > 0);
    assert.ok(secondaryHubMessageId > 0);

    const finishedIndex = activeTurns.findIndex((turn) => turn.sessionId === finishedBackgroundSession.sessionId);
    assert.ok(finishedIndex >= 0);
    activeTurns.splice(finishedIndex, 1);

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, finishedBackgroundSession.sessionId);
    await controller.reanchorRuntimeAfterBridgeReply(null, "chat-1", "final_answer_sent", finishedBackgroundSession.sessionId);

    assert.equal(sentHtml.length, 3);
    assert.equal(sentHtml[2]?.messageId, 1002);
    assert.equal(deletedMessages.at(-1), mainHubMessageId);
    assert.notEqual(deletedMessages.at(-1), secondaryHubMessageId);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController keeps the visible expanded hub actionable when compact fallback delivery fails", async () => {
  const activeTurns: unknown[] = [];
  let inspect = createInspectSnapshot({
    planSnapshot: ["Ship the small patch."]
  });
  let failHubEdit = false;
  let failFreshSend = false;
  let nextMessageId = 2000;
  const sendCalls: Array<{ messageId: number; html: string }> = [];
  const editCalls: Array<{ messageId: number; html: string }> = [];
  const { controller, store, callbackAnswers, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    safeSendHtmlMessageResult: async (_chatId, html) => {
      if (failFreshSend) {
        return null;
      }

      const messageId = nextMessageId++;
      sendCalls.push({ messageId, html });
      return createFakeTelegramMessage(messageId, html);
    },
    safeEditHtmlMessageText: async (_chatId, messageId, html) => {
      editCalls.push({ messageId, html });
      if (failHubEdit) {
        return { outcome: "failed" };
      }
      return { outcome: "edited" };
    }
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);

    activeTurns.push({
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const visibleMessageId = sendCalls[0]?.messageId ?? 0;
    assert.ok(visibleMessageId > 0);

    await controller.handleStatusCardSectionToggle(
      "plan-expand",
      "chat-1",
      visibleMessageId,
      session.sessionId,
      true,
      "plan"
    );

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, {
        liveHubs: Map<number, {
          messageId: number;
          planExpanded: boolean;
          visibleState: { planExpanded: boolean };
        }>;
      }>;
    }).runtimeHubStates;
    const hubState = runtimeHubStates.get("chat-1")?.liveHubs.get(0);
    assert.ok(hubState);
    assert.equal(hubState?.messageId, visibleMessageId);
    assert.equal(hubState?.planExpanded, true);
    assert.equal(hubState?.visibleState.planExpanded, true);

    inspect = createInspectSnapshot({
      planSnapshot: Array.from({ length: 14 }, (_, index) => `${index + 1}. ${"x".repeat(260)}`)
    });
    failHubEdit = true;
    failFreshSend = true;
    await controller.refreshLiveRuntimeHubs("chat-1", "runtime_progress", session.sessionId);

    assert.equal(hubState?.messageId, visibleMessageId);
    assert.equal(hubState?.planExpanded, true);
    assert.equal(hubState?.visibleState.planExpanded, true);

    failHubEdit = false;
    failFreshSend = false;
    await controller.handleStatusCardSectionToggle(
      "plan-collapse",
      "chat-1",
      visibleMessageId,
      session.sessionId,
      false,
      "plan"
    );

    assert.equal(callbackAnswers.at(-1), undefined);
    assert.equal(hubState?.planExpanded, false);
    assert.equal(hubState?.visibleState.planExpanded, false);
    assert.equal(sendCalls.length, 1);
    assert.ok(editCalls.length >= 2);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController marks hidden plan sections as collapsed in compact hub renders", async () => {
  const activeTurns: unknown[] = [];
  let inspect = createInspectSnapshot({
    planSnapshot: ["Ship the small patch."]
  });
  let nextMessageId = 2100;
  const sendCalls: Array<{ messageId: number; html: string; replyMarkup?: TelegramInlineKeyboardMarkup }> = [];
  const editCalls: Array<{ messageId: number; html: string; replyMarkup?: TelegramInlineKeyboardMarkup }> = [];
  const { controller, store, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    buildRuntimeStatusLine: () => Array.from({ length: 20 }, (_, index) => `Field ${index + 1}: ${"w".repeat(400)}`),
    safeSendHtmlMessageResult: async (_chatId, html, replyMarkup) => {
      const messageId = nextMessageId++;
      sendCalls.push(replyMarkup ? { messageId, html, replyMarkup } : { messageId, html });
      return createFakeTelegramMessage(messageId, html);
    },
    safeEditHtmlMessageText: async (_chatId, messageId, html, replyMarkup) => {
      editCalls.push(replyMarkup ? { messageId, html, replyMarkup } : { messageId, html });
      return { outcome: "edited" };
    }
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);

    activeTurns.push({
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const visibleMessageId = sendCalls[0]?.messageId ?? 0;
    assert.ok(visibleMessageId > 0);

    await controller.handleStatusCardSectionToggle(
      "plan-expand",
      "chat-1",
      visibleMessageId,
      session.sessionId,
      true,
      "plan"
    );

    inspect = createInspectSnapshot({
      planSnapshot: Array.from({ length: 14 }, (_, index) => `${index + 1}. ${"x".repeat(260)}`),
      completedCommentary: ["y".repeat(1200)]
    });
    const editCountBeforeRefresh = editCalls.length;
    await controller.refreshLiveRuntimeHubs("chat-1", "test_compact_render", session.sessionId);

    const compactEdit = editCalls[editCountBeforeRefresh];
    assert.ok(compactEdit);
    assert.match(compactEdit?.html ?? "", /<b>运行状态<\/b>/u);
    assert.equal(compactEdit?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "计划清单：1. xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…");
    assert.match(compactEdit?.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data ?? "", /plan:expand/u);

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, {
        liveHubs: Map<number, {
          planExpanded: boolean;
          visibleState: { planExpanded: boolean };
        }>;
      }>;
    }).runtimeHubStates;
    const hubState = runtimeHubStates.get("chat-1")?.liveHubs.get(0);
    assert.ok(hubState);
    assert.equal(hubState?.planExpanded, false);
    assert.equal(hubState?.visibleState.planExpanded, false);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController does not leave retry timers on disposed hubs", async () => {
  const activeTurns: unknown[] = [];
  let inspect = createInspectSnapshot();
  let resolveEdit!: (result: { outcome: "failed" }) => void;
  let signalEditStarted!: () => void;
  const editStartedPromise: Promise<void> = new Promise((resolve) => {
    signalEditStarted = resolve;
  });
  const editResultPromise: Promise<{ outcome: "failed" }> = new Promise((resolve) => {
    resolveEdit = resolve;
  });

  const { controller, store, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    safeEditHtmlMessageText: async () => {
      signalEditStarted();
      return await editResultPromise;
    }
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);

    activeTurns.push({
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    });

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { liveHubs: Map<number, { destroyed: boolean; timer: ReturnType<typeof setTimeout> | null }> }>;
    }).runtimeHubStates;
    const hubState = runtimeHubStates.get("chat-1")?.liveHubs.get(0);
    assert.ok(hubState);

    inspect = createInspectSnapshot({
      completedCommentary: ["updated progress"]
    });
    const refreshPromise = controller.refreshLiveRuntimeHubs("chat-1", "runtime_progress", session.sessionId);
    await editStartedPromise;

    activeTurns.length = 0;
    const terminalPromise = controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, session.sessionId);
    resolveEdit({ outcome: "failed" });
    await Promise.all([refreshPromise, terminalPromise]);

    assert.equal(hubState.destroyed, true);
    assert.equal(hubState.timer, null);
  } finally {
    await cleanup();
  }
});
