import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { BridgeStateStore } from "../state/store.js";
import { RichInputAdapter } from "./rich-input-adapter.js";

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
  telegramPollIntervalMs: 1500,
  projectScanRoots: [],
  voiceInputEnabled: false,
  voiceOpenaiApiKey: "",
  voiceOpenaiTranscribeModel: "gpt-4o-mini-transcribe",
  voiceFfmpegBin: "ffmpeg"
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

function authorizeChatWithSession(store: BridgeStateStore, chatId: string, projectPath = "/tmp/project-one") {
  store.upsertPendingAuthorization({
    telegramUserId: chatId,
    telegramChatId: chatId,
    telegramUsername: "tester",
    displayName: "Tester"
  });
  const candidate = store.listPendingAuthorizations()[0];
  if (!candidate) {
    throw new Error("expected pending authorization candidate");
  }
  store.confirmPendingAuthorization(candidate);

  const session = store.createSession({
    telegramChatId: chatId,
    projectName: "Project One",
    projectPath,
    displayName: "Project One"
  });
  store.setActiveSession(chatId, session.sessionId);
  return store.getSessionById(session.sessionId) ?? session;
}

async function createAdapterContext(options: {
  config?: BridgeConfig;
  api?: Record<string, unknown>;
  getBlockedTurnSteerAvailability?: () => { kind: "available"; threadId: string; turnId: string } | { kind: "interaction_pending" } | { kind: "busy" };
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "ctb-rich-input-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  const sentMessages: string[] = [];
  const startTextTurns: Array<{ chatId: string; sessionId: string; text: string; transcript?: string }> = [];
  const startStructuredTurns: Array<{ chatId: string; sessionId: string; input: unknown[] }> = [];
  const pendingInteractionNotices: string[] = [];

  const adapter = new RichInputAdapter({
    getStore: () => store,
    getApi: () => options.api as never,
    ensureAppServerAvailable: async () => ({
      steerTurn: async () => {},
      readThread: async () => ({ thread: { turns: [] } }),
      startThread: async () => ({ thread: { id: "temp-thread" } }),
      startThreadRealtime: async () => {},
      appendThreadRealtimeAudio: async () => {},
      stopThreadRealtime: async () => {},
      archiveThread: async () => {}
    }) as never,
    fetchAllModels: async () => [{
      id: "gpt-realtime",
      model: "gpt-realtime",
      displayName: "GPT Realtime",
      description: "Realtime model",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Default" }],
      inputModalities: ["audio"]
    }] as never,
    extractFinalAnswerFromHistory: async () => "transcript",
    logger: testLogger,
    config: {
      ...(options.config ?? testConfig)
    },
    paths: {
      cacheDir: paths.cacheDir
    },
    isStopping: () => false,
    sleep: async () => {},
    getBlockedTurnSteerAvailability: () =>
      options.getBlockedTurnSteerAvailability?.() ?? { kind: "busy" },
    sendPendingInteractionBlockNotice: async (chatId) => {
      pendingInteractionNotices.push(chatId);
    },
    startTextTurn: async (chatId, session, text, extra) => {
      const turn: { chatId: string; sessionId: string; text: string; transcript?: string } = {
        chatId,
        sessionId: session.sessionId,
        text
      };
      if (extra?.transcript) {
        turn.transcript = extra.transcript;
      }
      startTextTurns.push(turn);
    },
    startStructuredTurn: async (chatId, session, input) => {
      startStructuredTurns.push({
        chatId,
        sessionId: session.sessionId,
        input
      });
    },
    safeSendMessage: async (_chatId, text) => {
      sentMessages.push(text);
      return true;
    }
  });

  return {
    adapter,
    store,
    paths,
    sentMessages,
    startTextTurns,
    startStructuredTurns,
    pendingInteractionNotices,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("RichInputAdapter sends /local_image as a structured localImage turn with prompt text", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ctb-local-image-owner-test-"));
  const { adapter, store, startStructuredTurns, cleanup } = await createAdapterContext();

  try {
    authorizeChatWithSession(store, "1", projectRoot);
    await writeFile(join(projectRoot, "diagram.png"), "fake-png", "utf8");

    await adapter.handleLocalImage("1", "diagram.png :: explain the image");

    assert.deepEqual(startStructuredTurns, [{
      chatId: "1",
      sessionId: store.getActiveSession("1")!.sessionId,
      input: [
        { type: "localImage", path: join(projectRoot, "diagram.png") },
        { type: "text", text: "explain the image" }
      ]
    }]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await cleanup();
  }
});

test("RichInputAdapter sends /mention as a structured mention turn", async () => {
  const { adapter, store, startStructuredTurns, cleanup } = await createAdapterContext();

  try {
    authorizeChatWithSession(store, "1");

    await adapter.handleMention("1", "Docs | app://docs/reference :: use this context");

    assert.deepEqual(startStructuredTurns, [{
      chatId: "1",
      sessionId: store.getActiveSession("1")!.sessionId,
      input: [
        { type: "mention", name: "Docs", path: "app://docs/reference" },
        { type: "text", text: "use this context" }
      ]
    }]);
  } finally {
    await cleanup();
  }
});

test("RichInputAdapter does not queue rich input while a running turn is blocked by a pending interaction", async () => {
  const { adapter, store, pendingInteractionNotices, cleanup } = await createAdapterContext({
    getBlockedTurnSteerAvailability: () => ({ kind: "interaction_pending" })
  });

  try {
    const session = authorizeChatWithSession(store, "1");
    store.updateSessionStatus(session.sessionId, "running", {
      lastTurnId: "turn-1",
      lastTurnStatus: "inProgress"
    });
    const runningSession = store.getSessionById(session.sessionId)!;

    await adapter.submitOrQueueRichInput(
      "1",
      runningSession,
      [{ type: "mention", name: "Docs", path: "app://docs/reference" }],
      null,
      "引用：Docs"
    );

    assert.deepEqual(pendingInteractionNotices, ["1"]);
    assert.equal(adapter.hasPendingRichInputComposer("1"), false);
  } finally {
    await cleanup();
  }
});

test("RichInputAdapter voice processing stays in the background so later structured input is not blocked", async () => {
  const voiceEnabledConfig: BridgeConfig = {
    ...testConfig,
    voiceInputEnabled: true
  };
  const { adapter, store, sentMessages, startStructuredTurns, cleanup } = await createAdapterContext({
    config: voiceEnabledConfig,
    api: {
      getFile: async () => ({
        file_id: "voice-1",
        file_path: "voice.ogg"
      }),
      downloadFile: async () => "/tmp/voice.ogg"
    }
  });
  let releaseVoiceTask!: () => void;
  const voiceTaskGate = new Promise<void>((resolve) => {
    releaseVoiceTask = resolve;
  });

  try {
    authorizeChatWithSession(store, "1");
    (adapter as any).processQueuedVoiceTask = async () => {
      await voiceTaskGate;
    };

    await adapter.handleVoiceMessage("1", {
      message_id: 1,
      from: { id: 1, is_bot: false, first_name: "Tester" },
      chat: { id: 1, type: "private" },
      date: 0,
      voice: {
        file_id: "voice-1",
        duration: 3
      }
    } as never);

    await adapter.handleMention("1", "Docs | app://docs/reference :: use this context");

    assert.match(sentMessages[0] ?? "", /已收到语音，正在转写/u);
    assert.equal(startStructuredTurns.length, 1);
    assert.deepEqual(startStructuredTurns[0]?.input, [
      { type: "mention", name: "Docs", path: "app://docs/reference" },
      { type: "text", text: "use this context" }
    ]);

    releaseVoiceTask();
    await (adapter as any).voiceTaskQueue;
  } finally {
    await cleanup();
  }
});
