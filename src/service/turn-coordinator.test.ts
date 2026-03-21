import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import type { CodexAppServerClient } from "../codex/app-server.js";
import { BridgeStateStore } from "../state/store.js";
import { TurnCoordinator } from "./turn-coordinator.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
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

async function createCoordinatorContext(options: {
  appServer?: Partial<CodexAppServerClient>;
  models?: Array<{
    id: string;
    model: string;
    displayName: string;
    description: string;
    hidden: boolean;
    isDefault: boolean;
    defaultReasoningEffort: "low" | "medium" | "high";
    supportedReasoningEfforts: Array<{ reasoningEffort: "low" | "medium" | "high"; description: string }>;
  }>;
  safeSendHtmlMessageResult?: (
    chatId: string,
    html: string,
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }
  ) => Promise<{ message_id: number } | null>;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctb-turn-coordinator-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  const appServer = options.appServer ?? {};
  const syncReasons: string[] = [];
  const safeMessages: string[] = [];
  const sentHtmlMessages: Array<{
    chatId: string;
    html: string;
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  }> = [];
  const interactionResolutions: Array<{ chatId: string; sessionId: string; state: string; reason: string }> = [];
  const reanchorReasons: string[] = [];
  const finalizedHandoffs: Array<{ chatId: string; sessionId: string }> = [];
  let nextMessageId = 1;

  const coordinator = new TurnCoordinator({
    paths: { runtimeDir: paths.runtimeDir },
    logger: testLogger,
    getStore: () => store,
    getAppServer: () => appServer as CodexAppServerClient,
    ensureAppServerAvailable: async () => {},
    fetchAllModels: async () => options.models ?? [{
      id: "gpt-5-default",
      model: "gpt-5-default",
      displayName: "GPT-5 Default",
      description: "Default model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Default" }]
    }],
    interactionBroker: {
      getBlockedTurnSteerAvailability: (_chatId, _session, activeTurn) =>
        activeTurn ? { kind: "available", activeTurn } : { kind: "busy" },
      handleNormalizedServerRequest: async () => {},
      handleServerRequestResolvedNotification: async () => {},
      resolveActionablePendingInteractionsForSession: async (chatId, sessionId, resolution) => {
        interactionResolutions.push({
          chatId,
          sessionId,
          state: resolution.state,
          reason: resolution.reason
        });
      }
    },
    syncRuntimeCards: async (_activeTurn, _classified, _previousStatus, _nextStatus, options) => {
      syncReasons.push(options.reason);
    },
    runRuntimeCardOperation: async (_activeTurn, operation) => {
      await operation();
    },
    reanchorStatusCardToLatestMessage: async (_activeTurn, reason) => {
      reanchorReasons.push(reason);
    },
    reanchorRuntimeAfterBridgeReply: async (_chatId, reason, _sessionId) => {
      reanchorReasons.push(reason);
    },
    finalizeTerminalRuntimeHandoff: async (chatId, sessionId) => {
      finalizedHandoffs.push({ chatId, sessionId });
    },
    disposeRuntimeCards: () => {},
    safeSendMessage: async (_chatId, text) => {
      safeMessages.push(text);
      return true;
    },
    safeSendHtmlMessageResult: async (chatId, html, replyMarkup) => {
      if (options.safeSendHtmlMessageResult) {
        const sent = await options.safeSendHtmlMessageResult(chatId, html, replyMarkup);
        if (sent) {
          sentHtmlMessages.push(replyMarkup ? { chatId, html, replyMarkup } : { chatId, html });
        }
        return sent;
      }

      sentHtmlMessages.push(replyMarkup ? { chatId, html, replyMarkup } : { chatId, html });
      return { message_id: nextMessageId++ };
    },
    handleGlobalRuntimeNotice: async () => {},
    handleThreadArchiveNotification: async () => {}
  });

  return {
    coordinator,
    store,
    syncReasons,
    safeMessages,
    sentHtmlMessages,
    interactionResolutions,
    reanchorReasons,
    finalizedHandoffs,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("TurnCoordinator starts plan-mode turns with collaborationMode and records the active turn", async () => {
  const startTurnCalls: unknown[] = [];
  const { coordinator, store, syncReasons, cleanup } = await createCoordinatorContext({
    appServer: {
      startThread: async () => ({ thread: { id: "thread-plan" } }),
      startTurn: async (payload: unknown) => {
        startTurnCalls.push(payload);
        return { turn: { id: "turn-plan", status: "inProgress" } };
      }
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      planMode: true,
      selectedReasoningEffort: "medium"
    });

    await coordinator.startTextTurn("chat-1", session, "Implement the plan.");

    assert.deepEqual(startTurnCalls, [{
      threadId: "thread-plan",
      cwd: "/tmp/project-one",
      text: "Implement the plan.",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5-default",
          developerInstructions: null,
          reasoningEffort: "medium"
        }
      }
    }]);
    assert.equal(coordinator.getActiveTurn()?.threadId, "thread-plan");
    assert.equal(coordinator.getActiveTurn()?.turnId, "turn-plan");
    assert.equal(coordinator.getActiveTurn()?.effectiveModel, "gpt-5-default");
    assert.equal(coordinator.getActiveTurn()?.effectiveReasoningEffort, "medium");
    assert.deepEqual(syncReasons, ["turn_initialized"]);
    assert.equal(store.getSessionById(session.sessionId)?.status, "running");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator resolves the default model and reasoning effort for runtime surfaces", async () => {
  const { coordinator, store, cleanup } = await createCoordinatorContext({
    models: [{
      id: "gpt-5.3-codex",
      model: "gpt-5.3-codex",
      displayName: "GPT-5.3 Codex",
      description: "Picker default model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "medium" },
        { reasoningEffort: "high", description: "high" }
      ]
    }],
    appServer: {
      startThread: async () => ({
        thread: { id: "thread-default" },
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "high"
      }),
      startTurn: async () => ({ turn: { id: "turn-default", status: "inProgress" } })
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Alpha",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.startTextTurn("chat-1", session, "Use the default runtime settings.");

    assert.equal(coordinator.getActiveTurn()?.effectiveModel, "gpt-5.4");
    assert.equal(coordinator.getActiveTurn()?.effectiveReasoningEffort, "high");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator uses resumed thread runtime config instead of model picker defaults", async () => {
  const { coordinator, store, cleanup } = await createCoordinatorContext({
    models: [{
      id: "gpt-5.3-codex",
      model: "gpt-5.3-codex",
      displayName: "GPT-5.3 Codex",
      description: "Picker default model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "medium" },
        { reasoningEffort: "high", description: "high" }
      ]
    }],
    appServer: {
      resumeThread: async () => ({
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "high",
        thread: {
          id: "thread-existing",
          turns: []
        }
      }),
      startTurn: async () => ({ turn: { id: "turn-existing", status: "inProgress" } })
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      threadId: "thread-existing"
    });

    await coordinator.startTextTurn("chat-1", session, "Resume the thread.");

    assert.equal(coordinator.getActiveTurn()?.effectiveModel, "gpt-5.4");
    assert.equal(coordinator.getActiveTurn()?.effectiveReasoningEffort, "high");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator keeps the known reasoning effort when the model is rerouted", async () => {
  const { coordinator, store, cleanup } = await createCoordinatorContext({
    appServer: {
      startThread: async () => ({
        thread: { id: "thread-reroute" },
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "high"
      }),
      startTurn: async () => ({ turn: { id: "turn-reroute", status: "inProgress" } })
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Alpha",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.startTextTurn("chat-1", session, "Start the reroute test.");
    await coordinator.handleAppServerNotification("model/rerouted", {
      threadId: "thread-reroute",
      fromModel: "gpt-5.4",
      toModel: "gpt-5.5",
      reason: "capacity"
    });

    assert.equal(coordinator.getActiveTurn()?.effectiveModel, "gpt-5.5");
    assert.equal(coordinator.getActiveTurn()?.effectiveReasoningEffort, "high");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator recreates missing remote threads before starting a turn", async () => {
  const startTurnCalls: unknown[] = [];
  let startThreadCalls = 0;
  const { coordinator, store, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        throw new Error("no rollout found for thread id thread-missing");
      },
      startThread: async () => {
        startThreadCalls += 1;
        return { thread: { id: "thread-new" } };
      },
      startTurn: async (payload: unknown) => {
        startTurnCalls.push(payload);
        return { turn: { id: "turn-new", status: "inProgress" } };
      }
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      threadId: "thread-missing"
    });

    await coordinator.startTextTurn("chat-1", session, "Do the work");

    assert.equal(startThreadCalls, 1);
    assert.deepEqual(startTurnCalls, [{
      threadId: "thread-new",
      cwd: "/tmp/project-one",
      text: "Do the work"
    }]);
    assert.equal(store.getSessionById(session.sessionId)?.threadId, "thread-new");
    assert.equal(coordinator.getActiveTurn()?.threadId, "thread-new");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator completes a normal turn and delivers the recovered final answer", async () => {
  const { coordinator, store, sentHtmlMessages, interactionResolutions, reanchorReasons, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-1",
          turns: [{
            id: "turn-1",
            items: [{
              type: "agentMessage",
              phase: "final_answer",
              text: "Recovered final answer"
            }]
          }]
        }
      })
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Alpha",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-1", "turn-1", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /<b>Session Alpha \/ Project One<\/b>/u);
    assert.match(sentHtmlMessages[0]?.html ?? "", /Recovered final answer/u);
    const views = store.listFinalAnswerViews("chat-1");
    assert.equal(views.length, 1);
    assert.equal(views[0]?.deliveryState, "visible");
    assert.equal(views[0]?.telegramMessageId, 1);
    assert.deepEqual(interactionResolutions, [{
      chatId: "chat-1",
      sessionId: session.sessionId,
      state: "expired",
      reason: "turn_completed"
    }]);
    assert.deepEqual(reanchorReasons, []);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
    assert.equal(store.getSessionById(session.sessionId)?.status, "idle");
    assert.equal(store.getSessionById(session.sessionId)?.lastTurnId, "turn-1");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator delivers review results when review mode exits without a populated final_answer message", async () => {
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-review",
          turns: [{
            id: "turn-review",
            items: [
              {
                type: "agentMessage",
                phase: "final_answer",
                text: ""
              },
              {
                type: "exitedReviewMode",
                review: "The working tree only contains one planning document and no code changes."
              },
              {
                type: "agentMessage",
                phase: null,
                text: "The working tree only contains one planning document and no code changes."
              }
            ]
          }]
        }
      } as any)
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "turn-review", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "turn-review",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /no code changes/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator completes with the fallback terminal message when thread history recovery fails", async () => {
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        throw new Error("app-server request timed out: thread/resume");
      }
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Fallback",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-fallback-final", "turn-fallback-final", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-fallback-final",
      turnId: "turn-fallback-final",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(store.getSessionById(session.sessionId)?.status, "idle");
    assert.match(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator completes plan-mode turns by sending a plan result with implementation action markup", async () => {
  const { coordinator, store, sentHtmlMessages, reanchorReasons, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-plan",
          turns: [{
            id: "turn-plan",
            items: [{
              type: "plan",
              text: "## Plan\n\nShip the refactor."
            }]
          }]
        }
      })
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Plan",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      planMode: true
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-plan", "turn-plan", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-plan",
      turnId: "turn-plan",
      status: "completed"
    });

    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /<b>Session Plan \/ Project One<\/b>/u);
    assert.match(sentHtmlMessages[0]?.html ?? "", /<b>Plan<\/b>/u);
    assert.equal(sentHtmlMessages[0]?.replyMarkup?.inline_keyboard?.[0]?.[0]?.text, "实施这个计划");
    const views = store.listFinalAnswerViews("chat-1");
    assert.equal(views.length, 1);
    assert.equal(views[0]?.telegramMessageId, 1);
    assert.equal(views[0]?.kind, "plan_result");
    assert.equal(views[0]?.deliveryState, "visible");
    assert.deepEqual(reanchorReasons, []);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator leaves a deferred terminal notice when final answer delivery is flood-limited", async () => {
  let sendAttempt = 0;
  const { coordinator, store, sentHtmlMessages, reanchorReasons, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-deferred-final",
          turns: [{
            id: "turn-deferred-final",
            items: [{
              type: "agentMessage",
              phase: "final_answer",
              text: "Deferred final answer"
            }]
          }]
        }
      })
    },
    safeSendHtmlMessageResult: async (_chatId, _html, _replyMarkup) => {
      sendAttempt += 1;
      return sendAttempt === 1 ? null : { message_id: 1 };
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Deferred",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-deferred-final", "turn-deferred-final", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-deferred-final",
      turnId: "turn-deferred-final",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /暂未送达/u);
    const views = store.listFinalAnswerViews("chat-1");
    assert.equal(views.length, 1);
    assert.equal(views[0]?.deliveryState, "deferred_notice_visible");
    assert.equal(views[0]?.telegramMessageId, null);
    assert.deepEqual(reanchorReasons, []);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
    assert.equal(store.countRuntimeNotices(), 0);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator keeps the final runtime surface until a deferred terminal notice becomes visible", async () => {
  const { coordinator, store, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-pending-final",
          turns: [{
            id: "turn-pending-final",
            items: [{
              type: "agentMessage",
              phase: "final_answer",
              text: "Pending final answer"
            }]
          }]
        }
      })
    },
    safeSendHtmlMessageResult: async () => null
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Pending",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-pending-final", "turn-pending-final", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-pending-final",
      turnId: "turn-pending-final",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(store.listFinalAnswerViews("chat-1")[0]?.deliveryState, "pending");
    assert.equal(store.countRuntimeNotices(), 1);
    assert.deepEqual(finalizedHandoffs, []);

    await coordinator.handleDeferredTerminalNoticeVisible("chat-1", session.sessionId, "turn-pending-final");
    assert.equal(coordinator.getActiveTurn(), null);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator does not reanchor the hub after a failed-turn notice", async () => {
  const { coordinator, store, safeMessages, reanchorReasons, cleanup } = await createCoordinatorContext();

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-failed", "turn-failed", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-failed",
      turnId: "turn-failed",
      status: "failed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.deepEqual(safeMessages, ["这次操作未成功完成，请重试。"]);
    assert.deepEqual(reanchorReasons, []);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator ignores queued late notifications after a turn reaches terminal handoff", async () => {
  const syncReasons: string[] = [];
  const { coordinator, store, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          thread: {
            id: "thread-late",
            turns: [{
              id: "turn-late",
              items: [{
                type: "agentMessage",
                phase: "final_answer",
                text: "Recovered final answer"
              }]
            }]
          }
        };
      }
    }
  });

  const originalSyncRuntimeCards = (coordinator as any).deps.syncRuntimeCards;
  (coordinator as any).deps.syncRuntimeCards = async (...args: unknown[]) => {
    syncReasons.push((args[4] as { reason: string }).reason);
    await originalSyncRuntimeCards(...args);
  };

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      displayName: "Session Late",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-late", "turn-late", "inProgress");
    const completed = coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-late",
      turnId: "turn-late",
      status: "completed"
    });
    const late = coordinator.handleAppServerNotification("thread/status/changed", {
      threadId: "thread-late",
      status: "active"
    });

    await Promise.all([completed, late]);

    assert.deepEqual(syncReasons, ["turn_initialized", "turn_completed"]);
    assert.equal(coordinator.getActiveTurn(), null);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator marks interrupted turns without sending a terminal answer", async () => {
  const { coordinator, store, sentHtmlMessages, interactionResolutions, cleanup } = await createCoordinatorContext();

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-interrupted", "turn-interrupted", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-interrupted",
      turnId: "turn-interrupted",
      status: "interrupted"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.deepEqual(sentHtmlMessages, []);
    assert.deepEqual(interactionResolutions, [{
      chatId: "chat-1",
      sessionId: session.sessionId,
      state: "expired",
      reason: "turn_interrupted"
    }]);
    assert.equal(store.getSessionById(session.sessionId)?.status, "interrupted");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator rejects known unsupported server requests and journals the rejection", async () => {
  const requestErrors: Array<{ id: string; code: number; message: string }> = [];
  const { coordinator, store, safeMessages, reanchorReasons, cleanup } = await createCoordinatorContext({
    appServer: {
      respondToServerRequestError: async (id, code, message) => {
        requestErrors.push({ id: `${id}`, code, message });
      }
    }
  });

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-unsupported", "turn-unsupported", "inProgress");
    const debugFilePath = coordinator.getRecentActivity(session.sessionId)?.debugFilePath;

    await coordinator.handleAppServerServerRequest({
      id: "tool-call-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-unsupported",
        turnId: "turn-unsupported",
        tool: "view_image"
      }
    });

    assert.deepEqual(requestErrors, [{
      id: "tool-call-1",
      code: -32601,
      message: "Dynamic tool calls are not supported by the Telegram bridge"
    }]);
    assert.equal(safeMessages.length, 1);
    assert.match(safeMessages[0] ?? "", /动态工具调用/u);
    assert.deepEqual(reanchorReasons, ["known_unsupported_server_request"]);
    assert.ok(debugFilePath);

    const journal = await readFile(debugFilePath!, "utf8");
    assert.match(journal, /bridge\/serverRequest\/rejected/u);
    assert.match(journal, /item\/tool\/call/u);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator fails the active turn when the app-server exits mid-run", async () => {
  const { coordinator, store, safeMessages, interactionResolutions, cleanup } = await createCoordinatorContext();

  try {
    const session = store.createSession({
      telegramChatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-exit", "turn-exit", "inProgress");
    await coordinator.handleActiveTurnAppServerExit();

    assert.equal(coordinator.getActiveTurn(), null);
    assert.deepEqual(interactionResolutions, [{
      chatId: "chat-1",
      sessionId: session.sessionId,
      state: "failed",
      reason: "app_server_lost"
    }]);
    assert.deepEqual(safeMessages, ["Codex 服务暂时不可用，请稍后重试。"]);
    assert.equal(store.getSessionById(session.sessionId)?.status, "failed");
    assert.equal(store.getSessionById(session.sessionId)?.failureReason, "app_server_lost");
  } finally {
    await cleanup();
  }
});
