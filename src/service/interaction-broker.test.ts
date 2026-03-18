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

async function createBrokerContext() {
  const root = await mkdtemp(join(tmpdir(), "ctb-interaction-broker-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  const broker = new InteractionBroker({
    getStore: () => store,
    getAppServer: () => null,
    logger: testLogger,
    safeSendMessage: async () => true,
    safeSendHtmlMessageResult: async () => null,
    safeEditHtmlMessageText: async () => ({ outcome: "edited" }),
    safeAnswerCallbackQuery: async () => {},
    appendInteractionCreatedJournal: async () => {},
    appendInteractionResolvedJournal: async () => {}
  });

  return {
    store,
    broker,
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
