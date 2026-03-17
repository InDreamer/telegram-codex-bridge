import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { createLogger, type Logger } from "./logger.js";
import { TurnDebugJournal, type DebugJournalWriter } from "./activity/debug-journal.js";
import { ensureBridgeDirectories, getBridgePaths, getDebugRuntimeDir, type BridgePaths } from "./paths.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { probeReadiness } from "./readiness.js";
import { BridgeStateStore, StateStoreOpenError } from "./state/store.js";
import { TelegramApi, TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate
} from "./telegram/api.js";
import { TelegramPoller } from "./telegram/poller.js";
import { ActivityTracker, type SubagentIdentityEvent } from "./activity/tracker.js";
import type { ActivityStatus, CollabAgentStateSnapshot, DebugJournalRecord, InspectSnapshot } from "./activity/types.js";
import { classifyNotification } from "./codex/notification-classifier.js";
import type { JsonRpcRequestId, JsonRpcServerRequest, UserInput } from "./codex/app-server.js";
import {
  buildArchiveSuccessText,
  buildCollapsibleFinalAnswerView,
  buildFinalAnswerReplyMarkup,
  buildInteractionApprovalCard,
  buildInteractionExpiredCard,
  buildInteractionQuestionCard,
  buildInteractionResolvedCard,
  buildInspectText,
  buildInspectViewMessage,
  buildManualPathConfirmMessage,
  buildManualPathPrompt,
  buildModelPickerMessage,
  buildNoNewProjectsMessage,
  buildProjectAliasClearedText,
  buildProjectAliasRenamedText,
  buildProjectPinnedText,
  buildProjectPickerMessage,
  buildReasoningEffortPickerMessage,
  buildRollbackConfirmMessage,
  buildRollbackPickerMessage,
  buildRenameTargetPicker,
  buildSessionCreatedText,
  buildProjectSelectedText,
  buildRuntimePreferencesMessage,
  buildRuntimeErrorCard,
  buildRuntimeStatusReplyMarkup,
  buildRuntimeStatusCard,
  buildSessionRenamedText,
  buildSessionSwitchedText,
  buildSessionsText,
  buildStatusText,
  buildUnarchiveSuccessText,
  buildUnsupportedCommandText,
  buildWhereText,
  formatSessionModelReasoningConfig,
  renderFinalAnswerHtmlChunks,
  parseCallbackData,
  parseCommand,
  type ParsedCallbackData,
  type RollbackTargetView,
  type RuntimeCommandEntryView
} from "./telegram/ui.js";
import { buildHelpText, syncTelegramCommands } from "./telegram/commands.js";
import {
  DEFAULT_RUNTIME_STATUS_FIELDS,
  isOperationalReadinessState,
  type RuntimeStatusField,
  PendingInteractionRow,
  PendingInteractionState,
  PendingInteractionSummary,
  ProjectCandidate,
  ProjectPickerResult,
  ReadinessSnapshot,
  ReasoningEffort,
  SessionRow
} from "./types.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import {
  normalizeServerRequest,
  SKIP_QUESTION_OPTION_VALUE,
  type NormalizedApprovalInteraction,
  type NormalizedElicitationInteraction,
  type NormalizedInteraction,
  type NormalizedPermissionsInteraction,
  type NormalizedQuestion,
  type NormalizedQuestionnaireInteraction
} from "./interactions/normalize.js";
import { buildProjectPicker, refreshProjectPicker, validateManualProjectPath } from "./project/discovery.js";
import { commandExists, runCommand } from "./process.js";
import { parseBooleanLike } from "./util/boolean.js";
import { asRecord, getString, getNumber, getArray, getStringArray } from "./util/untyped.js";
import { normalizeWhitespace, truncateText, normalizeAndTruncate, normalizeNullableText } from "./util/text.js";

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

const INSPECT_PLAIN_TEXT_FALLBACK_LIMIT = 3500;
const HISTORY_SUMMARY_LIMIT = 5;
const HISTORY_TEXT_LIMIT = 220;

const MAX_RECENT_ACTIVITY_ENTRIES = 20;
const RUNTIME_CARD_THROTTLE_MS = 2000;
const FAILED_EDIT_RETRY_MS = 5000;
const TELEGRAM_SEND_RETRY_DELAYS_MS = [750, 2_000] as const;
const TELEGRAM_SEND_MAX_RETRY_AFTER_MS = 10_000;
const TELEGRAM_IMAGE_CACHE_DIRNAME = "telegram-images";
const TELEGRAM_IMAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
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

interface PickerState {
  picker: ProjectPickerResult;
  awaitingManualProjectPath: boolean;
  resolved: boolean;
}

interface PendingRenameState {
  kind: "session" | "project";
  sessionId: string;
  projectPath: string;
}

interface RuntimePreferencesDraftState {
  chatId: string;
  messageId: number;
  fields: RuntimeStatusField[];
  page: number;
}

interface RuntimeCardMessageState {
  surface: "status" | "plan" | "error";
  key: string;
  parseMode: "HTML" | null;
  messageId: number;
  lastRenderedText: string;
  lastRenderedReplyMarkupKey: string | null;
  lastRenderedAtMs: number | null;
  rateLimitUntilAtMs: number | null;
  pendingText: string | null;
  pendingReplyMarkup: TelegramInlineKeyboardMarkup | null;
  pendingReason: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RuntimeCommandState {
  itemId: string;
  commandText: string;
  latestSummary: string | null;
  outputBuffer: string;
  status: "running" | "completed" | "failed" | "interrupted";
}

interface StatusCardState extends RuntimeCardMessageState {
  surface: "status";
  parseMode: "HTML";
  commandItems: Map<string, RuntimeCommandState>;
  commandOrder: RuntimeCommandState[];
  planExpanded: boolean;
  agentsExpanded: boolean;
}

interface ErrorCardState extends RuntimeCardMessageState {
  title: string;
  detail: string | null;
}

type RuntimeCardTraceContext = {
  sessionId: string;
  chatId: string | null;
  threadId: string | null;
  turnId: string | null;
};

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
  finalMessage: string | null;
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

type PendingThreadArchiveState = "archived" | "unarchived";

interface PendingThreadArchiveOp {
  id: number;
  sessionId: string;
  expectedRemoteState: PendingThreadArchiveState;
  requestedAt: string;
  origin: "telegram_archive" | "telegram_unarchive";
  localStateCommitted: boolean;
  remoteStateObserved: PendingThreadArchiveState | null;
}

interface PendingInteractionTextMode {
  interactionId: string;
  questionId: string;
}

interface PendingRichInputComposer {
  sessionId: string;
  inputs: UserInput[];
  promptLabel: string;
}

interface VoiceTranscriptionResult {
  transcript: string;
  source: "openai" | "realtime";
}

interface VoiceProcessingTask {
  chatId: string;
  sessionId: string;
  messageId: number;
  telegramFileId: string;
}

interface QuestionnaireDraft {
  answers: Record<string, unknown>;
  awaitingQuestionId?: string | null;
}

type PendingInteractionTerminalState = Extract<
  PendingInteractionRow["state"],
  "answered" | "canceled" | "expired" | "failed"
>;

type InteractionResolutionSource =
  | "server_response_success"
  | "server_response_error"
  | "app_server_exit"
  | "telegram_delivery_failed"
  | "turn_expired"
  | "bridge_restart_recovery";

type TelegramEditResult =
  | { outcome: "edited" }
  | { outcome: "rate_limited"; retryAfterMs: number }
  | { outcome: "failed" };

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
  private poller: TelegramPoller | null = null;
  private api: TelegramApi | null = null;
  private store: BridgeStateStore | null = null;
  private snapshot: ReadinessSnapshot | null = null;
  private appServer: CodexAppServerClient | null = null;
  private readonly unauthorizedReplyAt = new Map<string, number>();
  private readonly pickerStates = new Map<string, PickerState>();
  private readonly pendingRenameStates = new Map<string, PendingRenameState>();
  private readonly pendingThreadArchiveOps = new Map<string, PendingThreadArchiveOp[]>();
  private readonly pendingInteractionTextModes = new Map<string, PendingInteractionTextMode>();
  private readonly pendingRichInputComposers = new Map<string, PendingRichInputComposer>();
  private readonly runtimePreferenceDrafts = new Map<string, RuntimePreferencesDraftState>();
  private readonly recentActivityBySessionId = new Map<string, RecentActivityEntry>();
  private voiceTaskQueue: Promise<void> = Promise.resolve();
  private pendingVoiceTaskCount = 0;
  private activeTurn: ActiveTurnState | null = null;
  private nextPendingThreadArchiveOpId = 1;
  private realtimeVoiceModelId: string | null | undefined = undefined;
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
    this.realtimeVoiceModelId = undefined;
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
    await this.flushRuntimeNotices();
    await this.poller.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.poller?.stop();
    this.pendingThreadArchiveOps.clear();
    if (this.activeTurn) {
      this.disposeRuntimeCards(this.activeTurn);
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
        const pendingRename = this.pendingRenameStates.get(chatId);
        this.pendingRenameStates.delete(chatId);
        await this.safeSendMessage(
          chatId,
          pendingRename?.kind === "project" ? "已取消项目别名修改。" : "已取消会话重命名。"
        );
        return;
      }

      await this.handleRenameInput(chatId, text);
      return;
    }

    if (this.isAwaitingManualProjectPath(chatId)) {
      const command = parseCommand(text);
      if (command?.name === "cancel") {
        await this.returnToProjectPicker(chatId);
        return;
      }

      await this.handleManualPathInput(chatId, text);
      return;
    }

    const pendingTextMode = this.pendingInteractionTextModes.get(chatId);
    if (pendingTextMode) {
      const command = parseCommand(text);
      if (command?.name === "cancel") {
        await this.cancelPendingTextInteraction(chatId, pendingTextMode.interactionId);
        return;
      }

      await this.handlePendingInteractionTextAnswer(chatId, pendingTextMode, text);
      return;
    }

    const pendingRichInputComposer = this.pendingRichInputComposers.get(chatId);
    if (pendingRichInputComposer) {
      const command = parseCommand(text);
      if (command?.name === "cancel") {
        this.pendingRichInputComposers.delete(chatId);
        await this.safeSendMessage(chatId, "已取消待发送的结构化输入。");
        return;
      }

      await this.handlePendingRichInputPrompt(chatId, pendingRichInputComposer, text);
      return;
    }

    if (message.voice) {
      await this.handleVoiceMessage(chatId, message);
      return;
    }

    if (Array.isArray(message.photo) && message.photo.length > 0) {
      await this.handlePhotoMessage(chatId, message);
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

    switch (parsed.kind) {
      case "pick": {
        await this.safeAnswerCallbackQuery(callbackQuery.id);
        await this.handleProjectPick(chatId, parsed.projectKey);
        return;
      }

      case "scan_more": {
        await this.safeAnswerCallbackQuery(callbackQuery.id);
        await this.handleScanMore(chatId);
        return;
      }

      case "path_manual": {
        await this.safeAnswerCallbackQuery(callbackQuery.id);
        await this.enterManualPathMode(chatId);
        return;
      }

      case "path_back": {
        await this.safeAnswerCallbackQuery(callbackQuery.id);
        await this.returnToProjectPicker(chatId);
        return;
      }

      case "path_confirm": {
        await this.safeAnswerCallbackQuery(callbackQuery.id);
        await this.confirmManualProject(chatId, parsed.projectKey);
        return;
      }

      case "rename_session": {
        await this.safeAnswerCallbackQuery(callbackQuery.id);
        await this.beginSessionRename(chatId, parsed.sessionId);
        return;
      }

      case "rename_project": {
        await this.safeAnswerCallbackQuery(callbackQuery.id);
        await this.beginProjectRename(chatId, parsed.sessionId);
        return;
      }

      case "rename_project_clear": {
        await this.safeAnswerCallbackQuery(callbackQuery.id);
        await this.clearProjectAlias(chatId, parsed.sessionId);
        return;
      }

      case "model_default": {
        await this.handleModelDefaultCallback(callbackQuery.id, chatId, message.message_id, parsed.sessionId);
        return;
      }

      case "model_page": {
        await this.handleModelPageCallback(callbackQuery.id, chatId, message.message_id, parsed.sessionId, parsed.page);
        return;
      }

      case "model_pick": {
        await this.handleModelPickCallback(callbackQuery.id, chatId, message.message_id, parsed.sessionId, parsed.modelIndex);
        return;
      }

      case "model_effort": {
        await this.handleModelEffortCallback(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed.sessionId,
          parsed.modelIndex,
          parsed.effort
        );
        return;
      }

      case "plan_expand": {
        await this.handleStatusCardSectionToggle(callbackQuery.id, message.message_id, parsed.sessionId, true, "plan");
        return;
      }

      case "plan_collapse": {
        await this.handleStatusCardSectionToggle(callbackQuery.id, message.message_id, parsed.sessionId, false, "plan");
        return;
      }

      case "agent_expand": {
        await this.handleStatusCardSectionToggle(callbackQuery.id, message.message_id, parsed.sessionId, true, "agents");
        return;
      }

      case "agent_collapse": {
        await this.handleStatusCardSectionToggle(callbackQuery.id, message.message_id, parsed.sessionId, false, "agents");
        return;
      }

      case "final_open": {
        await this.renderPersistedFinalAnswer(callbackQuery.id, chatId, message.message_id, parsed.answerId, {
          expanded: true,
          page: 1
        });
        return;
      }

      case "final_close": {
        await this.renderPersistedFinalAnswer(callbackQuery.id, chatId, message.message_id, parsed.answerId, {
          expanded: false
        });
        return;
      }

      case "final_page": {
        await this.renderPersistedFinalAnswer(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed.answerId,
          { expanded: true, page: parsed.page }
        );
        return;
      }

      case "runtime_page": {
        await this.handleRuntimePreferencesPageCallback(callbackQuery.id, chatId, message.message_id, parsed.token, parsed.page);
        return;
      }

      case "runtime_toggle": {
        await this.handleRuntimePreferencesToggleCallback(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed.token,
          parsed.field
        );
        return;
      }

      case "runtime_save": {
        await this.handleRuntimePreferencesSaveCallback(callbackQuery.id, chatId, message.message_id, parsed.token);
        return;
      }

      case "runtime_reset": {
        await this.handleRuntimePreferencesResetCallback(callbackQuery.id, chatId, message.message_id, parsed.token);
        return;
      }

      case "inspect_expand":
      case "inspect_page": {
        await this.handleInspectViewCallback(callbackQuery.id, chatId, message.message_id, parsed.sessionId, {
          collapsed: false,
          page: parsed.page
        });
        return;
      }

      case "inspect_collapse": {
        await this.handleInspectViewCallback(callbackQuery.id, chatId, message.message_id, parsed.sessionId, {
          collapsed: true,
          page: 0
        });
        return;
      }

      case "rollback_page":
      case "rollback_back": {
        await this.handleRollbackPickerCallback(callbackQuery.id, chatId, message.message_id, parsed.sessionId, {
          mode: "list",
          page: parsed.page
        });
        return;
      }

      case "rollback_pick": {
        await this.handleRollbackPickerCallback(callbackQuery.id, chatId, message.message_id, parsed.sessionId, {
          mode: "confirm",
          page: parsed.page,
          targetIndex: parsed.targetIndex
        });
        return;
      }

      case "rollback_confirm": {
        await this.handleRollbackConfirmCallback(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed.sessionId,
          parsed.targetIndex
        );
        return;
      }

      case "interaction_decision": {
        await this.handleInteractionDecisionCallback(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed
        );
        return;
      }

      case "interaction_question": {
        await this.handleInteractionQuestionCallback(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed
        );
        return;
      }

      case "interaction_text": {
        await this.handleInteractionTextModeCallback(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed
        );
        return;
      }

      case "interaction_cancel": {
        await this.handleInteractionCancelCallback(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed.interactionId
        );
        return;
      }
    }
  }

  private getActiveSessionForModelCallback(chatId: string, sessionId: string): SessionRow | null {
    if (!this.store) {
      return null;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      return null;
    }

    return activeSession;
  }

  private async handleExpiredModelPicker(chatId: string, messageId: number): Promise<void> {
    await this.safeEditMessageText(chatId, messageId, "这个模型列表已过期，请重新发送 /model。");
  }

  private async handleModelDefaultCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    if (!this.store) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);
    this.store.setSessionSelectedModel(session.sessionId, null);
    this.store.setSessionSelectedReasoningEffort(session.sessionId, null);
    await this.safeEditMessageText(
      chatId,
      messageId,
      "已设置当前会话模型：默认模型 + 默认\n下次任务开始时生效。"
    );
  }

  private async handleModelPageCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    page: number
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);
    await this.ensureAppServerAvailable();
    const models = await this.fetchAllModels();
    const picker = buildModelPickerMessage({ session, models, page });
    await this.safeEditMessageText(chatId, messageId, picker.text, picker.replyMarkup);
  }

  private async handleModelPickCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    modelIndex: number
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);
    await this.ensureAppServerAvailable();
    const models = await this.fetchAllModels();
    const model = models[modelIndex];
    if (!model) {
      await this.handleExpiredModelPicker(chatId, messageId);
      return;
    }

    if (model.supportedReasoningEfforts.length > 1) {
      const picker = buildReasoningEffortPickerMessage({ session, model, modelIndex });
      await this.safeEditMessageText(chatId, messageId, picker.text, picker.replyMarkup);
      return;
    }

    await this.persistSessionModelSelection(chatId, messageId, session, model.id, null);
  }

  private async handleModelEffortCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    modelIndex: number,
    effort: ReasoningEffort | null
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);
    await this.ensureAppServerAvailable();
    const models = await this.fetchAllModels();
    const model = models[modelIndex];
    if (!model) {
      await this.handleExpiredModelPicker(chatId, messageId);
      return;
    }

    await this.persistSessionModelSelection(chatId, messageId, session, model.id, effort);
  }

  private async persistSessionModelSelection(
    chatId: string,
    messageId: number | null,
    session: SessionRow,
    modelId: string | null,
    effort: ReasoningEffort | null
  ): Promise<void> {
    if (!this.store) {
      return;
    }

    this.store.setSessionSelectedModel(session.sessionId, modelId);
    this.store.setSessionSelectedReasoningEffort(session.sessionId, effort);

    const nextConfig = formatSessionModelReasoningConfig({
      selectedModel: modelId,
      selectedReasoningEffort: effort
    });
    const text = `已设置当前会话模型：${nextConfig}\n下次任务开始时生效。`;

    if (messageId === null) {
      await this.safeSendMessage(chatId, text);
      return;
    }

    await this.safeEditMessageText(chatId, messageId, text);
  }

  private async handleRuntime(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const token = this.createRuntimePreferencesDraftToken();
    const draft: RuntimePreferencesDraftState = {
      chatId,
      messageId: 0,
      fields: [...this.store.getRuntimeCardPreferences().fields],
      page: 0
    };
    const rendered = buildRuntimePreferencesMessage({
      token,
      fields: draft.fields,
      page: draft.page
    });
    const sent = await this.safeSendHtmlMessageResult(chatId, rendered.text, rendered.replyMarkup);
    if (!sent) {
      return;
    }

    draft.messageId = sent.message_id;
    this.runtimePreferenceDrafts.set(token, draft);
  }

  private createRuntimePreferencesDraftToken(): string {
    return randomUUID().replace(/-/gu, "").slice(0, 10);
  }

  private getRuntimePreferencesDraft(
    token: string,
    chatId: string,
    messageId: number
  ): RuntimePreferencesDraftState | null {
    const draft = this.runtimePreferenceDrafts.get(token);
    if (!draft || draft.chatId !== chatId || draft.messageId !== messageId) {
      return null;
    }

    return draft;
  }

  private async renderRuntimePreferencesDraft(token: string, draft: RuntimePreferencesDraftState): Promise<void> {
    const rendered = buildRuntimePreferencesMessage({
      token,
      fields: draft.fields,
      page: draft.page
    });
    await this.safeEditHtmlMessageText(draft.chatId, draft.messageId, rendered.text, rendered.replyMarkup);
  }

  private async handleRuntimePreferencesPageCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    page: number
  ): Promise<void> {
    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    draft.page = Math.max(0, page);
    await this.safeAnswerCallbackQuery(callbackQueryId);
    await this.renderRuntimePreferencesDraft(token, draft);
  }

  private async handleRuntimePreferencesToggleCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    field: RuntimeStatusField
  ): Promise<void> {
    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    draft.fields = draft.fields.includes(field)
      ? draft.fields.filter((candidate) => candidate !== field)
      : [...draft.fields, field];
    await this.safeAnswerCallbackQuery(callbackQueryId);
    await this.renderRuntimePreferencesDraft(token, draft);
  }

  private async handleRuntimePreferencesSaveCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string
  ): Promise<void> {
    if (!this.store) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "状态存储当前不可用。");
      return;
    }

    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    const saved = this.store.setRuntimeCardPreferences(draft.fields);
    draft.fields = [...saved.fields];
    await this.safeAnswerCallbackQuery(callbackQueryId, "已保存。");
    await this.renderRuntimePreferencesDraft(token, draft);
    await this.refreshActiveRuntimeStatusCard(chatId, "runtime_preferences_saved");
  }

  private async handleRuntimePreferencesResetCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string
  ): Promise<void> {
    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    draft.fields = [...DEFAULT_RUNTIME_STATUS_FIELDS];
    draft.page = 0;
    await this.safeAnswerCallbackQuery(callbackQueryId, "已恢复默认，记得保存。");
    await this.renderRuntimePreferencesDraft(token, draft);
  }

  private async refreshActiveRuntimeStatusCard(chatId: string, reason: string): Promise<void> {
    if (!this.activeTurn || this.activeTurn.chatId !== chatId) {
      return;
    }

    const rendered = this.buildStatusCardRenderPayload(
      this.activeTurn.sessionId,
      this.activeTurn.tracker,
      this.activeTurn.statusCard
    );
    await this.requestRuntimeCardRender(this.activeTurn, this.activeTurn.statusCard, rendered.text, rendered.replyMarkup, {
      force: true,
      reason
    });
  }

  private async handleStatusCardSectionToggle(
    callbackQueryId: string,
    messageId: number,
    sessionId: string,
    expanded: boolean,
    section: "plan" | "agents"
  ): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.sessionId !== sessionId || activeTurn.statusCard.messageId !== messageId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const inspect = activeTurn.tracker.getInspectSnapshot();
    const snapshotData = section === "plan" ? inspect.planSnapshot : inspect.agentSnapshot;
    if (snapshotData.length === 0) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const expandedField = section === "plan" ? "planExpanded" : "agentsExpanded";
    if (activeTurn.statusCard[expandedField] === expanded) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个操作已处理。");
      return;
    }

    activeTurn.statusCard[expandedField] = expanded;
    await this.safeAnswerCallbackQuery(callbackQueryId);

    const expandedLabel = `${section === "plan" ? "plan" : "agents"}_${expanded ? "expanded" : "collapsed"}`;
    const triggerMethod = `v1:${section === "plan" ? "plan" : "agent"}:${expanded ? "expand" : "collapse"}`;
    const rendered = this.buildStatusCardRenderPayload(activeTurn.sessionId, activeTurn.tracker, activeTurn.statusCard);
    await this.logRuntimeCardEvent(this.getRuntimeCardTraceContext(activeTurn), activeTurn.statusCard, "state_transition", {
      reason: expandedLabel,
      forced: true,
      triggerKind: "callback",
      triggerMethod,
      commandStateChanged: false,
      statusProgressTextChanged: false,
      previousStatus: summarizeActivityStatus(inspect),
      nextStatus: summarizeActivityStatus(inspect),
      selectedProgressText: selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null),
      commands: summarizeRuntimeCommands(activeTurn.statusCard.commandOrder),
      card: summarizeRuntimeCardSurface(activeTurn.statusCard),
      renderedText: rendered.text,
      replyMarkup: rendered.replyMarkup ?? null
    });
    await this.requestRuntimeCardRender(activeTurn, activeTurn.statusCard, rendered.text, rendered.replyMarkup, {
      force: true,
      reason: expandedLabel
    });
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
    if (!this.store) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const view = this.store.getFinalAnswerView(answerId, chatId);
    if (!view) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (!mode.expanded) {
      const result = await this.safeEditHtmlMessageText(
        chatId,
        messageId,
        view.previewHtml,
        buildFinalAnswerReplyMarkup({
          answerId,
          totalPages: view.pages.length,
          expanded: false
        })
      );
      await this.finishPersistedFinalAnswerRender(callbackQueryId, answerId, messageId, result);
      return;
    }

    const page = mode.page ?? 1;
    const pageHtml = view.pages[page - 1];
    if (!pageHtml) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const result = await this.safeEditHtmlMessageText(
      chatId,
      messageId,
      pageHtml,
      buildFinalAnswerReplyMarkup({
        answerId,
        totalPages: view.pages.length,
        expanded: true,
        currentPage: page
      })
    );
    await this.finishPersistedFinalAnswerRender(callbackQueryId, answerId, messageId, result);
  }

  private async finishPersistedFinalAnswerRender(
    callbackQueryId: string,
    answerId: string,
    messageId: number,
    result: TelegramEditResult
  ): Promise<void> {
    switch (result.outcome) {
      case "edited":
        this.store?.setFinalAnswerMessageId(answerId, messageId);
        await this.safeAnswerCallbackQuery(callbackQueryId);
        return;
      case "rate_limited":
        await this.safeAnswerCallbackQuery(callbackQueryId, "Telegram 正在限流，请稍后再试。");
        return;
      default:
        await this.safeAnswerCallbackQuery(callbackQueryId, "暂时无法更新这条消息，请稍后再试。");
        return;
    }
  }

  private async handleInteractionDecisionCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    parsed: Extract<ParsedCallbackData, { kind: "interaction_decision" }>
  ): Promise<void> {
    const loaded = await this.loadPendingInteractionForCallback(
      chatId,
      messageId,
      parsed.interactionId,
      callbackQueryId
    );
    if (!loaded) {
      return;
    }

    const { row, interaction } = loaded;
    if (!isPendingInteractionActionable(row)) {
      await this.renderStoredPendingInteraction(chatId, row, interaction);
      await this.safeAnswerCallbackQuery(
        callbackQueryId,
        isPendingInteractionHandled(row) ? "这个操作已处理。" : "这个按钮已过期，请重新操作。"
      );
      return;
    }

    const decisionKey = resolveInteractionDecisionKey(interaction, parsed);
    if (!decisionKey) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const resolved = buildInteractionDecisionResolution(interaction, decisionKey);
    if (!resolved) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个操作当前不支持。");
      return;
    }

    const success = await this.submitPendingInteractionResponse(chatId, row, interaction, resolved.payload);
    if (!success) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "暂时无法处理这个交互，请稍后再试。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);
  }

  private async handleInteractionQuestionCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    parsed: Extract<ParsedCallbackData, { kind: "interaction_question" }>
  ): Promise<void> {
    const loaded = await this.loadPendingInteractionForCallback(
      chatId,
      messageId,
      parsed.interactionId,
      callbackQueryId
    );
    if (!loaded) {
      return;
    }

    const { row, interaction } = loaded;
    if (!isPendingInteractionActionable(row)) {
      await this.renderStoredPendingInteraction(chatId, row, interaction);
      await this.safeAnswerCallbackQuery(
        callbackQueryId,
        isPendingInteractionHandled(row) ? "这个操作已处理。" : "这个按钮已过期，请重新操作。"
      );
      return;
    }

    if (interaction.kind !== "questionnaire") {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const questionId = resolveInteractionQuestionId(interaction, parsed);
    if (!questionId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    const selectedOption = currentQuestion?.options?.[parsed.optionIndex];
    if (!currentQuestion || currentQuestion.id !== questionId || !selectedOption) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const parsedAnswer = parseQuestionAnswerInput(
      currentQuestion,
      selectedOption.value,
      "option"
    );
    if (!parsedAnswer.ok) {
      await this.safeAnswerCallbackQuery(callbackQueryId, parsedAnswer.message);
      return;
    }

    draft.answers[currentQuestion.id] = parsedAnswer.value;
    draft.awaitingQuestionId = null;

    const nextQuestion = getCurrentQuestion(interaction, draft);
    if (nextQuestion) {
      this.store?.markPendingInteractionPending(row.interactionId, JSON.stringify(draft));
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: "pending",
        responseJson: JSON.stringify(draft)
      }, interaction);
      await this.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    const payload = buildQuestionnaireSubmissionPayload(interaction, draft);
    const success = await this.submitPendingInteractionResponse(chatId, row, interaction, payload);
    if (!success) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "暂时无法处理这个交互，请稍后再试。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);
  }

  private async handleInteractionTextModeCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    parsed: Extract<ParsedCallbackData, { kind: "interaction_text" }>
  ): Promise<void> {
    const loaded = await this.loadPendingInteractionForCallback(
      chatId,
      messageId,
      parsed.interactionId,
      callbackQueryId
    );
    if (!loaded) {
      return;
    }

    const { row, interaction } = loaded;
    if (!isPendingInteractionActionable(row)) {
      await this.renderStoredPendingInteraction(chatId, row, interaction);
      await this.safeAnswerCallbackQuery(
        callbackQueryId,
        isPendingInteractionHandled(row) ? "这个操作已处理。" : "这个按钮已过期，请重新操作。"
      );
      return;
    }

    if (interaction.kind !== "questionnaire") {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const questionId = resolveInteractionQuestionId(interaction, parsed);
    if (!questionId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    if (!currentQuestion || currentQuestion.id !== questionId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }
    if (!questionAllowsTextAnswer(currentQuestion)) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个问题只能用按钮回答。");
      return;
    }

    draft.awaitingQuestionId = currentQuestion.id;
    this.store?.markPendingInteractionAwaitingText(row.interactionId, JSON.stringify(draft));
    this.pendingInteractionTextModes.set(chatId, {
      interactionId: row.interactionId,
      questionId: currentQuestion.id
    });
    await this.safeAnswerCallbackQuery(callbackQueryId);
    await this.safeSendMessage(
      chatId,
      currentQuestion.isSecret
        ? "请直接发送这条敏感回答。桥不会把它回显到可见摘要里。"
        : "请直接发送这条问题的文字回答。发送 /cancel 可以取消。"
    );
  }

  private async handleInteractionCancelCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    interactionId: string
  ): Promise<void> {
    const loaded = await this.loadPendingInteractionForCallback(chatId, messageId, interactionId, callbackQueryId);
    if (!loaded) {
      return;
    }

    const { row, interaction } = loaded;
    if (!isPendingInteractionActionable(row)) {
      await this.renderStoredPendingInteraction(chatId, row, interaction);
      await this.safeAnswerCallbackQuery(
        callbackQueryId,
        isPendingInteractionHandled(row) ? "这个操作已处理。" : "这个按钮已过期，请重新操作。"
      );
      return;
    }

    const success = await this.cancelInteraction(chatId, row, interaction, "user_canceled_interaction");
    await this.safeAnswerCallbackQuery(callbackQueryId, success ? undefined : "暂时无法处理这个交互，请稍后再试。");
  }

  private async cancelPendingTextInteraction(chatId: string, interactionId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const row = this.store.getPendingInteraction(interactionId, chatId);
    if (!row) {
      this.pendingInteractionTextModes.delete(chatId);
      await this.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction) {
      this.pendingInteractionTextModes.delete(chatId);
      await this.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    await this.cancelInteraction(chatId, row, interaction, "user_canceled_text_mode");
  }

  private async cancelInteraction(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction,
    errorReason: string
  ): Promise<boolean> {
    if (interaction.kind === "approval") {
      const resolved = buildInteractionDecisionResolution(interaction, "cancel");
      return resolved
        ? await this.submitPendingInteractionResponse(chatId, row, interaction, resolved.payload, {
          state: "canceled",
          errorReason
        })
        : await this.failPendingInteraction(chatId, row, interaction, errorReason, {
          state: "canceled"
        });
    }

    if (interaction.kind === "elicitation" || (interaction.kind === "questionnaire" && interaction.submission === "mcp_elicitation_form")) {
      return await this.submitPendingInteractionResponse(chatId, row, interaction, { action: "cancel" }, {
        state: "canceled",
        errorReason
      });
    }

    return await this.failPendingInteraction(chatId, row, interaction, errorReason, {
      state: "canceled"
    });
  }

  private async handlePendingInteractionTextAnswer(
    chatId: string,
    mode: PendingInteractionTextMode,
    text: string
  ): Promise<void> {
    if (!this.store) {
      return;
    }

    const row = this.store.getPendingInteraction(mode.interactionId, chatId);
    if (!row) {
      this.pendingInteractionTextModes.delete(chatId);
      await this.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction || interaction.kind !== "questionnaire") {
      this.pendingInteractionTextModes.delete(chatId);
      await this.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    if (!isPendingInteractionActionable(row)) {
      this.pendingInteractionTextModes.delete(chatId);
      await this.renderStoredPendingInteraction(chatId, row, interaction);
      await this.safeSendMessage(chatId, isPendingInteractionHandled(row) ? "这个操作已处理。" : "这个交互已过期。");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    if (!currentQuestion || currentQuestion.id !== mode.questionId) {
      this.pendingInteractionTextModes.delete(chatId);
      await this.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    const parsedAnswer = parseQuestionAnswerInput(currentQuestion, text, "text");
    if (!parsedAnswer.ok) {
      await this.safeSendMessage(chatId, parsedAnswer.message);
      return;
    }

    draft.answers[currentQuestion.id] = parsedAnswer.value;
    draft.awaitingQuestionId = null;
    this.pendingInteractionTextModes.delete(chatId);

    const nextQuestion = getCurrentQuestion(interaction, draft);
    if (nextQuestion) {
      this.store.markPendingInteractionPending(row.interactionId, JSON.stringify(draft));
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: "pending",
        responseJson: JSON.stringify(draft)
      }, interaction);
      return;
    }

    const payload = buildQuestionnaireSubmissionPayload(interaction, draft);
    const success = await this.submitPendingInteractionResponse(chatId, row, interaction, payload);
    if (!success) {
      await this.safeSendMessage(chatId, "暂时无法处理这个交互，请稍后再试。");
    }
  }

  private async submitPendingInteractionResponse(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction,
    payload: unknown,
    options?: {
      state?: Extract<PendingInteractionState, "answered" | "canceled">;
      errorReason?: string | null;
    }
  ): Promise<boolean> {
    if (!this.store || !this.appServer) {
      return false;
    }

    const terminalState = options?.state ?? "answered";
    const payloadJson = JSON.stringify(payload);
    try {
      await this.appServer.respondToServerRequest(deserializeJsonRpcRequestId(row.requestId), payload);
      if (terminalState === "canceled") {
        this.store.markPendingInteractionCanceled(row.interactionId, payloadJson, options?.errorReason ?? null);
      } else {
        this.store.markPendingInteractionAnswered(row.interactionId, payloadJson);
      }
      this.clearPendingInteractionTextMode(row.interactionId);
      await this.appendInteractionResolvedJournal(row, {
        finalState: terminalState,
        responseJson: payloadJson,
        errorReason: options?.errorReason ?? null,
        resolutionSource: "server_response_success"
      });
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: terminalState,
        responseJson: payloadJson,
        errorReason: options?.errorReason ?? null
      }, interaction);
      return true;
    } catch (error) {
      await this.logger.warn("interaction response dispatch failed", {
        interactionId: row.interactionId,
        requestMethod: row.requestMethod,
        error: `${error}`
      });
      this.store.markPendingInteractionFailed(row.interactionId, "response_dispatch_failed");
      this.clearPendingInteractionTextMode(row.interactionId);
      await this.appendInteractionResolvedJournal(row, {
        finalState: "failed",
        errorReason: "response_dispatch_failed",
        resolutionSource: "server_response_error"
      });
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: "failed",
        errorReason: "response_dispatch_failed"
      }, interaction);
      return false;
    }
  }

  private async failPendingInteraction(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction,
    reason: string,
    options?: {
      state?: Extract<PendingInteractionState, "failed" | "canceled">;
    }
  ): Promise<boolean> {
    if (!this.store || !this.appServer) {
      return false;
    }

    const terminalState = options?.state ?? "failed";
    try {
      await this.appServer.respondToServerRequestError(
        deserializeJsonRpcRequestId(row.requestId),
        4001,
        reason
      );
      if (terminalState === "canceled") {
        this.store.markPendingInteractionCanceled(row.interactionId, null, reason);
      } else {
        this.store.markPendingInteractionFailed(row.interactionId, reason);
      }
      this.clearPendingInteractionTextMode(row.interactionId);
      await this.appendInteractionResolvedJournal(row, {
        finalState: terminalState,
        errorReason: reason,
        resolutionSource: "server_response_error"
      });
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: terminalState,
        errorReason: reason
      }, interaction);
      return true;
    } catch (error) {
      await this.logger.warn("interaction failure dispatch failed", {
        interactionId: row.interactionId,
        requestMethod: row.requestMethod,
        error: `${error}`
      });
      return false;
    }
  }

  private async loadPendingInteractionForCallback(
    chatId: string,
    messageId: number,
    interactionId: string,
    callbackQueryId: string
  ): Promise<{ row: PendingInteractionRow; interaction: NormalizedInteraction } | null> {
    if (!this.store) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return null;
    }

    const row = this.store.getPendingInteraction(interactionId, chatId);
    if (!row) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return null;
    }

    if (row.telegramMessageId !== null && row.telegramMessageId !== messageId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return null;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return null;
    }

    return { row, interaction };
  }

  private async renderStoredPendingInteraction(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction
  ): Promise<void> {
    if (row.telegramMessageId === null) {
      return;
    }

    const rendered = buildPendingInteractionSurface(row, interaction);
    await this.safeEditHtmlMessageText(chatId, row.telegramMessageId, rendered.text, rendered.replyMarkup);
  }

  private clearPendingInteractionTextMode(interactionId: string): void {
    for (const [chatId, pending] of this.pendingInteractionTextModes.entries()) {
      if (pending.interactionId === interactionId) {
        this.pendingInteractionTextModes.delete(chatId);
      }
    }
  }

  private listActionablePendingInteractionsForSession(chatId: string, sessionId: string): PendingInteractionRow[] {
    if (!this.store) {
      return [];
    }

    return this.store
      .listPendingInteractionsByChat(chatId, ["pending", "awaiting_text"])
      .filter((interaction) => interaction.sessionId === sessionId && isPendingInteractionActionable(interaction));
  }

  private getBlockedTurnSteerAvailability(
    chatId: string,
    session: SessionRow
  ):
    | { kind: "available"; activeTurn: ActiveTurnState }
    | { kind: "interaction_pending" }
    | { kind: "busy" } {
    if (session.status !== "running") {
      return { kind: "busy" };
    }

    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.sessionId !== session.sessionId) {
      return { kind: "busy" };
    }

    if (activeTurn.tracker.getStatus().turnStatus !== "blocked") {
      return { kind: "busy" };
    }

    if (this.listActionablePendingInteractionsForSession(chatId, session.sessionId).length > 0) {
      return { kind: "interaction_pending" };
    }

    return { kind: "available", activeTurn };
  }

  private async sendPendingInteractionBlockNotice(chatId: string): Promise<void> {
    await this.safeSendMessage(chatId, "当前正在等待你处理交互卡片，请先在卡片中回答或取消。");
  }

  private async updatePendingInteractionTerminalState(
    row: PendingInteractionRow,
    state: Extract<PendingInteractionState, "failed" | "expired">,
    reason: string
  ): Promise<PendingInteractionRow | null> {
    if (!this.store) {
      return null;
    }

    if (state === "failed") {
      this.store.markPendingInteractionFailed(row.interactionId, reason);
    } else {
      this.store.markPendingInteractionExpired(row.interactionId, reason);
    }

    return this.store.getPendingInteraction(row.interactionId, row.telegramChatId);
  }

  private async resolveActionablePendingInteractionsForSession(
    chatId: string,
    sessionId: string,
    options: {
      state: Extract<PendingInteractionState, "failed" | "expired">;
      reason: string;
      resolutionSource: InteractionResolutionSource;
    }
  ): Promise<void> {
    if (!this.store) {
      return;
    }

    const pending = this.listActionablePendingInteractionsForSession(chatId, sessionId);
    if (pending.length === 0) {
      return;
    }

    for (const interactionRow of pending) {
      const updatedRow = await this.updatePendingInteractionTerminalState(
        interactionRow,
        options.state,
        options.reason
      );
      this.clearPendingInteractionTextMode(interactionRow.interactionId);
      await this.appendInteractionResolvedJournal(interactionRow, {
        finalState: options.state,
        errorReason: options.reason,
        resolutionSource: options.resolutionSource
      });
      const interaction = parseStoredInteraction((updatedRow ?? interactionRow).promptJson);
      if (!interaction) {
        continue;
      }

      await this.renderStoredPendingInteraction(chatId, updatedRow ?? {
        ...interactionRow,
        state: options.state,
        errorReason: options.reason
      }, interaction);
    }
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
    switch (commandName) {
      case "start":
      case "help":
      case "commands": {
        await this.safeSendMessage(chatId, buildHelpText());
        return;
      }

      case "status": {
        await this.sendStatus(chatId);
        return;
      }

      case "new": {
        if (!this.store) {
          return;
        }

        const activeSession = this.store.getActiveSession(chatId);
        if (activeSession?.status === "running") {
          await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
          return;
        }

        await this.showProjectPicker(chatId);
        return;
      }

      case "cancel": {
        if (this.isAwaitingRename(chatId)) {
          const pendingRename = this.pendingRenameStates.get(chatId);
          this.pendingRenameStates.delete(chatId);
          await this.safeSendMessage(
            chatId,
            pendingRename?.kind === "project" ? "已取消项目别名修改。" : "已取消会话重命名。"
          );
          return;
        }

        if (this.isAwaitingManualProjectPath(chatId)) {
          await this.returnToProjectPicker(chatId);
          return;
        }

        if (this.pendingRichInputComposers.has(chatId)) {
          this.pendingRichInputComposers.delete(chatId);
          await this.safeSendMessage(chatId, "已取消待发送的结构化输入。");
          return;
        }

        await this.safeSendMessage(chatId, "当前没有可取消的输入。");
        return;
      }

      case "sessions": {
        await this.handleSessions(chatId, args);
        return;
      }

      case "archive": {
        await this.handleArchive(chatId);
        return;
      }

      case "where": {
        if (!this.store) {
          return;
        }

        await this.safeSendHtmlMessage(chatId, buildWhereText(this.store.getActiveSession(chatId)));
        return;
      }

      case "interrupt": {
        await this.handleInterrupt(chatId);
        return;
      }

      case "inspect": {
        await this.handleInspect(chatId);
        return;
      }

      case "runtime": {
        await this.handleRuntime(chatId);
        return;
      }

      case "use": {
        await this.handleUse(chatId, args);
        return;
      }

      case "unarchive": {
        await this.handleUnarchive(chatId, args);
        return;
      }

      case "rename": {
        await this.handleRename(chatId, args);
        return;
      }

      case "pin": {
        await this.handlePin(chatId);
        return;
      }

      case "plan": {
        await this.handlePlan(chatId);
        return;
      }

      case "model": {
        await this.runGuardedCommand(chatId, "模型操作暂时不可用，请稍后重试。", async () => {
          await this.handleModel(chatId, args);
        });
        return;
      }

      case "skills": {
        await this.runGuardedCommand(chatId, "技能列表暂时不可用，请稍后重试。", async () => {
          await this.handleSkills(chatId);
        });
        return;
      }

      case "skill": {
        await this.runGuardedCommand(chatId, "结构化 skill 输入暂时不可用，请稍后重试。", async () => {
          await this.handleSkill(chatId, args);
        });
        return;
      }

      case "plugins": {
        await this.runGuardedCommand(chatId, "插件列表暂时不可用，请稍后重试。", async () => {
          await this.handlePlugins(chatId);
        });
        return;
      }

      case "plugin": {
        await this.runGuardedCommand(chatId, "当前无法管理插件，请稍后重试。", async () => {
          await this.handlePlugin(chatId, args);
        });
        return;
      }

      case "apps": {
        await this.runGuardedCommand(chatId, "当前无法读取 Apps 列表，请稍后重试。", async () => {
          await this.handleApps(chatId);
        });
        return;
      }

      case "mcp": {
        await this.runGuardedCommand(chatId, "当前无法读取 MCP 状态，请稍后重试。", async () => {
          await this.handleMcp(chatId, args);
        });
        return;
      }

      case "account": {
        await this.runGuardedCommand(chatId, "当前无法读取账号状态，请稍后重试。", async () => {
          await this.handleAccount(chatId);
        });
        return;
      }

      case "review": {
        await this.runGuardedCommand(chatId, "当前无法启动审查，请稍后重试。", async () => {
          await this.handleReview(chatId, args);
        });
        return;
      }

      case "fork": {
        await this.runGuardedCommand(chatId, "当前无法分叉这个会话，请稍后重试。", async () => {
          await this.handleFork(chatId, args);
        });
        return;
      }

      case "rollback": {
        await this.runGuardedCommand(chatId, "当前无法回滚这个会话，请稍后重试。", async () => {
          await this.handleRollback(chatId, args);
        });
        return;
      }

      case "compact": {
        await this.runGuardedCommand(chatId, "当前无法压缩这个线程，请稍后重试。", async () => {
          await this.handleCompact(chatId);
        });
        return;
      }

      case "local_image": {
        await this.runGuardedCommand(chatId, "本地图片输入暂时不可用，请稍后重试。", async () => {
          await this.handleLocalImage(chatId, args);
        });
        return;
      }

      case "mention": {
        await this.runGuardedCommand(chatId, "结构化引用输入暂时不可用，请稍后重试。", async () => {
          await this.handleMention(chatId, args);
        });
        return;
      }

      case "thread": {
        await this.runGuardedCommand(chatId, "当前无法更新线程设置，请稍后重试。", async () => {
          await this.handleThreadCommand(chatId, args);
        });
        return;
      }

      default: {
        await this.safeSendMessage(chatId, buildUnsupportedCommandText());
      }
    }
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
      const steerAvailability = this.getBlockedTurnSteerAvailability(chatId, activeSession);
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
        await this.sendPendingInteractionBlockNotice(chatId);
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
    if (!this.store) {
      return;
    }

    const picker = await buildProjectPicker(this.paths.homeDir, this.config.projectScanRoots, this.store);
    this.pickerStates.set(chatId, {
      picker,
      awaitingManualProjectPath: false,
      resolved: false
    });

    const rendered = buildProjectPickerMessage(picker);
    await this.safeSendMessage(chatId, rendered.text, rendered.replyMarkup);
  }

  private async handleProjectPick(chatId: string, projectKey: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (pickerState.resolved) {
      await this.safeSendMessage(chatId, "这个操作已处理。");
      return;
    }

    const candidate = pickerState.picker.projectMap.get(projectKey);
    if (!candidate) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (activeSession?.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    this.store.createSession({
      telegramChatId: chatId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      displayName: candidate.displayName
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    await this.safeSendHtmlMessage(chatId, buildSessionCreatedText(candidate.displayName));
  }

  private async handleScanMore(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    await this.safeSendMessage(chatId, "正在扫描本地项目，请稍候…");
    const previousKeys = new Set([...pickerState.picker.projectMap.keys()]);
    const refreshed = await refreshProjectPicker(
      this.paths.homeDir,
      this.config.projectScanRoots,
      this.store,
      previousKeys
    );

    this.pickerStates.set(chatId, {
      picker: refreshed.picker,
      awaitingManualProjectPath: false,
      resolved: false
    });

    if (!refreshed.hasNewResults) {
      const noNewProjects = buildNoNewProjectsMessage();
      await this.safeSendMessage(chatId, noNewProjects.text, noNewProjects.replyMarkup);
      return;
    }

    const rendered = buildProjectPickerMessage(refreshed.picker);
    await this.safeSendMessage(chatId, rendered.text, rendered.replyMarkup);
  }

  private async enterManualPathMode(chatId: string): Promise<void> {
    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    pickerState.awaitingManualProjectPath = true;
    const prompt = buildManualPathPrompt();
    await this.safeSendMessage(chatId, prompt.text, prompt.replyMarkup);
  }

  private async handleManualPathInput(chatId: string, text: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const candidate = await validateManualProjectPath(text, this.paths.homeDir, this.store);
    if (!candidate) {
      await this.safeSendMessage(
        chatId,
        "这个目录不可用，请重新发送目录路径。\n也可以发送 /cancel 返回项目列表。"
      );
      return;
    }

    pickerState.picker.projectMap.set(candidate.projectKey, candidate);
    const confirmation = buildManualPathConfirmMessage(candidate);
    await this.safeSendHtmlMessage(chatId, confirmation.text, confirmation.replyMarkup);
  }

  private async confirmManualProject(chatId: string, projectKey: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (pickerState.resolved) {
      await this.safeSendMessage(chatId, "这个操作已处理。");
      return;
    }

    const candidate = pickerState.picker.projectMap.get(projectKey);
    if (!candidate) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (activeSession?.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    this.store.createSession({
      telegramChatId: chatId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      displayName: candidate.displayName
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    await this.safeSendHtmlMessage(chatId, buildSessionCreatedText(candidate.displayName));
  }

  private async returnToProjectPicker(chatId: string): Promise<void> {
    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    pickerState.awaitingManualProjectPath = false;
    const rendered = buildProjectPickerMessage(pickerState.picker);
    await this.safeSendMessage(chatId, rendered.text, rendered.replyMarkup);
  }

  private isAwaitingManualProjectPath(chatId: string): boolean {
    return this.pickerStates.get(chatId)?.awaitingManualProjectPath ?? false;
  }

  private isAwaitingRename(chatId: string): boolean {
    return this.pendingRenameStates.has(chatId);
  }

  private projectDisplayName(project: Pick<SessionRow, "projectName" | "projectAlias">): string {
    return project.projectAlias?.trim() || project.projectName;
  }

  private async sendStatus(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const snapshot = this.store.getReadinessSnapshot() ?? this.snapshot;
    const activeSession = this.store.getActiveSession(chatId);
    if (!snapshot) {
      await this.safeSendMessage(chatId, "桥接状态未知，请在本机运行 ctb doctor。");
      return;
    }

    await this.safeSendHtmlMessage(chatId, buildStatusText(snapshot, activeSession));
  }

  private async handleSessions(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const archived = args.trim() === "archived";
    const sessions = this.store.listSessions(chatId, { archived, limit: 10 });
    const activeSession = archived ? null : this.store.getActiveSession(chatId);
    await this.safeSendMessage(
      chatId,
      buildSessionsText({
        sessions,
        activeSessionId: activeSession?.sessionId ?? null,
        archived
      })
    );
  }

  private async handleUse(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (activeSession?.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    const index = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(index) || index < 1) {
      await this.safeSendMessage(chatId, "找不到这个会话。");
      return;
    }

    const sessions = this.store.listSessions(chatId);
    const target = sessions[index - 1];
    if (!target) {
      await this.safeSendMessage(chatId, "找不到这个会话。");
      return;
    }

    this.store.setActiveSession(chatId, target.sessionId);
    await this.safeSendHtmlMessage(chatId, buildSessionSwitchedText(this.projectDisplayName(target)));
  }

  private async handleArchive(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    if (activeSession.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    let mirroredRemotely = false;
    let pendingOpId: number | null = null;
    try {
      if (activeSession.threadId) {
        pendingOpId = this.registerPendingThreadArchiveOp(
          activeSession.threadId,
          activeSession.sessionId,
          "archived",
          "telegram_archive"
        );
        await this.ensureAppServerAvailable();
        await this.appServer?.archiveThread(activeSession.threadId);
        mirroredRemotely = true;
      }

      this.store.archiveSession(activeSession.sessionId);
      if (activeSession.threadId) {
        await this.markPendingThreadArchiveLocalCommit(activeSession.threadId, pendingOpId);
      }
      const nextActiveSession = this.store.getActiveSession(chatId);
      await this.safeSendHtmlMessage(
        chatId,
        buildArchiveSuccessText(
          this.projectDisplayName(activeSession),
          nextActiveSession
            ? {
                displayName: nextActiveSession.displayName,
                projectName: nextActiveSession.projectName,
                projectAlias: nextActiveSession.projectAlias
              }
            : null
        )
      );
    } catch {
      // If the remote archive succeeded but the local store update failed, best-effort
      // roll the thread back so Telegram and Codex do not silently drift apart.
      if (activeSession.threadId && pendingOpId !== null) {
        this.removePendingThreadArchiveOp(activeSession.threadId, pendingOpId);
      }
      if (mirroredRemotely && activeSession.threadId) {
        try {
          await this.appServer?.unarchiveThread(activeSession.threadId);
        } catch (rollbackError) {
          await this.logger.warn("archive rollback failed after local persistence error", {
            sessionId: activeSession.sessionId,
            threadId: activeSession.threadId,
            error: `${rollbackError}`
          });
        }
      }

      await this.safeSendMessage(chatId, "当前无法归档这个会话，请稍后重试。");
    }
  }

  private async handleUnarchive(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const index = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(index) || index < 1) {
      await this.safeSendMessage(chatId, "找不到这个会话。");
      return;
    }

    const archivedSessions = this.store.listSessions(chatId, { archived: true, limit: 10 });
    const target = archivedSessions[index - 1];
    if (!target) {
      await this.safeSendMessage(chatId, "找不到这个会话。");
      return;
    }

    let mirroredRemotely = false;
    let pendingOpId: number | null = null;
    try {
      if (target.threadId) {
        pendingOpId = this.registerPendingThreadArchiveOp(
          target.threadId,
          target.sessionId,
          "unarchived",
          "telegram_unarchive"
        );
        await this.ensureAppServerAvailable();
        await this.appServer?.unarchiveThread(target.threadId);
        mirroredRemotely = true;
      }

      this.store.unarchiveSession(target.sessionId);
      if (target.threadId) {
        await this.markPendingThreadArchiveLocalCommit(target.threadId, pendingOpId);
      }
      await this.safeSendHtmlMessage(chatId, buildUnarchiveSuccessText(this.projectDisplayName(target)));
    } catch {
      // Apply the inverse compensation on restore failures for the same reason.
      if (target.threadId && pendingOpId !== null) {
        this.removePendingThreadArchiveOp(target.threadId, pendingOpId);
      }
      if (mirroredRemotely && target.threadId) {
        try {
          await this.appServer?.archiveThread(target.threadId);
        } catch (rollbackError) {
          await this.logger.warn("unarchive rollback failed after local persistence error", {
            sessionId: target.sessionId,
            threadId: target.threadId,
            error: `${rollbackError}`
          });
        }
      }

      await this.safeSendMessage(chatId, "当前无法恢复这个会话，请稍后重试。");
    }
  }

  private async handleRename(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const name = args.trim();
    if (!name) {
      const picker = buildRenameTargetPicker({
        sessionId: activeSession.sessionId,
        projectName: this.projectDisplayName(activeSession),
        hasProjectAlias: Boolean(activeSession.projectAlias?.trim())
      });
      await this.safeSendHtmlMessage(chatId, picker.text, picker.replyMarkup);
      return;
    }

    this.store.renameSession(activeSession.sessionId, name);
    this.pendingRenameStates.delete(chatId);
    await this.safeSendHtmlMessage(chatId, buildSessionRenamedText(name));
  }

  private async beginSessionRename(chatId: string, sessionId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    this.pendingRenameStates.set(chatId, {
      kind: "session",
      sessionId: activeSession.sessionId,
      projectPath: activeSession.projectPath
    });
    await this.safeSendMessage(chatId, "请输入新的会话名称。\n发送 /cancel 取消。");
  }

  private async beginProjectRename(chatId: string, sessionId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    this.pendingRenameStates.set(chatId, {
      kind: "project",
      sessionId: activeSession.sessionId,
      projectPath: activeSession.projectPath
    });
    await this.safeSendMessage(chatId, "请输入新的项目别名。\n发送 /cancel 取消。");
  }

  private async clearProjectAlias(chatId: string, sessionId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (!activeSession.projectAlias?.trim()) {
      await this.safeSendMessage(chatId, "当前项目还没有设置别名。");
      return;
    }

    this.store.clearProjectAlias(activeSession.projectPath);
    this.pendingRenameStates.delete(chatId);
    await this.safeSendHtmlMessage(chatId, buildProjectAliasClearedText(activeSession.projectName));
  }

  private async handleRenameInput(chatId: string, text: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const pendingRename = this.pendingRenameStates.get(chatId);
    if (!pendingRename) {
      return;
    }

    const name = text.trim();
    if (!name) {
      await this.safeSendMessage(
        chatId,
        pendingRename.kind === "project" ? "请输入新的项目别名。\n发送 /cancel 取消。" : "请输入新的会话名称。\n发送 /cancel 取消。"
      );
      return;
    }

    const session = this.store.getSessionById(pendingRename.sessionId);
    if (!session) {
      this.pendingRenameStates.delete(chatId);
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    if (pendingRename.kind === "project") {
      this.store.setProjectAlias({
        projectPath: pendingRename.projectPath,
        projectName: session.projectName,
        projectAlias: name,
        sessionId: session.sessionId
      });
      this.pendingRenameStates.delete(chatId);
      await this.safeSendHtmlMessage(chatId, buildProjectAliasRenamedText(name));
      return;
    }

    this.store.renameSession(session.sessionId, name);
    this.pendingRenameStates.delete(chatId);
    await this.safeSendHtmlMessage(chatId, buildSessionRenamedText(name));
  }

  private async handlePin(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    if (this.store.isProjectPinned(activeSession.projectPath)) {
      await this.safeSendMessage(chatId, "这个项目已经收藏。");
      return;
    }

    this.store.pinProject({
      projectPath: activeSession.projectPath,
      projectName: activeSession.projectName,
      sessionId: activeSession.sessionId
    });
    await this.safeSendHtmlMessage(chatId, buildProjectPinnedText(this.projectDisplayName(activeSession)));
  }

  private async handlePlan(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const nextPlanMode = !activeSession.planMode;
    this.store.setSessionPlanMode(activeSession.sessionId, nextPlanMode);

    const verb = nextPlanMode ? "开启" : "关闭";
    const suffix = activeSession.status === "running"
      ? "当前任务不受影响，下次任务开始时生效。"
      : "下次任务开始时生效。";
    await this.safeSendMessage(chatId, `已为当前会话${verb} Plan mode。${suffix}`);
  }

  private async handleModel(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const requestedModel = args.trim();
    await this.ensureAppServerAvailable();
    const models = await this.fetchAllModels();

    if (!requestedModel) {
      const picker = buildModelPickerMessage({
        session: activeSession,
        models,
        page: 0
      });
      await this.safeSendMessage(chatId, picker.text, picker.replyMarkup);
      return;
    }

    if (requestedModel === "default" || requestedModel === "默认") {
      await this.persistSessionModelSelection(chatId, null, activeSession, null, null);
      return;
    }

    const matched = models.find((model) => model.id === requestedModel || model.model === requestedModel);
    if (!matched) {
      await this.safeSendMessage(chatId, "找不到这个模型，请先发送 /model 用按钮选择。");
      return;
    }

    if (matched.supportedReasoningEfforts.length > 1) {
      const modelIndex = models.findIndex((model) => model.id === matched.id);
      const picker = buildReasoningEffortPickerMessage({
        session: activeSession,
        model: matched,
        modelIndex
      });
      await this.safeSendMessage(chatId, picker.text, picker.replyMarkup);
      return;
    }

    await this.persistSessionModelSelection(chatId, null, activeSession, matched.id, null);
  }

  private async handleSkills(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    await this.ensureAppServerAvailable();
    const result = await this.appServer?.listSkills({
      cwds: [activeSession.projectPath],
      forceReload: false
    });
    const entry = result?.data.find((candidate) => candidate.cwd === activeSession.projectPath) ?? result?.data[0];
    if (!entry) {
      await this.safeSendMessage(chatId, "当前项目没有可列出的技能。");
      return;
    }

    const lines = ["当前项目可用技能"];
    for (const skill of entry.skills.slice(0, 20)) {
      const description = skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description;
      const marker = skill.enabled ? "[启用] " : "[禁用] ";
      lines.push(`${marker}${skill.name} | ${truncatePlainText(description, 80)}`);
    }
    if (entry.errors.length > 0) {
      lines.push("", `扫描警告：${truncatePlainText(entry.errors[0]?.message ?? "unknown error", 120)}`);
    }
    lines.push("", "使用 /skill <技能名> :: 任务说明 将 skill 作为结构化输入发送给 Codex。");
    await this.safeSendMessage(chatId, lines.join("\n"));
  }

  private async handleSkill(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.safeSendMessage(chatId, "用法：/skill <技能名> :: 任务说明");
      return;
    }

    await this.ensureAppServerAvailable();
    const result = await this.appServer?.listSkills({
      cwds: [activeSession.projectPath],
      forceReload: false
    });
    const entry = result?.data.find((candidate) => candidate.cwd === activeSession.projectPath) ?? result?.data[0];
    const skill = entry?.skills.find((candidate) => candidate.name === parsed.value);
    if (!skill) {
      await this.safeSendMessage(chatId, "找不到这个技能，请先发送 /skills 查看当前项目的技能列表。");
      return;
    }

    const input: UserInput = {
      type: "skill",
      name: skill.name,
      path: skill.path
    };
    await this.submitOrQueueRichInput(chatId, activeSession, [input], parsed.prompt, `skill：${skill.name}`);
  }

  private async handlePlugins(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    await this.ensureAppServerAvailable();
    const result = await this.appServer?.listPlugins({
      cwds: [activeSession.projectPath]
    });
    if (!result || result.marketplaces.length === 0) {
      await this.safeSendMessage(chatId, "当前项目没有可列出的插件。");
      return;
    }

    const lines = ["当前项目可用插件"];
    const installExample = findFirstInstallablePlugin(result);

    for (const marketplace of result.marketplaces.slice(0, 5)) {
      lines.push(`市场：${marketplace.name}`);
      for (const plugin of marketplace.plugins.slice(0, 8)) {
        const flags = [
          plugin.installed ? "[已安装]" : "[未安装]",
          plugin.enabled ? "[启用]" : ""
        ].join("");
        const label = plugin.interface?.displayName ?? plugin.name;
        const description = plugin.interface?.shortDescription;
        lines.push(`${flags} ${plugin.id} | ${label}${description ? ` | ${truncatePlainText(description, 60)}` : ""}`);
      }
    }

    lines.push("", "使用 /plugin install <市场>/<插件名> 安装插件。");
    lines.push("使用 /plugin uninstall <插件ID> 卸载插件。");
    if (installExample) {
      lines.push(`例如：/plugin install ${installExample.marketplaceName}/${installExample.pluginName}`);
    }
    await this.safeSendMessage(chatId, lines.join("\n"));
  }

  private async handlePlugin(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const [subcommand = "", ...rest] = args.trim().split(/\s+/u);
    await this.ensureAppServerAvailable();

    if (subcommand === "install") {
      const target = rest.join(" ").trim();
      const parsedTarget = parsePluginInstallTarget(target);
      if (!parsedTarget) {
        await this.safeSendMessage(chatId, "用法：/plugin install <市场>/<插件名>");
        return;
      }

      const result = await this.appServer?.listPlugins({
        cwds: [activeSession.projectPath]
      });
      const marketplace = result?.marketplaces.find((entry) => entry.name === parsedTarget.marketplaceName);
      const plugin = marketplace?.plugins.find((entry) => entry.name === parsedTarget.pluginName);
      if (!marketplace || !plugin) {
        await this.safeSendMessage(chatId, "找不到这个插件，请先发送 /plugins 查看当前可用列表。");
        return;
      }

      const installResult = await this.appServer?.installPlugin({
        marketplacePath: marketplace.path,
        pluginName: plugin.name
      });
      const lines = [`已安装插件：${plugin.name}`];
      if (installResult?.appsNeedingAuth.length) {
        lines.push("", "这些 App 可能还需要额外授权：");
        for (const app of installResult.appsNeedingAuth.slice(0, 5)) {
          lines.push(`- ${app.name}${app.installUrl ? ` | ${app.installUrl}` : ""}`);
        }
      }
      await this.safeSendMessage(chatId, lines.join("\n"));
      return;
    }

    if (subcommand === "uninstall") {
      const pluginId = rest.join(" ").trim();
      if (!pluginId) {
        await this.safeSendMessage(chatId, "用法：/plugin uninstall <插件ID>");
        return;
      }

      await this.appServer?.uninstallPlugin(pluginId);
      await this.safeSendMessage(chatId, `已卸载插件：${pluginId}`);
      return;
    }

    await this.safeSendMessage(chatId, "用法：/plugin install <市场>/<插件名> 或 /plugin uninstall <插件ID>");
  }

  private async handleApps(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    await this.ensureAppServerAvailable();
    const apps = await this.fetchAllApps(activeSession.threadId ?? undefined);
    if (apps.length === 0) {
      await this.safeSendMessage(chatId, "当前没有可列出的 Apps。");
      return;
    }

    const lines = ["当前可用 Apps"];
    for (const app of apps.slice(0, 12)) {
      const flags = [
        app.isAccessible ? "[可访问]" : "[不可访问]",
        app.isEnabled ? "[启用]" : "[未启用]"
      ].join("");
      lines.push(`${flags} ${app.name}${app.description ? ` | ${truncatePlainText(app.description, 70)}` : ""}`);
      if (app.pluginDisplayNames.length > 0) {
        lines.push(`来源插件：${app.pluginDisplayNames.join("、")}`);
      }
      if (app.installUrl) {
        lines.push(`安装地址：${app.installUrl}`);
      }
    }

    await this.safeSendMessage(chatId, lines.join("\n"));
  }

  private async handleMcp(chatId: string, args: string): Promise<void> {
    const trimmed = args.trim();
    const [subcommand = "", ...rest] = trimmed.split(/\s+/u);
    await this.ensureAppServerAvailable();

    if (!trimmed) {
      const statuses = await this.fetchAllMcpServerStatuses();
      if (statuses.length === 0) {
        await this.safeSendMessage(chatId, "当前没有可列出的 MCP 服务器。");
        return;
      }

      const lines = ["MCP 服务器状态"];
      for (const status of statuses.slice(0, 12)) {
        lines.push(
          `${status.name} | ${formatMcpAuthStatus(status.authStatus)} | 工具 ${Object.keys(status.tools).length} | 资源 ${status.resources.length} | 模板 ${status.resourceTemplates.length}`
        );
      }
      lines.push("", "使用 /mcp reload 重新加载配置，或 /mcp login <名称> 启动 OAuth 登录。");
      await this.safeSendMessage(chatId, lines.join("\n"));
      return;
    }

    if (subcommand === "reload") {
      await this.appServer?.reloadMcpServers();
      await this.safeSendMessage(chatId, "已重新加载 MCP 服务器配置。");
      return;
    }

    if (subcommand === "login") {
      const serverName = rest.join(" ").trim();
      if (!serverName) {
        await this.safeSendMessage(chatId, "用法：/mcp login <名称>");
        return;
      }

      const result = await this.appServer?.loginToMcpServer({ name: serverName });
      if (!result?.authorizationUrl) {
        await this.safeSendMessage(chatId, "当前无法生成这个 MCP 服务器的登录链接。");
        return;
      }

      await this.safeSendMessage(
        chatId,
        `已生成 MCP 登录链接：${serverName}\n${result.authorizationUrl}\n完成后重新发送 /mcp 查看最新状态。`
      );
      return;
    }

    await this.safeSendMessage(chatId, "用法：/mcp、/mcp reload 或 /mcp login <名称>");
  }

  private async handleAccount(chatId: string): Promise<void> {
    await this.ensureAppServerAvailable();
    const accountResult = this.appServer ? await this.appServer.readAccount(false) : null;
    let rateLimitsResult: Awaited<ReturnType<CodexAppServerClient["readAccountRateLimits"]>> | null = null;
    if (this.appServer) {
      try {
        rateLimitsResult = await this.appServer.readAccountRateLimits();
      } catch {
        rateLimitsResult = null;
      }
    }

    const lines = ["当前 Codex 账号"];
    if (!accountResult?.account) {
      lines.push("账号：未登录");
    } else if (accountResult.account.type === "apiKey") {
      lines.push("类型：API Key");
    } else {
      lines.push("类型：ChatGPT");
      lines.push(`邮箱：${accountResult.account.email}`);
      lines.push(`计划：${accountResult.account.planType}`);
    }
    lines.push(`需要 OpenAI Auth：${accountResult?.requiresOpenaiAuth ? "是" : "否"}`);

    const rateSummary = formatRateLimitSummary(rateLimitsResult?.rateLimits ?? null);
    if (rateSummary) {
      lines.push(rateSummary);
    }

    await this.safeSendMessage(chatId, lines.join("\n"));
  }

  private async handleReview(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    if (activeSession.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    const parsed = parseReviewCommandArgs(args);
    if (!parsed) {
      await this.safeSendMessage(
        chatId,
        "用法：/review [detached] [branch <分支>|commit <SHA>|custom <说明>]"
      );
      return;
    }

    await this.ensureAppServerAvailable();
    const threadId = await this.ensureSessionThread(activeSession);
    const result = await this.appServer?.reviewStart({
      threadId,
      target: parsed.target,
      ...(parsed.delivery ? { delivery: parsed.delivery } : {})
    });
    if (!result) {
      throw new Error("review start returned no result");
    }

    let reviewSession = this.store.getSessionById(activeSession.sessionId) ?? activeSession;
    if (result.reviewThreadId !== threadId) {
      reviewSession = this.store.createSession({
        telegramChatId: chatId,
        projectName: activeSession.projectName,
        projectPath: activeSession.projectPath,
        displayName: `Review: ${activeSession.displayName}`,
        selectedModel: activeSession.selectedModel,
        selectedReasoningEffort: activeSession.selectedReasoningEffort,
        planMode: activeSession.planMode
      });
      this.store.updateSessionThreadId(reviewSession.sessionId, result.reviewThreadId);
      reviewSession = this.store.getSessionById(reviewSession.sessionId) ?? reviewSession;
      await this.safeSendMessage(chatId, `已创建审查会话：${reviewSession.displayName}`);
    }

    await this.beginActiveTurn(chatId, reviewSession, result.reviewThreadId, result.turn.id, result.turn.status);
  }

  private async handleFork(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.safeSendMessage(chatId, "当前会话还没有可分叉的 Codex 线程，请先完成一次任务。");
      return;
    }

    if (activeSession.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    await this.ensureAppServerAvailable();
    const forked = await this.appServer?.forkThread({
      threadId: activeSession.threadId,
      ...(activeSession.selectedModel ? { model: activeSession.selectedModel } : {})
    });
    if (!forked) {
      throw new Error("thread fork returned no result");
    }

    const lastForkTurn = forked.thread.turns.at(-1) ?? null;
    const created = this.store.createSession({
      telegramChatId: chatId,
      projectName: activeSession.projectName,
      projectPath: activeSession.projectPath,
      displayName: args.trim() || `Fork: ${activeSession.displayName}`,
      selectedModel: activeSession.selectedModel ?? forked.model,
      selectedReasoningEffort: activeSession.selectedReasoningEffort ?? forked.reasoningEffort ?? null,
      planMode: activeSession.planMode,
      threadId: forked.thread.id,
      lastTurnId: lastForkTurn?.id ?? activeSession.lastTurnId,
      lastTurnStatus: lastForkTurn?.status ?? activeSession.lastTurnStatus
    });
    await this.safeSendMessage(chatId, `已创建分叉会话：${created.displayName}`);
  }

  private async handleRollback(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.safeSendMessage(chatId, "当前会话还没有可回滚的 Codex 线程。");
      return;
    }

    if (activeSession.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      const targets = await this.buildRollbackTargets(activeSession);
      if (targets.length === 0) {
        await this.safeSendMessage(chatId, "当前没有可选择的回滚目标。");
        return;
      }

      const rendered = buildRollbackPickerMessage({
        sessionId: activeSession.sessionId,
        page: 0,
        targets
      });
      await this.safeSendHtmlMessage(chatId, rendered.text, rendered.replyMarkup);
      return;
    }

    const numTurns = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(numTurns) || numTurns < 1) {
      await this.safeSendMessage(chatId, "用法：/rollback 或 /rollback <回滚的 turn 数量>");
      return;
    }

    await this.executeRollback(activeSession, numTurns);
    await this.safeSendMessage(chatId, this.buildRollbackSuccessText(numTurns));
  }

  private getRollbackSessionForCallback(chatId: string, sessionId: string): SessionRow | null {
    if (!this.store) {
      return null;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId || !activeSession.threadId) {
      return null;
    }

    if (activeSession.status === "running") {
      return null;
    }

    return activeSession;
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
    const session = this.getRollbackSessionForCallback(chatId, sessionId);
    if (!session) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /rollback。");
      return;
    }

    const targets = await this.buildRollbackTargets(session);
    if (targets.length === 0) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "当前没有可选择的回滚目标。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);

    if (options.mode === "confirm") {
      const target = targets.find((candidate) => candidate.index === options.targetIndex);
      if (!target) {
        await this.safeEditMessageText(chatId, messageId, "这个回滚目标已失效，请重新发送 /rollback。");
        return;
      }

      const rendered = buildRollbackConfirmMessage({
        sessionId,
        page: options.page,
        target
      });
      await this.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
      return;
    }

    const rendered = buildRollbackPickerMessage({
      sessionId,
      page: options.page,
      targets
    });
    await this.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
  }

  private async handleRollbackConfirmCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    targetIndex: number
  ): Promise<void> {
    const session = this.getRollbackSessionForCallback(chatId, sessionId);
    if (!session) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /rollback。");
      return;
    }

    const targets = await this.buildRollbackTargets(session);
    const target = targets.find((candidate) => candidate.index === targetIndex);
    if (!target || target.rollbackCount < 1) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个回滚目标已失效，请重新发送 /rollback。");
      return;
    }

    await this.safeAnswerCallbackQuery(callbackQueryId);
    await this.executeRollback(session, target.rollbackCount);
    await this.safeEditMessageText(
      chatId,
      messageId,
      `已回滚到：${target.sequenceNumber}. ${target.label}\n${this.buildRollbackSuccessText(target.rollbackCount)}`
    );
  }

  private buildRollbackSuccessText(numTurns: number): string {
    return `已回滚最近 ${numTurns} 个 turn。\n注意：这不会自动撤销代理已经写到本地文件的改动。`;
  }

  private async executeRollback(session: SessionRow, numTurns: number): Promise<void> {
    if (!this.store || !session.threadId) {
      return;
    }

    await this.ensureAppServerAvailable();
    const result = await this.appServer?.rollbackThread(session.threadId, numTurns);
    const lastTurn = result?.thread.turns.at(-1) ?? null;
    this.store.updateSessionStatus(session.sessionId, "idle", {
      lastTurnId: lastTurn?.id ?? null,
      lastTurnStatus: lastTurn?.status ?? null
    });
    this.clearRecentActivity(session.sessionId);
  }

  private async buildRollbackTargets(session: SessionRow): Promise<RollbackTargetView[]> {
    if (!session.threadId) {
      return [];
    }

    await this.ensureAppServerAvailable();
    const result = await this.appServer?.readThread(session.threadId, true);
    const threadRecord = asRecord(result?.thread);
    const turns = getArray(threadRecord, "turns");
    const targets: RollbackTargetView[] = [];
    let sequenceNumber = 1;

    for (let turnIndex = turns.length - 2; turnIndex >= 0; turnIndex -= 1) {
      const turn = asRecord(turns[turnIndex]);
      const label = this.summarizeRollbackTargetInput(session.threadId, turn);
      if (!label) {
        continue;
      }

      targets.push({
        index: turnIndex,
        sequenceNumber,
        label,
        rollbackCount: turns.length - turnIndex - 1
      });
      sequenceNumber += 1;
    }

    return targets;
  }

  private summarizeRollbackTargetInput(threadId: string, turn: Record<string, unknown> | null): string | null {
    const turnId = getString(turn, "id");
    if (turnId) {
      const source = this.store?.getTurnInputSource(threadId, turnId);
      if (source?.sourceKind === "voice") {
        return truncateText(`语音：${normalizeWhitespace(source.transcript)}`, HISTORY_TEXT_LIMIT);
      }
    }

    const userMessage = asRecord(turn?.userMessage);
    const content = getArray(userMessage, "content");
    if (content.length === 0) {
      return null;
    }

    const textParts: string[] = [];
    const labels: string[] = [];

    for (const item of content) {
      const record = asRecord(item);
      const type = getString(record, "type");
      switch (type) {
        case "text": {
          const text = normalizeWhitespace(getString(record, "text") ?? "");
          if (text) {
            textParts.push(text);
          }
          break;
        }
        case "image":
        case "localImage":
          labels.push("图片输入");
          break;
        case "skill":
          labels.push(`skill: ${getString(record, "name") ?? "unknown"}`);
          break;
        case "mention":
          labels.push(`引用: ${getString(record, "name") ?? getString(record, "path") ?? "unknown"}`);
          break;
        default:
          labels.push("结构化输入");
          break;
      }
    }

    const summary = textParts.length > 0
      ? textParts.join(" ")
      : labels.length > 0
        ? labels.join(" + ")
        : null;
    return summary ? truncateText(summary, HISTORY_TEXT_LIMIT) : null;
  }

  private async handleCompact(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.safeSendMessage(chatId, "当前会话还没有可压缩的 Codex 线程。");
      return;
    }

    if (activeSession.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    await this.ensureAppServerAvailable();
    await this.appServer?.compactThread(activeSession.threadId);
    await this.safeSendMessage(chatId, "已请求压缩当前线程。");
  }

  private async handleLocalImage(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.safeSendMessage(chatId, "用法：/local_image <图片路径> :: 任务说明");
      return;
    }

    const imagePath = resolve(activeSession.projectPath, parsed.value);
    if (!await isReadableImagePath(imagePath)) {
      await this.safeSendMessage(chatId, "这个本地图片路径不可用，请确认文件存在且是常见图片格式。");
      return;
    }

    await this.submitOrQueueRichInput(chatId, activeSession, [{
      type: "localImage",
      path: imagePath
    }], parsed.prompt, `本地图片：${basename(imagePath)}`);
  }

  private async handleMention(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.safeSendMessage(chatId, "用法：/mention <path> :: 任务说明");
      return;
    }

    const { name, path } = parseMentionValue(parsed.value);
    await this.submitOrQueueRichInput(chatId, activeSession, [{
      type: "mention",
      name,
      path
    }], parsed.prompt, `引用：${name}`);
  }

  private async handleThreadCommand(chatId: string, args: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.safeSendMessage(chatId, "当前会话还没有 Codex 线程，请先完成一次任务。");
      return;
    }

    if (activeSession.status === "running") {
      await this.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    const trimmed = args.trim();
    const [subcommand, ...rest] = trimmed.split(/\s+/u);
    if (!subcommand) {
      await this.safeSendMessage(
        chatId,
        "用法：/thread name <名称> 或 /thread meta branch=<分支> sha=<提交> origin=<URL> 或 /thread clean-terminals"
      );
      return;
    }

    await this.ensureAppServerAvailable();

    if (subcommand === "name") {
      const nextName = rest.join(" ").trim();
      if (!nextName) {
        await this.safeSendMessage(chatId, "用法：/thread name <名称>");
        return;
      }

      await this.appServer?.setThreadName(activeSession.threadId, nextName);
      this.store.renameSession(activeSession.sessionId, nextName);
      await this.safeSendMessage(chatId, `已更新线程名称：${nextName}`);
      return;
    }

    if (subcommand === "meta") {
      const gitInfo = parseThreadMetadataTokens(rest);
      if (!gitInfo) {
        await this.safeSendMessage(chatId, "用法：/thread meta branch=<分支> sha=<提交> origin=<URL>");
        return;
      }

      await this.appServer?.updateThreadMetadata({
        threadId: activeSession.threadId,
        gitInfo
      });
      const fragments = [
        gitInfo.branch !== undefined ? `branch=${gitInfo.branch ?? "clear"}` : null,
        gitInfo.sha !== undefined ? `sha=${gitInfo.sha ?? "clear"}` : null,
        gitInfo.originUrl !== undefined ? `origin=${gitInfo.originUrl ?? "clear"}` : null
      ].filter((value): value is string => Boolean(value));
      await this.safeSendMessage(chatId, `已更新线程元数据：${fragments.join(", ")}`);
      return;
    }

    if (subcommand === "clean-terminals") {
      await this.appServer?.cleanBackgroundTerminals(activeSession.threadId);
      await this.safeSendMessage(chatId, "已清理当前线程的后台终端。");
      return;
    }

    await this.safeSendMessage(
      chatId,
      "用法：/thread name <名称> 或 /thread meta branch=<分支> sha=<提交> origin=<URL> 或 /thread clean-terminals"
    );
  }

  private async handleVoiceMessage(chatId: string, message: TelegramMessage): Promise<void> {
    if (!this.store || !this.api?.getFile || !this.api?.downloadFile) {
      return;
    }

    if (!this.config.voiceInputEnabled) {
      await this.safeSendMessage(chatId, "未启用语音输入。");
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "请先发送 /new 选择项目。");
      return;
    }

    const voice = message.voice;
    if (!voice) {
      return;
    }

    this.enqueueVoiceProcessingTask({
      chatId,
      sessionId: activeSession.sessionId,
      messageId: message.message_id,
      telegramFileId: voice.file_id
    });
    await this.safeSendMessage(
      chatId,
      this.pendingVoiceTaskCount > 1
        ? `已收到语音，正在排队转写。前方还有 ${this.pendingVoiceTaskCount - 1} 条语音。`
        : "已收到语音，正在转写。"
    );
  }

  private enqueueVoiceProcessingTask(task: VoiceProcessingTask): void {
    this.pendingVoiceTaskCount += 1;
    const runTask = async () => {
      try {
        await this.processQueuedVoiceTask(task);
      } finally {
        this.pendingVoiceTaskCount = Math.max(0, this.pendingVoiceTaskCount - 1);
      }
    };
    this.voiceTaskQueue = this.voiceTaskQueue.then(runTask, runTask);
  }

  private async processQueuedVoiceTask(task: VoiceProcessingTask): Promise<void> {
    if (this.stopping || !this.store || !this.api?.getFile || !this.api?.downloadFile) {
      return;
    }

    const session = this.store.getSessionById(task.sessionId);
    if (!session || session.telegramChatId !== task.chatId || session.archived) {
      await this.safeSendMessage(task.chatId, "这条语音对应的会话已不可用，请重新选择会话后再试。");
      return;
    }

    let localVoicePath: string | null = null;
    try {
      const file = await this.api.getFile(task.telegramFileId);
      if (!file.file_path) {
        await this.safeSendMessage(task.chatId, "暂时无法读取这段语音，请稍后重试。");
        return;
      }

      localVoicePath = await this.cacheTelegramVoice(task.messageId, task.telegramFileId, file.file_path, file);
      if (!localVoicePath) {
        await this.safeSendMessage(task.chatId, "暂时无法读取这段语音，请稍后重试。");
        return;
      }

      let transcription: VoiceTranscriptionResult | null = null;
      if (this.config.voiceOpenaiApiKey.trim()) {
        try {
          transcription = await this.transcribeVoiceWithOpenAi(localVoicePath);
        } catch (error) {
          await this.logger.warn("openai voice transcription failed", {
            chatId: task.chatId,
            sessionId: session.sessionId,
            error: `${error}`
          });
          await this.safeSendMessage(task.chatId, "OpenAI 语音转写失败，正在尝试 realtime 兜底。");
        }
      }

      if (!transcription) {
        try {
          transcription = await this.transcribeVoiceWithRealtime(session, localVoicePath);
        } catch (error) {
          await this.logger.warn("realtime voice transcription failed", {
            chatId: task.chatId,
            sessionId: session.sessionId,
            error: `${error}`
          });
          await this.safeSendMessage(task.chatId, `语音输入失败：${normalizeWhitespace(`${error}`)}`);
          return;
        }
      }

      const currentSession = this.store.getSessionById(task.sessionId);
      if (!currentSession || currentSession.telegramChatId !== task.chatId || currentSession.archived) {
        await this.safeSendMessage(task.chatId, "语音已转写，但对应会话已不可用，请重新发送。");
        return;
      }

      await this.safeSendMessage(task.chatId, `语音转写：${transcription.transcript}`);
      await this.submitVoiceTranscript(task.chatId, currentSession, transcription.transcript);
    } catch (error) {
      await this.logger.warn("voice message handling failed", {
        chatId: task.chatId,
        sessionId: session.sessionId,
        error: `${error}`
      });
      await this.safeSendMessage(task.chatId, "暂时无法处理这段语音，请稍后重试。");
    } finally {
      if (localVoicePath) {
        await rm(localVoicePath, { force: true }).catch(() => {});
      }
    }
  }

  private async submitVoiceTranscript(chatId: string, session: SessionRow, transcript: string): Promise<void> {
    if (!this.store) {
      return;
    }

    if (session.status === "running") {
      const steerAvailability = this.getBlockedTurnSteerAvailability(chatId, session);
      if (steerAvailability.kind === "available") {
        try {
          await this.ensureAppServerAvailable();
          await this.appServer?.steerTurn({
            threadId: steerAvailability.activeTurn.threadId,
            expectedTurnId: steerAvailability.activeTurn.turnId,
            input: [{ type: "text", text: transcript }]
          });
        } catch (error) {
          await this.logger.warn("voice turn steer failed", {
            chatId,
            sessionId: session.sessionId,
            threadId: steerAvailability.activeTurn.threadId,
            turnId: steerAvailability.activeTurn.turnId,
            error: `${error}`
          });
          await this.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
        }
        return;
      }

      if (steerAvailability.kind === "interaction_pending") {
        await this.sendPendingInteractionBlockNotice(chatId);
        return;
      }

      await this.safeSendMessage(chatId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    await this.startRealTurn(chatId, session, transcript, {
      sourceKind: "voice",
      transcript
    });
  }

  private async transcribeVoiceWithOpenAi(localVoicePath: string): Promise<VoiceTranscriptionResult> {
    const audioBytes = await readFile(localVoicePath);
    const formData = new FormData();
    formData.append("model", this.config.voiceOpenaiTranscribeModel);
    formData.append("file", new Blob([audioBytes], {
      type: "audio/ogg"
    }), basename(localVoicePath));

    const response = await fetch(OPENAI_AUDIO_TRANSCRIPT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.voiceOpenaiApiKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(60_000)
    });

    if (!response.ok) {
      const bodyText = normalizeWhitespace(await response.text());
      throw new Error(bodyText || `OpenAI transcription failed: ${response.status}`);
    }

    const payload = asRecord(await response.json());
    const transcript = normalizeWhitespace(getString(payload, "text") ?? "");
    if (!transcript) {
      throw new Error("OpenAI transcription returned empty text");
    }

    return {
      transcript,
      source: "openai"
    };
  }

  private async transcribeVoiceWithRealtime(
    session: SessionRow,
    localVoicePath: string
  ): Promise<VoiceTranscriptionResult> {
    const realtimeModelId = await this.getRealtimeVoiceModelId();
    if (!realtimeModelId) {
      throw new Error("当前 Codex 模型不支持 realtime 音频输入。");
    }

    if (!await commandExists(this.config.voiceFfmpegBin)) {
      throw new Error(`系统里找不到 ffmpeg：${this.config.voiceFfmpegBin}`);
    }

    await this.ensureAppServerAvailable();
    if (!this.appServer) {
      throw new Error("app-server unavailable");
    }

    const tempThread = await this.appServer.startThread({
      cwd: session.projectPath,
      model: realtimeModelId
    });
    const tempThreadId = tempThread.thread.id;
    const existingTurns = await this.appServer.readThread(tempThreadId, true);
    const existingTurnIds = new Set(
      getArray(asRecord(existingTurns.thread), "turns")
        .map((turn) => getString(turn, "id"))
        .filter((turnId): turnId is string => Boolean(turnId))
    );
    const pcmPath = `${localVoicePath}.${randomUUID()}.pcm`;

    try {
      await this.convertVoiceToPcm(localVoicePath, pcmPath);
      const pcmBytes = await readFile(pcmPath);

      await this.appServer.startThreadRealtime({
        threadId: tempThreadId,
        prompt: VOICE_REALTIME_TRANSCRIPTION_PROMPT
      });

      for (let offset = 0; offset < pcmBytes.length; offset += VOICE_REALTIME_CHUNK_BYTES) {
        const chunk = pcmBytes.subarray(offset, Math.min(offset + VOICE_REALTIME_CHUNK_BYTES, pcmBytes.length));
        if (chunk.length === 0) {
          continue;
        }

        await this.appServer.appendThreadRealtimeAudio(tempThreadId, {
          data: chunk.toString("base64"),
          sampleRate: VOICE_PCM_SAMPLE_RATE,
          numChannels: VOICE_PCM_NUM_CHANNELS,
          samplesPerChannel: Math.floor(chunk.length / (VOICE_PCM_BYTES_PER_SAMPLE * VOICE_PCM_NUM_CHANNELS))
        });
      }

      await this.appServer.stopThreadRealtime(tempThreadId);
      const turnId = await this.waitForRealtimeTurnCompletion(tempThreadId, existingTurnIds);
      const transcript = normalizeWhitespace(await extractFinalAnswerFromHistory(this.appServer, tempThreadId, turnId) ?? "");
      if (!transcript) {
        throw new Error("realtime transcription returned empty text");
      }

      return {
        transcript,
        source: "realtime"
      };
    } finally {
      await rm(pcmPath, { force: true }).catch(() => {});
      await this.appServer.stopThreadRealtime(tempThreadId).catch(() => {});
      await this.appServer.archiveThread(tempThreadId).catch(() => {});
    }
  }

  private async getRealtimeVoiceModelId(): Promise<string | null> {
    if (this.realtimeVoiceModelId !== undefined) {
      return this.realtimeVoiceModelId;
    }

    await this.ensureAppServerAvailable();
    const models = await this.fetchAllModels();
    const realtimeModel = models.find((model) => (model.inputModalities ?? []).includes("audio")) ?? null;
    this.realtimeVoiceModelId = realtimeModel?.id ?? null;
    return this.realtimeVoiceModelId;
  }

  private async waitForRealtimeTurnCompletion(threadId: string, existingTurnIds: Set<string>): Promise<string> {
    if (!this.appServer) {
      throw new Error("app-server unavailable");
    }

    const deadline = Date.now() + VOICE_REALTIME_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const thread = await this.appServer.readThread(threadId, true);
      const turns = getArray(asRecord(thread.thread), "turns")
        .map((turn) => asRecord(turn))
        .filter((turn): turn is Record<string, unknown> => Boolean(turn));
      const candidateTurns = turns.filter((turn) => {
        const turnId = getString(turn, "id");
        if (!turnId) {
          return false;
        }
        return !existingTurnIds.has(turnId);
      });

      const completedTurn = candidateTurns.find((turn) => getString(turn, "status") === "completed");
      if (completedTurn) {
        const completedTurnId = getString(completedTurn, "id");
        if (completedTurnId) {
          return completedTurnId;
        }
      }

      const failedTurn = candidateTurns.find((turn) => {
        const status = getString(turn, "status");
        return status === "failed" || status === "interrupted";
      });
      if (failedTurn) {
        throw new Error(`realtime transcription turn ${getString(failedTurn, "status") ?? "failed"}`);
      }

      await this.sleep(VOICE_REALTIME_POLL_INTERVAL_MS);
    }

    throw new Error("realtime transcription timed out");
  }

  private async convertVoiceToPcm(inputPath: string, outputPath: string): Promise<void> {
    const result = await runCommand(this.config.voiceFfmpegBin, [
      "-y",
      "-i",
      inputPath,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      `${VOICE_PCM_NUM_CHANNELS}`,
      "-ar",
      `${VOICE_PCM_SAMPLE_RATE}`,
      outputPath
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "ffmpeg conversion failed");
    }
  }

  private async handlePhotoMessage(chatId: string, message: TelegramMessage): Promise<void> {
    if (!this.store || !this.api?.getFile || !this.api?.downloadFile) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "请先发送 /new 选择项目。");
      return;
    }

    const photo = message.photo?.at(-1);
    if (!photo) {
      return;
    }

    try {
      const file = await this.api.getFile(photo.file_id);
      if (!file.file_path) {
        await this.safeSendMessage(chatId, "暂时无法读取这张图片，请稍后重试。");
        return;
      }

      const localImagePath = await this.cacheTelegramPhoto(message.message_id, photo.file_id, file.file_path, file);
      if (!localImagePath) {
        await this.safeSendMessage(chatId, "暂时无法读取这张图片，请稍后重试。");
        return;
      }

      await this.submitOrQueueRichInput(
        chatId,
        activeSession,
        [{ type: "localImage", path: localImagePath }],
        (message.caption ?? "").trim() || null,
        "图片"
      );
    } catch {
      await this.safeSendMessage(chatId, "暂时无法读取这张图片，请稍后重试。");
    }
  }

  private async handlePendingRichInputPrompt(
    chatId: string,
    pending: PendingRichInputComposer,
    text: string
  ): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== pending.sessionId) {
      this.pendingRichInputComposers.delete(chatId);
      await this.safeSendMessage(chatId, "当前会话已经变化，请重新发送结构化输入。");
      return;
    }

    const prompt = text.trim();
    if (!prompt) {
      await this.safeSendMessage(chatId, `请继续发送要和${pending.promptLabel}一起交给 Codex 的说明。`);
      return;
    }

    this.pendingRichInputComposers.delete(chatId);
    await this.submitRichInputs(chatId, activeSession, [
      ...pending.inputs,
      { type: "text", text: prompt }
    ]);
  }

  private async submitOrQueueRichInput(
    chatId: string,
    session: SessionRow,
    inputs: UserInput[],
    prompt: string | null,
    promptLabel: string
  ): Promise<void> {
    if (prompt) {
      await this.submitRichInputs(chatId, session, [
        ...inputs,
        { type: "text", text: prompt }
      ]);
      return;
    }

    const steerAvailability = this.getBlockedTurnSteerAvailability(chatId, session);
    if (session.status === "running" && steerAvailability.kind !== "available") {
      if (steerAvailability.kind === "interaction_pending") {
        await this.sendPendingInteractionBlockNotice(chatId);
        return;
      }

      await this.safeSendMessage(chatId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    this.pendingRichInputComposers.set(chatId, {
      sessionId: session.sessionId,
      inputs,
      promptLabel
    });
    await this.safeSendMessage(chatId, `已记录${promptLabel}，请继续发送任务说明，或发送 /cancel 取消。`);
  }

  private async submitRichInputs(chatId: string, session: SessionRow, input: UserInput[]): Promise<void> {
    if (!this.store) {
      return;
    }

    if (session.status === "running") {
      const steerAvailability = this.getBlockedTurnSteerAvailability(chatId, session);
      if (steerAvailability.kind === "available") {
        try {
          await this.ensureAppServerAvailable();
          await this.appServer?.steerTurn({
            threadId: steerAvailability.activeTurn.threadId,
            expectedTurnId: steerAvailability.activeTurn.turnId,
            input
          });
        } catch (error) {
          await this.logger.warn("turn steer failed", {
            chatId,
            sessionId: session.sessionId,
            threadId: steerAvailability.activeTurn.threadId,
            turnId: steerAvailability.activeTurn.turnId,
            error: `${error}`
          });
          await this.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
        }
        return;
      }

      if (steerAvailability.kind === "interaction_pending") {
        await this.sendPendingInteractionBlockNotice(chatId);
        return;
      }

      await this.safeSendMessage(chatId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    try {
      await this.ensureAppServerAvailable();
      const threadId = await this.ensureSessionThread(session);
      const turn = await this.appServer?.startTurn({
        threadId,
        cwd: session.projectPath,
        input,
        ...(session.planMode ? { collaborationMode: { mode: "plan" as const } } : {}),
        ...(session.selectedModel ? { model: session.selectedModel } : {}),
        ...(session.selectedReasoningEffort ? { effort: session.selectedReasoningEffort } : {})
      });
      if (!turn) {
        throw new Error("turn start returned no result");
      }

      await this.beginActiveTurn(chatId, session, threadId, turn.turn.id, turn.turn.status);
    } catch (error) {
      await this.logger.error("structured turn start failed", {
        sessionId: session.sessionId,
        error: `${error}`
      });
      this.store.updateSessionStatus(session.sessionId, "failed", {
        failureReason: "turn_failed",
        lastTurnId: session.lastTurnId,
        lastTurnStatus: "failed"
      });
      await this.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
    }
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
    if (!this.store || !this.activeTurn) {
      await this.safeSendMessage(chatId, "当前没有正在执行的操作。");
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== this.activeTurn.sessionId || activeSession.status !== "running") {
      await this.safeSendMessage(chatId, "当前没有正在执行的操作。");
      return;
    }

    try {
      await this.ensureAppServerAvailable();
      await this.appServer?.interruptTurn(this.activeTurn.threadId, this.activeTurn.turnId);
      await this.safeSendMessage(chatId, "已请求停止当前操作。");
    } catch {
      await this.safeSendMessage(chatId, "当前无法中断正在运行的操作。");
    }
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
    if (!this.store) {
      return;
    }

    try {
      await this.ensureAppServerAvailable();
      const threadId = await this.ensureSessionThread(session);
      const turn = await this.appServer?.startTurn({
        threadId,
        cwd: session.projectPath,
        text,
        ...(session.planMode ? { collaborationMode: { mode: "plan" as const } } : {}),
        ...(session.selectedModel ? { model: session.selectedModel } : {}),
        ...(session.selectedReasoningEffort ? { effort: session.selectedReasoningEffort } : {})
      });

      if (!turn) {
        throw new Error("turn start returned no result");
      }
      if (options?.sourceKind === "voice") {
        this.store.saveTurnInputSource({
          threadId,
          turnId: turn.turn.id,
          sourceKind: "voice",
          transcript: options.transcript
        });
      }
      await this.beginActiveTurn(chatId, session, threadId, turn.turn.id, turn.turn.status);
    } catch (error) {
      await this.logger.error("turn start failed", {
        sessionId: session.sessionId,
        error: `${error}`
      });
      this.store.updateSessionStatus(session.sessionId, "failed", {
        failureReason: "turn_failed",
        lastTurnId: session.lastTurnId,
        lastTurnStatus: "failed"
      });
      await this.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
    }
  }

  private async beginActiveTurn(
    chatId: string,
    session: SessionRow,
    threadId: string,
    turnId: string,
    turnStatus: string
  ): Promise<void> {
    if (!this.store) {
      return;
    }

    this.activeTurn = {
      sessionId: session.sessionId,
      chatId,
      threadId,
      turnId,
      finalMessage: null,
      tracker: new ActivityTracker({
        threadId,
        turnId
      }),
      debugJournal: new TurnDebugJournal({
        debugRootDir: getDebugRuntimeDir(this.paths.runtimeDir),
        threadId,
        turnId
      }),
      statusCard: createStatusCardMessageState(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    };

    const recentActivity: RecentActivityEntry = {
      tracker: this.activeTurn.tracker,
      debugFilePath: this.activeTurn.debugJournal.filePath,
      statusCard: this.activeTurn.statusCard
    };
    this.setRecentActivity(session.sessionId, recentActivity);
    this.store.updateSessionStatus(session.sessionId, "running", {
      lastTurnId: turnId,
      lastTurnStatus: turnStatus
    });
    await this.syncRuntimeCards(this.activeTurn, null, null, this.activeTurn.tracker.getStatus(), {
      force: true,
      reason: "turn_initialized"
    });
  }

  private async ensureSessionThread(session: SessionRow): Promise<string> {
    if (!this.store) {
      throw new Error("state store unavailable");
    }

    if (!this.appServer) {
      throw new Error("app-server unavailable");
    }

    if (!session.threadId) {
      const started = await this.appServer.startThread({
        cwd: session.projectPath,
        ...(session.selectedModel ? { model: session.selectedModel } : {})
      });
      this.store.updateSessionThreadId(session.sessionId, started.thread.id);
      return started.thread.id;
    }

    await this.appServer.resumeThread(session.threadId);
    return session.threadId;
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
    if (!this.store || !this.appServer) {
      return;
    }

    const knownUnsupported = getKnownUnsupportedServerRequest(request);
    if (knownUnsupported) {
      await this.logger.warn("known unsupported app-server server request", {
        method: request.method,
        id: request.id,
        detail: knownUnsupported.logDetail
      });
      if (this.activeTurn) {
        await this.appendDebugJournal(this.activeTurn, "bridge/serverRequest/rejected", {
          requestId: serializeJsonRpcRequestId(request.id),
          requestMethod: request.method,
          params: request.params,
          reason: knownUnsupported.errorMessage
        });
        await this.safeSendMessage(this.activeTurn.chatId, knownUnsupported.userMessage);
      }
      await this.appServer.respondToServerRequestError(request.id, -32601, knownUnsupported.errorMessage);
      return;
    }

    const normalized = normalizeServerRequest(request.method, request.params);
    if (!normalized) {
      await this.logger.warn("unsupported app-server server request", {
        method: request.method,
        id: request.id
      });
      await this.appServer.respondToServerRequestError(request.id, -32601, `Unsupported server request: ${request.method}`);
      return;
    }

    const activeTurn = this.activeTurn;
    if (!activeTurn) {
      await this.logger.warn("server request received without active turn", {
        method: request.method,
        id: request.id
      });
      await this.appServer.respondToServerRequestError(request.id, -32000, "No active turn available for interaction");
      return;
    }

    const effectiveTurnId = normalized.turnId || activeTurn.turnId;
    const requestOnRootTurn = normalized.threadId === activeTurn.threadId;
    const requestOnKnownSubagent = !requestOnRootTurn
      && activeTurn.tracker.getInspectSnapshot().agentSnapshot.some((agent) => agent.threadId === normalized.threadId);

    if ((requestOnRootTurn && effectiveTurnId !== activeTurn.turnId) || (!requestOnRootTurn && !requestOnKnownSubagent)) {
      await this.logger.warn("server request does not match active turn", {
        method: request.method,
        id: request.id,
        requestThreadId: normalized.threadId,
        requestTurnId: effectiveTurnId,
        activeThreadId: activeTurn.threadId,
        activeTurnId: activeTurn.turnId,
        knownSubagentThreadIds: requestOnRootTurn
          ? []
          : activeTurn.tracker.getInspectSnapshot().agentSnapshot.map((agent) => agent.threadId)
      });
      await this.appServer.respondToServerRequestError(request.id, -32001, "Interaction does not match the active turn");
      return;
    }

    const pending = this.store.createPendingInteraction({
      telegramChatId: activeTurn.chatId,
      sessionId: activeTurn.sessionId,
      threadId: normalized.threadId,
      turnId: effectiveTurnId,
      requestId: serializeJsonRpcRequestId(request.id),
      requestMethod: request.method,
      interactionKind: normalized.kind,
      promptJson: JSON.stringify({
        ...normalized,
        turnId: effectiveTurnId
      })
    });
    await this.appendInteractionCreatedJournal(pending);

    const sent = await this.sendPendingInteractionCard(activeTurn.chatId, pending, normalized);
    if (!sent) {
      this.store.markPendingInteractionFailed(pending.interactionId, "telegram_delivery_failed");
      await this.appendInteractionResolvedJournal(pending, {
        finalState: "failed",
        errorReason: "telegram_delivery_failed",
        resolutionSource: "telegram_delivery_failed"
      });
      await this.appServer.respondToServerRequestError(request.id, -32603, "Failed to deliver Telegram interaction card");
      return;
    }

    this.store.setPendingInteractionMessageId(pending.interactionId, sent.message_id);
  }

  private async sendPendingInteractionCard(
    chatId: string,
    pending: PendingInteractionRow,
    interaction: NormalizedInteraction
  ): Promise<TelegramMessage | null> {
    const rendered = buildPendingInteractionSurface(pending, interaction);
    return await this.safeSendHtmlMessageResult(chatId, rendered.text, rendered.replyMarkup);
  }

  private async handleServerRequestResolvedNotification(
    notification: Extract<ReturnType<typeof classifyNotification>, { kind: "server_request_resolved" }>
  ): Promise<void> {
    if (!this.store || !notification.threadId || notification.requestId === null) {
      return;
    }

    const requestId = serializeJsonRpcRequestId(notification.requestId);
    const pendingRows = this.store.listPendingInteractionsByRequest(notification.threadId, requestId);
    for (const row of pendingRows) {
      const interaction = parseStoredInteraction(row.promptJson);
      const responseJson = row.responseJson ?? JSON.stringify({ resolvedBy: "serverRequest/resolved" });
      this.store.markPendingInteractionAnswered(row.interactionId, responseJson);
      this.clearPendingInteractionTextMode(row.interactionId);
      await this.appendInteractionResolvedJournal(row, {
        finalState: "answered",
        responseJson,
        resolutionSource: "server_response_success"
      });

      if (interaction) {
        await this.renderStoredPendingInteraction(row.telegramChatId, { ...row, state: "answered", responseJson, resolvedAt: new Date().toISOString() }, interaction);
      }
    }
  }

  private async handleGlobalRuntimeNotice(
    notification: Extract<
      ReturnType<typeof classifyNotification>,
      { kind: "config_warning" | "deprecation_notice" | "model_rerouted" | "skills_changed" | "thread_compacted" }
    >
  ): Promise<void> {
    if (!this.store) {
      return;
    }

    const message = formatGlobalRuntimeNotice(notification);
    if (!message) {
      return;
    }

    const bindings = this.store.listChatBindings();
    for (const binding of bindings) {
      const delivered = await this.safeSendMessage(binding.telegramChatId, message);
      if (!delivered) {
        this.store.createRuntimeNotice({
          telegramChatId: binding.telegramChatId,
          type: "app_server_notice",
          message
        });
      }
    }
  }

  private async handleAppServerNotification(method: string, params: unknown): Promise<void> {
    const classified = classifyNotification(method, params);

    if (classified.kind === "server_request_resolved") {
      await this.handleServerRequestResolvedNotification(classified);
    }

    if (classified.kind === "thread_archived" || classified.kind === "thread_unarchived") {
      if (this.activeTurn) {
        await this.appendDebugJournal(this.activeTurn, method, params, {
          threadId: classified.threadId ?? null,
          turnId: null
        });
      }
      await this.handleThreadArchiveNotification(classified);
      return;
    }

    if (!this.activeTurn) {
      if (isGlobalRuntimeNotice(classified)) {
        await this.handleGlobalRuntimeNotice(classified);
      }
      return;
    }

    const activeTurn = this.activeTurn;
    await this.appendDebugJournal(activeTurn, method, params, {
      threadId: classified.threadId ?? activeTurn.threadId,
      turnId: classified.turnId ?? activeTurn.turnId
    });
    const before = activeTurn.tracker.getStatus();

    if (
      classified.kind === "final_message_available" &&
      classified.message &&
      (!classified.threadId || classified.threadId === activeTurn.threadId)
    ) {
      activeTurn.finalMessage = classified.message;
    }

    activeTurn.tracker.apply(classified);
    await this.logSubagentIdentityEvents(activeTurn, activeTurn.tracker.drainSubagentIdentityEvents());
    const after = activeTurn.tracker.getStatus();
    const forceSurfaceSync = classified.kind === "turn_completed";
    await this.logger.info("turn event processed", {
      sessionId: activeTurn.sessionId,
      chatId: activeTurn.chatId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      method,
      classifiedKind: classified.kind,
      forceSurfaceSync,
      before: summarizeActivityStatus(before),
      after: summarizeActivityStatus(after)
    });
    await this.syncRuntimeCards(activeTurn, classified, before, after, {
      force: forceSurfaceSync,
      reason: classified.kind
    });

    if (classified.kind !== "turn_completed" || (classified.turnId && classified.turnId !== activeTurn.turnId)) {
      return;
    }

    await this.resolveActionablePendingInteractionsForSession(activeTurn.chatId, activeTurn.sessionId, {
      state: "expired",
      reason: `turn_${classified.status}`,
      resolutionSource: "turn_expired"
    });

    this.activeTurn = null;

    if (!this.store) {
      return;
    }

    if (classified.status === "completed") {
      let finalMessage = activeTurn.finalMessage;
      if (!finalMessage && this.appServer) {
        finalMessage = await extractFinalAnswerFromHistory(this.appServer, activeTurn.threadId, activeTurn.turnId);
      }

      this.store.markSessionSuccessful(activeTurn.sessionId);
      this.disposeRuntimeCards(activeTurn);
      await this.sendFinalAnswer(activeTurn, finalMessage);
      return;
    }

    if (classified.status === "interrupted") {
      this.store.updateSessionStatus(activeTurn.sessionId, "interrupted", {
        lastTurnId: activeTurn.turnId,
        lastTurnStatus: "interrupted"
      });
      this.disposeRuntimeCards(activeTurn);
      return;
    }

    this.store.updateSessionStatus(activeTurn.sessionId, "failed", {
      failureReason: "turn_failed",
      lastTurnId: activeTurn.turnId,
      lastTurnStatus: classified.status
    });
    this.disposeRuntimeCards(activeTurn);
    await this.safeSendMessage(activeTurn.chatId, "这次操作未成功完成，请重试。");
  }

  private setRecentActivity(sessionId: string, entry: RecentActivityEntry): void {
    this.recentActivityBySessionId.delete(sessionId);
    this.recentActivityBySessionId.set(sessionId, entry);

    while (this.recentActivityBySessionId.size > MAX_RECENT_ACTIVITY_ENTRIES) {
      const oldestSessionId = this.recentActivityBySessionId.keys().next().value;
      if (!oldestSessionId) {
        return;
      }

      this.recentActivityBySessionId.delete(oldestSessionId);
    }
  }

  private clearRecentActivity(sessionId: string): void {
    this.recentActivityBySessionId.delete(sessionId);
  }

  private async cacheTelegramPhoto(
    messageId: number,
    fileId: string,
    filePath: string,
    file?: { file_id: string; file_path?: string }
  ): Promise<string | null> {
    if (!this.api) {
      return null;
    }

    const cacheDir = await this.ensureTelegramImageCacheDir();
    void this.pruneTelegramImageCache(cacheDir).catch(async (error) => {
      await this.logger.warn("telegram image cache cleanup failed", {
        cacheDir,
        error: `${error}`
      });
    });

    const targetPath = join(cacheDir, `${messageId}-${randomUUID()}${getTelegramImageExtension(filePath)}`);
    return await this.api.downloadFile(fileId, targetPath, file);
  }

  private async cacheTelegramVoice(
    messageId: number,
    fileId: string,
    filePath: string,
    file?: { file_id: string; file_path?: string }
  ): Promise<string | null> {
    if (!this.api) {
      return null;
    }

    const cacheDir = await this.ensureTelegramVoiceCacheDir();
    void this.pruneTelegramImageCache(cacheDir).catch(async (error) => {
      await this.logger.warn("telegram voice cache cleanup failed", {
        cacheDir,
        error: `${error}`
      });
    });

    const targetPath = join(cacheDir, `${messageId}-${randomUUID()}${getTelegramVoiceExtension(filePath)}`);
    return await this.api.downloadFile(fileId, targetPath, file);
  }

  private async ensureTelegramImageCacheDir(): Promise<string> {
    const cacheDir = join(this.paths.cacheDir, TELEGRAM_IMAGE_CACHE_DIRNAME);
    await mkdir(cacheDir, { recursive: true });
    return cacheDir;
  }

  private async ensureTelegramVoiceCacheDir(): Promise<string> {
    const cacheDir = join(this.paths.cacheDir, TELEGRAM_VOICE_CACHE_DIRNAME);
    await mkdir(cacheDir, { recursive: true });
    return cacheDir;
  }

  private async pruneTelegramImageCache(cacheDir: string): Promise<void> {
    const cutoffMs = Date.now() - TELEGRAM_IMAGE_CACHE_MAX_AGE_MS;
    const entries = await readdir(cacheDir, { withFileTypes: true });

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }

      const entryPath = join(cacheDir, entry.name);
      try {
        const fileStats = await stat(entryPath);
        if (fileStats.mtimeMs < cutoffMs) {
          await rm(entryPath, { force: true });
        }
      } catch {
        return;
      }
    }));
  }

  private async handleInspect(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const activeSession = this.store.getActiveSession(chatId);
    if (!activeSession) {
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const payload = await this.getInspectRenderPayload(activeSession);
    if (!payload) {
      await this.safeSendMessage(chatId, "当前没有可用的活动详情。");
      return;
    }

    const inspectHtml = this.buildInspectHtml(activeSession, payload);
    const rendered = buildInspectViewMessage({
      sessionId: activeSession.sessionId,
      html: inspectHtml,
      page: 0,
      collapsed: false
    });

    if (!await this.safeSendHtmlMessage(chatId, rendered.text, rendered.replyMarkup)) {
      await this.safeSendMessage(chatId, buildInspectPlainTextFallback(inspectHtml));
    }
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
    const session = this.getInspectableSession(chatId, sessionId);
    if (!session) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /inspect。");
      return;
    }

    const payload = await this.getInspectRenderPayload(session);
    if (!payload) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "当前没有可用的活动详情。");
      return;
    }

    const inspectHtml = this.buildInspectHtml(session, payload);
    const rendered = buildInspectViewMessage({
      sessionId,
      html: inspectHtml,
      page: options.page,
      collapsed: options.collapsed
    });

    const editResult = await this.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
    if (editResult.outcome === "edited") {
      await this.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    const fallbackSent = await this.safeSendMessage(chatId, buildInspectPlainTextFallback(rendered.text));
    await this.safeAnswerCallbackQuery(
      callbackQueryId,
      fallbackSent ? "详情过长，已改为纯文本发送。" : "暂时无法更新详情，请稍后重试。"
    );
  }

  private getInspectableSession(chatId: string, sessionId: string): SessionRow | null {
    const session = this.store?.getSessionById(sessionId) ?? null;
    if (!session || session.telegramChatId !== chatId) {
      return null;
    }

    return session;
  }

  private buildInspectHtml(activeSession: SessionRow, payload: InspectRenderPayload): string {
    return buildInspectText(payload.snapshot, {
      sessionName: activeSession.displayName,
      projectName: activeSession.projectName,
      commands: payload.commands,
      note: payload.note
    });
  }

  private async getInspectRenderPayload(activeSession: SessionRow): Promise<InspectRenderPayload | null> {
    const pendingInteractions = this.buildPendingInteractionSummaries(activeSession);
    const activity = this.activeTurn?.sessionId === activeSession.sessionId
      ? {
          tracker: this.activeTurn.tracker,
          debugFilePath: this.activeTurn.debugJournal.filePath,
          statusCard: this.activeTurn.statusCard
        }
      : this.recentActivityBySessionId.get(activeSession.sessionId);

    if (activity) {
      const snapshot = {
        ...activity.tracker.getInspectSnapshot(),
        pendingInteractions
      };
      if (snapshot.inspectAvailable) {
        return {
          snapshot,
          commands: buildInspectCommandEntries(activity.statusCard),
          note: null
        };
      }

      if (shouldRetryInspectFromHistory(activeSession, snapshot)) {
        const historicalPayload = await this.buildHistoricalInspectRenderPayload(activeSession);
        if (historicalPayload) {
          return historicalPayload;
        }
      }

      if (snapshot.turnStatus !== "starting") {
        return {
          snapshot,
          commands: buildInspectCommandEntries(activity.statusCard),
          note: null
        };
      }
    }

    const historicalPayload = await this.buildHistoricalInspectRenderPayload(activeSession);
    if (historicalPayload) {
      return {
        ...historicalPayload,
        snapshot: {
          ...historicalPayload.snapshot,
          pendingInteractions
        }
      };
    }

    if (pendingInteractions.length > 0) {
      return {
        snapshot: buildPendingInteractionOnlyInspectSnapshot(pendingInteractions),
        commands: [],
        note: null
      };
    }

    return null;
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

  private buildPendingInteractionSummaries(activeSession: SessionRow): PendingInteractionSummary[] {
    if (!this.store) {
      return [];
    }

    return this.store
      .listPendingInteractionsByChat(activeSession.telegramChatId, ["pending", "awaiting_text"])
      .filter((interaction) => interaction.sessionId === activeSession.sessionId)
      .map((interaction) => ({
        interactionId: interaction.interactionId,
        requestMethod: interaction.requestMethod,
        interactionKind: interaction.interactionKind,
        state: interaction.state,
        awaitingText: interaction.state === "awaiting_text"
      }));
  }

  private getRuntimeCardTraceContext(activeTurn: ActiveTurnState): RuntimeCardTraceContext {
    return {
      sessionId: activeTurn.sessionId,
      chatId: activeTurn.chatId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId
    };
  }

  private async logRuntimeCardEvent(
    context: RuntimeCardTraceContext,
    surface: RuntimeCardMessageState,
    event: string,
    meta: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await this.runtimeCardTraceLoggers[surface.surface].info(event, {
        sessionId: context.sessionId,
        chatId: context.chatId,
        threadId: context.threadId,
        turnId: context.turnId,
        surface: surface.surface,
        key: surface.key,
        messageId: surface.messageId === 0 ? null : surface.messageId,
        ...meta
      });
    } catch (error) {
      try {
        await this.logger.warn("runtime card trace log failed", {
          sessionId: context.sessionId,
          turnId: context.turnId,
          surface: surface.surface,
          key: surface.key,
          error: `${error}`
        });
      } catch {
        // Ignore trace-log failures entirely so Telegram rendering keeps running.
      }
    }
  }

  private async logSubagentIdentityEvents(
    activeTurn: ActiveTurnState,
    events: SubagentIdentityEvent[]
  ): Promise<void> {
    for (const event of events) {
      await this.logger.info(
        event.kind === "cached" ? "subagent identity cached" : "subagent identity applied",
        {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: event.threadId,
          label: event.label,
          labelSource: event.labelSource,
          origin: event.origin
        }
      );
    }
  }

  private async backfillSubagentIdentities(
    activeTurn: ActiveTurnState,
    agentEntries: CollabAgentStateSnapshot[]
  ): Promise<boolean> {
    const appServer = this.appServer as { readThread?: (threadId: string, includeTurns?: boolean) => Promise<unknown> } | null;
    if (!appServer?.readThread) {
      return false;
    }

    const readThread = appServer.readThread.bind(appServer);

    const candidates = agentEntries.filter((agent) => {
      if (agent.labelSource === "nickname") {
        return false;
      }
      const backfillState = activeTurn.subagentIdentityBackfillStates.get(agent.threadId);
      return backfillState !== "pending" && backfillState !== "resolved" && backfillState !== "exhausted";
    });

    if (candidates.length === 0) {
      return false;
    }

    for (const agent of candidates) {
      activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "pending");
    }

    const fetchResults = await Promise.allSettled(
      candidates.map(async (agent) => {
        await this.logger.info("subagent identity backfill requested", {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: agent.threadId
        });
        const result = await readThread(agent.threadId, false) as {
          thread?: {
            agentNickname?: string | null;
            agentRole?: string | null;
            name?: string | null;
          };
        };
        return { agent, thread: result.thread ?? null };
      })
    );

    let changed = false;
    for (const entry of fetchResults) {
      if (entry.status === "rejected") {
        continue;
      }
      const { agent, thread } = entry.value;

      try {
        const applied = thread
          ? activeTurn.tracker.applyResolvedSubagentIdentity(agent.threadId, {
            agentNickname: getString(thread, "agentNickname"),
            agentRole: getString(thread, "agentRole"),
            threadName: getString(thread, "name")
          })
          : false;
        await this.logSubagentIdentityEvents(activeTurn, activeTurn.tracker.drainSubagentIdentityEvents());

        const resolvedLabel = activeTurn.tracker.getInspectSnapshot().agentSnapshot
          .find((e) => e.threadId === agent.threadId);

        if (applied && resolvedLabel && resolvedLabel.labelSource !== "fallback") {
          changed = true;
          activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "resolved");
          await this.logger.info("subagent identity backfill resolved", {
            sessionId: activeTurn.sessionId,
            chatId: activeTurn.chatId,
            threadId: activeTurn.threadId,
            turnId: activeTurn.turnId,
            subagentThreadId: agent.threadId,
            label: resolvedLabel.label,
            labelSource: resolvedLabel.labelSource
          });
          continue;
        }

        activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "exhausted");
        await this.logger.info("subagent identity backfill exhausted", {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: agent.threadId
        });
      } catch (error) {
        activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "exhausted");
        await this.logger.warn("subagent identity backfill failed", {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: agent.threadId,
          error: `${error}`
        });
      }
    }

    // Handle fetch-level failures for agents whose promises rejected.
    for (const [index, entry] of fetchResults.entries()) {
      if (entry.status === "rejected") {
        const agent = candidates[index]!;
        activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "exhausted");
        await this.logger.warn("subagent identity backfill failed", {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: agent.threadId,
          error: `${entry.reason}`
        });
      }
    }

    return changed;
  }

  private buildStatusCardRenderPayload(
    sessionId: string,
    tracker: ActivityTracker,
    statusCard: StatusCardState
  ): {
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  } {
    const inspect = tracker.getInspectSnapshot();
    const context = this.getRuntimeCardContext(sessionId);
    const text = buildRuntimeStatusCard({
      ...context,
      optionalFieldLines: this.buildRuntimeStatusLine(sessionId, inspect),
      state: formatVisibleRuntimeState(inspect),
      progressText: selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null),
      planEntries: inspect.planSnapshot,
      planExpanded: statusCard.planExpanded,
      agentEntries: inspect.agentSnapshot,
      agentsExpanded: statusCard.agentsExpanded
    });
    const replyMarkup = buildRuntimeStatusReplyMarkup({
      sessionId,
      planEntries: inspect.planSnapshot,
      planExpanded: statusCard.planExpanded,
      agentEntries: inspect.agentSnapshot,
      agentsExpanded: statusCard.agentsExpanded
    });

    return replyMarkup ? { text, replyMarkup } : { text };
  }

  private async handleAppServerExit(error: Error): Promise<void> {
    if (this.stopping || !this.store) {
      return;
    }

    if (this.pendingThreadArchiveOps.size > 0) {
      await this.logger.warn("clearing pending thread archive ops after app-server exit", {
        pendingCount: this.countPendingThreadArchiveOps()
      });
      this.pendingThreadArchiveOps.clear();
    }

    await this.logger.warn("app-server exit observed", { error: `${error}` });

    if (this.activeTurn) {
      const runningTurn = this.activeTurn;
      await this.resolveActionablePendingInteractionsForSession(runningTurn.chatId, runningTurn.sessionId, {
        state: "failed",
        reason: "app_server_lost",
        resolutionSource: "app_server_exit"
      });
      this.activeTurn = null;
      this.disposeRuntimeCards(runningTurn);
      this.store.updateSessionStatus(runningTurn.sessionId, "failed", {
        failureReason: "app_server_lost",
        lastTurnId: runningTurn.turnId,
        lastTurnStatus: "failed"
      });
      await this.safeSendMessage(runningTurn.chatId, "Codex 服务暂时不可用，请稍后重试。");
    }

    try {
      const client = new CodexAppServerClient(
        this.config.codexBin,
        this.paths.appServerLogPath,
        this.bootstrapLogger,
        5000,
        {
          experimentalApi: this.config.voiceInputEnabled
        }
      );
      await client.initializeAndProbe();
      this.appServer = client;
      this.realtimeVoiceModelId = undefined;
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
        experimentalApi: this.config.voiceInputEnabled
      }
    );
    await client.initializeAndProbe();
    this.appServer = client;
    this.realtimeVoiceModelId = undefined;
    this.attachAppServerListeners();
  }

  private registerPendingThreadArchiveOp(
    threadId: string,
    sessionId: string,
    expectedRemoteState: PendingThreadArchiveState,
    origin: PendingThreadArchiveOp["origin"]
  ): number {
    const requestedAt = new Date().toISOString();
    const opId = this.nextPendingThreadArchiveOpId++;
    const pending: PendingThreadArchiveOp = {
      id: opId,
      sessionId,
      expectedRemoteState,
      requestedAt,
      origin,
      localStateCommitted: false,
      remoteStateObserved: null
    };
    const queue = this.pendingThreadArchiveOps.get(threadId) ?? [];
    queue.push(pending);
    this.pendingThreadArchiveOps.set(threadId, queue);
    void this.logger.info("thread archive op registered", {
      opId,
      sessionId,
      threadId,
      expectedRemoteState,
      origin,
      requestedAt,
      pendingDepth: queue.length
    });
    return opId;
  }

  private async markPendingThreadArchiveLocalCommit(threadId: string, opId: number | null): Promise<void> {
    if (opId === null) {
      return;
    }

    const pending = this.findPendingThreadArchiveOp(threadId, opId);
    if (!pending) {
      return;
    }

    pending.localStateCommitted = true;
    if (pending.remoteStateObserved !== pending.expectedRemoteState) {
      return;
    }

    this.removePendingThreadArchiveOp(threadId, opId);
    await this.logger.info("thread archive op confirmed", {
      opId: pending.id,
      sessionId: pending.sessionId,
      threadId,
      expectedRemoteState: pending.expectedRemoteState,
      origin: pending.origin,
      requestedAt: pending.requestedAt
    });
  }

  private async handleThreadArchiveNotification(
    classified: Extract<ReturnType<typeof classifyNotification>, { kind: "thread_archived" | "thread_unarchived" }>
  ): Promise<void> {
    if (!classified.threadId) {
      return;
    }

    const actualRemoteState: PendingThreadArchiveState =
      classified.kind === "thread_archived" ? "archived" : "unarchived";
    const pending = this.pendingThreadArchiveOps.get(classified.threadId)?.[0] ?? null;

    if (!pending) {
      const session = this.store?.getSessionByThreadId(classified.threadId) ?? null;
      await this.logger.warn("thread archive drift observed", {
        threadId: classified.threadId,
        actualRemoteState,
        sessionId: session?.sessionId ?? null,
        localArchived: session?.archived ?? null,
        method: classified.method
      });
      return;
    }

    if (pending.expectedRemoteState !== actualRemoteState) {
      this.removePendingThreadArchiveOp(classified.threadId, pending.id);
      await this.logger.warn("thread archive op conflicted", {
        opId: pending.id,
        sessionId: pending.sessionId,
        threadId: classified.threadId,
        expectedRemoteState: pending.expectedRemoteState,
        actualRemoteState,
        origin: pending.origin,
        requestedAt: pending.requestedAt,
        method: classified.method
      });
      return;
    }

    pending.remoteStateObserved = actualRemoteState;
    if (!pending.localStateCommitted) {
      await this.logger.info("thread archive op observed before local commit", {
        opId: pending.id,
        sessionId: pending.sessionId,
        threadId: classified.threadId,
        actualRemoteState,
        origin: pending.origin,
        requestedAt: pending.requestedAt,
        method: classified.method
      });
      return;
    }

    this.removePendingThreadArchiveOp(classified.threadId, pending.id);
    await this.logger.info("thread archive op confirmed", {
      opId: pending.id,
      sessionId: pending.sessionId,
      threadId: classified.threadId,
      expectedRemoteState: pending.expectedRemoteState,
      origin: pending.origin,
      requestedAt: pending.requestedAt,
      method: classified.method
    });
  }

  private async sendFinalAnswer(activeTurn: ActiveTurnState, finalMessage: string | null): Promise<void> {
    const text = finalMessage || "本次操作已完成，但没有可返回的最终答复。";
    const rendered = buildCollapsibleFinalAnswerView(text);
    await this.logger.info("sending final answer", {
      chatId: activeTurn.chatId,
      chunkCount: rendered.pages.length,
      collapsible: rendered.truncated,
      hasFinalMessage: finalMessage !== null,
      preview: summarizeTextPreview(text)
    });

    if (rendered.truncated && this.store) {
      let answerId: string | null = null;

      try {
        const saved = this.store.saveFinalAnswerView({
          telegramChatId: activeTurn.chatId,
          sessionId: activeTurn.sessionId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          previewHtml: rendered.previewHtml,
          pages: rendered.pages
        });
        answerId = saved.answerId;

        const sent = await this.safeSendHtmlMessageResult(
          activeTurn.chatId,
          saved.previewHtml,
          buildFinalAnswerReplyMarkup({
            answerId: saved.answerId,
            totalPages: saved.pages.length,
            expanded: false
          })
        );

        if (sent) {
          this.store.setFinalAnswerMessageId(saved.answerId, sent.message_id);
          return;
        }
      } catch (error) {
        await this.logger.warn("persisted final answer delivery failed; falling back to chunked send", {
          chatId: activeTurn.chatId,
          sessionId: activeTurn.sessionId,
          error: `${error}`
        });
      }

      if (answerId) {
        this.store.deleteFinalAnswerView(answerId);
      }
    }

    if (!rendered.truncated && rendered.pages.length === 1) {
      await this.safeSendHtmlMessageResult(activeTurn.chatId, rendered.pages[0] ?? "");
      return;
    }

    const chunks = renderFinalAnswerHtmlChunks(text, 3000);
    for (const chunk of chunks) {
      await this.safeSendHtmlMessageResult(activeTurn.chatId, chunk);
    }
  }

  private async appendDebugJournal(
    activeTurn: ActiveTurnState,
    method: string,
    params: unknown,
    overrides?: {
      threadId?: string | null;
      turnId?: string | null;
    }
  ): Promise<void> {
    const record: DebugJournalRecord = {
      receivedAt: new Date().toISOString(),
      threadId: overrides?.threadId ?? activeTurn.threadId,
      turnId: overrides?.turnId ?? activeTurn.turnId,
      method,
      params
    };

    try {
      await activeTurn.debugJournal.append(record);
    } catch (error) {
      await this.logger.warn("debug journal append failed", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        error: `${error}`
      });
    }
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
    if (
      threadId
      && this.activeTurn?.threadId === threadId
      && (turnId === null || this.activeTurn.turnId === turnId)
    ) {
      return this.activeTurn.debugJournal;
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

  private findPendingThreadArchiveOp(threadId: string, opId: number): PendingThreadArchiveOp | null {
    const queue = this.pendingThreadArchiveOps.get(threadId);
    if (!queue) {
      return null;
    }

    return queue.find((pending) => pending.id === opId) ?? null;
  }

  private removePendingThreadArchiveOp(threadId: string, opId: number): PendingThreadArchiveOp | null {
    const queue = this.pendingThreadArchiveOps.get(threadId);
    if (!queue) {
      return null;
    }

    const index = queue.findIndex((pending) => pending.id === opId);
    if (index === -1) {
      return null;
    }

    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.pendingThreadArchiveOps.delete(threadId);
    } else {
      this.pendingThreadArchiveOps.set(threadId, queue);
    }
    return removed ?? null;
  }

  private countPendingThreadArchiveOps(): number {
    let count = 0;
    for (const queue of this.pendingThreadArchiveOps.values()) {
      count += queue.length;
    }
    return count;
  }

  private async syncRuntimeCards(
    activeTurn: ActiveTurnState,
    classified: ReturnType<typeof classifyNotification> | null,
    previousStatus: ActivityStatus | null,
    nextStatus: ActivityStatus,
    options: {
      force?: boolean;
      reason: string;
    }
  ): Promise<void> {
    let inspect = activeTurn.tracker.getInspectSnapshot();
    if (inspect.agentSnapshot.length > 0) {
      const identityChanged = await this.backfillSubagentIdentities(activeTurn, inspect.agentSnapshot);
      if (identityChanged) {
        inspect = activeTurn.tracker.getInspectSnapshot();
      }
    }
    const context = this.getRuntimeCardContext(activeTurn.sessionId);
    const planFingerprint = inspect.planSnapshot.join("\n");
    const planChanged = planFingerprint !== activeTurn.latestPlanFingerprint;
    if (planChanged) {
      activeTurn.latestPlanFingerprint = planFingerprint;
    }
    const agentFingerprint = inspect.agentSnapshot
      .map((agent) => `${agent.threadId}|${agent.label}|${agent.status}|${agent.progress ?? ""}`)
      .join("\n");
    const agentsChanged = agentFingerprint !== activeTurn.latestAgentFingerprint;
    if (agentsChanged) {
      activeTurn.latestAgentFingerprint = agentFingerprint;
    }
    if (inspect.agentSnapshot.length === 0 && activeTurn.statusCard.agentsExpanded) {
      activeTurn.statusCard.agentsExpanded = false;
    }
    const commandStateChanged = classified && classified.threadId && classified.threadId !== activeTurn.threadId
      ? false
      : applyRuntimeCommandDelta(activeTurn.statusCard, classified, nextStatus);
    const nextStatusProgressText = selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null);
    const statusProgressTextChanged = nextStatusProgressText !== activeTurn.latestStatusProgressText;
    if (statusProgressTextChanged) {
      activeTurn.latestStatusProgressText = nextStatusProgressText;
    }

    const statusChanged = previousStatus === null ||
      previousStatus.turnStatus !== nextStatus.turnStatus ||
      previousStatus.threadBlockedReason !== nextStatus.threadBlockedReason ||
      previousStatus.activeItemType !== nextStatus.activeItemType ||
      previousStatus.activeItemLabel !== nextStatus.activeItemLabel ||
      previousStatus.lastHighValueEventType !== nextStatus.lastHighValueEventType ||
      previousStatus.lastHighValueTitle !== nextStatus.lastHighValueTitle ||
      previousStatus.lastHighValueDetail !== nextStatus.lastHighValueDetail ||
      previousStatus.latestProgress !== nextStatus.latestProgress ||
      previousStatus.finalMessageAvailable !== nextStatus.finalMessageAvailable ||
      previousStatus.errorState !== nextStatus.errorState ||
      commandStateChanged ||
      planChanged ||
      agentsChanged ||
      statusProgressTextChanged ||
      options.force;
    if (statusChanged) {
      const rendered = this.buildStatusCardRenderPayload(activeTurn.sessionId, activeTurn.tracker, activeTurn.statusCard);
      await this.logRuntimeCardEvent(this.getRuntimeCardTraceContext(activeTurn), activeTurn.statusCard, "state_transition", {
        reason: options.reason,
        forced: options.force ?? false,
        triggerKind: classified?.kind ?? null,
        triggerMethod: classified?.method ?? null,
        commandStateChanged,
        statusProgressTextChanged,
        previousStatus: previousStatus ? summarizeActivityStatus(previousStatus) : null,
        nextStatus: summarizeActivityStatus(nextStatus),
        selectedProgressText: nextStatusProgressText,
        commands: summarizeRuntimeCommands(activeTurn.statusCard.commandOrder),
        card: summarizeRuntimeCardSurface(activeTurn.statusCard),
        renderedText: rendered.text,
        replyMarkup: rendered.replyMarkup ?? null
      });
      await this.requestRuntimeCardRender(
        activeTurn,
        activeTurn.statusCard,
        rendered.text,
        rendered.replyMarkup,
        options.force
          ? { force: true, reason: options.reason }
          : { reason: options.reason }
      );
    }

    if (classified?.kind === "error") {
      const errorCard = createRuntimeCardMessageState(
        "error",
        `error-${activeTurn.nextErrorCardId++}`,
        "HTML"
      ) as ErrorCardState;
      errorCard.title = "Runtime error";
      errorCard.detail = cleanRuntimeErrorMessage(classified.message);
      activeTurn.errorCards.push(errorCard);
      const renderedErrorText = buildRuntimeErrorCard({
        ...context,
        title: errorCard.title,
        detail: errorCard.detail
      });
      await this.logRuntimeCardEvent(this.getRuntimeCardTraceContext(activeTurn), errorCard, "card_created", {
        reason: "runtime_error",
        triggerKind: classified.kind,
        triggerMethod: classified.method,
        title: errorCard.title,
        detail: errorCard.detail,
        card: summarizeRuntimeCardSurface(errorCard),
        renderedText: renderedErrorText
      });
      await this.requestRuntimeCardRender(
        activeTurn,
        errorCard,
        renderedErrorText,
        undefined,
        {
          force: true,
          reason: "runtime_error"
        }
      );
    }

    if (classified?.kind === "turn_completed") {
      if (classified.status === "failed" && activeTurn.errorCards.length === 0) {
        const errorCard = createRuntimeCardMessageState(
          "error",
          `error-${activeTurn.nextErrorCardId++}`,
          "HTML"
        ) as ErrorCardState;
        errorCard.title = "Turn failed";
        errorCard.detail = "This operation did not complete successfully.";
        activeTurn.errorCards.push(errorCard);
        const renderedErrorText = buildRuntimeErrorCard({
          ...context,
          title: errorCard.title,
          detail: errorCard.detail
        });
        await this.logRuntimeCardEvent(this.getRuntimeCardTraceContext(activeTurn), errorCard, "card_created", {
          reason: "turn_failed",
          triggerKind: classified.kind,
          triggerMethod: classified.method,
          title: errorCard.title,
          detail: errorCard.detail,
          card: summarizeRuntimeCardSurface(errorCard),
          renderedText: renderedErrorText
        });
        await this.requestRuntimeCardRender(
          activeTurn,
          errorCard,
          renderedErrorText,
          undefined,
          {
            force: true,
            reason: "turn_failed"
          }
        );
      }
    }
  }

  private async requestRuntimeCardRender(
    activeTurn: ActiveTurnState,
    surface: RuntimeCardMessageState,
    text: string,
    replyMarkup: TelegramInlineKeyboardMarkup | undefined,
    options: {
      force?: boolean;
      reason: string;
    }
  ): Promise<void> {
    const traceContext = this.getRuntimeCardTraceContext(activeTurn);
    const replyMarkupKey = serializeReplyMarkup(replyMarkup);
    const pendingChanged = surface.pendingText !== text ||
      serializeReplyMarkup(surface.pendingReplyMarkup) !== replyMarkupKey;
    surface.pendingText = text;
    surface.pendingReplyMarkup = replyMarkup ?? null;
    surface.pendingReason = options.reason;
    await this.logRuntimeCardEvent(traceContext, surface, "render_requested", {
      reason: options.reason,
      forced: options.force ?? false,
      pendingChanged,
      renderedText: text,
      replyMarkup: replyMarkup ?? null,
      card: summarizeRuntimeCardSurface(surface)
    });

    if (!pendingChanged && text === surface.lastRenderedText && surface.lastRenderedReplyMarkupKey === replyMarkupKey) {
      await this.logRuntimeCardEvent(traceContext, surface, "render_skipped", {
        reason: "text_unchanged",
        renderedText: text,
        replyMarkup: replyMarkup ?? null,
        card: summarizeRuntimeCardSurface(surface)
      });
      await this.logger.info("runtime card update skipped", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        reason: "text_unchanged"
      });
      return;
    }

    const now = Date.now();
    const throttleMs = options.force || surface.messageId === 0 ? 0 : getRuntimeCardThrottleMs(surface.surface);
    const lastRenderedAtMs = surface.lastRenderedAtMs ?? null;
    const throttleRemainingMs = lastRenderedAtMs === null
      ? 0
      : Math.max(0, lastRenderedAtMs + throttleMs - now);
    const rateLimitRemainingMs = surface.rateLimitUntilAtMs === null
      ? 0
      : Math.max(0, surface.rateLimitUntilAtMs - now);
    const remainingMs = Math.max(throttleRemainingMs, rateLimitRemainingMs);

    if (remainingMs > 0) {
      this.scheduleRuntimeCardRetry(activeTurn, surface, remainingMs, options.reason);
      await this.logRuntimeCardEvent(traceContext, surface, "render_scheduled", {
        reason: options.reason,
        forced: options.force ?? false,
        remainingMs,
        throttleRemainingMs,
        rateLimitRemainingMs,
        card: summarizeRuntimeCardSurface(surface)
      });
      await this.logger.info("runtime card update scheduled", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        reason: options.reason,
        remainingMs
      });
      return;
    }

    await this.flushRuntimeCardRender(activeTurn, surface);
  }

  private scheduleRuntimeCardRetry(
    activeTurn: ActiveTurnState,
    surface: RuntimeCardMessageState,
    delayMs: number,
    reason: string
  ): void {
    const traceContext = this.getRuntimeCardTraceContext(activeTurn);
    this.clearRuntimeCardTimer(surface);
    surface.timer = setTimeout(() => {
      surface.timer = null;
      void this.logRuntimeCardEvent(traceContext, surface, "retry_fired", {
        reason,
        delayMs,
        card: summarizeRuntimeCardSurface(surface)
      });
      void this.logger.info("runtime card retry fired", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        reason
      });
      void this.flushRuntimeCardRender(activeTurn, surface);
    }, delayMs);
    surface.timer.unref?.();
  }

  private async flushRuntimeCardRender(
    activeTurn: ActiveTurnState,
    surface: RuntimeCardMessageState
  ): Promise<void> {
    await this.runRuntimeCardOperation(activeTurn, async () => {
      const traceContext = this.getRuntimeCardTraceContext(activeTurn);
      const text = surface.pendingText;
      const replyMarkup = surface.pendingReplyMarkup ?? undefined;
      const replyMarkupKey = serializeReplyMarkup(replyMarkup);
      const reason = surface.pendingReason;
      if (!text) {
        return;
      }

      if (text === surface.lastRenderedText && surface.lastRenderedReplyMarkupKey === replyMarkupKey) {
        surface.pendingText = null;
        surface.pendingReplyMarkup = null;
        surface.pendingReason = null;
        await this.logRuntimeCardEvent(traceContext, surface, "render_skipped", {
          reason: "render_unchanged",
          renderedText: text,
          replyMarkup: replyMarkup ?? null,
          card: summarizeRuntimeCardSurface(surface)
        });
        await this.logger.info("runtime card update skipped", {
          sessionId: activeTurn.sessionId,
          turnId: activeTurn.turnId,
          surface: surface.surface,
          key: surface.key,
          reason: "render_unchanged"
        });
        return;
      }

      surface.pendingText = null;
      surface.pendingReplyMarkup = null;
      surface.pendingReason = null;

      if (surface.messageId === 0) {
        const sent = surface.parseMode === "HTML"
          ? await this.safeSendHtmlMessageResult(activeTurn.chatId, text, replyMarkup)
          : await this.safeSendMessageResult(activeTurn.chatId, text, replyMarkup);
        if (!sent) {
          surface.pendingText = text;
          surface.pendingReplyMarkup = replyMarkup ?? null;
          surface.pendingReason = reason;
          await this.logRuntimeCardEvent(traceContext, surface, "send_failed_requeued", {
            reason,
            renderedText: text,
            replyMarkup: replyMarkup ?? null,
            card: summarizeRuntimeCardSurface(surface)
          });
          return;
        }
        surface.messageId = sent.message_id;
        surface.lastRenderedText = text;
        surface.lastRenderedReplyMarkupKey = replyMarkupKey;
        surface.lastRenderedAtMs = Date.now();
        surface.rateLimitUntilAtMs = null;
        await this.logRuntimeCardEvent(traceContext, surface, "render_sent", {
          reason,
          renderedText: text,
          replyMarkup: replyMarkup ?? null,
          card: summarizeRuntimeCardSurface(surface)
        });
        await this.logger.info("runtime card sent", {
          sessionId: activeTurn.sessionId,
          turnId: activeTurn.turnId,
          surface: surface.surface,
          key: surface.key,
          messageId: surface.messageId,
          reason,
          preview: summarizeTextPreview(text)
        });
        return;
      }

      const editResult = surface.parseMode === "HTML"
        ? await this.safeEditHtmlMessageText(activeTurn.chatId, surface.messageId, text, replyMarkup)
        : await this.safeEditMessageText(activeTurn.chatId, surface.messageId, text, replyMarkup);
      await this.logRuntimeCardEvent(traceContext, surface, "edit_attempted", {
        reason,
        outcome: editResult.outcome,
        renderedText: text,
        replyMarkup: replyMarkup ?? null,
        retryAfterMs: editResult.outcome === "rate_limited" ? editResult.retryAfterMs : null,
        card: summarizeRuntimeCardSurface(surface)
      });
      await this.logger.info("runtime card edit attempted", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        messageId: surface.messageId,
        outcome: editResult.outcome,
        reason,
        preview: summarizeTextPreview(text),
        retryAfterMs: editResult.outcome === "rate_limited" ? editResult.retryAfterMs : undefined
      });

      if (editResult.outcome === "edited") {
        surface.lastRenderedText = text;
        surface.lastRenderedReplyMarkupKey = replyMarkupKey;
        surface.lastRenderedAtMs = Date.now();
        surface.rateLimitUntilAtMs = null;
        await this.logRuntimeCardEvent(traceContext, surface, "render_edited", {
          reason,
          renderedText: text,
          replyMarkup: replyMarkup ?? null,
          card: summarizeRuntimeCardSurface(surface)
        });
        return;
      }

      surface.pendingText = text;
      surface.pendingReplyMarkup = replyMarkup ?? null;
      surface.pendingReason = reason;
      if (editResult.outcome === "rate_limited") {
        surface.rateLimitUntilAtMs = Date.now() + editResult.retryAfterMs;
      }
      const retryMs = editResult.outcome === "rate_limited" ? editResult.retryAfterMs : FAILED_EDIT_RETRY_MS;
      await this.logRuntimeCardEvent(traceContext, surface, "edit_requeued", {
        reason,
        outcome: editResult.outcome,
        retryMs,
        renderedText: text,
        replyMarkup: replyMarkup ?? null,
        card: summarizeRuntimeCardSurface(surface)
      });
      this.scheduleRuntimeCardRetry(activeTurn, surface, retryMs, reason ?? "edit_retry");
    });
  }

  private async runRuntimeCardOperation(activeTurn: ActiveTurnState, operation: () => Promise<void>): Promise<void> {
    const queuedOperation = activeTurn.surfaceQueue.then(operation, operation);
    activeTurn.surfaceQueue = queuedOperation.catch(() => {});
    await queuedOperation;
  }

  private clearRuntimeCardTimer(surface: RuntimeCardMessageState): void {
    if (!surface.timer) {
      return;
    }

    clearTimeout(surface.timer);
    surface.timer = null;
  }

  private disposeRuntimeCards(activeTurn: ActiveTurnState): void {
    const traceContext = this.getRuntimeCardTraceContext(activeTurn);
    void this.logRuntimeCardEvent(traceContext, activeTurn.statusCard, "card_disposed", {
      card: summarizeRuntimeCardSurface(activeTurn.statusCard)
    });
    this.clearRuntimeCardTimer(activeTurn.statusCard);

    for (const errorCard of activeTurn.errorCards) {
      void this.logRuntimeCardEvent(traceContext, errorCard, "card_disposed", {
        card: summarizeRuntimeCardSurface(errorCard)
      });
      this.clearRuntimeCardTimer(errorCard);
    }
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
        return `model-name: ${session.selectedModel ?? "默认模型"}`;
      case "model-with-reasoning":
        return `model-with-reasoning: ${formatSessionModelReasoningConfig(session)}`;
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
        return session.displayName ? `会话: ${session.displayName}` : null;
      case "project_name":
        return `项目: ${this.projectDisplayName(session)}`;
      case "project_path":
        return session.projectPath ? `路径: ${session.projectPath}` : null;
      case "plan_mode":
        return `Plan mode: ${session.planMode ? "on" : "off"}`;
      case "model_reasoning":
        return `模型: ${formatSessionModelReasoningConfig(session)}`;
      case "thread_id":
        return session.threadId ? `线程: ${session.threadId}` : null;
      case "turn_id":
        return session.lastTurnId ? `Turn: ${session.lastTurnId}` : null;
      case "blocked_reason":
        return blockedReason ? `阻塞: ${blockedReason}` : null;
      case "current_step":
        return progressText ? `步骤: ${progressText}` : null;
      case "last_token_usage":
        return inspect.tokenUsage?.lastTotalTokens !== null && inspect.tokenUsage?.lastTotalTokens !== undefined
          ? `本次Token: ${inspect.tokenUsage.lastTotalTokens}`
          : null;
      case "total_token_usage":
        return inspect.tokenUsage?.totalTokens !== null && inspect.tokenUsage?.totalTokens !== undefined
          ? `累计Token: ${inspect.tokenUsage.totalTokens}`
          : null;
      case "context_window":
        return inspect.tokenUsage?.modelContextWindow !== null && inspect.tokenUsage?.modelContextWindow !== undefined
          ? `上下文: ${inspect.tokenUsage.modelContextWindow}`
          : null;
      case "final_answer_ready":
        return `终答: ${inspect.finalMessageAvailable ? "是" : "否"}`;
    }
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

  private async syncTelegramCommands(): Promise<void> {
    if (!this.api) {
      return;
    }

    try {
      await syncTelegramCommands(this.api);
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
    activeItemLabel: status.activeItemLabel,
    lastActivityAt: status.lastActivityAt,
    currentItemStartedAt: status.currentItemStartedAt,
    currentItemDurationSec: status.currentItemDurationSec,
    lastHighValueEventType: status.lastHighValueEventType,
    lastHighValueTitle: status.lastHighValueTitle,
    lastHighValueDetail: status.lastHighValueDetail,
    latestProgress: status.latestProgress,
    recentStatusUpdates: status.recentStatusUpdates,
    blockedReason: status.threadBlockedReason,
    finalMessageAvailable: status.finalMessageAvailable,
    inspectAvailable: status.inspectAvailable,
    debugAvailable: status.debugAvailable,
    errorState: status.errorState
  };
}

function summarizeTextPreview(text: string, limit = 160): string {
  return normalizeAndTruncate(text, limit, "...") ?? "";
}

function truncatePlainText(text: string, limit: number): string {
  return normalizeAndTruncate(text, limit, "...") ?? "";
}

function splitStructuredInputCommand(args: string): { value: string; prompt: string | null } {
  const separatorIndex = args.indexOf("::");
  if (separatorIndex === -1) {
    return {
      value: args.trim(),
      prompt: null
    };
  }

  return {
    value: args.slice(0, separatorIndex).trim(),
    prompt: args.slice(separatorIndex + 2).trim() || null
  };
}

function parseReviewCommandArgs(args: string): {
  delivery?: "inline" | "detached";
  target:
    | { type: "uncommittedChanges" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title?: string | null }
    | { type: "custom"; instructions: string };
} | null {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let delivery: "inline" | "detached" | undefined;
  let index = 0;

  if (tokens[0] === "detached") {
    delivery = "detached";
    index += 1;
  }

  const kind = tokens[index];
  if (!kind) {
    return {
      ...(delivery ? { delivery } : {}),
      target: { type: "uncommittedChanges" }
    };
  }

  if (kind === "branch" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "baseBranch",
        branch: tokens.slice(index + 1).join(" ")
      }
    };
  }

  if (kind === "commit" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "commit",
        sha: tokens[index + 1] ?? ""
      }
    };
  }

  if (kind === "custom" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "custom",
        instructions: tokens.slice(index + 1).join(" ")
      }
    };
  }

  return null;
}

function parseMentionValue(value: string): {
  name: string;
  path: string;
} {
  const separatorIndex = value.indexOf("|");
  if (separatorIndex !== -1) {
    const explicitName = value.slice(0, separatorIndex).trim();
    const explicitPath = value.slice(separatorIndex + 1).trim();
    if (explicitName && explicitPath) {
      return {
        name: explicitName,
        path: explicitPath
      };
    }
  }

  return {
    name: deriveMentionName(value),
    path: value.trim()
  };
}

function deriveMentionName(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (/^[a-z]+:\/\//iu.test(trimmed)) {
    const withoutScheme = trimmed.replace(/^[a-z]+:\/\//iu, "");
    const tail = withoutScheme.split("/").filter(Boolean).at(-1);
    return tail ?? trimmed;
  }

  const base = basename(trimmed);
  return base || trimmed;
}

function parseThreadMetadataTokens(tokens: string[]): {
  branch?: string | null;
  sha?: string | null;
  originUrl?: string | null;
} | null {
  const gitInfo: {
    branch?: string | null;
    sha?: string | null;
    originUrl?: string | null;
  } = {};

  for (const token of tokens) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) {
      return null;
    }

    const key = token.slice(0, separatorIndex).trim();
    const rawValue = token.slice(separatorIndex + 1).trim();
    const value = rawValue === "-" ? null : rawValue;
    switch (key) {
      case "branch":
        gitInfo.branch = value;
        break;
      case "sha":
        gitInfo.sha = value;
        break;
      case "origin":
      case "originUrl":
        gitInfo.originUrl = value;
        break;
      default:
        return null;
    }
  }

  return Object.keys(gitInfo).length > 0 ? gitInfo : null;
}

async function isReadableImagePath(imagePath: string): Promise<boolean> {
  if (!/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/iu.test(imagePath)) {
    return false;
  }

  try {
    await access(imagePath);
    return true;
  } catch {
    return false;
  }
}

function getTelegramImageExtension(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/iu.test(extension) ? extension : ".jpg";
}

function getTelegramVoiceExtension(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/iu.test(extension) ? extension : ".ogg";
}

function isGlobalRuntimeNotice(
  notification: ReturnType<typeof classifyNotification>
): notification is Extract<
  ReturnType<typeof classifyNotification>,
  { kind: "config_warning" | "deprecation_notice" | "model_rerouted" | "skills_changed" | "thread_compacted" }
> {
  return notification.kind === "config_warning"
    || notification.kind === "deprecation_notice"
    || notification.kind === "model_rerouted"
    || notification.kind === "skills_changed"
    || notification.kind === "thread_compacted";
}

function formatGlobalRuntimeNotice(
  notification: Extract<
    ReturnType<typeof classifyNotification>,
    { kind: "config_warning" | "deprecation_notice" | "model_rerouted" | "skills_changed" | "thread_compacted" }
  >
): string | null {
  switch (notification.kind) {
    case "config_warning":
      return notification.summary
        ? `Codex 配置警告：${notification.summary}${notification.detail ? `\n${notification.detail}` : ""}`
        : null;
    case "deprecation_notice":
      return notification.summary
        ? `Codex 弃用提示：${notification.summary}${notification.detail ? `\n${notification.detail}` : ""}`
        : null;
    case "model_rerouted":
      if (!notification.fromModel || !notification.toModel) {
        return null;
      }
      return `Codex 已调整模型：${notification.fromModel} -> ${notification.toModel}${notification.reason ? ` (${notification.reason})` : ""}`;
    case "skills_changed":
      return "Codex 技能列表已刷新。";
    case "thread_compacted":
      return "Codex 线程上下文已压缩。";
    default:
      return null;
  }
}

function summarizeRuntimeCommands(commands: RuntimeCommandState[]): Array<Record<string, unknown>> {
  return commands.map((command) => ({
    itemId: command.itemId,
    commandText: command.commandText,
    latestSummary: command.latestSummary,
    status: command.status
  }));
}

function summarizeRuntimeCardSurface(surface: RuntimeCardMessageState): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    surface: surface.surface,
    key: surface.key,
    parseMode: surface.parseMode,
    messageId: surface.messageId === 0 ? null : surface.messageId,
    lastRenderedText: surface.lastRenderedText || null,
    lastRenderedReplyMarkupKey: surface.lastRenderedReplyMarkupKey,
    lastRenderedAtMs: surface.lastRenderedAtMs,
    rateLimitUntilAtMs: surface.rateLimitUntilAtMs,
    pendingText: surface.pendingText,
    pendingReplyMarkupKey: serializeReplyMarkup(surface.pendingReplyMarkup),
    pendingReason: surface.pendingReason
  };

  if (surface.surface === "status") {
    const statusSurface = surface as StatusCardState;
    summary.commandCount = statusSurface.commandOrder.length;
    summary.commands = summarizeRuntimeCommands(statusSurface.commandOrder);
    summary.planExpanded = statusSurface.planExpanded;
    summary.agentsExpanded = statusSurface.agentsExpanded;
    return summary;
  }

  if (surface.surface === "error") {
    const errorSurface = surface as ErrorCardState;
    summary.title = errorSurface.title;
    summary.detail = errorSurface.detail;
  }

  return summary;
}

function createRuntimeCardMessageState(
  surface: RuntimeCardMessageState["surface"],
  key: string,
  parseMode: "HTML" | null = null
): RuntimeCardMessageState {
  return {
    surface,
    key,
    parseMode,
    messageId: 0,
    lastRenderedText: "",
    lastRenderedReplyMarkupKey: null,
    lastRenderedAtMs: null,
    rateLimitUntilAtMs: null,
    pendingText: null,
    pendingReplyMarkup: null,
    pendingReason: null,
    timer: null
  };
}

function createStatusCardMessageState(): StatusCardState {
  return {
    ...createRuntimeCardMessageState("status", "status", "HTML"),
    surface: "status",
    parseMode: "HTML",
    commandItems: new Map(),
    commandOrder: [],
    planExpanded: false,
    agentsExpanded: false
  };
}

function serializeReplyMarkup(replyMarkup: TelegramInlineKeyboardMarkup | null | undefined): string | null {
  return replyMarkup ? JSON.stringify(replyMarkup) : null;
}

function getRuntimeCardThrottleMs(_surface: RuntimeCardMessageState["surface"]): number {
  return RUNTIME_CARD_THROTTLE_MS;
}

function formatVisibleRuntimeState(status: ActivityStatus): string {
  if (status.latestProgress && /^Reconnecting/i.test(status.latestProgress)) {
    return "Reconnecting";
  }

  switch (status.turnStatus) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      break;
  }

  if (status.threadBlockedReason || status.turnStatus === "blocked") {
    return "Blocked";
  }

  if (status.threadRuntimeState === "systemError") {
    return "Failed";
  }

  if (status.threadRuntimeState === "active") {
    return "Running";
  }

  switch (status.turnStatus) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}

function formatRuntimeBlockedReason(reason: ActivityStatus["threadBlockedReason"]): string | null {
  switch (reason) {
    case "waitingOnApproval":
      return "approval";
    case "waitingOnUserInput":
      return "user input";
    default:
      return null;
  }
}

function selectStatusProgressText(status: ActivityStatus, latestProgressUnit: string | null): string | null {
  if (latestProgressUnit) {
    return latestProgressUnit;
  }

  if (status.latestProgress && /^Reconnecting/i.test(status.latestProgress)) {
    return status.latestProgress;
  }

  if (status.turnStatus === "failed") {
    return null;
  }

  if (status.latestProgress) {
    return status.latestProgress;
  }

  if (status.lastHighValueEventType === "found" && status.lastHighValueDetail) {
    return status.lastHighValueDetail;
  }

  return null;
}

function normalizeCommandName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "command";
}

function isGenericCommandName(value: string | null | undefined): boolean {
  return normalizeCommandName(value ?? "") === "command";
}

function summarizeRuntimeCommandOutput(text: string | null): { command: string | null; detail: string | null } {
  if (!text) {
    return {
      command: null,
      detail: null
    };
  }

  const rawLines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) {
    return {
      command: null,
      detail: null
    };
  }

  const firstLine = rawLines[0]!;
  const command = /^[>$#]\s*/u.test(firstLine)
    ? normalizeCommandName(firstLine.replace(/^[>$#]\s*/u, ""))
    : null;
  const detailCandidate = rawLines.at(-1) ?? null;
  const detail = detailCandidate && detailCandidate !== firstLine
    ? cleanRuntimeErrorMessage(detailCandidate)
    : null;

  return {
    command,
    detail
  };
}

function getOrCreateRuntimeCommand(
  statusCard: StatusCardState,
  itemId: string,
  label: string | null
): { command: RuntimeCommandState; created: boolean } {
  const existing = statusCard.commandItems.get(itemId);
  if (existing) {
    return {
      command: existing,
      created: false
    };
  }

  const created: RuntimeCommandState = {
    itemId,
    commandText: normalizeCommandName(label ?? "command"),
    latestSummary: null,
    outputBuffer: "",
    status: "running"
  };
  statusCard.commandItems.set(itemId, created);
  statusCard.commandOrder.push(created);
  return {
    command: created,
    created: true
  };
}

function applyRuntimeCommandDelta(
  statusCard: StatusCardState,
  classified: ReturnType<typeof classifyNotification> | null,
  nextStatus: ActivityStatus
): boolean {
  if (!classified) {
    return false;
  }

  let changed = false;
  if (classified.kind === "item_started" && classified.itemType === "commandExecution" && classified.itemId) {
    const commandResult = getOrCreateRuntimeCommand(statusCard, classified.itemId, classified.label);
    const command = commandResult.command;
    changed = commandResult.created || changed;
    const nextCommandText = normalizeCommandName(classified.label ?? command.commandText);
    if (command.commandText !== nextCommandText) {
      command.commandText = nextCommandText;
      changed = true;
    }
    if (command.status !== "running") {
      command.status = "running";
      changed = true;
    }
  }

  if (classified.kind === "command_output" && classified.itemId) {
    const commandResult = getOrCreateRuntimeCommand(statusCard, classified.itemId, "command");
    const command = commandResult.command;
    changed = commandResult.created || changed;
    const nextOutputBuffer = `${command.outputBuffer}${classified.text ?? ""}`;
    if (command.outputBuffer !== nextOutputBuffer) {
      command.outputBuffer = nextOutputBuffer;
    }
    const parsed = summarizeRuntimeCommandOutput(command.outputBuffer);
    if (parsed.command && (isGenericCommandName(command.commandText) || command.commandText !== parsed.command)) {
      command.commandText = parsed.command;
      changed = true;
    }
    if (command.latestSummary !== parsed.detail) {
      command.latestSummary = parsed.detail;
      changed = true;
    }
  }

  if (classified.kind === "item_completed" && classified.itemType === "commandExecution" && classified.itemId) {
    const command = statusCard.commandItems.get(classified.itemId);
    if (command && command.status !== "completed") {
      command.status = nextStatus.turnStatus === "interrupted" ? "interrupted" : "completed";
      changed = true;
    }
  }

  if (classified.kind === "turn_aborted" || classified.kind === "error" || classified.kind === "turn_completed") {
    const finalCommandStatus = classified.kind === "turn_aborted"
      ? "interrupted"
      : classified.kind === "error"
        ? "failed"
        : classified.status === "completed"
          ? "completed"
          : classified.status === "interrupted"
            ? "interrupted"
            : "failed";
    for (const command of statusCard.commandOrder) {
      if (command.status === finalCommandStatus || command.status !== "running") {
        continue;
      }
      command.status = finalCommandStatus;
      changed = true;
    }
  }

  return changed;
}

function formatRuntimeCommandState(status: RuntimeCommandState["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      return "Unknown";
  }
}

function buildInspectCommandEntries(statusCard: StatusCardState | null | undefined): RuntimeCommandEntryView[] {
  if (!statusCard) {
    return [];
  }

  return statusCard.commandOrder.map((command) => ({
    commandText: command.commandText,
    state: formatRuntimeCommandState(command.status),
    latestSummary: command.latestSummary
  }));
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
            pushHistorySummary(planSnapshot, line);
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
    agentSnapshot: [],
    completedCommentary,
    tokenUsage: null,
    latestDiffSummary: null,
    terminalInteractionSummary: null,
    pendingInteractions: []
  };

  const hasStructuredDetail = commands.length > 0
    || recentFileChangeSummaries.length > 0
    || recentMcpSummaries.length > 0
    || recentWebSearches.length > 0
    || planSnapshot.length > 0
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

function buildPendingInteractionSurface(
  row: PendingInteractionRow,
  interaction: NormalizedInteraction
): {
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
} {
  if (row.state === "answered") {
    return buildInteractionResolvedCard({
      title: interaction.title,
      state: "answered",
      summary: summarizeAnsweredInteraction(row, interaction)
    });
  }

  if (row.state === "canceled") {
    return buildInteractionResolvedCard({
      title: interaction.title,
      state: "canceled",
      summary: "已取消"
    });
  }

  if (row.state === "failed") {
    return buildInteractionResolvedCard({
      title: interaction.title,
      state: "failed",
      summary: formatPendingInteractionTerminalReason(row.errorReason)
    });
  }

  if (row.state === "expired") {
    return buildInteractionExpiredCard({
      title: interaction.title,
      reason: formatPendingInteractionTerminalReason(row.errorReason)
    });
  }

  switch (interaction.kind) {
    case "approval":
      return buildInteractionApprovalCard({
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: interaction.subtitle,
        body: interaction.body,
        detail: interaction.detail,
        actions: buildApprovalActions(interaction)
      });

    case "permissions":
      return buildInteractionApprovalCard({
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: interaction.subtitle,
        body: summarizePermissions(interaction.requestedPermissions),
        detail: interaction.detail,
        actions: [
          { text: "批准本次权限", decisionKey: "accept" },
          { text: "本会话内总是批准", decisionKey: "acceptForSession" },
          { text: "拒绝", decisionKey: "decline" }
        ]
      });

    case "elicitation":
      return buildInteractionApprovalCard({
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: `MCP: ${interaction.serverName}`,
        body: interaction.message,
        detail: interaction.detail,
        actions: [
          { text: "接受", decisionKey: "accept" },
          { text: "拒绝", decisionKey: "decline" }
        ]
      });

    case "questionnaire": {
      const draft = parseQuestionnaireDraft(row.responseJson);
      const currentQuestion = getCurrentQuestion(interaction, draft);
      if (!currentQuestion) {
        return buildInteractionResolvedCard({
          title: interaction.title,
          state: "answered",
          summary: summarizeAnsweredInteraction(row, interaction)
        });
      }

      return buildInteractionQuestionCard({
        interactionId: row.interactionId,
        title: interaction.title,
        questionId: currentQuestion.id,
        header: currentQuestion.header,
        question: currentQuestion.question,
        questionIndex: findQuestionIndex(interaction, currentQuestion.id) + 1,
        totalQuestions: interaction.questions.length,
        options: currentQuestion.options,
        isOther: currentQuestion.isOther,
        isSecret: currentQuestion.isSecret
      });
    }
  }
}

function buildApprovalActions(interaction: NormalizedApprovalInteraction): Array<{ text: string; decisionKey: string }> {
  return interaction.decisionOptions
    .filter((option) => option.kind !== "cancel")
    .map((option) => ({
      decisionKey: option.key,
      text: option.label
    }));
}

function summarizeAnsweredInteraction(row: PendingInteractionRow, interaction: NormalizedInteraction): string | null {
  const payload = parseJsonRecord(row.responseJson);
  switch (interaction.kind) {
    case "approval": {
      const decisionRecord = asRecord(payload?.decision);
      if (decisionRecord?.acceptWithExecpolicyAmendment) {
        return "已批准，并更新命令规则";
      }
      if (decisionRecord?.applyNetworkPolicyAmendment) {
        const networkDecision = asRecord(decisionRecord.applyNetworkPolicyAmendment);
        const amendment = asRecord(networkDecision?.network_policy_amendment);
        const host = typeof amendment?.host === "string" ? amendment.host : null;
        return host ? `已批准，并保存网络规则（${host}）` : "已批准，并保存网络规则";
      }

      const decision = typeof payload?.decision === "string" ? payload.decision : null;
      if (decision === "accept" || decision === "approved") {
        return "已批准";
      }
      if (decision === "acceptForSession" || decision === "approved_for_session") {
        return "已批准，并写入本会话缓存";
      }
      if (decision === "decline" || decision === "denied") {
        return "已拒绝";
      }
      if (decision === "cancel" || decision === "abort") {
        return "已取消";
      }
      return "已处理";
    }

    case "permissions": {
      const scope = typeof payload?.scope === "string" ? payload.scope : "turn";
      const granted = summarizeGrantedPermissions(payload?.permissions ?? null);
      return granted ? `已授权（${scope}）: ${granted}` : `已拒绝（${scope}）`;
    }

    case "questionnaire": {
      const action = typeof payload?.action === "string" ? payload.action : null;
      if (action === "cancel") {
        return "已取消";
      }
      if (action === "decline") {
        return "已拒绝";
      }
      if (action === "accept") {
        const content = parseJsonRecord(payload?.content);
        const count = content ? Object.keys(content).length : 0;
        return count > 0 ? `已提交 ${count} 个字段` : "已提交表单";
      }

      const answers = parseJsonRecord(payload?.answers);
      const count = answers ? Object.keys(answers).length : 0;
      return count > 0 ? `已提交 ${count} 个回答` : "已提交回答";
    }

    case "elicitation": {
      const action = typeof payload?.action === "string" ? payload.action : null;
      return action === "accept" ? "已接受" : action === "decline" ? "已拒绝" : action === "cancel" ? "已取消" : "已处理";
    }
  }
}

function summarizePermissions(value: unknown): string | null {
  const parts = collectPermissionSummaryParts(value);
  return parts.length > 0 ? parts.join("；") : "无额外权限";
}

function summarizeGrantedPermissions(value: unknown): string | null {
  const parts = collectPermissionSummaryParts(value);
  return parts.length > 0 ? parts.join("；") : null;
}

function collectPermissionSummaryParts(value: unknown): string[] {
  const record = parseJsonRecord(value);
  if (!record) {
    return [];
  }

  const parts: string[] = [];
  const fileSystem = parseJsonRecord(record.fileSystem);
  if (fileSystem) {
    const read = Array.isArray(fileSystem.read) ? fileSystem.read.length : 0;
    const write = Array.isArray(fileSystem.write) ? fileSystem.write.length : 0;
    if (read > 0 || write > 0) {
      parts.push(`文件系统 读${read}/写${write}`);
    }
  }

  const network = parseJsonRecord(record.network);
  if (network?.enabled === true) {
    parts.push("网络");
  }

  const macos = parseJsonRecord(record.macos);
  if (macos) {
    parts.push("macOS 权限");
  }

  return parts;
}

function formatPendingInteractionTerminalReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "app_server_lost":
      return "Codex 服务已断开，这个交互无法继续。";
    case "bridge_restart":
      return "桥接服务已重启，这个交互无法继续。";
    case "response_dispatch_failed":
      return "Codex 服务没有收到这次交互结果。";
    case "turn_completed":
    case "turn_failed":
    case "turn_interrupted":
      return "当前操作已结束，交互已失效。";
    case "telegram_delivery_failed":
      return "Telegram 未能发送这张交互卡片。";
    default:
      return reason ? "这个交互无法继续。" : null;
  }
}

function isPendingInteractionActionable(row: PendingInteractionRow): boolean {
  return row.state === "pending" || row.state === "awaiting_text";
}

function isPendingInteractionHandled(row: PendingInteractionRow): boolean {
  return row.state === "answered" || row.state === "canceled";
}

function parseStoredInteraction(promptJson: string): NormalizedInteraction | null {
  try {
    return JSON.parse(promptJson) as NormalizedInteraction;
  } catch {
    return null;
  }
}

function parseQuestionnaireDraft(responseJson: string | null): QuestionnaireDraft {
  if (!responseJson) {
    return { answers: {} };
  }

  try {
    const parsed = asRecord(JSON.parse(responseJson));
    return {
      answers: asRecord(parsed?.answers) ?? {},
      awaitingQuestionId: getString(parsed, "awaitingQuestionId")
    };
  } catch {
    return { answers: {} };
  }
}

function getCurrentQuestion(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): NormalizedQuestion | null {
  if (draft.awaitingQuestionId) {
    return interaction.questions.find((question) => question.id === draft.awaitingQuestionId) ?? null;
  }

  return interaction.questions.find((question) => !hasDraftAnswer(draft, question.id)) ?? null;
}

function findQuestionIndex(interaction: NormalizedQuestionnaireInteraction, questionId: string): number {
  return Math.max(
    0,
    interaction.questions.findIndex((question) => question.id === questionId)
  );
}

function hasDraftAnswer(draft: QuestionnaireDraft, questionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(draft.answers, questionId);
}

function questionAllowsTextAnswer(question: NormalizedQuestion): boolean {
  return question.isOther || !question.options || question.options.length === 0;
}

function buildQuestionnaireSubmissionPayload(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): unknown {
  if (interaction.submission === "mcp_elicitation_form") {
    return {
      action: "accept",
      content: buildMcpElicitationFormContent(interaction, draft)
    };
  }

  return {
    answers: buildToolQuestionnaireAnswers(interaction, draft)
  };
}

function buildToolQuestionnaireAnswers(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of interaction.questions) {
    if (!hasDraftAnswer(draft, question.id)) {
      continue;
    }

    const value = toToolQuestionnaireAnswerArray(draft.answers[question.id]);
    if (!value) {
      continue;
    }

    answers[question.id] = { answers: value };
  }

  return answers;
}

function buildMcpElicitationFormContent(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const question of interaction.questions) {
    if (!hasDraftAnswer(draft, question.id)) {
      continue;
    }

    const value = toQuestionAnswerValue(question, draft.answers[question.id]);
    if (value === null || value === undefined) {
      continue;
    }

    content[question.id] = value;
  }

  return content;
}

type ParsedQuestionAnswer = { ok: true; value: unknown } | { ok: false; message: string };

function parseQuestionAnswerInput(
  question: NormalizedQuestion,
  rawInput: string,
  source: "option" | "text"
): ParsedQuestionAnswer {
  if (rawInput === SKIP_QUESTION_OPTION_VALUE) {
    if (question.required) {
      return { ok: false, message: "这个问题不能跳过。" };
    }
    return { ok: true, value: null };
  }

  switch (question.answerFormat) {
    case "number": {
      const trimmed = rawInput.trim();
      const value = Number(trimmed);
      if (!trimmed || !Number.isFinite(value)) {
        return { ok: false, message: "请输入有效数字。" };
      }
      return { ok: true, value };
    }

    case "integer": {
      const trimmed = rawInput.trim();
      if (!/^[-+]?\d+$/u.test(trimmed)) {
        return { ok: false, message: "请输入整数。" };
      }
      return { ok: true, value: Number(trimmed) };
    }

    case "boolean": {
      const parsed = parseBooleanLike(rawInput);
      if (parsed !== undefined) {
        return { ok: true, value: parsed };
      }

      const normalized = rawInput.trim().toLowerCase();
      if (normalized === "y" || normalized === "是") {
        return { ok: true, value: true };
      }
      if (normalized === "n" || normalized === "否") {
        return { ok: true, value: false };
      }
      return { ok: false, message: "请输入 true/false 或 是/否。" };
    }

    case "string_array": {
      const values = rawInput.split(/[,\uFF0C]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (values.length === 0) {
        return {
          ok: false,
          message: question.required ? "请至少输入一个值。" : "请先输入至少一个值，或点击跳过。"
        };
      }
      const invalid = question.allowedValues
        ? values.filter((entry) => !question.allowedValues?.includes(entry))
        : [];
      if (invalid.length > 0) {
        return {
          ok: false,
          message: buildAllowedValuesMessage(question.allowedValues)
        };
      }
      return { ok: true, value: values };
    }

    case "string":
    default: {
      if (source === "text" && rawInput.trim().length === 0) {
        return { ok: false, message: "回答不能为空。" };
      }
      if (question.allowedValues && !(source === "text" && question.isOther) && !question.allowedValues.includes(rawInput)) {
        return {
          ok: false,
          message: buildAllowedValuesMessage(question.allowedValues)
        };
      }
      return { ok: true, value: rawInput };
    }
  }
}

function buildAllowedValuesMessage(values: string[] | null): string {
  return values && values.length > 0
    ? `可用值：${values.join("、")}。`
    : "输入值不合法。";
}

function toToolQuestionnaireAnswerArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }

  const legacy = extractLegacyAnswerArray(value);
  return legacy && legacy.length > 0 ? legacy : null;
}

function toQuestionAnswerValue(question: NormalizedQuestion, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  switch (question.answerFormat) {
    case "number":
    case "integer":
      if (typeof value === "number") {
        return value;
      }
      break;

    case "boolean":
      if (typeof value === "boolean") {
        return value;
      }
      break;

    case "string_array":
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        return value;
      }
      break;

    case "string":
    default:
      if (typeof value === "string") {
        return value;
      }
      break;
  }

  const legacyAnswers = extractLegacyAnswerArray(value);
  if (legacyAnswers) {
    if (question.answerFormat === "string_array") {
      return legacyAnswers;
    }

    const parsed = parseQuestionAnswerInput(question, legacyAnswers[0] ?? "", "text");
    return parsed.ok ? parsed.value : null;
  }

  if (typeof value === "string") {
    const parsed = parseQuestionAnswerInput(question, value, "text");
    return parsed.ok ? parsed.value : null;
  }

  return null;
}

function extractLegacyAnswerArray(value: unknown): string[] | null {
  const record = asRecord(value);
  if (!Array.isArray(record?.answers)) {
    return null;
  }

  return getStringArray(record, "answers");
}

function buildInteractionDecisionResolution(
  interaction: NormalizedInteraction,
  decisionKey: string
): { payload: unknown } | null {
  switch (interaction.kind) {
    case "approval": {
      const option = interaction.decisionOptions.find((candidate) => candidate.key === decisionKey);
      return option ? { payload: option.payload } : null;
    }

    case "permissions":
      if (decisionKey === "accept") {
        return {
          payload: {
            permissions: interaction.requestedPermissions,
            scope: "turn"
          }
        };
      }
      if (decisionKey === "acceptForSession") {
        return {
          payload: {
            permissions: interaction.requestedPermissions,
            scope: "session"
          }
        };
      }
      if (decisionKey === "decline") {
        return {
          payload: {
            permissions: {},
            scope: "turn"
          }
        };
      }
      return null;

    case "elicitation":
      if (decisionKey === "accept" || decisionKey === "decline") {
        return {
          payload: {
            action: decisionKey
          }
        };
      }
      return null;

    case "questionnaire":
      return null;
  }
}

function resolveInteractionDecisionKey(
  interaction: NormalizedInteraction,
  parsed: Extract<ParsedCallbackData, { kind: "interaction_decision" }>
): string | null {
  if (parsed.decisionKey) {
    return parsed.decisionKey;
  }

  if (parsed.decisionIndex === null) {
    return null;
  }

  return getVisibleInteractionDecisionKeys(interaction)[parsed.decisionIndex] ?? null;
}

function getVisibleInteractionDecisionKeys(interaction: NormalizedInteraction): string[] {
  switch (interaction.kind) {
    case "approval":
      return buildApprovalActions(interaction).map((action) => action.decisionKey);
    case "permissions":
      return ["accept", "acceptForSession", "decline"];
    case "elicitation":
      return ["accept", "decline"];
    case "questionnaire":
      return [];
  }
}

function resolveInteractionQuestionId(
  interaction: NormalizedInteraction,
  parsed: Extract<ParsedCallbackData, { kind: "interaction_question" | "interaction_text" }>
): string | null {
  if (parsed.questionId) {
    return parsed.questionId;
  }

  if (interaction.kind !== "questionnaire" || parsed.questionIndex === null) {
    return null;
  }

  return interaction.questions[parsed.questionIndex]?.id ?? null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseJsonRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }

  return asRecord(value);
}

function serializeJsonRpcRequestId(id: JsonRpcRequestId): string {
  return JSON.stringify(id);
}

function deserializeJsonRpcRequestId(text: string): JsonRpcRequestId {
  try {
    const parsed = JSON.parse(text) as JsonRpcRequestId;
    if (typeof parsed === "number" || typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // Fall through to the raw string.
  }

  return text;
}

function buildPendingInteractionOnlyInspectSnapshot(
  pendingInteractions: PendingInteractionSummary[]
): InspectSnapshot {
  return {
    turnStatus: "blocked",
    threadRuntimeState: null,
    activeItemType: null,
    activeItemId: null,
    activeItemLabel: null,
    lastActivityAt: null,
    currentItemStartedAt: null,
    currentItemDurationSec: null,
    lastHighValueEventType: "blocked",
    lastHighValueTitle: "Blocked: waiting on interaction",
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
    agentSnapshot: [],
    completedCommentary: [],
    tokenUsage: null,
    latestDiffSummary: null,
    terminalInteractionSummary: null,
    pendingInteractions
  };
}

function cleanRuntimeErrorMessage(message: string | null | undefined): string {
  return normalizeAndTruncate(`${message ?? "unknown error"}`, 240) ?? "unknown error";
}

async function extractFinalAnswerFromHistory(
  appServer: CodexAppServerClient,
  threadId: string,
  turnId: string
): Promise<string | null> {
  const resumed = await appServer.resumeThread(threadId);
  const targetTurn = resumed.thread.turns.find((turn) => turn.id === turnId);
  if (!targetTurn) {
    return null;
  }

  const finalItem = targetTurn.items.find(
    (item) => item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string"
  );

  return finalItem?.text ?? null;
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

function shouldRetryInspectFromHistory(activeSession: SessionRow, snapshot: InspectSnapshot): boolean {
  if (!activeSession.threadId || !activeSession.lastTurnId) {
    return false;
  }

  return snapshot.turnStatus === "completed"
    || snapshot.turnStatus === "interrupted"
    || snapshot.turnStatus === "failed"
    || activeSession.status !== "running";
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

function buildInspectPlainTextFallback(html: string): string {
  const plainText = html
    .replace(/<\/?b>/gu, "")
    .replace(/<\/?i>/gu, "")
    .replace(/<br\s*\/?>/gu, "\n")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");

  return plainText.length <= INSPECT_PLAIN_TEXT_FALLBACK_LIMIT
    ? plainText
    : `${plainText.slice(0, INSPECT_PLAIN_TEXT_FALLBACK_LIMIT)}…`;
}

function parsePluginInstallTarget(value: string): { marketplaceName: string; pluginName: string } | null {
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  return {
    marketplaceName: trimmed.slice(0, slashIndex),
    pluginName: trimmed.slice(slashIndex + 1)
  };
}

function findFirstInstallablePlugin(
  result: Awaited<ReturnType<CodexAppServerClient["listPlugins"]>> | undefined
): { marketplaceName: string; pluginName: string } | null {
  if (!result) {
    return null;
  }

  for (const marketplace of result.marketplaces) {
    const plugin = marketplace.plugins.find((entry) => !entry.installed);
    if (plugin) {
      return {
        marketplaceName: marketplace.name,
        pluginName: plugin.name
      };
    }
  }

  return null;
}

function formatMcpAuthStatus(status: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth"): string {
  switch (status) {
    case "unsupported":
      return "不支持认证";
    case "notLoggedIn":
      return "未登录";
    case "bearerToken":
      return "Bearer Token";
    case "oAuth":
      return "OAuth";
    default:
      return status;
  }
}

function formatRateLimitSummary(rateLimits: {
  limitName: string | null;
  primary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  planType: string | null;
} | null): string | null {
  if (!rateLimits) {
    return null;
  }

  const parts: string[] = [];
  if (rateLimits.limitName) {
    parts.push(`额度：${rateLimits.limitName}`);
  }
  if (rateLimits.planType) {
    parts.push(`限额计划：${rateLimits.planType}`);
  }
  if (rateLimits.primary) {
    const window = rateLimits.primary.windowDurationMins ? `${rateLimits.primary.windowDurationMins} 分钟` : "当前窗口";
    parts.push(`主额度使用：${rateLimits.primary.usedPercent}%（${window}）`);
  }
  if (rateLimits.credits) {
    parts.push(
      rateLimits.credits.unlimited
        ? "Credits：无限"
        : `Credits：${rateLimits.credits.balance ?? (rateLimits.credits.hasCredits ? "可用" : "不可用")}`
    );
  }

  return parts.length > 0 ? parts.join("\n") : null;
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
