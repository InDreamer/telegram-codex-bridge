import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import type { CodexAppServerClient } from "../codex/app-server.js";
import type {
  ControlSurfaceFileResult,
  ControlSurfaceImageResult
} from "../core/interaction-model/platform-actions.js";
import type { EgressMessageSendResult } from "../packs/contract.js";
import { TELEGRAM_PACK } from "../packs/telegram/index.js";
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
    perfLogsDir: join(logsDir, "perf"),
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
  ) => Promise<EgressMessageSendResult | null>;
  safeSendRichMarkdownMessageResult?: (
    chatId: string,
    markdown: string,
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }
  ) => Promise<EgressMessageSendResult | null>;
  sendControlSurfaceFile?: (
    chatId: string,
    filePath: string,
    options?: {
      caption?: string;
      fileName?: string;
    }
  ) => Promise<ControlSurfaceFileResult>;
  sendControlSurfaceImage?: (
    chatId: string,
    imagePath: string,
    options?: {
      caption?: string;
    }
  ) => Promise<ControlSurfaceImageResult>;
  getDynamicToolAvailability?: (toolName: string) => {
    enabled: boolean;
    failureText: string;
  } | null;
  fetchRuntimeConfig?: () => Promise<{
    model: string | null;
    reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  }>;
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
  const syncCalls: Array<{ reason: string; force: boolean | undefined }> = [];
  const safeMessages: string[] = [];
  const sentDocuments: Array<{
    chatId: string;
    filePath: string;
    options?: {
      caption?: string;
      parseMode?: "HTML";
      fileName?: string;
    };
  }> = [];
  const sentImages: Array<{
    chatId: string;
    imagePath: string;
    options?: {
      caption?: string;
    };
  }> = [];
  const sentHtmlMessages: Array<{
    chatId: string;
    html: string;
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  }> = [];
  const sentRichMessages: Array<{
    chatId: string;
    markdown: string;
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
  }> = [];
  const interactionResolutions: Array<{ chatId: string; sessionId: string; state: string; reason: string }> = [];
  const acceptedTurnStartReanchors: Array<{ chatId: string; sessionId: string; kind: "text" | "structured" }> = [];
  const reanchorReasons: string[] = [];
  const finalizedHandoffs: Array<{ chatId: string; sessionId: string }> = [];
  const currentSessionCardSyncs: Array<{ sessionId: string; reason: string }> = [];
  let nextMessageId = 1;

  const coordinator = new TurnCoordinator({
    paths: { runtimeDir: paths.runtimeDir },
    logger: testLogger,
    getStore: () => store,
    getAppServer: () => appServer as CodexAppServerClient,
    ensureAppServerAvailable: async () => {},
    fetchRuntimeConfig: async () =>
      options.fetchRuntimeConfig
        ? await options.fetchRuntimeConfig()
        : {
            model: "gpt-5-default",
            reasoningEffort: "medium"
          },
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
      syncCalls.push({ reason: options.reason, force: options.force });
    },
    runRuntimeCardOperation: async (_activeTurn, operation) => {
      await operation();
    },
    reanchorStatusCardToLatestMessage: async (_activeTurn, reason) => {
      reanchorReasons.push(reason);
    },
    shouldReanchorAcceptedTurnStart: () => true,
    reanchorAcceptedTurnStart: async (chatId, sessionId, kind) => {
      acceptedTurnStartReanchors.push({ chatId, sessionId, kind });
    },
    syncCurrentSessionCardForSession: async (sessionId, reason) => {
      currentSessionCardSyncs.push({ sessionId, reason });
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
    platformActions: {
      sendControlSurfaceImage: async ({ chatId, imagePath, caption }) => {
        if (options.sendControlSurfaceImage) {
          const sent = await options.sendControlSurfaceImage(chatId, imagePath, caption ? { caption } : undefined);
          if (sent.outcome === "sent") {
            sentImages.push(caption ? { chatId, imagePath, options: { caption } } : { chatId, imagePath });
          }
          return sent;
        }

        sentImages.push(caption ? { chatId, imagePath, options: { caption } } : { chatId, imagePath });
        return {
          action: "send_control_surface_image",
          outcome: "sent",
          deliveryRef: { messageId: nextMessageId++ }
        };
      },
      sendControlSurfaceFile: async ({ chatId, filePath, caption, fileName }) => {
        if (options.sendControlSurfaceFile) {
          const sent = await options.sendControlSurfaceFile(chatId, filePath, {
            ...(caption ? { caption } : {}),
            ...(fileName ? { fileName } : {})
          });
          if (sent.outcome === "sent") {
            sentDocuments.push(
              caption || fileName
                ? { chatId, filePath, options: { ...(caption ? { caption } : {}), ...(fileName ? { fileName } : {}) } }
                : { chatId, filePath }
            );
          }
          return sent;
        }

        sentDocuments.push(
          caption || fileName
            ? { chatId, filePath, options: { ...(caption ? { caption } : {}), ...(fileName ? { fileName } : {}) } }
            : { chatId, filePath }
        );
        return {
          action: "send_control_surface_file",
          outcome: "sent",
          deliveryRef: { messageId: nextMessageId++ }
        };
      }
    },
    dynamicToolDeclarations: TELEGRAM_PACK.platformActions.getDynamicToolDeclarations(),
    ...(options.getDynamicToolAvailability ? { getDynamicToolAvailability: options.getDynamicToolAvailability } : {}),
    interpretPackServerRequest: TELEGRAM_PACK.platformActions.interpretServerRequest,
    safeSendHtmlMessageResult: async (chatId, html, replyMarkup) => {
      if (options.safeSendHtmlMessageResult) {
        const sent = await options.safeSendHtmlMessageResult(chatId, html, replyMarkup);
        if (sent) {
          sentHtmlMessages.push(replyMarkup ? { chatId, html, replyMarkup } : { chatId, html });
        }
        return sent;
      }

      sentHtmlMessages.push(replyMarkup ? { chatId, html, replyMarkup } : { chatId, html });
      return { messageId: nextMessageId++ };
    },
    ...(options.safeSendRichMarkdownMessageResult
      ? {
          safeSendRichMarkdownMessageResult: async (chatId, markdown, replyMarkup) => {
            const sent = await options.safeSendRichMarkdownMessageResult?.(chatId, markdown, replyMarkup) ?? null;
            if (sent) {
              sentRichMessages.push(replyMarkup ? { chatId, markdown, replyMarkup } : { chatId, markdown });
            }
            return sent;
          }
        }
      : {}),
    handleGlobalRuntimeNotice: async () => {},
    handleThreadArchiveNotification: async () => {}
  });

  return {
    coordinator,
    store,
    syncReasons,
    syncCalls,
    safeMessages,
    sentDocuments,
    sentImages,
    sentHtmlMessages,
    sentRichMessages,
    interactionResolutions,
    acceptedTurnStartReanchors,
    currentSessionCardSyncs,
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
  const { coordinator, store, syncReasons, acceptedTurnStartReanchors, cleanup } = await createCoordinatorContext({
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
      chatId: "chat-1",
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
    assert.deepEqual(acceptedTurnStartReanchors, [{
      chatId: "chat-1",
      sessionId: session.sessionId,
      kind: "text"
    }]);
    assert.equal(store.getSessionById(session.sessionId)?.status, "running");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator starts structured turns and requests the structured-work hub reanchor", async () => {
  const startTurnCalls: unknown[] = [];
  const { coordinator, store, acceptedTurnStartReanchors, cleanup } = await createCoordinatorContext({
    appServer: {
      startThread: async () => ({ thread: { id: "thread-structured" } }),
      startTurn: async (payload: unknown) => {
        startTurnCalls.push(payload);
        return { turn: { id: "turn-structured", status: "inProgress" } };
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.startStructuredTurn("chat-1", session, [{ type: "text", text: "Use this input." }] as never);

    assert.deepEqual(startTurnCalls, [{
      threadId: "thread-structured",
      cwd: "/tmp/project-one",
      input: [{ type: "text", text: "Use this input." }]
    }]);
    assert.deepEqual(acceptedTurnStartReanchors, [{
      chatId: "chat-1",
      sessionId: session.sessionId,
      kind: "structured"
    }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator plan mode uses runtime-thread truth over model picker defaults", async () => {
  const startTurnCalls: unknown[] = [];
  const { coordinator, store, cleanup } = await createCoordinatorContext({
    models: [{
      id: "gpt-5.3-codex",
      model: "gpt-5.3-codex",
      displayName: "GPT-5.3 Codex",
      description: "Picker default model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "medium" }]
    }],
    appServer: {
      startThread: async () => ({
        thread: { id: "thread-plan-runtime" },
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "xhigh"
      }),
      startTurn: async (payload: unknown) => {
        startTurnCalls.push(payload);
        return { turn: { id: "turn-plan-runtime", status: "inProgress" } };
      }
    },
    fetchRuntimeConfig: async () => ({
      model: "gpt-5.4",
      reasoningEffort: "xhigh"
    })
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      planMode: true
    });

    await coordinator.startTextTurn("chat-1", session, "Plan with runtime defaults.");

    assert.deepEqual(startTurnCalls, [{
      threadId: "thread-plan-runtime",
      cwd: "/tmp/project-one",
      text: "Plan with runtime defaults.",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.4",
          developerInstructions: null,
          reasoningEffort: null
        }
      }
    }]);
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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

test("TurnCoordinator resolves effective display state from config/read for default sessions without threads", async () => {
  const { coordinator, store, cleanup } = await createCoordinatorContext({
    fetchRuntimeConfig: async () => ({
      model: "gpt-5.4",
      reasoningEffort: "xhigh"
    })
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Alpha",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });
    const modelState = await coordinator.resolveSessionModelState(session);

    assert.deepEqual(modelState, {
      configuredModel: null,
      configuredReasoningEffort: null,
      effectiveModel: "gpt-5.4",
      effectiveReasoningEffort: "xhigh",
      source: "config_read"
    });
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
      chatId: "chat-1",
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

test("TurnCoordinator auto-syncs session names from thread title updates but keeps manual names locked", async () => {
  const { coordinator, store, cleanup } = await createCoordinatorContext();

  try {
    const autoSession = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      threadId: "thread-auto-title"
    });
    const manualSession = store.createSession({
      chatId: "chat-1",
      projectName: "Project Two",
      projectPath: "/tmp/project-two",
      threadId: "thread-manual-title"
    });
    store.renameSession(manualSession.sessionId, "Manual Name");

    await coordinator.handleAppServerNotification("thread/name/updated", {
      threadId: "thread-auto-title",
      threadName: "Implement runtime title sync"
    });
    await coordinator.handleAppServerNotification("thread/name/updated", {
      threadId: "thread-manual-title",
      threadName: "Should not overwrite manual"
    });

    assert.equal(store.getSessionById(autoSession.sessionId)?.displayName, "Implement runtime title sync");
    assert.equal(store.getSessionById(autoSession.sessionId)?.displayNameSource, "auto");
    assert.equal(store.getSessionById(manualSession.sessionId)?.displayName, "Manual Name");
    assert.equal(store.getSessionById(manualSession.sessionId)?.displayNameSource, "manual");
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator refreshes auto session names from remote thread metadata after a normal turn completes", async () => {
  let readThreadCalls = 0;
  const { coordinator, store, sentHtmlMessages, currentSessionCardSyncs, cleanup } = await createCoordinatorContext({
    appServer: {
      startThread: async () => ({
        thread: {
          id: "thread-late-title"
        }
      }),
      startTurn: async () => ({
        turn: {
          id: "turn-late-title",
          status: "inProgress"
        }
      }),
      readThread: async () => {
        readThreadCalls += 1;
        return {
          thread: {
            id: "thread-late-title",
            name: "Fix laggy session title refresh",
            cwd: "/tmp/project-one",
            preview: "Fix laggy session title refresh",
            updatedAt: 0,
            createdAt: 0,
            status: "idle",
            turns: []
          }
        } as any;
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.startTextTurn("chat-1", session, "Fix laggy session title refresh");
    assert.equal(store.getSessionById(session.sessionId)?.displayName, "Project One");

    await coordinator.handleAppServerNotification("codex/event/task_complete", {
      threadId: "thread-late-title",
      turnId: "turn-late-title",
      msg: {
        last_agent_message: "Done"
      }
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-late-title",
      turnId: "turn-late-title",
      status: "completed"
    });

    assert.equal(readThreadCalls, 1);
    assert.equal(store.getSessionById(session.sessionId)?.displayName, "Fix laggy session title refresh");
    assert.equal(store.getSessionById(session.sessionId)?.displayNameSource, "auto");
    assert.deepEqual(currentSessionCardSyncs, [{
      sessionId: session.sessionId,
      reason: "turn_completed"
    }]);
    assert.match(sentHtmlMessages[0]?.html ?? "", /Fix laggy session title refresh \/ Project One/u);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator forces runtime refresh when thread title notifications update the active auto session name", async () => {
  const { coordinator, store, syncCalls, currentSessionCardSyncs, cleanup } = await createCoordinatorContext();

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      threadId: "thread-title-live"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-title-live", "turn-live-title", "inProgress");
    await coordinator.handleAppServerNotification("thread/name/updated", {
      threadId: "thread-title-live",
      threadName: "Runtime title updated in place"
    });

    assert.equal(store.getSessionById(session.sessionId)?.displayName, "Runtime title updated in place");
    assert.equal(syncCalls.at(-1)?.reason, "thread_name_updated");
    assert.equal(syncCalls.at(-1)?.force, true);
    assert.deepEqual(currentSessionCardSyncs, [{
      sessionId: session.sessionId,
      reason: "thread_name_updated"
    }]);
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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
    assert.equal(views[0]?.deliveryMessageId, 1);
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

test("TurnCoordinator prefers native rich Markdown for final answers", async () => {
  const markdown = "| Worker | State |\n| --- | --- |\n| Delivery | Ready |";
  const { coordinator, store, sentHtmlMessages, sentRichMessages, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-rich",
          turns: [{
            id: "turn-rich",
            items: [{ type: "agentMessage", phase: "final_answer", text: markdown }]
          }]
        }
      })
    },
    safeSendRichMarkdownMessageResult: async () => ({ messageId: 91 })
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-rich", "turn-rich", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-rich",
      turnId: "turn-rich",
      status: "completed"
    });

    assert.deepEqual(sentRichMessages, [{ chatId: "chat-1", markdown }]);
    assert.equal(sentHtmlMessages.length, 0);
    assert.equal(store.listFinalAnswerViews("chat-1")[0]?.deliveryMessageId, 91);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator falls back to HTML when native rich Markdown delivery fails", async () => {
  const { coordinator, store, sentHtmlMessages, sentRichMessages, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-rich-fallback",
          turns: [{
            id: "turn-rich-fallback",
            items: [{ type: "agentMessage", phase: "final_answer", text: "Fallback answer" }]
          }]
        }
      })
    },
    safeSendRichMarkdownMessageResult: async () => null
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn(
      "chat-1",
      session,
      "thread-rich-fallback",
      "turn-rich-fallback",
      "inProgress"
    );
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-rich-fallback",
      turnId: "turn-rich-fallback",
      status: "completed"
    });

    assert.equal(sentRichMessages.length, 0);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /Fallback answer/u);
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
      chatId: "chat-1",
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

test("TurnCoordinator prefers trailing review findings over the exited-review summary line", async () => {
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
                review: "The patch fixes one split-turn review case."
              },
              {
                type: "agentMessage",
                phase: null,
                text: [
                  "The patch fixes one split-turn review case, but it can now return stale results from an older review in the same thread.",
                  "",
                  "- [P1] Correlate review fallback with the current review run"
                ].join("\n")
              }
            ]
          }]
        }
      } as any)
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
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
    assert.match(sentHtmlMessages[0]?.html ?? "", /Correlate review fallback with the current review run/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /^The patch fixes one split-turn review case\.$/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator delivers review outer turn results from the durable inner turn", async () => {
  let resumeCount = 0;
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        resumeCount += 1;
        return {
          thread: {
            id: "thread-review",
            turns: resumeCount === 1 ? [] : [{
              id: "019d0fe8-e2bd-73a3-886a-2a2c7444045b",
              status: "completed",
              items: [
                {
                  type: "exitedReviewMode",
                  review: "The review found a missing regression test for split-turn recovery."
                },
                {
                  type: "agentMessage",
                  phase: null,
                  text: "The review found a missing regression test for split-turn recovery."
                }
              ]
            }]
          }
        } as any;
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "019d0fe8-dc95-7b10-91c6-e462e5f731d7", "inProgress", undefined, {
      mode: "review"
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "019d0fe8-dc95-7b10-91c6-e462e5f731d7",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /missing regression test for split-turn recovery/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator delivers split-turn review findings from live review items even before durable history catches up", async () => {
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-review",
          turns: []
        }
      } as any)
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "outer-turn", "inProgress", undefined, {
      mode: "review"
    });
    await coordinator.handleAppServerNotification("item/completed", {
      threadId: "thread-review",
      turnId: "inner-turn",
      item: {
        id: "review-exit",
        type: "exitedReviewMode",
        review: "The patch fixes one split-turn review case."
      }
    });
    await coordinator.handleAppServerNotification("item/completed", {
      threadId: "thread-review",
      turnId: "inner-turn",
      item: {
        id: "review-message",
        type: "agentMessage",
        phase: null,
        text: [
          "The patch fixes one split-turn review case, but it can now return stale results from an older review in the same thread.",
          "",
          "- [P1] Correlate review fallback without UUIDv7 ordering assumptions"
        ].join("\n")
      }
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "outer-turn",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /Correlate review fallback without UUIDv7 ordering assumptions/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator uses the observed live review turn id instead of UUID ordering assumptions", async () => {
  let resumeCount = 0;
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        resumeCount += 1;
        return {
          thread: {
            id: "thread-review",
            turns: resumeCount === 1
              ? []
              : [{
                id: "inner-turn",
                status: "completed",
                items: [
                  {
                    type: "exitedReviewMode",
                    review: ""
                  },
                  {
                    type: "agentMessage",
                    phase: null,
                    text: "The review finished without inline findings but included a trailing summary."
                  }
                ]
              }]
          }
        } as any;
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "outer-turn", "inProgress", undefined, {
      mode: "review"
    });
    await coordinator.handleAppServerNotification("item/completed", {
      threadId: "thread-review",
      turnId: "inner-turn",
      item: {
        id: "review-exit",
        type: "exitedReviewMode",
        review: ""
      }
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "outer-turn",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /included a trailing summary/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator ignores subagent turns when tracking review result candidates", async () => {
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-review",
          turns: []
        }
      } as any)
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "outer-turn", "inProgress", undefined, {
      mode: "review"
    });
    await coordinator.handleAppServerNotification("item/started", {
      threadId: "thread-review",
      turnId: "outer-turn",
      item: {
        id: "collab-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-1"],
        agentsStates: {
          "thread-sub-1": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    });
    await coordinator.handleAppServerNotification("turn/started", {
      threadId: "thread-sub-1",
      turn: { id: "turn-sub-1" }
    });
    await coordinator.handleAppServerNotification("item/completed", {
      threadId: "thread-sub-1",
      turnId: "turn-sub-1",
      item: {
        id: "subagent-final",
        type: "agentMessage",
        phase: null,
        text: "This subagent text must not be delivered as the review result."
      }
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "outer-turn",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /subagent text must not be delivered/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator delivers review outer turn trailing agent text when the durable inner review is empty", async () => {
  let resumeCount = 0;
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        resumeCount += 1;
        return {
          thread: {
            id: "thread-review",
            turns: resumeCount === 1 ? [] : [{
              id: "019d0fe8-e2bd-73a3-886a-2a2c7444045b",
              status: "completed",
              items: [
                {
                  type: "exitedReviewMode",
                  review: ""
                },
                {
                  type: "agentMessage",
                  phase: null,
                  text: "The review finished without inline findings but included a trailing summary."
                }
              ]
            }]
          }
        } as any;
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "019d0fe8-dc95-7b10-91c6-e462e5f731d7", "inProgress", undefined, {
      mode: "review"
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "019d0fe8-dc95-7b10-91c6-e462e5f731d7",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /included a trailing summary/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator does not reuse an older completed review when the current review result turn is still missing", async () => {
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-review",
          turns: [{
            id: "turn-review-old",
            status: "completed",
            items: [{
              type: "exitedReviewMode",
              review: "This stale review must not be delivered for the new run."
            }]
          }]
        }
      } as any)
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "019d0fe8-dc95-7b10-91c6-e462e5f731d7", "inProgress", undefined, {
      mode: "review"
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "019d0fe8-dc95-7b10-91c6-e462e5f731d7",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /stale review must not be delivered/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator captures early review notifications that arrive before baseline history capture completes", async () => {
  let resumeCount = 0;
  let releaseBaselineCapture!: () => void;
  const baselineCaptureGate = new Promise<void>((resolve) => {
    releaseBaselineCapture = resolve;
  });
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        resumeCount += 1;
        if (resumeCount === 1) {
          await baselineCaptureGate;
        }
        return {
          thread: {
            id: "thread-review",
            turns: []
          }
        } as any;
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    const beginActiveTurn = coordinator.beginActiveTurn(
      "chat-1",
      session,
      "thread-review",
      "outer-turn",
      "inProgress",
      undefined,
      { mode: "review" }
    );
    await coordinator.handleAppServerNotification("item/completed", {
      threadId: "thread-review",
      turnId: "inner-turn",
      item: {
        id: "review-message",
        type: "exitedReviewMode",
        review: "",
      }
    });
    await coordinator.handleAppServerNotification("item/completed", {
      threadId: "thread-review",
      turnId: "inner-turn",
      item: {
        id: "review-message",
        type: "agentMessage",
        phase: null,
        text: "Early review completion should not be dropped."
      }
    });
    const completed = coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "outer-turn",
      status: "completed"
    });
    releaseBaselineCapture();
    await Promise.all([beginActiveTurn, completed]);

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(store.getSessionById(session.sessionId)?.status, "idle");
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /Early review completion should not be dropped/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator ignores delayed pre-existing review turns when resolving preferred review history turns", async () => {
  let resumeCount = 0;
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        resumeCount += 1;
        if (resumeCount === 1) {
          return {
            thread: {
              id: "thread-review",
              turns: [{
                id: "turn-review-old",
                status: "completed",
                items: [{
                  type: "exitedReviewMode",
                  review: "Old review output must not win preferred-turn recovery."
                }]
              }]
            }
          } as any;
        }

        return {
          thread: {
            id: "thread-review",
            turns: [
              {
                id: "turn-review-old",
                status: "completed",
                items: [{
                  type: "exitedReviewMode",
                  review: "Old review output must not win preferred-turn recovery."
                }]
              },
              {
                id: "outer-turn",
                status: "completed",
                items: [{
                  type: "exitedReviewMode",
                  review: "Fresh review output from this run."
                }]
              }
            ]
          }
        } as any;
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "outer-turn", "inProgress", undefined, {
      mode: "review"
    });
    await coordinator.handleAppServerNotification("item/completed", {
      threadId: "thread-review",
      turnId: "turn-review-old",
      item: {
        id: "stale-review-exit",
        type: "exitedReviewMode",
        review: "Old review output must not win preferred-turn recovery."
      }
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "outer-turn",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /Fresh review output from this run/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /Old review output must not win preferred-turn recovery/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator disables review fallback and preferred history reuse when baseline capture fails", async () => {
  let resumeCount = 0;
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => {
        resumeCount += 1;
        if (resumeCount === 1) {
          throw new Error("baseline capture timed out");
        }

        return {
          thread: {
            id: "thread-review",
            turns: [{
              id: "turn-review-old",
              status: "completed",
              items: [{
                type: "exitedReviewMode",
                review: "Old review output must not be reused after baseline failure."
              }]
            }]
          }
        } as any;
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-review", "outer-turn", "inProgress", undefined, {
      mode: "review"
    });
    await coordinator.handleAppServerNotification("turn/started", {
      threadId: "thread-review",
      turn: { id: "turn-review-old" }
    });
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-review",
      turnId: "outer-turn",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.doesNotMatch(
      sentHtmlMessages[0]?.html ?? "",
      /Old review output must not be reused after baseline failure/u
    );
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator keeps non-review trailing agent text out of final-answer recovery", async () => {
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-non-review",
          turns: [{
            id: "turn-non-review",
            items: [{
              type: "agentMessage",
              phase: null,
              text: "This intermediate text should stay hidden from Telegram."
            }]
          }]
        }
      } as any)
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Non Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-non-review", "turn-non-review", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-non-review",
      turnId: "turn-non-review",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /This intermediate text should stay hidden/u);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator does not bind a non-review outer turn to a neighboring review result turn", async () => {
  const { coordinator, store, sentHtmlMessages, finalizedHandoffs, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-non-review",
          turns: [{
            id: "turn-neighbor-review",
            status: "completed",
            items: [{
              type: "exitedReviewMode",
              review: "This neighboring review result should not be reused."
            }]
          }]
        }
      } as any)
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      displayName: "Session Non Review",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-non-review", "turn-non-review", "inProgress");
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-non-review",
      turnId: "turn-non-review",
      status: "completed"
    });

    assert.equal(coordinator.getActiveTurn(), null);
    assert.equal(sentHtmlMessages.length, 1);
    assert.match(sentHtmlMessages[0]?.html ?? "", /没有可返回的最终答复/u);
    assert.doesNotMatch(sentHtmlMessages[0]?.html ?? "", /neighboring review result should not be reused/u);
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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
    assert.equal(views[0]?.deliveryMessageId, 1);
    assert.equal(views[0]?.kind, "plan_result");
    assert.equal(views[0]?.deliveryState, "visible");
    assert.deepEqual(reanchorReasons, []);
    assert.deepEqual(finalizedHandoffs, [{ chatId: "chat-1", sessionId: session.sessionId }]);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator sends plan results as native rich Markdown with implementation actions", async () => {
  const planMarkdown = "## Plan\n\n| Step | State |\n| --- | --- |\n| Ship | Ready |";
  const { coordinator, store, sentHtmlMessages, sentRichMessages, cleanup } = await createCoordinatorContext({
    appServer: {
      resumeThread: async () => ({
        thread: {
          id: "thread-rich-plan",
          turns: [{ id: "turn-rich-plan", items: [{ type: "plan", text: planMarkdown }] }]
        }
      })
    },
    safeSendRichMarkdownMessageResult: async () => ({ messageId: 92 })
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      planMode: true
    });

    await coordinator.beginActiveTurn(
      "chat-1",
      session,
      "thread-rich-plan",
      "turn-rich-plan",
      "inProgress"
    );
    await coordinator.handleAppServerNotification("turn/completed", {
      threadId: "thread-rich-plan",
      turnId: "turn-rich-plan",
      status: "completed"
    });

    assert.equal(sentHtmlMessages.length, 0);
    assert.equal(sentRichMessages[0]?.markdown, planMarkdown);
    assert.equal(sentRichMessages[0]?.replyMarkup?.inline_keyboard[0]?.[0]?.text, "实施这个计划");
    assert.equal(store.listFinalAnswerViews("chat-1")[0]?.deliveryMessageId, 92);
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
      return sendAttempt === 1 ? null : { messageId: 1 };
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
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
    assert.equal(views[0]?.deliveryMessageId, null);
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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
      chatId: "chat-1",
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

test("TurnCoordinator handles send_telegram_document tool calls by sending documents and replying success", async () => {
  const requestErrors: Array<{ id: string; code: number; message: string }> = [];
  const requestResults: Array<{ id: string; payload: unknown }> = [];
  const { coordinator, store, sentDocuments, cleanup } = await createCoordinatorContext({
    appServer: {
      respondToServerRequest: async (id, payload) => {
        requestResults.push({ id: `${id}`, payload });
      },
      respondToServerRequestError: async (id, code, message) => {
        requestErrors.push({ id: `${id}`, code, message });
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-tool", "turn-tool", "inProgress");

    await coordinator.handleAppServerServerRequest({
      id: "tool-call-1",
      method: "item/tool/call",
      params: {
        threadId: "thread-tool",
        turnId: "turn-tool",
        tool: "send_telegram_document",
        arguments: {
          path: "/tmp/tool-output.zip",
          caption: "artifact <a&b>",
          filename: "tool-output.zip"
        }
      }
    });

    assert.deepEqual(requestErrors, []);
    assert.deepEqual(sentDocuments, [{
      chatId: "chat-1",
      filePath: "/tmp/tool-output.zip",
      options: {
        caption: "artifact <a&b>",
        fileName: "tool-output.zip"
      }
    }]);
    assert.equal(requestResults.length, 1);
    assert.match(JSON.stringify(requestResults[0]?.payload ?? {}), /"success":true/u);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator rejects send_telegram_document when the pack blocks uploads", async () => {
  const requestResults: Array<{ id: string; payload: unknown }> = [];
  const { coordinator, store, sentDocuments, cleanup } = await createCoordinatorContext({
    appServer: {
      respondToServerRequest: async (id, payload) => {
        requestResults.push({ id: `${id}`, payload });
      }
    },
    sendControlSurfaceFile: async () => ({
      action: "send_control_surface_file",
      outcome: "failed",
      reason: "capability_blocked",
      deliveryRef: { messageId: null }
    })
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-tool-blocked", "turn-tool-blocked", "inProgress");

    await coordinator.handleAppServerServerRequest({
      id: "tool-call-2",
      method: "item/tool/call",
      params: {
        threadId: "thread-tool-blocked",
        turnId: "turn-tool-blocked",
        tool: "send_telegram_document",
        arguments: {
          path: "/tmp/tool-output.zip"
        }
      }
    });

    assert.deepEqual(sentDocuments, []);
    assert.equal(requestResults.length, 1);
    assert.match(JSON.stringify(requestResults[0]?.payload ?? {}), /"success":false/u);
    assert.match(JSON.stringify(requestResults[0]?.payload ?? {}), /does not allow control-surface file delivery/u);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator handles send_telegram_image tool calls by sending images and replying success", async () => {
  const requestResults: Array<{ id: string; payload: unknown }> = [];
  const { coordinator, store, sentImages, cleanup } = await createCoordinatorContext({
    appServer: {
      respondToServerRequest: async (id, payload) => {
        requestResults.push({ id: `${id}`, payload });
      }
    }
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-image", "turn-image", "inProgress");

    await coordinator.handleAppServerServerRequest({
      id: "tool-call-image",
      method: "item/tool/call",
      params: {
        threadId: "thread-image",
        turnId: "turn-image",
        tool: "send_telegram_image",
        arguments: {
          path: "/tmp/preview.png",
          caption: "preview"
        }
      }
    });

    assert.deepEqual(sentImages, [{
      chatId: "chat-1",
      imagePath: "/tmp/preview.png",
      options: {
        caption: "preview"
      }
    }]);
    assert.equal(requestResults.length, 1);
    assert.match(JSON.stringify(requestResults[0]?.payload ?? {}), /"success":true/u);
    assert.match(JSON.stringify(requestResults[0]?.payload ?? {}), /Image sent to the active control surface/u);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator rejects platform actions when runtime tool availability blocks the tool", async () => {
  const requestResults: Array<{ id: string; payload: unknown }> = [];
  const { coordinator, store, sentImages, cleanup } = await createCoordinatorContext({
    appServer: {
      respondToServerRequest: async (id, payload) => {
        requestResults.push({ id: `${id}`, payload });
      }
    },
    getDynamicToolAvailability: (toolName) => toolName === "send_telegram_image"
      ? {
        enabled: false,
        failureText: "The current Feishu pack upload health does not allow image delivery."
      }
      : null
  });

  try {
    const session = store.createSession({
      chatId: "chat-1",
      projectName: "Project One",
      projectPath: "/tmp/project-one"
    });

    await coordinator.beginActiveTurn("chat-1", session, "thread-image-gated", "turn-image-gated", "inProgress");

    await coordinator.handleAppServerServerRequest({
      id: "tool-call-image-gated",
      method: "item/tool/call",
      params: {
        threadId: "thread-image-gated",
        turnId: "turn-image-gated",
        tool: "send_telegram_image",
        arguments: {
          path: "/tmp/preview.png"
        }
      }
    });

    assert.deepEqual(sentImages, []);
    assert.equal(requestResults.length, 1);
    assert.match(JSON.stringify(requestResults[0]?.payload ?? {}), /"success":false/u);
    assert.match(JSON.stringify(requestResults[0]?.payload ?? {}), /does not allow image delivery/u);
  } finally {
    await cleanup();
  }
});

test("TurnCoordinator rejects unknown dynamic tool calls and journals the rejection", async () => {
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
      chatId: "chat-1",
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
      message: "Dynamic tool call is not supported by the active bridge pack: view_image"
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
      chatId: "chat-1",
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
