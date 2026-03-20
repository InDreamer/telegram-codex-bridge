import { basename } from "node:path";

import { createLogger, type Logger } from "./logger.js";
import { TurnDebugJournal, type DebugJournalWriter } from "./activity/debug-journal.js";
import { ensureBridgeDirectories, getBridgePaths, getDebugRuntimeDir, type BridgePaths } from "./paths.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { probeReadiness } from "./readiness.js";
import { routeBridgeCallback } from "./service/callback-router.js";
import { CodexCommandCoordinator } from "./service/codex-command-coordinator.js";
import { routeBridgeCommand } from "./service/command-router.js";
import {
  InteractionBroker,
  type InteractionResolutionSource,
  type PendingInteractionTerminalState
} from "./service/interaction-broker.js";
import { RichInputAdapter } from "./service/rich-input-adapter.js";
import { ProjectBrowserCoordinator } from "./service/project-browser-coordinator.js";
import { RuntimeNoticeBroadcaster } from "./service/runtime-notice-broadcaster.js";
import { RuntimeSurfaceController } from "./service/runtime-surface-controller.js";
import { RuntimeSurfaceTraceSink } from "./service/runtime-surface-trace-sink.js";
import { SessionProjectCoordinator } from "./service/session-project-coordinator.js";
import { SubagentIdentityBackfiller } from "./service/subagent-identity-backfiller.js";
import {
  ThreadArchiveReconciler,
  type PendingThreadArchiveOp
} from "./service/thread-archive-reconciler.js";
import {
  formatRuntimeBlockedReason,
  type ErrorCardState,
  type RuntimeCardMessageState,
  selectStatusProgressText,
  type StatusCardState,
  type TelegramEditResult
} from "./service/runtime-surface-state.js";
import { extractFinalAnswerFromHistory } from "./service/turn-artifacts.js";
import { TurnCoordinator } from "./service/turn-coordinator.js";
import { BridgeStateStore, StateStoreOpenError } from "./state/store.js";
import { TelegramApi, TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate
} from "./telegram/api.js";
import { TelegramPoller } from "./telegram/poller.js";
import { ActivityTracker } from "./activity/tracker.js";
import type { ActivityStatus, DebugJournalRecord, InspectSnapshot } from "./activity/types.js";
import { classifyNotification } from "./codex/notification-classifier.js";
import type { JsonRpcServerRequest, UserInput } from "./codex/app-server.js";
import {
  buildProjectSelectedText,
  buildRuntimeErrorCard,
  buildRuntimeStatusReplyMarkup,
  buildRuntimeStatusCard,
  buildUnsupportedCommandText,
  encodeLanguageCloseCallback,
  encodeLanguageSetCallback,
  formatReasoningEffortLabel,
  type ParsedCallbackData,
  parseCallbackData,
  parseCommand,
  type RuntimeCommandEntryView
} from "./telegram/ui.js";
import { buildHelpText, syncTelegramCommands } from "./telegram/commands.js";
import {
  DEFAULT_RUNTIME_STATUS_FIELDS,
  isOperationalReadinessState,
  type ReasoningEffort,
  type RuntimeStatusField,
  PendingInteractionRow,
  ReadinessSnapshot,
  SessionRow,
  UiLanguage
} from "./types.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import { asRecord, getString, getNumber, getArray } from "./util/untyped.js";
import { normalizeAndTruncate } from "./util/text.js";

interface RecentActivityEntry {
  tracker: ActivityTracker;
  debugFilePath: string | null;
  statusCard: StatusCardState | null;
}

interface InspectRenderPayload {
  snapshot: InspectSnapshot;
  commands: RuntimeCommandEntryView[];
  note: string | null;
}

const HISTORY_SUMMARY_LIMIT = 5;
const HISTORY_TEXT_LIMIT = 220;

const MAX_RECENT_ACTIVITY_ENTRIES = 20;
const TELEGRAM_SEND_RETRY_DELAYS_MS = [750, 2_000] as const;
const TELEGRAM_SEND_MAX_RETRY_AFTER_MS = 10_000;
const TELEGRAM_IMAGE_CACHE_DIRNAME = "telegram-images";
const TELEGRAM_IMAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const TELEGRAM_VOICE_CACHE_DIRNAME = "telegram-voice";
const OPENAI_AUDIO_TRANSCRIPT_URL = "https://api.openai.com/v1/audio/transcriptions";
const VOICE_PCM_SAMPLE_RATE = 16_000;
const VOICE_PCM_NUM_CHANNELS = 1;
const VOICE_PCM_BYTES_PER_SAMPLE = 2;
const VOICE_REALTIME_CHUNK_BYTES = 32_000;
const VOICE_REALTIME_WAIT_TIMEOUT_MS = 30_000;
const VOICE_REALTIME_POLL_INTERVAL_MS = 1_000;
const VOICE_REALTIME_TRANSCRIPTION_PROMPT = "请逐字转写收到的语音，只返回转写文本，不要解释。";
const CODEX_CLI_STATUS_LINE_BASELINE_TOKENS = 12_000;

interface BridgeServiceDependencies {
  probeReadiness?: typeof probeReadiness;
  createTelegramApi?: (token: string, baseUrl: string) => TelegramApi;
  createPoller?: (
    api: TelegramApi,
    config: BridgeConfig,
    paths: BridgePaths,
    logger: Logger,
    onUpdate: (update: TelegramUpdate) => Promise<void>
  ) => TelegramPoller;
  sleep?: (delayMs: number) => Promise<void>;
}

interface ActiveTurnState {
  sessionId: string;
  chatId: string;
  threadId: string;
  turnId: string;
  startedInPlanMode: boolean;
  finalMessage: string | null;
  effectiveModel: string | null;
  effectiveReasoningEffort: ReasoningEffort | null;
  effectiveReasoningEffortPinned: boolean;
  tracker: ActivityTracker;
  debugJournal: DebugJournalWriter;
  statusCard: StatusCardState;
  latestStatusProgressText: string | null;
  latestPlanFingerprint: string;
  latestAgentFingerprint: string;
  subagentIdentityBackfillStates: Map<string, "pending" | "resolved" | "exhausted">;
  errorCards: ErrorCardState[];
  nextErrorCardId: number;
  surfaceQueue: Promise<void>;
}

function displayName(message: TelegramMessage): string | null {
  if (!message.from) {
    return null;
  }

  const parts = [message.from.first_name, message.from.last_name].filter(Boolean);
  return parts.join(" ").trim() || message.from.username || null;
}

export class BridgeService {
  private readonly logger: Logger;
  private readonly bootstrapLogger: Logger;
  private readonly runtimeCardTraceLoggers: Record<RuntimeCardMessageState["surface"], Logger>;
  private readonly codexCommandCoordinator: CodexCommandCoordinator;
  private readonly interactionBroker: InteractionBroker;
  private readonly richInputAdapter: RichInputAdapter;
  private readonly projectBrowserCoordinator: ProjectBrowserCoordinator;
  private readonly runtimeNoticeBroadcaster: RuntimeNoticeBroadcaster;
  private readonly runtimeSurfaceController: RuntimeSurfaceController;
  private readonly runtimeSurfaceTraceSink: RuntimeSurfaceTraceSink;
  private readonly sessionProjectCoordinator: SessionProjectCoordinator;
  private readonly subagentIdentityBackfiller: SubagentIdentityBackfiller;
  private readonly threadArchiveReconciler: ThreadArchiveReconciler;
  private readonly turnCoordinator: TurnCoordinator;
  private poller: TelegramPoller | null = null;
  private api: TelegramApi | null = null;
  private store: BridgeStateStore | null = null;
  private snapshot: ReadinessSnapshot | null = null;
  private appServer: CodexAppServerClient | null = null;
  private readonly unauthorizedReplyAt = new Map<string, number>();
  private stopping = false;

  constructor(
    private readonly paths: BridgePaths,
    private readonly config: BridgeConfig,
    private readonly deps: BridgeServiceDependencies = {}
  ) {
    this.logger = createLogger("bridge", paths.bridgeLogPath);
    this.bootstrapLogger = createLogger("bootstrap", paths.bootstrapLogPath);
    this.runtimeCardTraceLoggers = {
      status: createLogger("telegram-session-status-card", paths.telegramStatusCardLogPath, {
        mirrorToConsole: false
      }),
      plan: createLogger("telegram-session-plan-card", paths.telegramPlanCardLogPath, {
        mirrorToConsole: false
      }),
      error: createLogger("telegram-session-error-card", paths.telegramErrorCardLogPath, {
        mirrorToConsole: false
      })
    };
    this.runtimeSurfaceTraceSink = new RuntimeSurfaceTraceSink({
      logger: {
        info: async (message, meta) => this.logger.info(message, meta),
        warn: async (message, meta) => this.logger.warn(message, meta),
        error: async (message, meta) => this.logger.error(message, meta)
      },
      traceLoggers: this.runtimeCardTraceLoggers
    });
    this.runtimeNoticeBroadcaster = new RuntimeNoticeBroadcaster({
      getStore: () => this.store,
      safeSendMessage: async (chatId, text) => this.safeSendMessage(chatId, text)
    });
    this.threadArchiveReconciler = new ThreadArchiveReconciler({
      logger: {
        info: async (message, meta) => this.logger.info(message, meta),
        warn: async (message, meta) => this.logger.warn(message, meta),
        error: async (message, meta) => this.logger.error(message, meta)
      },
      getStore: () => this.store
    });
    this.subagentIdentityBackfiller = new SubagentIdentityBackfiller({
      logger: {
        info: async (message, meta) => this.logger.info(message, meta),
        warn: async (message, meta) => this.logger.warn(message, meta),
        error: async (message, meta) => this.logger.error(message, meta)
      },
      getAppServer: () => this.appServer
    });
    this.interactionBroker = new InteractionBroker({
      getStore: () => this.store,
      getAppServer: () => this.appServer,
      logger: this.logger,
      safeSendMessage: async (chatId, text) => this.safeSendMessage(chatId, text),
      safeSendHtmlMessageResult: async (chatId, html, replyMarkup) => this.safeSendHtmlMessageResult(chatId, html, replyMarkup),
      safeEditHtmlMessageText: async (chatId, messageId, html, replyMarkup) => this.safeEditHtmlMessageText(chatId, messageId, html, replyMarkup),
      safeAnswerCallbackQuery: async (callbackQueryId, text) => this.safeAnswerCallbackQuery(callbackQueryId, text),
      appendInteractionCreatedJournal: async (row) => this.appendInteractionCreatedJournal(row),
      appendInteractionResolvedJournal: async (row, resolution) => this.appendInteractionResolvedJournal(row, resolution)
    });
    this.sessionProjectCoordinator = new SessionProjectCoordinator({
      logger: {
        warn: async (message, meta) => this.logger.warn(message, meta)
      },
      paths: { homeDir: this.paths.homeDir },
      config: { projectScanRoots: this.config.projectScanRoots },
      getStore: () => this.store,
      getSnapshot: () => this.snapshot,
      ensureAppServerAvailable: async () => {
        await this.ensureAppServerAvailable();
        if (!this.appServer) {
          throw new Error("app-server unavailable");
        }
        return this.appServer;
      },
      registerPendingThreadArchiveOp: (threadId, sessionId, expectedRemoteState, origin) =>
        this.threadArchiveReconciler.registerPendingOp(threadId, sessionId, expectedRemoteState, origin),
      markPendingThreadArchiveCommit: async (threadId, opId) =>
        this.threadArchiveReconciler.markLocalCommit(threadId, opId),
      dropPendingThreadArchiveOp: (threadId, opId) => {
        this.threadArchiveReconciler.dropPendingOp(threadId, opId);
      },
      safeSendMessage: async (chatId, text, replyMarkup) => this.safeSendMessage(chatId, text, replyMarkup),
      safeSendMessageResult: async (chatId, text, replyMarkup) => this.safeSendMessageResult(chatId, text, replyMarkup),
      safeSendHtmlMessage: async (chatId, text, replyMarkup) => this.safeSendHtmlMessage(chatId, text, replyMarkup),
      safeSendHtmlMessageResult: async (chatId, text, replyMarkup) => this.safeSendHtmlMessageResult(chatId, text, replyMarkup),
      safeEditMessageText: async (chatId, messageId, text, replyMarkup) =>
        this.safeEditMessageText(chatId, messageId, text, replyMarkup),
      safeEditHtmlMessageText: async (chatId, messageId, text, replyMarkup) =>
        this.safeEditHtmlMessageText(chatId, messageId, text, replyMarkup),
      safeDeleteMessage: async (chatId, messageId) => this.safeDeleteMessage(chatId, messageId),
      reanchorRuntimeAfterBridgeReply: async (chatId, sessionId, reason) =>
        this.reanchorRuntimeAfterBridgeReply(chatId, reason, sessionId)
    });
    this.projectBrowserCoordinator = new ProjectBrowserCoordinator({
      getStore: () => this.store,
      safeSendMessage: async (chatId, text, replyMarkup) => this.safeSendMessage(chatId, text, replyMarkup),
      safeSendHtmlMessage: async (chatId, html, replyMarkup) => this.safeSendHtmlMessage(chatId, html, replyMarkup),
      safeSendHtmlMessageResult: async (chatId, html, replyMarkup) => this.safeSendHtmlMessageResult(chatId, html, replyMarkup),
      safeEditHtmlMessageText: async (chatId, messageId, html, replyMarkup) =>
        this.safeEditHtmlMessageText(chatId, messageId, html, replyMarkup),
      safeDeleteMessage: async (chatId, messageId) => this.safeDeleteMessage(chatId, messageId),
      safeAnswerCallbackQuery: async (callbackQueryId, text) => this.safeAnswerCallbackQuery(callbackQueryId, text),
      safeSendPhoto: async (chatId, photoPath, options) => this.safeSendPhoto(chatId, photoPath, options),
      getUiLanguage: () => this.getUiLanguage()
    });
    this.runtimeSurfaceController = new RuntimeSurfaceController({
      logger: this.logger,
      getStore: () => this.store,
      listActiveTurns: () => this.listActiveTurns() as never,
      getActiveInspectActivity: (sessionId) => this.turnCoordinator.getActiveInspectActivity(sessionId) as never,
      getRecentActivity: (sessionId) => this.turnCoordinator.getRecentActivity(sessionId) as never,
      getHistoricalInspectPayload: async (activeSession) => this.buildHistoricalInspectRenderPayload(activeSession),
      buildPendingInteractionSummaries: (activeSession) => this.interactionBroker.buildPendingInteractionSummaries(activeSession),
      buildAnsweredInteractionSummaries: (activeSession) => this.interactionBroker.buildAnsweredInteractionSummaries(activeSession),
      safeSendMessage: async (chatId, text, replyMarkup) => this.safeSendMessage(chatId, text, replyMarkup),
      safeSendHtmlMessage: async (chatId, html, replyMarkup) => this.safeSendHtmlMessage(chatId, html, replyMarkup),
      safeSendHtmlMessageResult: async (chatId, html, replyMarkup) => this.safeSendHtmlMessageResult(chatId, html, replyMarkup),
      safeSendMessageResult: async (chatId, text, replyMarkup) => this.safeSendMessageResult(chatId, text, replyMarkup),
      safeEditHtmlMessageText: async (chatId, messageId, html, replyMarkup) =>
        this.safeEditHtmlMessageText(chatId, messageId, html, replyMarkup),
      safeEditMessageText: async (chatId, messageId, text, replyMarkup) =>
        this.safeEditMessageText(chatId, messageId, text, replyMarkup),
      safeDeleteMessage: async (chatId, messageId) => this.safeDeleteMessage(chatId, messageId),
      safeAnswerCallbackQuery: async (callbackQueryId, text) => this.safeAnswerCallbackQuery(callbackQueryId, text),
      getUiLanguage: () => this.getUiLanguage(),
      getRuntimeCardContext: (sessionId) => this.getRuntimeCardContext(sessionId),
      buildRuntimeStatusLine: (sessionId, inspect) => this.buildRuntimeStatusLine(sessionId, inspect),
      runtimeTraceSink: {
        logRuntimeCardEvent: async (activeTurn, surface, event, meta) =>
          this.runtimeSurfaceTraceSink.logRuntimeCardEvent(activeTurn as ActiveTurnState, surface as RuntimeCardMessageState, event, meta)
      },
      backfillSubagentIdentities: async (activeTurn, agentEntries) =>
        this.subagentIdentityBackfiller.backfill(activeTurn as ActiveTurnState, agentEntries),
      refreshActiveRuntimeStatusCard: async (chatId, reason) => this.refreshActiveRuntimeStatusCard(chatId, reason)
    });
    this.turnCoordinator = new TurnCoordinator({
      paths: { runtimeDir: this.paths.runtimeDir },
      logger: {
        info: async (message, meta) => this.logger.info(message, meta),
        warn: async (message, meta) => this.logger.warn(message, meta),
        error: async (message, meta) => this.logger.error(message, meta)
      },
      getStore: () => this.store,
      getAppServer: () => this.appServer,
      ensureAppServerAvailable: async () => this.ensureAppServerAvailable(),
      fetchAllModels: async () => this.fetchAllModels(),
      interactionBroker: {
        getBlockedTurnSteerAvailability: (chatId, session, activeTurn) =>
          this.interactionBroker.getBlockedTurnSteerAvailability(chatId, session, activeTurn),
        handleNormalizedServerRequest: async (request, normalized, activeTurn) =>
          this.interactionBroker.handleNormalizedServerRequest(request, normalized, activeTurn),
        handleServerRequestResolvedNotification: async (threadId, requestId) =>
          this.interactionBroker.handleServerRequestResolvedNotification(threadId, requestId),
        resolveActionablePendingInteractionsForSession: async (chatId, sessionId, options) =>
          this.interactionBroker.resolveActionablePendingInteractionsForSession(chatId, sessionId, options)
      },
      syncRuntimeCards: async (activeTurn, classified, previousStatus, nextStatus, options) =>
        this.runtimeSurfaceController.syncRuntimeCards(
          activeTurn as ActiveTurnState,
          classified,
          previousStatus,
          nextStatus,
          options
        ),
      runRuntimeCardOperation: async (activeTurn, operation) =>
        this.runtimeSurfaceController.runRuntimeCardOperation(activeTurn as ActiveTurnState, operation),
      reanchorStatusCardToLatestMessage: async (activeTurn, reason) =>
        this.runtimeSurfaceController.reanchorStatusCardToLatestMessage(activeTurn as ActiveTurnState, reason),
      reanchorRuntimeAfterBridgeReply: async (chatId, reason) =>
        this.reanchorRuntimeAfterBridgeReply(chatId, reason),
      disposeRuntimeCards: (activeTurn) =>
        this.runtimeSurfaceController.disposeRuntimeCards(activeTurn as ActiveTurnState),
      safeSendMessage: async (chatId, text) => this.safeSendMessage(chatId, text),
      safeSendHtmlMessageResult: async (chatId, html, replyMarkup) =>
        this.safeSendHtmlMessageResult(chatId, html, replyMarkup),
      handleGlobalRuntimeNotice: async (notification) => this.runtimeNoticeBroadcaster.broadcast(notification),
      handleThreadArchiveNotification: async (classified) => this.threadArchiveReconciler.handleNotification(classified)
    });
    this.richInputAdapter = new RichInputAdapter({
      getStore: () => this.store,
      getApi: () => this.api,
      ensureAppServerAvailable: async () => {
        await this.ensureAppServerAvailable();
        if (!this.appServer) {
          throw new Error("app-server unavailable");
        }
        return this.appServer;
      },
      fetchAllModels: async () => this.fetchAllModels(),
      extractFinalAnswerFromHistory: async (appServer, threadId, turnId) =>
        extractFinalAnswerFromHistory(appServer, threadId, turnId),
      logger: this.logger,
      config: {
        voiceInputEnabled: this.config.voiceInputEnabled,
        voiceOpenaiApiKey: this.config.voiceOpenaiApiKey,
        voiceOpenaiTranscribeModel: this.config.voiceOpenaiTranscribeModel,
        voiceFfmpegBin: this.config.voiceFfmpegBin
      },
      paths: {
        cacheDir: this.paths.cacheDir
      },
      isStopping: () => this.stopping,
      sleep: async (delayMs) => this.sleep(delayMs),
      getBlockedTurnSteerAvailability: (chatId, session) => {
        const availability = this.turnCoordinator.getBlockedTurnSteerAvailability(chatId, session);
        if (availability.kind !== "available") {
          return availability;
        }

        return {
          kind: "available" as const,
          threadId: availability.activeTurn.threadId,
          turnId: availability.activeTurn.turnId
        };
      },
      sendPendingInteractionBlockNotice: async (chatId) => this.interactionBroker.sendPendingInteractionBlockNotice(chatId),
      startTextTurn: async (chatId, session, text, options) => this.turnCoordinator.startTextTurn(chatId, session, text, options),
      startStructuredTurn: async (chatId, session, input) => this.turnCoordinator.startStructuredTurn(chatId, session, input),
      safeSendMessage: async (chatId, text) => this.safeSendMessage(chatId, text)
    });
    this.codexCommandCoordinator = new CodexCommandCoordinator({
      getStore: () => this.store,
      ensureAppServerAvailable: async () => {
        await this.ensureAppServerAvailable();
        if (!this.appServer) {
          throw new Error("app-server unavailable");
        }
        return this.appServer;
      },
      fetchAllModels: async () => this.fetchAllModels(),
      fetchAllApps: async (threadId) => this.fetchAllApps(threadId),
      fetchAllMcpServerStatuses: async () => this.fetchAllMcpServerStatuses(),
      ensureSessionThread: async (session) => this.turnCoordinator.ensureSessionThread(session),
      beginActiveTurn: async (chatId, session, threadId, turnId, turnStatus) =>
        this.turnCoordinator.beginActiveTurn(chatId, session, threadId, turnId, turnStatus),
      submitOrQueueRichInput: async (chatId, session, inputs, prompt, promptLabel) =>
        this.richInputAdapter.submitOrQueueRichInput(chatId, session, inputs, prompt, promptLabel),
      getRunningTurnCapacity: (chatId) => this.turnCoordinator.getRunningTurnCapacity(chatId),
      clearRecentActivity: (sessionId) => this.turnCoordinator.clearRecentActivity(sessionId),
      safeSendMessage: async (chatId, text, replyMarkup) => this.safeSendMessage(chatId, text, replyMarkup),
      safeSendHtmlMessage: async (chatId, text, replyMarkup) => this.safeSendHtmlMessage(chatId, text, replyMarkup),
      safeEditMessageText: async (chatId, messageId, text, replyMarkup) =>
        this.safeEditMessageText(chatId, messageId, text, replyMarkup),
      safeEditHtmlMessageText: async (chatId, messageId, text, replyMarkup) =>
        this.safeEditHtmlMessageText(chatId, messageId, text, replyMarkup),
      safeAnswerCallbackQuery: async (callbackQueryId, text) => this.safeAnswerCallbackQuery(callbackQueryId, text)
    });
  }

  private getActiveTurnForSession(sessionId: string): ActiveTurnState | null {
    return this.turnCoordinator.getActiveTurnBySessionId(sessionId) as ActiveTurnState | null;
  }

  private getActiveTurnForThread(threadId: string): ActiveTurnState | null {
    return this.turnCoordinator.getActiveTurnByThreadId(threadId) as ActiveTurnState | null;
  }

  private getActiveTurnForChat(chatId: string): ActiveTurnState | null {
    const activeSession = this.store?.getActiveSession(chatId);
    return activeSession ? this.getActiveTurnForSession(activeSession.sessionId) : null;
  }

  private listActiveTurns(): ActiveTurnState[] {
    return this.turnCoordinator.listActiveTurns() as ActiveTurnState[];
  }

  private get activeTurn(): ActiveTurnState | null {
    return this.turnCoordinator.getActiveTurn() as ActiveTurnState | null;
  }

  private get pendingThreadArchiveOps(): ReadonlyMap<string, PendingThreadArchiveOp[]> {
    return this.threadArchiveReconciler.pendingOps;
  }

  async run(): Promise<void> {
    const readinessProbe = this.deps.probeReadiness ?? probeReadiness;
    const createTelegramApi = this.deps.createTelegramApi ?? ((token: string, baseUrl: string) =>
      new TelegramApi(token, baseUrl));
    const createPoller = this.deps.createPoller ?? ((api, config, paths, logger, onUpdate) =>
      new TelegramPoller(api, config, paths, logger, onUpdate));
    try {
      this.store = await BridgeStateStore.open(this.paths, this.bootstrapLogger);
    } catch (error) {
      if (error instanceof StateStoreOpenError) {
        await this.bootstrapLogger.error("state store open prevented service startup", { ...error.failure });
      } else {
        await this.bootstrapLogger.error("state store open prevented service startup", {
          dbPath: this.paths.dbPath,
          error: `${error}`
        });
      }
      throw error;
    }
    const recovered = this.store.recoveredFromCorruption;
    const recoverySessions = this.store.listRunningSessions();
    const recoveryInteractions = this.store.listPendingInteractionsForRunningSessions();
    const recoveryNotices = this.store.markRunningSessionsFailedWithNotices("bridge_restart");
    const failedSessions = recoveryNotices.length;

    for (const interaction of recoveryInteractions) {
      await this.appendInteractionResolvedJournal(interaction, {
        finalState: "failed",
        errorReason: "bridge_restart",
        resolutionSource: "bridge_restart_recovery"
      });
    }

    if (failedSessions > 0 || recovered) {
      await this.bootstrapLogger.warn("startup recovery applied", { failedSessions, recovered });
    }

    const { snapshot, appServer } = await readinessProbe({
      config: this.config,
      store: this.store,
      paths: this.paths,
      logger: this.bootstrapLogger,
      keepAppServer: true,
      persist: true
    });

    this.snapshot = snapshot;
    this.appServer = appServer;
    this.richInputAdapter.resetRuntimeCaches();
    this.attachAppServerListeners();

    if (!isOperationalReadinessState(snapshot.state)) {
      if (this.appServer) {
        await this.appServer.stop().catch(() => {});
        this.appServer = null;
      }
      throw new Error(`readiness ${snapshot.state}; service will not enter run loop`);
    }

    this.api = createTelegramApi(this.config.telegramBotToken, this.config.telegramApiBaseUrl);
    this.poller = createPoller(
      this.api,
      this.config,
      this.paths,
      this.logger,
      async (update) => {
        await this.handleUpdate(update);
      }
    );

    await this.syncTelegramCommands();
    await this.logger.info("bridge service started", { readiness: snapshot.state });
    if (recoverySessions.length > 0) {
      const recoveryChatId = recoverySessions[0]?.telegramChatId;
      if (recoveryChatId) {
        await this.runtimeSurfaceController.sendRecoveryHub(
          recoveryChatId,
          recoverySessions.map((session) => session.sessionId)
        );
        for (const notice of recoveryNotices) {
          this.store.clearRuntimeNotice(notice.key);
        }
      }
    }
    await this.flushRuntimeNotices();
    await this.poller.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.poller?.stop();
    this.threadArchiveReconciler.clear();
    this.runtimeSurfaceController.disposeAllRuntimeHubs();
    for (const activeTurn of this.listActiveTurns()) {
      this.runtimeSurfaceController.disposeRuntimeCards(activeTurn);
    }
    await this.appServer?.stop();
    this.store?.close();
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.message);
      return;
    }

    if (update.callback_query) {
      await this.handleCallback(update.callback_query);
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.api || !this.store || message.chat.type !== "private" || !message.from) {
      return;
    }

    const authResult = await this.authorizeMessageSender(message);
    if (!authResult.authorized) {
      return;
    }

    await this.flushRuntimeNotices(`${message.chat.id}`);

    const chatId = `${message.chat.id}`;
    const text = (message.text ?? "").trim();

    if (this.isAwaitingRename(chatId)) {
      const command = parseCommand(text);
      if (command?.name === "cancel") {
        await this.sessionProjectCoordinator.cancelPendingProjectInput(chatId);
        return;
      }

      await this.handleRenameInput(chatId, text);
      return;
    }

    if (this.isAwaitingManualProjectPath(chatId)) {
      const command = parseCommand(text);
      if (command?.name === "cancel") {
        await this.sessionProjectCoordinator.cancelPendingProjectInput(chatId);
        return;
      }

      await this.handleManualPathInput(chatId, text);
      return;
    }

    const pendingTextMode = this.interactionBroker.getPendingTextMode(
      chatId,
      this.store.getActiveSession(chatId)?.sessionId ?? null
    );
    if (pendingTextMode) {
      const command = parseCommand(text);
      if (command?.name === "cancel") {
        await this.interactionBroker.cancelPendingTextInteraction(chatId, pendingTextMode.interactionId);
        return;
      }

      await this.interactionBroker.handlePendingInteractionTextAnswer(chatId, pendingTextMode, text);
      return;
    }

    if (this.richInputAdapter.hasPendingRichInputComposer(chatId)) {
      const command = parseCommand(text);
      if (command?.name === "cancel") {
        await this.richInputAdapter.cancelPendingRichInputComposer(chatId);
        return;
      }

      await this.richInputAdapter.handlePendingRichInputPrompt(chatId, text);
      return;
    }

    if (message.voice) {
      await this.richInputAdapter.handleVoiceMessage(chatId, message);
      return;
    }

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      await this.richInputAdapter.handlePhotoMessage(chatId, message);
      return;
    }

    const command = parseCommand(text);

    if (!command) {
      await this.handleNormalText(chatId, text);
      return;
    }

    await this.routeCommand(chatId, command.name, command.args);
  }

  private async handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
    if (!this.api || !this.store || !callbackQuery.message || callbackQuery.message.chat.type !== "private") {
      return;
    }

    const message = callbackQuery.message;
    const authResult = await this.authorizeCallbackSender(callbackQuery);
    if (!authResult.authorized) {
      return;
    }

    const chatId = `${message.chat.id}`;
    const parsed = callbackQuery.data ? parseCallbackData(callbackQuery.data) : null;

    if (!parsed) {
      await this.safeAnswerCallbackQuery(callbackQuery.id, "这个按钮已过期，请重新操作。");
      return;
    }

    await routeBridgeCallback(parsed, {
      answer: async (text) => this.safeAnswerCallbackQuery(callbackQuery.id, text),
      handleProjectPick: async (projectKey) => this.handleProjectPick(chatId, message.message_id, projectKey),
      handleScanMore: async () => this.handleScanMore(chatId, message.message_id),
      enterManualPathMode: async () => this.enterManualPathMode(chatId, message.message_id),
      returnToProjectPicker: async () => this.returnToProjectPicker(chatId, message.message_id),
      confirmManualProject: async (projectKey) => this.confirmManualProject(chatId, message.message_id, projectKey),
      handleBrowseAction: async (nextParsed) => this.handleBrowseCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        nextParsed
      ),
      beginSessionRename: async (sessionId) => this.beginSessionRename(chatId, message.message_id, sessionId),
      beginProjectRename: async (sessionId) => this.beginProjectRename(chatId, message.message_id, sessionId),
      clearProjectAlias: async (sessionId) => this.clearProjectAlias(chatId, message.message_id, sessionId),
      handleModelDefault: async (sessionId) => this.codexCommandCoordinator.handleModelDefaultCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId
      ),
      handleModelClose: async (sessionId) => this.codexCommandCoordinator.handleModelCloseCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId
      ),
      handleModelPage: async (sessionId, page) => this.codexCommandCoordinator.handleModelPageCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId,
        page
      ),
      handleModelPick: async (sessionId, modelIndex) => this.codexCommandCoordinator.handleModelPickCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId,
        modelIndex
      ),
      handleModelEffort: async (sessionId, modelIndex, effort) => this.codexCommandCoordinator.handleModelEffortCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId,
        modelIndex,
        effort
      ),
      toggleStatusCardSection: async (sessionId, expanded, section) => this.handleStatusCardSectionToggle(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId,
        expanded,
        section
      ),
      handleStatusCardInspect: async (sessionId) => this.handleStatusCardInspectCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId
      ),
      handleStatusCardInterrupt: async (sessionId) => this.handleStatusCardInterruptCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId
      ),
      renderPersistedFinalAnswer: async (answerId, mode) => this.renderPersistedFinalAnswer(
        callbackQuery.id,
        chatId,
        message.message_id,
        answerId,
        mode
      ),
      renderPersistedPlanResult: async (answerId, mode) => this.renderPersistedPlanResult(
        callbackQuery.id,
        chatId,
        message.message_id,
        answerId,
        mode
      ),
      handleRuntimePreferencesPage: async (token, page) => this.handleRuntimePreferencesPageCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        token,
        page
      ),
      handleRuntimePreferencesToggle: async (token, field) => this.handleRuntimePreferencesToggleCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        token,
        field
      ),
      handleRuntimePreferencesSave: async (token) => this.handleRuntimePreferencesSaveCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        token
      ),
      handleRuntimePreferencesReset: async (token) => this.handleRuntimePreferencesResetCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        token
      ),
      handleRuntimePreferencesClose: async (token) => this.handleRuntimePreferencesCloseCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        token
      ),
      handleLanguageSet: async (language) => this.handleLanguageSetCallback(callbackQuery.id, chatId, message.message_id, language),
      handleLanguageClose: async () => this.handleLanguageCloseCallback(callbackQuery.id, chatId, message.message_id),
      handleInspectView: async (sessionId, options) => this.handleInspectViewCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId,
        options
      ),
      handleInspectClose: async (sessionId) => this.handleInspectCloseCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId
      ),
      handlePlanImplement: async (answerId) => this.handlePlanResultActionCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        answerId,
        "implement"
      ),
      handleRollbackList: async (sessionId, page) => this.handleRollbackPickerCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId,
        { mode: "list", page }
      ),
      handleRollbackPick: async (sessionId, page, targetIndex) => this.handleRollbackPickerCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId,
        { mode: "confirm", page, targetIndex }
      ),
      handleRollbackConfirm: async (sessionId, targetIndex) => this.handleRollbackConfirmCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId,
        targetIndex
      ),
      handleRollbackClose: async (sessionId) => this.handleRollbackCloseCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        sessionId
      ),
      handleInteractionDecision: async (nextParsed) => this.interactionBroker.handleInteractionDecisionCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        nextParsed
      ),
      handleInteractionQuestion: async (nextParsed) => this.interactionBroker.handleInteractionQuestionCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        nextParsed
      ),
      handleInteractionText: async (nextParsed) => this.interactionBroker.handleInteractionTextModeCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        nextParsed
      ),
      handleInteractionCancel: async (interactionId) => this.interactionBroker.handleInteractionCancelCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        interactionId
      ),
      handleInteractionAnswerToggle: async (interactionId, expanded) => this.interactionBroker.handleInteractionAnswerToggleCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        interactionId,
        expanded
      ),
      handleHubSelect: async (token, version, slot) => this.runtimeSurfaceController.handleHubSelectCallback(
        callbackQuery.id,
        chatId,
        message.message_id,
        token,
        version,
        slot
      )
    });
  }

  private async handleRuntime(chatId: string): Promise<void> {
    await this.runtimeSurfaceController.handleRuntime(chatId);
  }

  private async handleBrowse(chatId: string): Promise<void> {
    await this.projectBrowserCoordinator.handleBrowse(chatId);
  }

  private async handleBrowseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    parsed: Extract<
      ParsedCallbackData,
      | { kind: "browse_open" }
      | { kind: "browse_page" }
      | { kind: "browse_up" }
      | { kind: "browse_root" }
      | { kind: "browse_refresh" }
      | { kind: "browse_back" }
      | { kind: "browse_close" }
    >
  ): Promise<void> {
    await this.projectBrowserCoordinator.handleBrowseCallback(callbackQueryId, chatId, messageId, parsed);
  }

  private async handleRuntimePreferencesPageCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    page: number
  ): Promise<void> {
    await this.runtimeSurfaceController.handleRuntimePreferencesPageCallback(
      callbackQueryId,
      chatId,
      messageId,
      token,
      page
    );
  }

  private async handleRuntimePreferencesToggleCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    field: RuntimeStatusField
  ): Promise<void> {
    await this.runtimeSurfaceController.handleRuntimePreferencesToggleCallback(
      callbackQueryId,
      chatId,
      messageId,
      token,
      field
    );
  }

  private async handleRuntimePreferencesSaveCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string
  ): Promise<void> {
    await this.runtimeSurfaceController.handleRuntimePreferencesSaveCallback(
      callbackQueryId,
      chatId,
      messageId,
      token
    );
  }

  private async handleRuntimePreferencesResetCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string
  ): Promise<void> {
    await this.runtimeSurfaceController.handleRuntimePreferencesResetCallback(
      callbackQueryId,
      chatId,
      messageId,
      token
    );
  }

  private async handleRuntimePreferencesCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string
  ): Promise<void> {
    await this.runtimeSurfaceController.handleRuntimePreferencesCloseCallback(
      callbackQueryId,
      chatId,
      messageId,
      token
    );
  }

  private async refreshActiveRuntimeStatusCard(chatId: string, reason: string): Promise<void> {
    await this.runtimeSurfaceController.refreshActiveRuntimeStatusCard(this.getActiveTurnForChat(chatId), chatId, reason);
  }

  private async handleStatusCardSectionToggle(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    expanded: boolean,
    section: "plan" | "agents"
  ): Promise<void> {
    await this.runtimeSurfaceController.handleStatusCardSectionToggle(
      callbackQueryId,
      chatId,
      messageId,
      sessionId,
      expanded,
      section
    );
  }

  private async handleStatusCardInspectCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const hubState = this.runtimeSurfaceController.resolveFocusedRuntimeHubSession(chatId, messageId, sessionId);
    if (hubState) {
      await this.safeAnswerCallbackQuery(callbackQueryId);
      await this.runtimeSurfaceController.handleInspect(hubState.chatId, sessionId);
      return;
    }

    const activeTurn = this.getActiveTurnForSession(sessionId);
    if (!activeTurn || activeTurn.chatId !== chatId || activeTurn.statusCard.messageId !== messageId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);
    await this.runtimeSurfaceController.handleInspect(chatId, sessionId);
  }

  private async handleStatusCardInterruptCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const hubState = this.runtimeSurfaceController.resolveFocusedRuntimeHubSession(chatId, messageId, sessionId, {
      requireLive: true
    });
    if (hubState) {
      const result = await this.turnCoordinator.interruptSession(hubState.chatId, sessionId);
      await this.safeAnswerCallbackQuery(callbackQueryId, result.message);
      return;
    }

    const activeTurn = this.getActiveTurnForSession(sessionId);
    if (!activeTurn || activeTurn.chatId !== chatId || activeTurn.statusCard.messageId !== messageId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const result = await this.turnCoordinator.interruptSession(chatId, sessionId);
    await this.safeAnswerCallbackQuery(callbackQueryId, result.message);
  }

  private async renderPersistedFinalAnswer(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    answerId: string,
    mode: {
      expanded: boolean;
      page?: number;
    }
  ): Promise<void> {
    await this.runtimeSurfaceController.renderPersistedFinalAnswer(
      callbackQueryId,
      chatId,
      messageId,
      answerId,
      mode
    );
  }

  private async renderPersistedPlanResult(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    answerId: string,
    mode: {
      expanded: boolean;
      page?: number;
    }
  ): Promise<void> {
    await this.runtimeSurfaceController.renderPersistedPlanResult(
      callbackQueryId,
      chatId,
      messageId,
      answerId,
      mode
    );
  }

  private async handlePlanResultActionCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    answerId: string,
    action: "implement"
  ): Promise<void> {
    if (!this.store) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const view = this.store.getFinalAnswerView(answerId, chatId);
    if (!view || (view.telegramMessageId !== null && view.telegramMessageId !== messageId)) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (view.primaryActionConsumed) {
      await this.runtimeSurfaceController.renderPersistedPlanResult(
        callbackQueryId,
        chatId,
        messageId,
        answerId,
        { expanded: true, page: 1 }
      );
      return;
    }

    const sessionId = view.sessionId;
    const session = this.store.getSessionById(sessionId);
    if (!session || session.telegramChatId !== chatId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (session.status === "running" || this.getActiveTurnForSession(sessionId)) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    const capacity = this.turnCoordinator.getRunningTurnCapacity(chatId);
    if (!capacity.allowed) {
      await this.safeAnswerCallbackQuery(
        callbackQueryId,
        `当前最多只能并行运行 ${capacity.limit} 个会话，请先等待完成或停止部分任务。`
      );
      return;
    }

    this.store.setSessionPlanMode(sessionId, false);
    this.store.setActiveSession(chatId, sessionId);
    const updatedSession = this.store.getSessionById(sessionId);
    if (!updatedSession) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    try {
      await this.startRealTurn(chatId, updatedSession, "Implement the plan.");
    } catch {
      await this.safeAnswerCallbackQuery(callbackQueryId, "当前无法开始实施，请稍后重试。");
      return;
    }

    this.store.setFinalAnswerPrimaryActionConsumed(answerId, true);
    await this.runtimeSurfaceController.renderPersistedPlanResult(
      callbackQueryId,
      chatId,
      messageId,
      answerId,
      { expanded: true, page: 1 }
    );
  }

  private async authorizeMessageSender(
    message: TelegramMessage
  ): Promise<{ authorized: boolean; chatId: string; userId: string }> {
    if (!this.api || !this.store || !message.from) {
      return { authorized: false, chatId: "", userId: "" };
    }

    const authorized = this.store.getAuthorizedUser();
    const telegramUserId = `${message.from.id}`;
    const telegramChatId = `${message.chat.id}`;

    if (!authorized) {
      this.store.upsertPendingAuthorization({
        telegramUserId,
        telegramChatId,
        telegramUsername: message.from.username ?? null,
        displayName: displayName(message)
      });
      await this.safeSendMessage(
        telegramChatId,
        "这台服务器还没有绑定 Telegram 账号，请等待管理员在本机确认。"
      );
      return { authorized: false, chatId: telegramChatId, userId: telegramUserId };
    }

    if (authorized.telegramUserId !== telegramUserId) {
      await this.rejectUnauthorizedUser(telegramUserId, telegramChatId);
      return { authorized: false, chatId: telegramChatId, userId: telegramUserId };
    }

    return { authorized: true, chatId: telegramChatId, userId: telegramUserId };
  }

  private async authorizeCallbackSender(
    callbackQuery: TelegramCallbackQuery
  ): Promise<{ authorized: boolean; chatId: string; userId: string }> {
    if (!this.api || !this.store || !callbackQuery.message) {
      return { authorized: false, chatId: "", userId: "" };
    }

    const authorized = this.store.getAuthorizedUser();
    const telegramUserId = `${callbackQuery.from.id}`;
    const telegramChatId = `${callbackQuery.message.chat.id}`;

    if (!authorized || authorized.telegramUserId !== telegramUserId) {
      await this.safeAnswerCallbackQuery(callbackQuery.id, "这个 Telegram 账号无权访问此服务器上的 Codex。");
      await this.rejectUnauthorizedUser(telegramUserId, telegramChatId);
      return { authorized: false, chatId: telegramChatId, userId: telegramUserId };
    }

    return { authorized: true, chatId: telegramChatId, userId: telegramUserId };
  }

  private async rejectUnauthorizedUser(telegramUserId: string, telegramChatId: string): Promise<void> {
    if (!this.api) {
      return;
    }

    const lastReplyAt = this.unauthorizedReplyAt.get(telegramUserId) ?? 0;
    if (Date.now() - lastReplyAt > 60_000) {
      this.unauthorizedReplyAt.set(telegramUserId, Date.now());
      await this.safeSendMessage(telegramChatId, "这个 Telegram 账号无权访问此服务器上的 Codex。");
    }

    await this.logger.warn("unauthorized telegram access rejected", {
      telegramUserId,
      telegramChatId
    });
  }

  private async routeCommand(chatId: string, commandName: string, args: string): Promise<void> {
    await routeBridgeCommand(commandName, {
      sendHelp: async () => {
        await this.safeSendMessage(chatId, buildHelpText(this.getUiLanguage()));
        await this.reanchorRuntimeAfterBridgeReply(chatId, "help_sent");
      },
      sendStatus: async () => {
        await this.sendStatus(chatId);
        await this.reanchorRuntimeAfterBridgeReply(chatId, "status_sent");
      },
      handleNew: async () => {
        await this.sessionProjectCoordinator.handleNew(chatId);
      },
      handleBrowse: async () => {
        await this.handleBrowse(chatId);
      },
      handleCancel: async () => {
        await this.handleCancelCommand(chatId);
      },
      handleSessions: async () => {
        await this.handleSessions(chatId, args);
      },
      handleArchive: async () => {
        await this.sessionProjectCoordinator.handleArchive(chatId);
      },
      sendWhere: async () => {
        await this.sessionProjectCoordinator.sendWhere(chatId);
        await this.reanchorRuntimeAfterBridgeReply(chatId, "where_sent");
      },
      handleInterrupt: async () => {
        await this.handleInterrupt(chatId);
      },
      handleInspect: async () => {
        await this.handleInspect(chatId);
        await this.reanchorRuntimeAfterBridgeReply(chatId, "inspect_sent");
      },
      handleRuntime: async () => {
        await this.handleRuntime(chatId);
      },
      handleLanguage: async () => {
        await this.handleLanguage(chatId);
      },
      handleUse: async () => {
        await this.handleUse(chatId, args);
      },
      handleUnarchive: async () => {
        await this.sessionProjectCoordinator.handleUnarchive(chatId, args);
      },
      handleRename: async () => {
        await this.handleRename(chatId, args);
      },
      handlePin: async () => {
        await this.handlePin(chatId);
      },
      handlePlan: async () => {
        await this.handlePlan(chatId);
      },
      handleModel: async () => {
        await this.runGuardedCommand(chatId, "模型操作暂时不可用，请稍后重试。", async () => {
          await this.codexCommandCoordinator.handleModel(chatId, args);
        });
      },
      handleSkills: async () => {
        await this.runGuardedCommand(chatId, "技能列表暂时不可用，请稍后重试。", async () => {
          await this.handleSkills(chatId);
        });
      },
      handleSkill: async () => {
        await this.runGuardedCommand(chatId, "结构化 skill 输入暂时不可用，请稍后重试。", async () => {
          await this.handleSkill(chatId, args);
        });
      },
      handlePlugins: async () => {
        await this.runGuardedCommand(chatId, "插件列表暂时不可用，请稍后重试。", async () => {
          await this.handlePlugins(chatId);
        });
      },
      handlePlugin: async () => {
        await this.runGuardedCommand(chatId, "当前无法管理插件，请稍后重试。", async () => {
          await this.handlePlugin(chatId, args);
        });
      },
      handleApps: async () => {
        await this.runGuardedCommand(chatId, "当前无法读取 Apps 列表，请稍后重试。", async () => {
          await this.handleApps(chatId);
        });
      },
      handleMcp: async () => {
        await this.runGuardedCommand(chatId, "当前无法读取 MCP 状态，请稍后重试。", async () => {
          await this.handleMcp(chatId, args);
        });
      },
      handleAccount: async () => {
        await this.runGuardedCommand(chatId, "当前无法读取账号状态，请稍后重试。", async () => {
          await this.handleAccount(chatId);
        });
      },
      handleReview: async () => {
        await this.runGuardedCommand(chatId, "当前无法启动审查，请稍后重试。", async () => {
          await this.handleReview(chatId, args);
        });
      },
      handleFork: async () => {
        await this.runGuardedCommand(chatId, "当前无法分叉这个会话，请稍后重试。", async () => {
          await this.handleFork(chatId, args);
        });
      },
      handleRollback: async () => {
        await this.runGuardedCommand(chatId, "当前无法回滚这个会话，请稍后重试。", async () => {
          await this.handleRollback(chatId, args);
        });
      },
      handleCompact: async () => {
        await this.runGuardedCommand(chatId, "当前无法压缩这个线程，请稍后重试。", async () => {
          await this.handleCompact(chatId);
        });
      },
      handleLocalImage: async () => {
        await this.runGuardedCommand(chatId, "本地图片输入暂时不可用，请稍后重试。", async () => {
          await this.handleLocalImage(chatId, args);
        });
      },
      handleMention: async () => {
        await this.runGuardedCommand(chatId, "结构化引用输入暂时不可用，请稍后重试。", async () => {
          await this.handleMention(chatId, args);
        });
      },
      handleThread: async () => {
        await this.runGuardedCommand(chatId, "当前无法更新线程设置，请稍后重试。", async () => {
          await this.handleThreadCommand(chatId, args);
        });
      },
      sendUnsupported: async () => {
        await this.safeSendMessage(chatId, buildUnsupportedCommandText());
      }
    });
  }

  private async handleCancelCommand(chatId: string): Promise<void> {
    if (await this.sessionProjectCoordinator.cancelPendingProjectInput(chatId)) {
      return;
    }

    if (await this.richInputAdapter.cancelPendingRichInputComposer(chatId)) {
      return;
    }

    await this.safeSendMessage(chatId, "当前没有可取消的输入。");
  }

  private async runGuardedCommand(
    chatId: string,
    failureMessage: string,
    operation: () => Promise<void>
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      await this.logger.warn("command failed", {
        chatId,
        failureMessage,
        error: `${error}`
      });
      await this.safeSendMessage(chatId, failureMessage);
    }
  }

  private async flushRuntimeNotices(chatId?: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const targetChatIds = chatId
      ? [chatId]
      : this.store.listNoticeChatIds();

    for (const targetChatId of targetChatIds) {
      const notices = this.store.listRuntimeNotices(targetChatId);
      for (const notice of notices) {
        if (await this.safeSendMessage(targetChatId, notice.message)) {
          this.store.clearRuntimeNotice(notice.key);
        }
      }
    }
  }

  private async handleNormalText(chatId: string, text?: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "请先发送 /new 选择项目。");
      return;
    }

    if (activeSession.status === "running") {
      const steerAvailability = this.turnCoordinator.getBlockedTurnSteerAvailability(chatId, activeSession);
      if (text && steerAvailability.kind === "available") {
        try {
          await this.ensureAppServerAvailable();
          await this.appServer?.steerTurn({
            threadId: steerAvailability.activeTurn.threadId,
            expectedTurnId: steerAvailability.activeTurn.turnId,
            input: [{ type: "text", text }]
          });
        } catch (error) {
          await this.logger.warn("turn steer failed", {
            chatId,
            sessionId: activeSession.sessionId,
            threadId: steerAvailability.activeTurn.threadId,
            turnId: steerAvailability.activeTurn.turnId,
            error: `${error}`
          });
          await this.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
        }
        return;
      }

      if (steerAvailability.kind === "interaction_pending") {
        await this.interactionBroker.sendPendingInteractionBlockNotice(chatId);
        return;
      }

      await this.safeSendMessage(chatId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    if (!text) {
      await this.safeSendHtmlMessage(chatId, buildProjectSelectedText(this.projectDisplayName(activeSession)));
      return;
    }

    await this.startRealTurn(chatId, activeSession, text);
  }

  private async showProjectPicker(chatId: string): Promise<void> {
    await this.sessionProjectCoordinator.showProjectPicker(chatId);
  }

  private async handleProjectPick(chatId: string, messageId: number, projectKey: string): Promise<void> {
    await this.sessionProjectCoordinator.handleProjectPick(chatId, messageId, projectKey);
  }

  private async handleScanMore(chatId: string, messageId: number): Promise<void> {
    await this.sessionProjectCoordinator.handleScanMore(chatId, messageId);
  }

  private async enterManualPathMode(chatId: string, messageId: number): Promise<void> {
    await this.sessionProjectCoordinator.enterManualPathMode(chatId, messageId);
  }

  private async handleManualPathInput(chatId: string, text: string): Promise<void> {
    await this.sessionProjectCoordinator.handleManualPathInput(chatId, text);
  }

  private async confirmManualProject(chatId: string, messageId: number, projectKey: string): Promise<void> {
    await this.sessionProjectCoordinator.confirmManualProject(chatId, messageId, projectKey);
  }

  private async returnToProjectPicker(chatId: string, messageId?: number): Promise<void> {
    await this.sessionProjectCoordinator.returnToProjectPicker(chatId, messageId);
  }

  private isAwaitingManualProjectPath(chatId: string): boolean {
    return this.sessionProjectCoordinator.isAwaitingManualProjectPath(chatId);
  }

  private isAwaitingRename(chatId: string): boolean {
    return this.sessionProjectCoordinator.isAwaitingRename(chatId);
  }

  private projectDisplayName(project: Pick<SessionRow, "projectName" | "projectAlias">): string {
    return this.sessionProjectCoordinator.projectDisplayName(project);
  }

  private async sendStatus(chatId: string): Promise<void> {
    await this.sessionProjectCoordinator.sendStatus(chatId, this.snapshot);
  }

  private async handleSessions(chatId: string, args: string): Promise<void> {
    await this.sessionProjectCoordinator.handleSessions(chatId, args);
  }

  private async handleUse(chatId: string, args: string): Promise<void> {
    await this.sessionProjectCoordinator.handleUse(chatId, args);
  }

  private async handleRename(chatId: string, args: string): Promise<void> {
    await this.sessionProjectCoordinator.handleRename(chatId, args);
  }

  private async beginSessionRename(chatId: string, messageId: number, sessionId: string): Promise<void> {
    await this.sessionProjectCoordinator.beginSessionRename(chatId, messageId, sessionId);
  }

  private async beginProjectRename(chatId: string, messageId: number, sessionId: string): Promise<void> {
    await this.sessionProjectCoordinator.beginProjectRename(chatId, messageId, sessionId);
  }

  private async clearProjectAlias(chatId: string, messageId: number, sessionId: string): Promise<void> {
    await this.sessionProjectCoordinator.clearProjectAlias(chatId, messageId, sessionId);
  }

  private async handleRenameInput(chatId: string, text: string): Promise<void> {
    await this.sessionProjectCoordinator.handleRenameInput(chatId, text);
  }

  private async handlePin(chatId: string): Promise<void> {
    await this.sessionProjectCoordinator.handlePin(chatId);
  }

  private async handlePlan(chatId: string): Promise<void> {
    await this.sessionProjectCoordinator.handlePlan(chatId);
  }

  private async handleSkills(chatId: string): Promise<void> {
    await this.codexCommandCoordinator.handleSkills(chatId);
  }

  private async handleSkill(chatId: string, args: string): Promise<void> {
    await this.codexCommandCoordinator.handleSkill(chatId, args);
  }

  private async handlePlugins(chatId: string): Promise<void> {
    await this.codexCommandCoordinator.handlePlugins(chatId);
  }

  private async handlePlugin(chatId: string, args: string): Promise<void> {
    await this.codexCommandCoordinator.handlePlugin(chatId, args);
  }

  private async handleApps(chatId: string): Promise<void> {
    await this.codexCommandCoordinator.handleApps(chatId);
  }

  private async handleMcp(chatId: string, args: string): Promise<void> {
    await this.codexCommandCoordinator.handleMcp(chatId, args);
  }

  private async handleAccount(chatId: string): Promise<void> {
    await this.codexCommandCoordinator.handleAccount(chatId);
  }

  private async handleReview(chatId: string, args: string): Promise<void> {
    await this.codexCommandCoordinator.handleReview(chatId, args);
  }

  private async handleFork(chatId: string, args: string): Promise<void> {
    await this.codexCommandCoordinator.handleFork(chatId, args);
  }

  private async handleRollback(chatId: string, args: string): Promise<void> {
    await this.codexCommandCoordinator.handleRollback(chatId, args);
  }

  private async handleRollbackPickerCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    options:
      | {
          mode: "list";
          page: number;
        }
      | {
          mode: "confirm";
          page: number;
          targetIndex: number;
        }
  ): Promise<void> {
    await this.codexCommandCoordinator.handleRollbackPickerCallback(
      callbackQueryId,
      chatId,
      messageId,
      sessionId,
      options
    );
  }

  private async handleRollbackConfirmCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    targetIndex: number
  ): Promise<void> {
    await this.codexCommandCoordinator.handleRollbackConfirmCallback(
      callbackQueryId,
      chatId,
      messageId,
      sessionId,
      targetIndex
    );
  }

  private async handleRollbackCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    await this.codexCommandCoordinator.handleRollbackCloseCallback(
      callbackQueryId,
      chatId,
      messageId,
      sessionId
    );
  }

  private async handleCompact(chatId: string): Promise<void> {
    await this.codexCommandCoordinator.handleCompact(chatId);
  }

  private async handleLocalImage(chatId: string, args: string): Promise<void> {
    await this.richInputAdapter.handleLocalImage(chatId, args);
  }

  private async handleMention(chatId: string, args: string): Promise<void> {
    await this.richInputAdapter.handleMention(chatId, args);
  }

  private async handleThreadCommand(chatId: string, args: string): Promise<void> {
    await this.codexCommandCoordinator.handleThreadCommand(chatId, args);
  }

  private async startStructuredInputTurn(chatId: string, session: SessionRow, input: UserInput[]): Promise<void> {
    await this.turnCoordinator.startStructuredTurn(chatId, session, input);
  }

  private async fetchAllPaginated<T>(
    fetcher: (options: { cursor?: string; limit: number }) => Promise<{ data: T[]; nextCursor?: string | null } | undefined> | undefined
  ): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | null = null;

    do {
      const page = await fetcher({
        ...(cursor ? { cursor } : {}),
        limit: 50
      });
      if (!page) {
        break;
      }
      results.push(...page.data);
      cursor = page.nextCursor ?? null;
    } while (cursor);

    return results;
  }

  private async fetchAllModels(): Promise<NonNullable<Awaited<ReturnType<CodexAppServerClient["listModels"]>>["data"]>> {
    return this.fetchAllPaginated((opts) => this.appServer?.listModels({ ...opts, includeHidden: false }));
  }

  private async fetchAllApps(
    threadId?: string
  ): Promise<NonNullable<Awaited<ReturnType<CodexAppServerClient["listApps"]>>["data"]>> {
    return this.fetchAllPaginated((opts) => this.appServer?.listApps({ ...opts, ...(threadId ? { threadId } : {}) }));
  }

  private async fetchAllMcpServerStatuses(): Promise<
    NonNullable<Awaited<ReturnType<CodexAppServerClient["listMcpServerStatuses"]>>["data"]>
  > {
    return this.fetchAllPaginated((opts) => this.appServer?.listMcpServerStatuses(opts));
  }

  private async handleInterrupt(chatId: string): Promise<void> {
    await this.turnCoordinator.handleInterrupt(chatId);
  }

  private async startRealTurn(
    chatId: string,
    session: SessionRow,
    text: string,
    options?: {
      sourceKind: "voice";
      transcript: string;
    }
  ): Promise<void> {
    await this.turnCoordinator.startTextTurn(chatId, session, text, options);
  }

  private async beginActiveTurn(
    chatId: string,
    session: SessionRow,
    threadId: string,
    turnId: string,
    turnStatus: string
  ): Promise<void> {
    await this.turnCoordinator.beginActiveTurn(chatId, session, threadId, turnId, turnStatus);
  }

  private async ensureSessionThread(session: SessionRow): Promise<string> {
    return await this.turnCoordinator.ensureSessionThread(session);
  }

  private attachAppServerListeners(): void {
    if (!this.appServer) {
      return;
    }

    this.appServer.onNotification((notification) => {
      void this.handleAppServerNotification(notification.method, notification.params);
    });

    this.appServer.onServerRequest((request) => {
      void this.handleAppServerServerRequest(request);
    });

    this.appServer.onExit((error) => {
      void this.handleAppServerExit(error);
    });
  }

  private async handleAppServerServerRequest(request: JsonRpcServerRequest): Promise<void> {
    await this.turnCoordinator.handleAppServerServerRequest(request);
  }

  private async handleServerRequestResolvedNotification(
    notification: Extract<ReturnType<typeof classifyNotification>, { kind: "server_request_resolved" }>
  ): Promise<void> {
    await this.interactionBroker.handleServerRequestResolvedNotification(notification.threadId, notification.requestId);
  }

  private async handleAppServerNotification(method: string, params: unknown): Promise<void> {
    await this.turnCoordinator.handleAppServerNotification(method, params);
  }

  private setRecentActivity(sessionId: string, entry: RecentActivityEntry): void {
    this.turnCoordinator.setRecentActivity(sessionId, entry as never);
  }

  private clearRecentActivity(sessionId: string): void {
    this.turnCoordinator.clearRecentActivity(sessionId);
  }

  private async handleInspect(chatId: string): Promise<void> {
    await this.runtimeSurfaceController.handleInspect(chatId);
  }

  private async handleInspectViewCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    options: {
      collapsed: boolean;
      page: number;
    }
  ): Promise<void> {
    await this.runtimeSurfaceController.handleInspectViewCallback(
      callbackQueryId,
      chatId,
      messageId,
      sessionId,
      options
    );
  }

  private async handleInspectCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    await this.runtimeSurfaceController.handleInspectCloseCallback(
      callbackQueryId,
      chatId,
      messageId,
      sessionId
    );
  }

  private async buildHistoricalInspectRenderPayload(activeSession: SessionRow): Promise<InspectRenderPayload | null> {
    if (!activeSession.threadId || !activeSession.lastTurnId) {
      return null;
    }

    const appServer = this.appServer as { readThread?: (threadId: string, includeTurns?: boolean) => Promise<unknown> } | null;
    if (!appServer?.readThread) {
      return null;
    }

    try {
      const result = await appServer.readThread(activeSession.threadId, true) as { thread?: { turns?: unknown[] } };
      const turns = Array.isArray(result.thread?.turns) ? result.thread.turns : [];
      const targetTurn = turns.find((turn) => getString(turn, "id") === activeSession.lastTurnId);
      if (!targetTurn) {
        await this.logger.warn("inspect history turn missing", {
          sessionId: activeSession.sessionId,
          threadId: activeSession.threadId,
          turnId: activeSession.lastTurnId,
          availableTurnIds: turns
            .map((turn) => getString(turn, "id"))
            .filter((turnId): turnId is string => Boolean(turnId))
            .slice(-10)
        });
        return null;
      }

      return buildInspectPayloadFromThreadHistory(targetTurn, activeSession.lastTurnStatus);
    } catch (error) {
      await this.logger.warn("inspect history fallback failed", {
        sessionId: activeSession.sessionId,
        threadId: activeSession.threadId,
        turnId: activeSession.lastTurnId,
        error: `${error}`
      });
      return null;
    }
  }

  private buildStatusCardRenderPayload(
    sessionId: string,
    tracker: ActivityTracker,
    statusCard: StatusCardState
  ): {
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  } {
    return this.runtimeSurfaceController.buildStatusCardRenderPayload(sessionId, tracker, statusCard);
  }

  private async handleAppServerExit(error: Error): Promise<void> {
    if (this.stopping || !this.store) {
      return;
    }

    await this.threadArchiveReconciler.clearOnAppServerExit();
    await this.logger.warn("app-server exit observed", { error: `${error}` });

    await this.turnCoordinator.handleActiveTurnAppServerExit();

    try {
      const client = new CodexAppServerClient(
        this.config.codexBin,
        this.paths.appServerLogPath,
        this.bootstrapLogger,
        5000,
        {
          experimentalApi: true
        }
      );
      await client.initializeAndProbe();
      this.appServer = client;
      this.richInputAdapter.resetRuntimeCaches();
      this.attachAppServerListeners();
      if (this.snapshot) {
        this.snapshot = {
          ...this.snapshot,
          state: this.store.getAuthorizedUser() ? "ready" : "awaiting_authorization",
          checkedAt: new Date().toISOString(),
          appServerPid: client.pid ? `${client.pid}` : null,
          details: {
            ...this.snapshot.details,
            appServerAvailable: true
          }
        };
        this.store.writeReadinessSnapshot(this.snapshot);
      }
    } catch (restartError) {
      await this.logger.error("app-server restart failed", { error: `${restartError}` });
      if (this.snapshot) {
        this.snapshot = {
          ...this.snapshot,
          state: "app_server_unavailable",
          checkedAt: new Date().toISOString(),
          appServerPid: null,
          details: {
            ...this.snapshot.details,
            appServerAvailable: false,
            issues: [...this.snapshot.details.issues, `${restartError}`]
          }
        };
        this.store.writeReadinessSnapshot(this.snapshot);
      }
      this.appServer = null;
    }
  }

  private async ensureAppServerAvailable(): Promise<void> {
    if (this.appServer?.isRunning) {
      return;
    }

    const client = new CodexAppServerClient(
      this.config.codexBin,
      this.paths.appServerLogPath,
      this.bootstrapLogger,
      5000,
      {
        experimentalApi: true
      }
    );
    await client.initializeAndProbe();
    this.appServer = client;
    this.richInputAdapter.resetRuntimeCaches();
    this.attachAppServerListeners();
  }

  private async appendInteractionCreatedJournal(row: PendingInteractionRow): Promise<void> {
    await this.appendDebugJournalRecord({
      receivedAt: new Date().toISOString(),
      threadId: row.threadId,
      turnId: row.turnId,
      method: "bridge/interaction/created",
      params: {
        interactionId: row.interactionId,
        requestId: row.requestId,
        requestMethod: row.requestMethod,
        interactionKind: row.interactionKind,
        state: row.state,
        telegramChatId: row.telegramChatId,
        sessionId: row.sessionId
      }
    }, row.sessionId);
  }

  private async appendInteractionResolvedJournal(
    row: PendingInteractionRow,
    resolution: {
      finalState: PendingInteractionTerminalState;
      responseJson?: string | null;
      errorReason?: string | null;
      resolutionSource: InteractionResolutionSource;
    }
  ): Promise<void> {
    await this.appendDebugJournalRecord({
      receivedAt: new Date().toISOString(),
      threadId: row.threadId,
      turnId: row.turnId,
      method: "bridge/interaction/resolved",
      params: {
        interactionId: row.interactionId,
        requestId: row.requestId,
        requestMethod: row.requestMethod,
        interactionKind: row.interactionKind,
        finalState: resolution.finalState,
        responseJson: resolution.responseJson ?? null,
        errorReason: resolution.errorReason ?? null,
        resolutionSource: resolution.resolutionSource
      }
    }, row.sessionId);
  }

  private async appendDebugJournalRecord(record: DebugJournalRecord, sessionId: string | null): Promise<void> {
    const writer = this.resolveDebugJournalWriter(record.threadId, record.turnId);
    if (!writer) {
      return;
    }

    try {
      await writer.append(record);
    } catch (error) {
      await this.logger.warn("debug journal append failed", {
        sessionId,
        turnId: record.turnId,
        error: `${error}`
      });
    }
  }

  private resolveDebugJournalWriter(threadId: string | null, turnId: string | null): DebugJournalWriter | null {
    if (threadId) {
      const activeTurn = this.getActiveTurnForThread(threadId);
      if (activeTurn && (turnId === null || activeTurn.turnId === turnId)) {
        return activeTurn.debugJournal;
      }
    }

    if (!threadId || !turnId) {
      return null;
    }

    return new TurnDebugJournal({
      debugRootDir: getDebugRuntimeDir(this.paths.runtimeDir),
      threadId,
      turnId
    });
  }
  private getRuntimeCardContext(sessionId: string): {
    sessionName: string | null;
    projectName: string | null;
  } {
    const session = this.store?.getSessionById(sessionId);
    if (!session) {
      return { sessionName: null, projectName: null };
    }

    return {
      sessionName: session.displayName ?? null,
      projectName: this.projectDisplayName(session)
    };
  }

  private buildRuntimeStatusLine(sessionId: string, inspect: InspectSnapshot): string[] {
    if (!this.store) {
      return [];
    }

    const session = this.store.getSessionById(sessionId);
    if (!session) {
      return [];
    }

    const selectedFields = this.store.getRuntimeCardPreferences().fields;
    const progressText = selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null);
    const blockedReason = formatRuntimeBlockedReason(inspect.threadBlockedReason);
    return selectedFields
      .map((field) => this.formatRuntimeStatusLineField(field, session, inspect, progressText, blockedReason))
      .filter((value): value is string => Boolean(value));
  }

  private formatRuntimeStatusLineField(
    field: RuntimeStatusField,
    session: SessionRow,
    inspect: InspectSnapshot,
    progressText: string | null,
    blockedReason: string | null
  ): string | null {
    switch (field) {
      case "model-name":
        return `model-name: ${this.getRuntimeEffectiveModelConfig(session).model ?? "默认模型"}`;
      case "model-with-reasoning":
        return `model-with-reasoning: ${this.formatRuntimeEffectiveModelReasoning(session)}`;
      case "current-dir":
        return session.projectPath ? `current-dir: ${session.projectPath}` : null;
      case "project-root":
        return session.projectPath ? `project-root: ${basename(session.projectPath)}` : null;
      case "git-branch":
        return null;
      case "context-remaining": {
        const remaining = this.formatContextRemainingPercent(inspect);
        return remaining !== null ? `context-remaining: ${remaining}% left` : null;
      }
      case "context-used": {
        const used = this.formatContextUsedPercent(inspect);
        return used !== null ? `context-used: ${used}% used` : null;
      }
      case "five-hour-limit":
        return null;
      case "weekly-limit":
        return null;
      case "codex-version":
        return null;
      case "context-window-size":
        return inspect.tokenUsage?.modelContextWindow !== null && inspect.tokenUsage?.modelContextWindow !== undefined
          ? `context-window-size: ${inspect.tokenUsage.modelContextWindow}`
          : null;
      case "used-tokens":
        return inspect.tokenUsage?.totalTokens !== null && inspect.tokenUsage?.totalTokens !== undefined && inspect.tokenUsage.totalTokens > 0
          ? `used-tokens: ${inspect.tokenUsage.totalTokens}`
          : null;
      case "total-input-tokens":
        return inspect.tokenUsage?.totalInputTokens !== null && inspect.tokenUsage?.totalInputTokens !== undefined
          ? `total-input-tokens: ${inspect.tokenUsage.totalInputTokens}`
          : null;
      case "total-output-tokens":
        return inspect.tokenUsage?.totalOutputTokens !== null && inspect.tokenUsage?.totalOutputTokens !== undefined
          ? `total-output-tokens: ${inspect.tokenUsage.totalOutputTokens}`
          : null;
      case "session-id":
        return session.threadId ? `session-id: ${session.threadId}` : null;
      case "session_name":
        return session.displayName ? `session_name: ${session.displayName}` : null;
      case "project_name":
        return `project_name: ${this.projectDisplayName(session)}`;
      case "project_path":
        return session.projectPath ? `project_path: ${session.projectPath}` : null;
      case "plan_mode":
        return `plan_mode: ${session.planMode ? "on" : "off"}`;
      case "model_reasoning":
        return `model_reasoning: ${this.formatRuntimeEffectiveModelReasoning(session)}`;
      case "thread_id":
        return session.threadId ? `thread_id: ${session.threadId}` : null;
      case "turn_id":
        return session.lastTurnId ? `turn_id: ${session.lastTurnId}` : null;
      case "blocked_reason":
        return blockedReason ? `blocked_reason: ${blockedReason}` : null;
      case "current_step":
        return progressText ? `current_step: ${progressText}` : null;
      case "last_token_usage":
        return inspect.tokenUsage?.lastTotalTokens !== null && inspect.tokenUsage?.lastTotalTokens !== undefined
          ? `last_token_usage: ${inspect.tokenUsage.lastTotalTokens}`
          : null;
      case "total_token_usage":
        return inspect.tokenUsage?.totalTokens !== null && inspect.tokenUsage?.totalTokens !== undefined
          ? `total_token_usage: ${inspect.tokenUsage.totalTokens}`
          : null;
      case "context_window":
        return inspect.tokenUsage?.modelContextWindow !== null && inspect.tokenUsage?.modelContextWindow !== undefined
          ? `context_window: ${inspect.tokenUsage.modelContextWindow}`
          : null;
      case "final_answer_ready":
        return `final_answer_ready: ${inspect.finalMessageAvailable ? "yes" : "no"}`;
    }
  }

  private getRuntimeEffectiveModelConfig(session: SessionRow): {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
  } {
    const activeTurn = this.getActiveTurnForSession(session.sessionId);
    if (activeTurn) {
      return {
        model: activeTurn.effectiveModel,
        reasoningEffort: activeTurn.effectiveReasoningEffort
      };
    }

    return {
      model: session.selectedModel ?? null,
      reasoningEffort: session.selectedReasoningEffort ?? null
    };
  }

  private formatRuntimeEffectiveModelReasoning(session: SessionRow): string {
    const effective = this.getRuntimeEffectiveModelConfig(session);
    const modelLabel = effective.model ?? "默认模型";
    const effortLabel = effective.reasoningEffort ? formatReasoningEffortLabel(effective.reasoningEffort) : "默认";
    return `${modelLabel} + ${effortLabel}`;
  }

  private formatContextRemainingPercent(inspect: InspectSnapshot): number | null {
    const contextWindow = inspect.tokenUsage?.modelContextWindow;
    const lastTotalTokens = inspect.tokenUsage?.lastTotalTokens;
    if (contextWindow === null || contextWindow === undefined || lastTotalTokens === null || lastTotalTokens === undefined) {
      return null;
    }

    if (contextWindow <= CODEX_CLI_STATUS_LINE_BASELINE_TOKENS) {
      return 0;
    }

    const effectiveWindow = contextWindow - CODEX_CLI_STATUS_LINE_BASELINE_TOKENS;
    const used = Math.max(lastTotalTokens - CODEX_CLI_STATUS_LINE_BASELINE_TOKENS, 0);
    const remaining = Math.max(effectiveWindow - used, 0);
    return Math.round((remaining / effectiveWindow) * 100);
  }

  private formatContextUsedPercent(inspect: InspectSnapshot): number | null {
    const remaining = this.formatContextRemainingPercent(inspect);
    return remaining === null ? null : Math.max(0, Math.min(100, 100 - remaining));
  }

  private async safeSendHtmlMessage(
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<boolean> {
    return (await this.safeSendHtmlMessageResult(chatId, html, replyMarkup)) !== null;
  }

  private async safeSendMessage(
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<boolean> {
    return (await this.safeSendMessageResult(chatId, text, replyMarkup)) !== null;
  }

  private async safeSendMessageResult(
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<TelegramMessage | null> {
    return await this.safeSendTelegramMessageResult(chatId, text, {
      parseMode: null,
      successMessage: "telegram message sent",
      retryMessage: "telegram message delivery retry scheduled",
      failureMessage: "telegram message delivery failed",
      ...(replyMarkup ? { replyMarkup } : {})
    });
  }

  private async safeEditMessageText(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<TelegramEditResult> {
    if (!this.api?.editMessageText) {
      return { outcome: "failed" };
    }

    try {
      await this.api.editMessageText(chatId, messageId, text, replyMarkup ? { replyMarkup } : undefined);
      await this.logger.info("telegram message edited", {
        chatId,
        messageId,
        replyMarkup: replyMarkup ? "inline_keyboard" : null,
        preview: summarizeTextPreview(text)
      });
      return { outcome: "edited" };
    } catch (error) {
      await this.logger.warn("telegram message edit failed", { chatId, messageId, error: `${error}` });
      const retryAfterMs = getTelegramRetryAfterMs(error);
      if (retryAfterMs !== null) {
        return { outcome: "rate_limited", retryAfterMs };
      }

      return { outcome: "failed" };
    }
  }

  private async safeSendHtmlMessageResult(
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<TelegramMessage | null> {
    return await this.safeSendTelegramMessageResult(chatId, html, {
      parseMode: "HTML",
      successMessage: "telegram html message sent",
      retryMessage: "telegram HTML message delivery retry scheduled",
      failureMessage: "telegram HTML message delivery failed",
      ...(replyMarkup ? { replyMarkup } : {})
    });
  }

  private async safeSendPhoto(
    chatId: string,
    photoPath: string,
    options?: {
      caption?: string;
      parseMode?: "HTML";
    }
  ): Promise<boolean> {
    return (await this.safeSendPhotoResult(chatId, photoPath, options)) !== null;
  }

  private async safeSendPhotoResult(
    chatId: string,
    photoPath: string,
    options?: {
      caption?: string;
      parseMode?: "HTML";
    }
  ): Promise<TelegramMessage | null> {
    if (!this.api?.sendPhoto) {
      return null;
    }

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= TELEGRAM_SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const sent = await this.api.sendPhoto(chatId, photoPath, options);
        await this.logger.info("telegram photo sent", {
          chatId,
          messageId: sent.message_id,
          path: photoPath,
          preview: summarizeTextPreview(options?.caption),
          attempts: attempt + 1
        });
        return sent;
      } catch (error) {
        lastError = error;
        const retryDelayMs = getTelegramSendRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          break;
        }

        await this.logger.warn("telegram photo delivery retry scheduled", {
          chatId,
          path: photoPath,
          attempt: attempt + 1,
          retryDelayMs,
          error: `${error}`
        });
        await this.sleep(retryDelayMs);
      }
    }

    await this.logger.error("telegram photo delivery failed", {
      chatId,
      path: photoPath,
      error: `${lastError}`
    });
    return null;
  }

  private async safeSendTelegramMessageResult(
    chatId: string,
    text: string,
    options: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
      parseMode: "HTML" | null;
      successMessage: string;
      retryMessage: string;
      failureMessage: string;
    }
  ): Promise<TelegramMessage | null> {
    if (!this.api) {
      return null;
    }

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= TELEGRAM_SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const sent = await this.api.sendMessage(
          chatId,
          text,
          options.parseMode === "HTML"
            ? options.replyMarkup
              ? { parseMode: "HTML", replyMarkup: options.replyMarkup }
              : { parseMode: "HTML" }
            : options.replyMarkup
              ? { replyMarkup: options.replyMarkup }
              : undefined
        );
        await this.logger.info(options.successMessage, {
          chatId,
          messageId: sent.message_id,
          replyMarkup: options.replyMarkup ? "inline_keyboard" : null,
          preview: summarizeTextPreview(text),
          attempts: attempt + 1
        });
        return sent;
      } catch (error) {
        lastError = error;
        const retryDelayMs = getTelegramSendRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          break;
        }

        await this.logger.warn(options.retryMessage, {
          chatId,
          attempt: attempt + 1,
          retryDelayMs,
          error: `${error}`
        });
        await this.sleep(retryDelayMs);
      }
    }

    await this.logger.error(options.failureMessage, { chatId, error: `${lastError}` });
    return null;
  }

  private async safeEditHtmlMessageText(
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<TelegramEditResult> {
    if (!this.api?.editMessageText) {
      return { outcome: "failed" };
    }

    try {
      await this.api.editMessageText(
        chatId,
        messageId,
        html,
        replyMarkup
          ? { parseMode: "HTML", replyMarkup }
          : { parseMode: "HTML" }
      );
      await this.logger.info("telegram html message edited", {
        chatId,
        messageId,
        replyMarkup: replyMarkup ? "inline_keyboard" : null,
        preview: summarizeTextPreview(html)
      });
      return { outcome: "edited" };
    } catch (error) {
      await this.logger.warn("telegram HTML message edit failed", { chatId, messageId, error: `${error}` });
      const retryAfterMs = getTelegramRetryAfterMs(error);
      if (retryAfterMs !== null) {
        return { outcome: "rate_limited", retryAfterMs };
      }

      return { outcome: "failed" };
    }
  }

  private async replaceBridgeOwnedMessage(
    chatId: string,
    messageId: number,
    text: string,
    options?: {
      html?: boolean;
      replyMarkup?: TelegramInlineKeyboardMarkup;
    }
  ): Promise<boolean> {
    if (messageId > 0) {
      const result = options?.html
        ? await this.safeEditHtmlMessageText(chatId, messageId, text, options.replyMarkup)
        : await this.safeEditMessageText(chatId, messageId, text, options?.replyMarkup);
      if (result.outcome === "edited") {
        return true;
      }
    }

    const sent = options?.html
      ? await this.safeSendHtmlMessageResult(chatId, text, options?.replyMarkup)
      : await this.safeSendMessageResult(chatId, text, options?.replyMarkup);
    if (!sent) {
      return false;
    }

    if (messageId > 0 && sent.message_id !== messageId) {
      await this.safeDeleteMessage(chatId, messageId);
    }

    return true;
  }

  private async safeAnswerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.api) {
      return;
    }

    try {
      await this.api.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      await this.logger.warn("telegram callback acknowledgement failed", {
        callbackQueryId,
        error: `${error}`
      });
    }
  }

  private getUiLanguage(): UiLanguage {
    return this.store?.getUiLanguage() ?? "zh";
  }

  private buildLanguagePickerMessage(language: UiLanguage): {
    text: string;
    replyMarkup: TelegramInlineKeyboardMarkup;
  } {
    const chineseCurrent = language === "zh" ? " 当前" : "";
    const englishCurrent = language === "en" ? " Current" : "";

    return {
      text: language === "en"
        ? `<b>Bridge Language</b>\n<b>Current</b> · English`
        : `<b>桥接语言</b>\n<b>当前</b> · 中文`,
      replyMarkup: {
        inline_keyboard: [
          [{ text: `中文${chineseCurrent}`, callback_data: encodeLanguageSetCallback("zh") }],
          [{ text: `English${englishCurrent}`, callback_data: encodeLanguageSetCallback("en") }],
          [{ text: language === "en" ? "Close" : "关闭", callback_data: encodeLanguageCloseCallback() }]
        ]
      }
    };
  }

  private buildLanguageClosedMessage(language: UiLanguage): string {
    return language === "en"
      ? "<b>Language Picker Closed</b>\n<b>Current</b> English"
      : "<b>已关闭语言选择</b>\n<b>当前语言：</b> 中文";
  }

  private async handleLanguage(chatId: string): Promise<void> {
    const rendered = this.buildLanguagePickerMessage(this.getUiLanguage());
    await this.safeSendHtmlMessage(chatId, rendered.text, rendered.replyMarkup);
  }

  private async handleLanguageSetCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    language: UiLanguage
  ): Promise<void> {
    if (!this.store) {
      await this.safeAnswerCallbackQuery(callbackQueryId, this.getUiLanguage() === "en" ? "State storage unavailable." : "状态存储当前不可用。");
      return;
    }

    const nextLanguage = this.store.setUiLanguage(language);
    await this.safeAnswerCallbackQuery(callbackQueryId, nextLanguage === "en" ? "Saved." : "已保存。");
    await this.syncTelegramCommands();
    await this.replaceBridgeOwnedMessage(chatId, messageId, this.buildLanguageClosedMessage(nextLanguage), {
      html: true
    });
    await this.reanchorRuntimeAfterBridgeReply(chatId, "language_changed");
  }

  private async handleLanguageCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number
  ): Promise<void> {
    const delivered = await this.replaceBridgeOwnedMessage(chatId, messageId, this.buildLanguageClosedMessage(this.getUiLanguage()), {
      html: true
    });
    if (delivered) {
      await this.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId, this.getUiLanguage() === "en"
      ? "Unable to close this message right now."
      : "暂时无法关闭这条消息，请稍后再试。");
  }

  private async reanchorRuntimeAfterBridgeReply(
    chatId: string,
    reason: string,
    sessionId?: string
  ): Promise<void> {
    const activeTurn = sessionId ? this.getActiveTurnForSession(sessionId) : this.getActiveTurnForChat(chatId);
    await this.runtimeSurfaceController.reanchorRuntimeAfterBridgeReply(activeTurn, chatId, reason);
  }

  private async safeDeleteMessage(chatId: string, messageId: number): Promise<boolean> {
    if (!this.api?.deleteMessage) {
      return false;
    }

    try {
      await this.api.deleteMessage(chatId, messageId);
      await this.logger.info("telegram message deleted", { chatId, messageId });
      return true;
    } catch (error) {
      await this.logger.warn("telegram message delete failed", { chatId, messageId, error: `${error}` });
      return false;
    }
  }

  private async syncTelegramCommands(): Promise<void> {
    if (!this.api) {
      return;
    }

    try {
      await syncTelegramCommands(this.api, this.getUiLanguage());
    } catch (error) {
      await this.logger.warn("telegram command menu sync failed", {
        error: `${error}`
      });
    }
  }

  private async sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return;
    }

    const sleepImpl = this.deps.sleep ?? defaultSleep;
    await sleepImpl(delayMs);
  }
}

export async function runBridgeService(importMetaUrl: string): Promise<void> {
  const paths = getBridgePaths(importMetaUrl);
  await ensureBridgeDirectories(paths);
  const config = await loadConfig(paths);
  const service = new BridgeService(paths, config);

  const shutdown = async () => {
    await service.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await service.run();
}

function getTelegramRetryAfterMs(error: unknown): number | null {
  if (error instanceof TelegramApiError && error.retryAfterSeconds !== null) {
    return error.retryAfterSeconds * 1000;
  }

  const message = `${error}`;
  const retryAfterMatch = message.match(/retry after\s+(\d+)/iu);
  if (retryAfterMatch) {
    const retryAfterSeconds = Number.parseInt(retryAfterMatch[1] ?? "", 10);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
  }

  if (/too many requests/iu.test(message)) {
    return 30_000;
  }

  return null;
}

function getTelegramSendRetryDelayMs(error: unknown, attempt: number): number | null {
  if (attempt >= TELEGRAM_SEND_RETRY_DELAYS_MS.length) {
    return null;
  }

  const retryAfterMs = getTelegramRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return retryAfterMs <= TELEGRAM_SEND_MAX_RETRY_AFTER_MS ? retryAfterMs : null;
  }

  if (error instanceof TelegramApiError) {
    return null;
  }

  return TELEGRAM_SEND_RETRY_DELAYS_MS[attempt] ?? null;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function summarizeActivityStatus(status: ActivityStatus): Record<string, unknown> {
  return {
    turnStatus: status.turnStatus,
    threadRuntimeState: status.threadRuntimeState,
    activeItemType: status.activeItemType,
    activeItemId: status.activeItemId,
    activeItemLabel: summarizeTextPreview(status.activeItemLabel, 160) || null,
    lastActivityAt: status.lastActivityAt,
    currentItemStartedAt: status.currentItemStartedAt,
    currentItemDurationSec: status.currentItemDurationSec,
    lastHighValueEventType: status.lastHighValueEventType,
    lastHighValueTitle: summarizeTextPreview(status.lastHighValueTitle, 160) || null,
    lastHighValueDetail: summarizeTextPreview(status.lastHighValueDetail, 160) || null,
    latestProgress: summarizeTextPreview(status.latestProgress, 160) || null,
    recentStatusUpdates: summarizeActivityStatusList(status.recentStatusUpdates),
    blockedReason: status.threadBlockedReason,
    finalMessageAvailable: status.finalMessageAvailable,
    inspectAvailable: status.inspectAvailable,
    debugAvailable: status.debugAvailable,
    errorState: status.errorState
  };
}

function summarizeActivityStatusList(values: string[]): string[] {
  return values.map((value) => summarizeTextPreview(value, 160));
}

function summarizeTextPreview(text: string | null | undefined, limit = 160): string {
  return normalizeAndTruncate(text, limit, "...") ?? "";
}

function buildInspectPayloadFromThreadHistory(
  turn: unknown,
  fallbackTurnStatus: string | null
): InspectRenderPayload | null {
  const turnRecord = asRecord(turn);
  const items = getArray(turnRecord?.items);
  if (items.length === 0) {
    return null;
  }

  const commands: RuntimeCommandEntryView[] = [];
  const recentCommandSummaries: string[] = [];
  const recentFileChangeSummaries: string[] = [];
  const recentMcpSummaries: string[] = [];
  const recentWebSearches: string[] = [];
  const planSnapshot: string[] = [];
  const proposedPlanSnapshot: string[] = [];
  const completedCommentary: string[] = [];
  let finalMessageAvailable = false;
  let latestConclusion: string | null = null;

  for (const item of items) {
    const itemRecord = asRecord(item);
    const itemType = getString(itemRecord, "type");
    switch (itemType) {
      case "commandExecution": {
        const commandText = getString(itemRecord, "command") ?? "command";
        const aggregatedOutput = getString(itemRecord, "aggregatedOutput");
        const parsedOutput = summarizeHistoryCommandOutput(aggregatedOutput, commandText);
        const latestSummary = truncateHistoryText(parsedOutput.summary);
        commands.push({
          commandText: truncateHistoryText(commandText) ?? "command",
          state: formatHistoryCommandState(getString(itemRecord, "status")),
          latestSummary,
          cwd: truncateHistoryText(getString(itemRecord, "cwd")),
          exitCode: getNumber(itemRecord, "exitCode"),
          durationMs: getNumber(itemRecord, "durationMs")
        });
        if (latestSummary) {
          pushHistorySummary(recentCommandSummaries, `${commandText} -> ${latestSummary}`);
          latestConclusion = latestSummary;
        } else {
          pushHistorySummary(recentCommandSummaries, commandText);
          latestConclusion = commandText;
        }
        break;
      }

      case "fileChange": {
        const changes = getArray(itemRecord?.changes);
        const paths = changes
          .map((change) => {
            const changeRecord = asRecord(change);
            const path = getString(changeRecord, "path");
            const kind = getString(changeRecord, "kind");
            if (!path) {
              return null;
            }
            return kind ? `${path} (${kind})` : path;
          })
          .filter((value): value is string => value !== null);
        if (paths.length > 0) {
          for (const path of paths) {
            pushHistorySummary(recentFileChangeSummaries, path);
          }
          latestConclusion = truncateHistoryText(paths[0] ?? null) ?? latestConclusion;
        }
        break;
      }

      case "mcpToolCall": {
        const server = getString(itemRecord, "server");
        const tool = getString(itemRecord, "tool");
        const label = [server, tool].filter((value): value is string => Boolean(value)).join(" / ");
        const resultSummary = summarizeHistoryToolResult(asRecord(itemRecord?.result));
        const errorSummary = getString(asRecord(itemRecord?.error), "message");
        const summary = resultSummary ?? errorSummary;
        const line = summary
          ? `${label || "MCP 工具"} -> ${summary}`
          : label || "MCP 工具";
        pushHistorySummary(recentMcpSummaries, line);
        latestConclusion = truncateHistoryText(summary ?? label) ?? latestConclusion;
        break;
      }

      case "webSearch": {
        const query = getString(itemRecord, "query")
          ?? getString(asRecord(itemRecord?.action), "query")
          ?? getString(asRecord(itemRecord?.action), "url")
          ?? "web search";
        pushHistorySummary(recentWebSearches, query);
        latestConclusion = truncateHistoryText(query) ?? latestConclusion;
        break;
      }

      case "plan": {
        const text = getString(itemRecord, "text");
        if (text) {
          for (const line of text.split(/\r?\n/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
            pushHistorySummary(proposedPlanSnapshot, line);
          }
        }
        break;
      }

      case "agentMessage": {
        const phase = getString(itemRecord, "phase");
        const text = getString(itemRecord, "text");
        if (!text) {
          break;
        }
        if (phase === "commentary") {
          pushHistorySummary(completedCommentary, text);
        } else if (phase === "final_answer") {
          finalMessageAvailable = true;
        }
        break;
      }

      default:
        break;
    }
  }

  const turnStatus = mapStoredTurnStatus(getString(turnRecord, "status") ?? fallbackTurnStatus);
  const snapshot: InspectSnapshot = {
    turnStatus,
    threadRuntimeState: null,
    activeItemType: null,
    activeItemId: null,
    activeItemLabel: null,
    lastActivityAt: null,
    currentItemStartedAt: null,
    currentItemDurationSec: null,
    lastHighValueEventType: finalMessageAvailable ? "done" : null,
    lastHighValueTitle: finalMessageAvailable ? "Done: final answer ready" : null,
    lastHighValueDetail: null,
    latestProgress: null,
    recentStatusUpdates: latestConclusion ? [latestConclusion] : [],
    threadBlockedReason: null,
    finalMessageAvailable,
    inspectAvailable: true,
    debugAvailable: true,
    errorState: null,
    recentTransitions: [],
    recentCommandSummaries,
    recentFileChangeSummaries,
    recentMcpSummaries,
    recentWebSearches,
    recentHookSummaries: [],
    recentNoticeSummaries: [],
    planSnapshot,
    proposedPlanSnapshot,
    agentSnapshot: [],
    completedCommentary,
    tokenUsage: null,
    latestDiffSummary: null,
    terminalInteractionSummary: null,
    pendingInteractions: [],
    answeredInteractions: []
  };

  const hasStructuredDetail = commands.length > 0
    || recentFileChangeSummaries.length > 0
    || recentMcpSummaries.length > 0
    || recentWebSearches.length > 0
    || planSnapshot.length > 0
    || proposedPlanSnapshot.length > 0
    || completedCommentary.length > 0
    || finalMessageAvailable;

  if (!hasStructuredDetail) {
    return null;
  }

  return {
    snapshot,
    commands,
    note: "以下内容来自最近一次执行的历史记录。"
  };
}

function summarizeHistoryCommandOutput(aggregatedOutput: string | null, fallbackCommand: string): {
  command: string;
  summary: string | null;
} {
  const normalized = `${aggregatedOutput ?? ""}`.trim();
  if (!normalized) {
    return {
      command: fallbackCommand,
      summary: null
    };
  }

  const lines = normalized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      command: fallbackCommand,
      summary: null
    };
  }

  const command = lines[0]?.replace(/^[>$#]\s*/u, "") || fallbackCommand;
  const detail = lines.at(-1) && lines.at(-1) !== lines[0] ? lines.at(-1) ?? null : null;
  return {
    command,
    summary: detail
  };
}

function summarizeHistoryToolResult(result: Record<string, unknown> | null): string | null {
  if (!result) {
    return null;
  }

  const content = getArray(result.content);
  const firstContent = content[0];
  if (typeof firstContent === "string" && firstContent.trim().length > 0) {
    return firstContent.trim();
  }

  if (typeof result.structuredContent === "string" && result.structuredContent.trim().length > 0) {
    return result.structuredContent.trim();
  }

  return null;
}

function truncateHistoryText(value: string | null): string | null {
  return normalizeAndTruncate(value, HISTORY_TEXT_LIMIT);
}

function pushHistorySummary(target: string[], value: string): void {
  const nextValue = truncateHistoryText(value);
  if (!nextValue || target.at(-1) === nextValue) {
    return;
  }

  target.push(nextValue);
  if (target.length > HISTORY_SUMMARY_LIMIT) {
    target.splice(0, target.length - HISTORY_SUMMARY_LIMIT);
  }
}

function mapStoredTurnStatus(status: string | null): InspectSnapshot["turnStatus"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
    case "error":
      return "failed";
    case "inProgress":
      return "running";
    default:
      return "unknown";
  }
}

function formatHistoryCommandState(status: string | null): string {
  switch (status) {
    case "running":
    case "inProgress":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
    case "error":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      return "Unknown";
  }
}

function getKnownUnsupportedServerRequest(request: JsonRpcServerRequest): {
  errorMessage: string;
  userMessage: string;
  logDetail: string;
} | null {
  if (request.method === "item/tool/call") {
    const tool = getString(request.params, "tool") ?? "unknown";
    return {
      errorMessage: "Dynamic tool calls are not supported by the Telegram bridge",
      userMessage: `Codex 发起了动态工具调用（${tool}），但 Telegram bridge 当前没有稳定的客户端工具映射，已拒绝这次调用。`,
      logDetail: `tool=${tool}`
    };
  }

  if (request.method === "account/chatgptAuthTokens/refresh") {
    const reason = getString(request.params, "reason") ?? "unknown";
    return {
      errorMessage: "ChatGPT auth token refresh is not supported by the Telegram bridge",
      userMessage: `Codex 请求 ChatGPT 登录令牌刷新（原因：${reason}），但 bridge 不持有可刷新的 ChatGPT access token / account id，已拒绝这次请求。`,
      logDetail: `reason=${reason}`
    };
  }

  return null;
}
