import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActivityStatus, InspectSnapshot } from "../activity/types.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { BridgeStateStore } from "../state/store.js";
import { InteractionBroker } from "./interaction-broker.js";

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

async function createBrokerContext(options: {
  appServer?: Record<string, unknown>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctb-interaction-broker-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  const sentHtml: Array<{ chatId: string; html: string }> = [];
  const editedHtml: Array<{ chatId: string; messageId: number; html: string }> = [];
  const broker = new InteractionBroker({
    getStore: () => store,
    getAppServer: () => options.appServer as never,
    logger: testLogger,
    safeSendMessage: async () => true,
    safeSendHtmlMessageResult: async (chatId, html) => {
      sentHtml.push({ chatId, html });
      return {
        message_id: 100 + sentHtml.length,
        chat: { id: 1, type: "private" },
        date: 0,
        text: html
      } as never;
    },
    safeEditHtmlMessageText: async (chatId, messageId, html) => {
      editedHtml.push({ chatId, messageId, html });
      return { outcome: "edited" };
    },
    safeAnswerCallbackQuery: async () => {},
    appendInteractionCreatedJournal: async () => {},
    appendInteractionResolvedJournal: async () => {}
  });

  return {
    store,
    broker,
    sentHtml,
    editedHtml,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("buildPendingInteractionSummaries keeps only actionable rows for the active session", async () => {
  const { broker, store, cleanup } = await createBrokerContext();
  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      displayName: "Session One"
    });

    const otherSession = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two",
      displayName: "Session Two"
    });

    const pending = store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "1",
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: "{}"
    });
    store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: otherSession.sessionId,
      threadId: "thread-2",
      turnId: "turn-2",
      requestId: "2",
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: "{}"
    });
    const answered = store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-3",
      requestId: "3",
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: "{}"
    });
    store.markPendingInteractionAnswered(answered.interactionId, "{\"answers\":{}}");

    assert.deepEqual(broker.buildPendingInteractionSummaries(store.getSessionById(session.sessionId)!), [{
      interactionId: pending.interactionId,
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      state: "pending",
      awaitingText: false
    }]);
  } finally {
    await cleanup();
  }
});

test("getBlockedTurnSteerAvailability reports interaction_pending before steer availability", async () => {
  const { broker, store, cleanup } = await createBrokerContext();
  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      displayName: "Session One"
    });
    store.updateSessionStatus(session.sessionId, "running", { lastTurnId: "turn-1", lastTurnStatus: "inProgress" });
    store.createPendingInteraction({
      telegramChatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      requestId: "1",
      requestMethod: "item/tool/requestUserInput",
      interactionKind: "questionnaire",
      promptJson: "{}"
    });

    const blockedInspectSnapshot: InspectSnapshot = {
      turnStatus: "blocked",
      threadRuntimeState: "active",
      activeItemType: null,
      activeItemId: null,
      activeItemLabel: null,
      lastActivityAt: null,
      currentItemStartedAt: null,
      currentItemDurationSec: null,
      lastHighValueEventType: null,
      lastHighValueTitle: null,
      lastHighValueDetail: null,
      latestProgress: null,
      recentStatusUpdates: [],
      threadBlockedReason: null,
      finalMessageAvailable: false,
      inspectAvailable: true,
      debugAvailable: true,
      errorState: null,
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
      answeredInteractions: []
    };
    const blockedStatus: ActivityStatus = {
      turnStatus: "blocked",
      threadRuntimeState: "active",
      activeItemType: null,
      activeItemId: null,
      activeItemLabel: null,
      lastActivityAt: null,
      currentItemStartedAt: null,
      currentItemDurationSec: null,
      lastHighValueEventType: null,
      lastHighValueTitle: null,
      lastHighValueDetail: null,
      latestProgress: null,
      recentStatusUpdates: [],
      threadBlockedReason: null,
      finalMessageAvailable: false,
      inspectAvailable: true,
      debugAvailable: true,
      errorState: null
    };
    const activeTurn = {
      chatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => blockedInspectSnapshot,
        getStatus: () => blockedStatus
      },
      statusCard: {
        needsReanchorOnActive: false
      }
    };

    const currentSession = store.getSessionById(session.sessionId)!;
    assert.deepEqual(
      broker.getBlockedTurnSteerAvailability("chat-1", currentSession, activeTurn),
      { kind: "interaction_pending" }
    );
  } finally {
    await cleanup();
  }
});

test("pending interaction cards include the /hub hint", async () => {
  const { broker, store, sentHtml, cleanup } = await createBrokerContext({
    appServer: {
      respondToServerRequest: async () => {},
      respondToServerRequestError: async () => {}
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      displayName: "Session One"
    });
    const activeTurn = {
      chatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => ({ agentSnapshot: [] } as unknown as InspectSnapshot),
        getStatus: () => ({ turnStatus: "blocked" } as ActivityStatus)
      },
      statusCard: {
        needsReanchorOnActive: false
      }
    };

    await broker.handleNormalizedServerRequest({
      id: "req-pending",
      method: "item/commandExecution/requestApproval"
    } as never, {
      kind: "approval",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      rawParams: {},
      itemId: "item-1",
      approvalId: null,
      decisionOptions: [
        { key: "accept", kind: "accept", label: "批准", payload: { decision: { accept: true } } },
        { key: "decline", kind: "decline", label: "拒绝", payload: { decision: { accept: false } } }
      ],
      title: "Codex 需要命令批准",
      subtitle: "命令审批",
      body: "pnpm test",
      detail: null
    }, activeTurn as never);

    assert.match(sentHtml[0]?.html ?? "", /如需查看或刷新 Hub，可发送 \/hub。/u);
  } finally {
    await cleanup();
  }
});

test("answered and canceled interaction cards include the /hub hint", async () => {
  const { broker, store, editedHtml, cleanup } = await createBrokerContext({
    appServer: {
      respondToServerRequest: async () => {},
      respondToServerRequestError: async () => {}
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      displayName: "Session One"
    });
    const activeTurn = {
      chatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => ({ agentSnapshot: [] } as unknown as InspectSnapshot),
        getStatus: () => ({ turnStatus: "blocked" } as ActivityStatus)
      },
      statusCard: {
        needsReanchorOnActive: false
      }
    };

    await broker.handleNormalizedServerRequest({
      id: "req-answered",
      method: "item/commandExecution/requestApproval"
    } as never, {
      kind: "approval",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      rawParams: {},
      itemId: "item-1",
      approvalId: null,
      decisionOptions: [
        { key: "accept", kind: "accept", label: "批准", payload: { decision: { accept: true } } },
        { key: "decline", kind: "decline", label: "拒绝", payload: { decision: { accept: false } } }
      ],
      title: "Codex 需要命令批准",
      subtitle: "命令审批",
      body: "pnpm test",
      detail: null
    }, activeTurn as never);

    await broker.handleServerRequestResolvedNotification("thread-1", "req-answered");
    assert.match(editedHtml.at(-1)?.html ?? "", /如需查看或刷新 Hub，可发送 \/hub。/u);

    await broker.handleNormalizedServerRequest({
      id: "req-canceled",
      method: "item/commandExecution/requestApproval"
    } as never, {
      kind: "approval",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      rawParams: {},
      itemId: "item-2",
      approvalId: null,
      decisionOptions: [
        { key: "accept", kind: "accept", label: "批准", payload: { decision: { accept: true } } },
        { key: "cancel", kind: "cancel", label: "取消", payload: { decision: { cancel: true } } }
      ],
      title: "Codex 需要命令批准",
      subtitle: "命令审批",
      body: "pnpm test",
      detail: null
    }, activeTurn as never);

    const cancelPending = store.listPendingInteractionsByChat("chat-1", ["pending"])
      .find((row) => row.requestId === JSON.stringify("req-canceled"));
    assert.ok(cancelPending?.telegramMessageId !== null);
    if (!cancelPending?.telegramMessageId) {
      throw new Error("expected cancel interaction telegram message id");
    }

    await broker.handleInteractionCancelCallback(
      "callback-1",
      "chat-1",
      cancelPending.telegramMessageId,
      cancelPending.interactionId
    );

    assert.match(editedHtml.at(-1)?.html ?? "", /如需查看或刷新 Hub，可发送 \/hub。/u);
  } finally {
    await cleanup();
  }
});

test("failed and expired interaction cards do not include the /hub hint", async () => {
  const { broker, store, editedHtml, cleanup } = await createBrokerContext({
    appServer: {
      respondToServerRequest: async () => {},
      respondToServerRequestError: async () => {}
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      displayName: "Session One"
    });
    const activeTurn = {
      chatId: "chat-1",
      sessionId: session.sessionId,
      threadId: "thread-1",
      turnId: "turn-1",
      tracker: {
        getInspectSnapshot: () => ({ agentSnapshot: [] } as unknown as InspectSnapshot),
        getStatus: () => ({ turnStatus: "blocked" } as ActivityStatus)
      },
      statusCard: {
        needsReanchorOnActive: false
      }
    };

    await broker.handleNormalizedServerRequest({
      id: "req-failed",
      method: "item/commandExecution/requestApproval"
    } as never, {
      kind: "approval",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      rawParams: {},
      itemId: "item-1",
      approvalId: null,
      decisionOptions: [
        { key: "accept", kind: "accept", label: "批准", payload: { decision: { accept: true } } },
        { key: "decline", kind: "decline", label: "拒绝", payload: { decision: { accept: false } } }
      ],
      title: "Codex 需要命令批准",
      subtitle: "命令审批",
      body: "pnpm test",
      detail: null
    }, activeTurn as never);

    await broker.resolveActionablePendingInteractionsForSession("chat-1", session.sessionId, {
      state: "failed",
      reason: "telegram_delivery_failed",
      resolutionSource: "telegram_delivery_failed"
    });
    assert.doesNotMatch(editedHtml.at(-1)?.html ?? "", /如需查看或刷新 Hub，可发送 \/hub。/u);

    await broker.handleNormalizedServerRequest({
      id: "req-expired",
      method: "item/commandExecution/requestApproval"
    } as never, {
      kind: "approval",
      method: "item/commandExecution/requestApproval",
      threadId: "thread-1",
      turnId: "turn-1",
      rawParams: {},
      itemId: "item-2",
      approvalId: null,
      decisionOptions: [
        { key: "accept", kind: "accept", label: "批准", payload: { decision: { accept: true } } },
        { key: "decline", kind: "decline", label: "拒绝", payload: { decision: { accept: false } } }
      ],
      title: "Codex 需要命令批准",
      subtitle: "命令审批",
      body: "pnpm test",
      detail: null
    }, activeTurn as never);

    await broker.resolveActionablePendingInteractionsForSession("chat-1", session.sessionId, {
      state: "expired",
      reason: "turn_completed",
      resolutionSource: "turn_expired"
    });
    assert.doesNotMatch(editedHtml.at(-1)?.html ?? "", /如需查看或刷新 Hub，可发送 \/hub。/u);
  } finally {
    await cleanup();
  }
});
