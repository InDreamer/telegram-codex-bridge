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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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

test("RuntimeSurfaceController manual hub refresh resurfaces the live hub to the bottom", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
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
    };
    activeTurns.push(activeTurn);

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    assert.equal(sentHtml.length, 1);
    await (controller as any).handleHub("chat-1");

    assert.equal(sentHtml.length, 2);
    assert.match(sentHtml[1]?.html ?? "", /^<b>Runtime Status<\/b>|^<b>运行状态<\/b>/u);
    assert.deepEqual(deletedMessages, [sentHtml[0]!.messageId]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController manual hub refresh refuses while actionable interaction cards are pending", async () => {
  const activeTurns: unknown[] = [];
  let blockedSessionId = "";
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns,
    buildPendingInteractionSummaries: (session) => session.sessionId === blockedSessionId
      ? [{ id: "pending-1" }]
      : []
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    blockedSessionId = session.sessionId;
    store.setActiveSession("chat-1", session.sessionId);
    activeTurns.push({
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
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

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
      forcePreferredFocus: true
    });

    assert.equal(sentHtml.length, 1);
    const result = await (controller as any).handleHub("chat-1");
    assert.equal(result.kind, "interaction_pending");
    assert.equal(sentHtml.length, 1);
    assert.deepEqual(deletedMessages, []);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController manual hub refresh reports when no sessions are running", async () => {
  const { controller, cleanup } = await createControllerContext();

  try {
    const result = await (controller as any).handleHub("chat-1");
    assert.equal(result.kind, "no_running");
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController delays the start auto-refresh until work is still running", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);
    const inspect = createInspectSnapshot();
    const activeTurn = {
      sessionId: session.sessionId,
      chatId: "chat-1",
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => inspect,
        getStatus: () => createActivityStatus()
      },
      statusCard: createStatusCard(1000),
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
      null,
      createActivityStatus({ turnStatus: "running" }),
      { reason: "turn_initialized" }
    );

    assert.equal(sentHtml.length, 0);
    await sleep(900);
    assert.equal(sentHtml.length, 0);

    await sleep(700);
    assert.equal(sentHtml.length, 1);
    assert.equal(activeTurn.statusCard.messageId, sentHtml[0]?.messageId);
    assert.ok(deletedMessages.length <= 1);

    await controller.syncRuntimeCards(
      activeTurn as never,
      null,
      createActivityStatus({ turnStatus: "running" }),
      createActivityStatus({ turnStatus: "running", latestProgress: "Still running" }),
      { reason: "thread_status_changed" }
    );
    await sleep(1700);
    assert.equal(sentHtml.length, 1);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController delays recovery hub refresh after blocked work resumes active", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const session = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    store.setActiveSession("chat-1", session.sessionId);
    const inspect = createInspectSnapshot();
    const activeTurn = {
      sessionId: session.sessionId,
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

    assert.equal(sentHtml.length, 0);
    await sleep(900);
    assert.equal(sentHtml.length, 0);

    await sleep(400);
    assert.equal(sentHtml.length, 1);
    assert.equal(activeTurn.statusCard.messageId, sentHtml[0]?.messageId);
    assert.ok(deletedMessages.length <= 1);
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

test("RuntimeSurfaceController keeps a newly created idle session out of the live hub until it starts running", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
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

    const runningSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Running",
      projectPath: "/tmp/project-running"
    });
    const idleSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Idle",
      projectPath: "/tmp/project-idle"
    });
    store.setActiveSession("chat-1", idleSession.sessionId);

    activeTurns.push({
      sessionId: runningSession.sessionId,
      chatId: "chat-1",
      threadId: "thread-running",
      turnId: "turn-running",
      tracker: {
        getInspectSnapshot: () => createInspectSnapshot({
          completedCommentary: ["Running focused runtime checks."]
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

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", runningSession.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const html = sentHtml[0]?.html ?? "";
    const replyMarkup = sentHtml[0]?.replyMarkup as TelegramInlineKeyboardMarkup | undefined;
    assert.doesNotMatch(html, /<b>当前输入会话<\/b>/u);
    assert.doesNotMatch(html, /<b>当前查看中的会话<\/b>/u);
    assert.match(html, /<b>其他运行中的会话<\/b>/u);
    assert.match(html, /1\. <b>Session Alpha<\/b> \/ Project One · Running/u);
    assert.deepEqual(replyMarkup?.inline_keyboard[0]?.map((button) => button.text), ["1", "·", "·", "·", "·"]);
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
      2
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

test("RuntimeSurfaceController rejects archived sessions when selecting a retained hub slot", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, callbackAnswers, editedHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
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

    activeTurns.length = 0;
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, session.sessionId);
    store.archiveSession(session.sessionId);

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, {
        liveHubs: Map<number, {
          token: string;
          messageId: number;
          visibleState: { callbackVersion: number };
        }>;
      }>;
    }).runtimeHubStates;
    const hubState = runtimeHubStates.get("chat-1")?.liveHubs.get(0);
    assert.ok(hubState);
    const editCountBeforeSelect = editedHtml.length;

    await controller.handleHubSelectCallback(
      "callback-hub-select",
      "chat-1",
      hubState!.messageId,
      hubState!.token,
      hubState!.visibleState.callbackVersion,
      1
    );

    assert.equal(callbackAnswers.at(-1), "这个按钮已过期，请重新操作。");
    assert.equal(store.getActiveSession("chat-1"), null);
    assert.equal(editedHtml.length, editCountBeforeSelect);
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

test("RuntimeSurfaceController retains a completed hub instead of deleting its message", async () => {
  const activeTurns: unknown[] = [];
  const deleteAttempts: number[] = [];
  const { controller, store, sentHtml, editedHtml, cleanup } = await createControllerContext({
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

    activeTurns.length = 0;
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, session.sessionId);

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { liveHubs: Map<number, { messageId: number }>; retainedMessages: Array<{ messageId: number }> }>;
    }).runtimeHubStates;
    const chatState = runtimeHubStates.get("chat-1");
    assert.deepEqual(deleteAttempts, []);
    assert.equal(chatState?.liveHubs.size, 1);
    assert.deepEqual(chatState?.retainedMessages ?? [], []);
    assert.match(editedHtml.at(-1)?.html ?? sentHtml[0]?.html ?? "", /<b>Hub：<\/b> 1\/1 · 已完成/u);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController keeps the completed hub visible after terminal handoff completes", async () => {
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
  const { controller, store, sentHtml, editedHtml, cleanup } = await createControllerContext({
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
    assert.equal(runtimeHubStates.get("chat-1")?.liveHubs.size ?? 0, 1);
    assert.equal(runtimeHubStates.get("chat-1")?.liveHubs.get(0)?.messageId, initialMessageId);
    assert.match(editedHtml.at(-1)?.html ?? sentHtml.at(-1)?.html ?? "", /<b>Hub：<\/b> 1\/1 · 已完成/u);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController renders slot-based hub headers and selector buttons", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
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

    assert.match(sentHtml[0]?.html ?? "", /<b>Hub：<\/b> 1\/1/u);
    assert.match(sentHtml[0]?.html ?? "", /<b>当前查看中的会话<\/b>/u);
    assert.match(sentHtml[0]?.html ?? "", /<b>其他运行中的会话<\/b>/u);
    assert.deepEqual((sentHtml[0]?.replyMarkup as TelegramInlineKeyboardMarkup | undefined)?.inline_keyboard[0]?.map((button) => button.text), ["1", "2", "·", "·", "·"]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController reuses a completed latest hub when it still has an empty slot", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, editedHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
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

    activeTurns.length = 0;
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, session.sessionId);
    assert.match(editedHtml.at(-1)?.html ?? sentHtml[0]?.html ?? "", /<b>Hub：<\/b> 1\/1 · 已完成/u);

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
    assert.match(editedHtml.at(-1)?.html ?? "", /<b>Hub：<\/b> 1\/1/u);
    assert.deepEqual((editedHtml.at(-1)?.replyMarkup as TelegramInlineKeyboardMarkup | undefined)?.inline_keyboard[0]?.map((button) => button.text), ["1", "2", "·", "·", "·"]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController admits new work only into the latest hub, not older hubs with holes", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const sessions = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.createSession({
        telegramChatId: "chat-1",
        projectName: `Project ${index + 1}`,
        projectPath: `/tmp/project-${index + 1}`
      }))
    );
    for (const [index, session] of sessions.entries()) {
      activeTurns.push({
        sessionId: session.sessionId,
        chatId: "chat-1",
        threadId: `thread-${index + 1}`,
        turnId: `turn-${index + 1}`,
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
    }
    store.setActiveSession("chat-1", sessions[9]!.sessionId);

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", sessions[9]!.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const removed = sessions[0]!;
    activeTurns.splice(0, 1);
    store.archiveSession(removed.sessionId);
    await controller.handleSessionArchived("chat-1", removed.sessionId, "telegram_archive");

    const nextSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project 11",
      projectPath: "/tmp/project-11"
    });
    activeTurns.push({
      sessionId: nextSession.sessionId,
      chatId: "chat-1",
      threadId: "thread-11",
      turnId: "turn-11",
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
    store.setActiveSession("chat-1", nextSession.sessionId);

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", nextSession.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { liveHubs: Map<number, { slots: Array<{ sessionId: string | null }> }> }>;
    }).runtimeHubStates;
    const orderedHubs = [...(runtimeHubStates.get("chat-1")?.liveHubs.values() ?? [])].sort((left, right) => (left as any).windowIndex - (right as any).windowIndex);
    assert.equal(orderedHubs.length, 3);
    assert.equal(orderedHubs[0]?.slots[0]?.sessionId, null);
    assert.equal(orderedHubs[2]?.slots[0]?.sessionId, nextSession.sessionId);
    assert.match(sentHtml.at(-1)?.html ?? "", /<b>Hub：<\/b> 3\/3/u);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController removes archived sessions from live hubs immediately", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
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

    activeTurns.length = 0;
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, session.sessionId);
    const initialMessageId = sentHtml[0]?.messageId ?? 0;
    store.archiveSession(session.sessionId);

    await controller.handleSessionArchived("chat-1", session.sessionId, "telegram_archive");

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { liveHubs: Map<number, unknown> }>;
    }).runtimeHubStates;
    assert.equal(runtimeHubStates.get("chat-1")?.liveHubs.size ?? 0, 0);
    assert.deepEqual(deletedMessages, [initialMessageId]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController removes archived sessions from recovery hubs immediately", async () => {
  const { controller, store, cleanup } = await createControllerContext();

  try {
    const sessions = await Promise.all([
      store.createSession({ telegramChatId: "chat-1", projectName: "Project One", projectPath: "/tmp/project-one" }),
      store.createSession({ telegramChatId: "chat-1", projectName: "Project Two", projectPath: "/tmp/project-two" })
    ]);
    store.setActiveSession("chat-1", sessions[0]!.sessionId);

    await controller.sendRecoveryHub("chat-1", sessions.map((session) => session.sessionId));
    store.archiveSession(sessions[0]!.sessionId);
    await controller.handleSessionArchived("chat-1", sessions[0]!.sessionId, "telegram_archive");

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { recoveryHub: { sessionIds: string[] } | null }>;
    }).runtimeHubStates;
    assert.deepEqual(runtimeHubStates.get("chat-1")?.recoveryHub?.sessionIds ?? [], [sessions[1]!.sessionId]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController evicts the oldest non-running hub before creating a fourth live hub and keeps display order dense", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const sessions = await Promise.all(
      Array.from({ length: 11 }, (_, index) => store.createSession({
        telegramChatId: "chat-1",
        projectName: `Project ${index + 1}`,
        projectPath: `/tmp/project-${index + 1}`
      }))
    );
    for (const [index, session] of sessions.entries()) {
      activeTurns.push({
        sessionId: session.sessionId,
        chatId: "chat-1",
        threadId: `thread-${index + 1}`,
        turnId: `turn-${index + 1}`,
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
    }
    store.setActiveSession("chat-1", sessions[10]!.sessionId);

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", sessions[10]!.sessionId, undefined, {
      forcePreferredFocus: true
    });

    for (let index = 0; index < 5; index += 1) {
      const sessionId = sessions[index]!.sessionId;
      const turnIndex = activeTurns.findIndex((turn) => (turn as { sessionId: string }).sessionId === sessionId);
      if (turnIndex >= 0) {
        activeTurns.splice(turnIndex, 1);
      }
    }
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, sessions[0]!.sessionId);

    for (let index = 11; index < 16; index += 1) {
      const session = await store.createSession({
        telegramChatId: "chat-1",
        projectName: `Project ${index + 1}`,
        projectPath: `/tmp/project-${index + 1}`
      });
      activeTurns.push({
        sessionId: session.sessionId,
        chatId: "chat-1",
        threadId: `thread-${index + 1}`,
        turnId: `turn-${index + 1}`,
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
      store.setActiveSession("chat-1", session.sessionId);
      await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", session.sessionId, undefined, {
        forcePreferredFocus: true
      });
    }

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { liveHubs: Map<number, unknown> }>;
    }).runtimeHubStates;
    assert.equal(runtimeHubStates.get("chat-1")?.liveHubs.size ?? 0, 3);
    const orderedHubs = [...(runtimeHubStates.get("chat-1")?.liveHubs.values() ?? [])].sort((left, right) => (left as any).windowIndex - (right as any).windowIndex);
    const renderedHeaders = orderedHubs.map((hubState) => {
      const text = (controller as any).buildLiveHubRenderPayload("chat-1", hubState, orderedHubs.length, activeTurns).text as string;
      return text.match(/<b>Hub：<\/b> (\d+\/\d+)/u)?.[1] ?? null;
    });
    assert.deepEqual(renderedHeaders, ["1/3", "2/3", "3/3"]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController allows a temporary fourth live hub when the first three still have running sessions", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const sessions = await Promise.all(
      Array.from({ length: 16 }, (_, index) => store.createSession({
        telegramChatId: "chat-1",
        projectName: `Project ${index + 1}`,
        projectPath: `/tmp/project-${index + 1}`
      }))
    );
    for (const [index, session] of sessions.entries()) {
      activeTurns.push({
        sessionId: session.sessionId,
        chatId: "chat-1",
        threadId: `thread-${index + 1}`,
        turnId: `turn-${index + 1}`,
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
    }
    store.setActiveSession("chat-1", sessions[15]!.sessionId);

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", sessions[15]!.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, { liveHubs: Map<number, unknown> }>;
    }).runtimeHubStates;
    assert.equal(runtimeHubStates.get("chat-1")?.liveHubs.size ?? 0, 4);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController does not double-send delayed start auto-refresh after immediate accepted-work reanchor", async () => {
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
    };
    activeTurns.push(activeTurn);

    await controller.syncRuntimeCards(activeTurn as never, null, null, createActivityStatus(), {
      force: true,
      reason: "turn_initialized"
    });
    await controller.reanchorRuntimeAfterBridgeReply(activeTurn as never, "chat-1", "accepted_user_work", session.sessionId);
    await sleep(1700);

    assert.equal(sentHtml.length, 2);
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

test("RuntimeSurfaceController keeps terminal slots in recent ended sessions on the same hub", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, editedHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
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
    await controller.syncRuntimeCards(
      activeTurns[0] as never,
      { kind: "turn_completed", status: "completed" } as never,
      createActivityStatus(),
      createActivityStatus({ turnStatus: "completed" }),
      {
        force: true,
        reason: "turn_completed"
      }
    );
    activeTurns.splice(0, 1);
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, sessionOne.sessionId);

    const latestHtml = editedHtml.at(-1)?.html ?? sentHtml[0]?.html ?? "";
    assert.match(latestHtml, /<b>当前查看中的会话<\/b>/u);
    assert.match(latestHtml, /<b>最近结束的会话<\/b>/u);
    assert.match(latestHtml, /1\. <b>Session Alpha<\/b> \/ Project One · 已完成/u);
    assert.match(latestHtml, /2\. <b>Session Alpha<\/b> \/ Project One · Running/u);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController shows app-server-exit failures in recent ended sessions even without slot terminal state", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, editedHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
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
    const sessionThree = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Three",
      projectPath: "/tmp/project-three"
    });
    store.setActiveSession("chat-1", sessionThree.sessionId);

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
      },
      {
        sessionId: sessionThree.sessionId,
        chatId: "chat-1",
        threadId: "thread-3",
        turnId: "turn-3",
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

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", sessionThree.sessionId, undefined, {
      forcePreferredFocus: true
    });

    activeTurns.splice(0, activeTurns.length);
    store.updateSessionStatus(sessionOne.sessionId, "failed", { failureReason: "app_server_lost" });
    store.updateSessionStatus(sessionTwo.sessionId, "failed", { failureReason: "app_server_lost" });
    store.updateSessionStatus(sessionThree.sessionId, "failed", { failureReason: "app_server_lost" });
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, sessionThree.sessionId);

    const latestHtml = editedHtml.at(-1)?.html ?? sentHtml[0]?.html ?? "";
    assert.match(latestHtml, /<b>当前查看中的会话<\/b>/u);
    assert.match(latestHtml, /3\. <b>Session Alpha<\/b> \/ Project One · failed/u);
    assert.match(latestHtml, /<b>最近结束的会话<\/b>/u);
    assert.match(latestHtml, /1\. <b>Session Alpha<\/b> \/ Project One · failed/u);
    assert.match(latestHtml, /2\. <b>Session Alpha<\/b> \/ Project One · failed/u);
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
    assert.match(sentHtml[0]?.html ?? "", /当前查看中的会话/u);
    assert.match(sentHtml[0]?.html ?? "", /Recovered/u);

    language = "en";
    store.setActiveSession("chat-1", sessionTwo.sessionId);
    await controller.reanchorRuntimeAfterBridgeReply(null, "chat-1", "language_changed");

    assert.equal(sentHtml.length, 2);
    assert.match(sentHtml[1]?.html ?? "", /Focused session/u);
    assert.match(sentHtml[1]?.html ?? "", /\[viewing \/ current input\]/u);
    assert.doesNotMatch(sentHtml[1]?.html ?? "", /Input target:/u);
    assert.deepEqual(deletedMessages, [sentHtml[0]?.messageId ?? 0]);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController recovery hub shows a separate current input session when it is not in the recovered set", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
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

    const recoveredSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Recovered Project",
      projectPath: "/tmp/recovered-project"
    });
    const idleSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Idle Project",
      projectPath: "/tmp/idle-project"
    });
    store.setActiveSession("chat-1", idleSession.sessionId);
    store.updateSessionStatus(recoveredSession.sessionId, "failed", { failureReason: "bridge_restart" });

    const delivered = await controller.sendRecoveryHub("chat-1", [recoveredSession.sessionId]);
    assert.equal(delivered, true);

    const html = sentHtml[0]?.html ?? "";
    assert.match(html, /<b>当前输入会话<\/b>/u);
    assert.match(html, /\[当前输入\]\n<b>Session Alpha<\/b> \/ Project One · 空闲/u);
    assert.match(html, /<b>当前查看中的会话<\/b>/u);
    assert.match(html, /\[查看中\]\n1\. <b>Recovered Project<\/b> \/ Recovered Project · Recovered/u);
    assert.doesNotMatch(html, /当前查看中的运行会话/u);
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

test("RuntimeSurfaceController reanchors the hub that owns a finished background session", async () => {
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
    assert.equal(deletedMessages.at(-1), secondaryHubMessageId);
    assert.notEqual(deletedMessages.at(-1), mainHubMessageId);
  } finally {
    await cleanup();
  }
});

test("RuntimeSurfaceController reanchors the current live hub when the active session is idle", async () => {
  const activeTurns: unknown[] = [];
  const { controller, store, sentHtml, deletedMessages, cleanup } = await createControllerContext({
    listActiveTurns: () => activeTurns
  });

  try {
    const runningSessions = await Promise.all(
      Array.from({ length: 6 }, (_, index) => store.createSession({
        telegramChatId: "chat-1",
        projectName: `Project ${index + 1}`,
        projectPath: `/tmp/project-${index + 1}`
      }))
    );
    const currentLiveSession = runningSessions[5];
    assert.ok(currentLiveSession);
    store.setActiveSession("chat-1", currentLiveSession.sessionId);

    for (const [index, session] of runningSessions.entries()) {
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

    await controller.refreshLiveRuntimeHubs("chat-1", "turn_initialized", currentLiveSession.sessionId, undefined, {
      forcePreferredFocus: true
    });

    const completedHubMessageId = sentHtml[0]?.messageId ?? 0;
    const currentLiveHubMessageId = sentHtml[1]?.messageId ?? 0;
    assert.ok(completedHubMessageId > 0);
    assert.ok(currentLiveHubMessageId > 0);

    const idleSession = await store.createSession({
      telegramChatId: "chat-1",
      projectName: "Idle Project",
      projectPath: "/tmp/project-idle"
    });
    store.setActiveSession("chat-1", idleSession.sessionId);

    activeTurns.splice(0, 5);
    await controller.refreshLiveRuntimeHubs("chat-1", "turn_terminal", null, runningSessions[0]?.sessionId ?? null);

    const runtimeHubStates = (controller as unknown as {
      runtimeHubStates: Map<string, {
        currentHubIndex: number | null;
      }>;
    }).runtimeHubStates;
    assert.equal(runtimeHubStates.get("chat-1")?.currentHubIndex, 1);

    await controller.reanchorRuntimeAfterBridgeReply(null, "chat-1", "language_changed");

    assert.equal(sentHtml.length, 3);
    assert.equal(sentHtml[2]?.messageId, 1002);
    assert.equal(deletedMessages.at(-1), currentLiveHubMessageId);
    assert.notEqual(deletedMessages.at(-1), completedHubMessageId);
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

test("RuntimeSurfaceController keeps expanded hub plan sections when the slimmer layout stays under the text limit", async () => {
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
    assert.deepEqual(compactEdit?.replyMarkup?.inline_keyboard?.[0]?.map((button) => button.text), ["1", "·", "·", "·", "·"]);
    assert.equal(compactEdit?.replyMarkup?.inline_keyboard?.[1]?.[0]?.text, "收起计划清单");
    assert.match(compactEdit?.replyMarkup?.inline_keyboard?.[1]?.[0]?.callback_data ?? "", /plan:collapse/u);

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
    assert.equal(hubState?.planExpanded, true);
    assert.equal(hubState?.visibleState.planExpanded, true);
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

    assert.equal(hubState.destroyed, false);
    assert.equal(hubState.timer, null);
  } finally {
    await cleanup();
  }
});
