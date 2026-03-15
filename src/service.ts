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
import { ActivityTracker } from "./activity/tracker.js";
import type { ActivityStatus, DebugJournalRecord, InspectSnapshot } from "./activity/types.js";
import { classifyNotification } from "./codex/notification-classifier.js";
import {
  buildArchiveSuccessText,
  buildCollapsibleFinalAnswerView,
  buildFinalAnswerReplyMarkup,
  buildInspectText,
  buildManualPathConfirmMessage,
  buildManualPathPrompt,
  buildNoNewProjectsMessage,
  buildProjectPinnedText,
  buildProjectPickerMessage,
  buildProjectSelectedText,
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
  renderFinalAnswerHtmlChunks,
  parseCallbackData,
  parseCommand,
  type RuntimeCommandEntryView
} from "./telegram/ui.js";
import { buildHelpText, syncTelegramCommands } from "./telegram/commands.js";
import type { ProjectCandidate, ProjectPickerResult, ReadinessSnapshot, SessionRow } from "./types.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import { buildProjectPicker, refreshProjectPicker, validateManualProjectPath } from "./project/discovery.js";

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

interface PickerState {
  picker: ProjectPickerResult;
  awaitingManualProjectPath: boolean;
  resolved: boolean;
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
  private readonly pendingRenameSessionIds = new Map<string, string>();
  private readonly pendingThreadArchiveOps = new Map<string, PendingThreadArchiveOp[]>();
  private readonly recentActivityBySessionId = new Map<string, RecentActivityEntry>();
  private activeTurn: ActiveTurnState | null = null;
  private nextPendingThreadArchiveOpId = 1;
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
    const recoveryNotices = this.store.markRunningSessionsFailedWithNotices("bridge_restart");
    const failedSessions = recoveryNotices.length;

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
    this.attachAppServerListeners();

    if (snapshot.state !== "ready" && snapshot.state !== "awaiting_authorization") {
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
        this.pendingRenameSessionIds.delete(chatId);
        await this.safeSendMessage(chatId, "已取消会话重命名。");
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

      case "plan_expand": {
        await this.handlePlanToggle(callbackQuery.id, message.message_id, parsed.sessionId, true);
        return;
      }

      case "plan_collapse": {
        await this.handlePlanToggle(callbackQuery.id, message.message_id, parsed.sessionId, false);
        return;
      }

      case "agent_expand": {
        await this.handleAgentToggle(callbackQuery.id, message.message_id, parsed.sessionId, true);
        return;
      }

      case "agent_collapse": {
        await this.handleAgentToggle(callbackQuery.id, message.message_id, parsed.sessionId, false);
        return;
      }

      case "final_open": {
        await this.handleFinalAnswerOpen(callbackQuery.id, chatId, message.message_id, parsed.answerId);
        return;
      }

      case "final_close": {
        await this.handleFinalAnswerClose(callbackQuery.id, chatId, message.message_id, parsed.answerId);
        return;
      }

      case "final_page": {
        await this.handleFinalAnswerPage(
          callbackQuery.id,
          chatId,
          message.message_id,
          parsed.answerId,
          parsed.page
        );
        return;
      }
    }
  }

  private async handlePlanToggle(
    callbackQueryId: string,
    messageId: number,
    sessionId: string,
    expanded: boolean
  ): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.sessionId !== sessionId || activeTurn.statusCard.messageId !== messageId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const inspect = activeTurn.tracker.getInspectSnapshot();
    if (inspect.planSnapshot.length === 0) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (activeTurn.statusCard.planExpanded === expanded) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个操作已处理。");
      return;
    }

    activeTurn.statusCard.planExpanded = expanded;
    await this.safeAnswerCallbackQuery(callbackQueryId);

    const rendered = this.buildStatusCardRenderPayload(activeTurn.sessionId, activeTurn.tracker, activeTurn.statusCard);
    await this.logRuntimeCardEvent(this.getRuntimeCardTraceContext(activeTurn), activeTurn.statusCard, "state_transition", {
      reason: expanded ? "plan_expanded" : "plan_collapsed",
      forced: true,
      triggerKind: "callback",
      triggerMethod: expanded ? "v1:plan:expand" : "v1:plan:collapse",
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
      reason: expanded ? "plan_expanded" : "plan_collapsed"
    });
  }

  private async handleAgentToggle(
    callbackQueryId: string,
    messageId: number,
    sessionId: string,
    expanded: boolean
  ): Promise<void> {
    const activeTurn = this.activeTurn;
    if (!activeTurn || activeTurn.sessionId !== sessionId || activeTurn.statusCard.messageId !== messageId) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const inspect = activeTurn.tracker.getInspectSnapshot();
    if (inspect.agentSnapshot.length === 0) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (activeTurn.statusCard.agentsExpanded === expanded) {
      await this.safeAnswerCallbackQuery(callbackQueryId, "这个操作已处理。");
      return;
    }

    activeTurn.statusCard.agentsExpanded = expanded;
    await this.safeAnswerCallbackQuery(callbackQueryId);

    const rendered = this.buildStatusCardRenderPayload(activeTurn.sessionId, activeTurn.tracker, activeTurn.statusCard);
    await this.logRuntimeCardEvent(this.getRuntimeCardTraceContext(activeTurn), activeTurn.statusCard, "state_transition", {
      reason: expanded ? "agents_expanded" : "agents_collapsed",
      forced: true,
      triggerKind: "callback",
      triggerMethod: expanded ? "v1:agent:expand" : "v1:agent:collapse",
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
      reason: expanded ? "agents_expanded" : "agents_collapsed"
    });
  }

  private async handleFinalAnswerOpen(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    answerId: string
  ): Promise<void> {
    await this.renderPersistedFinalAnswer(callbackQueryId, chatId, messageId, answerId, {
      expanded: true,
      page: 1
    });
  }

  private async handleFinalAnswerClose(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    answerId: string
  ): Promise<void> {
    await this.renderPersistedFinalAnswer(callbackQueryId, chatId, messageId, answerId, {
      expanded: false
    });
  }

  private async handleFinalAnswerPage(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    answerId: string,
    page: number
  ): Promise<void> {
    await this.renderPersistedFinalAnswer(callbackQueryId, chatId, messageId, answerId, {
      expanded: true,
      page
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
        await this.showProjectPicker(chatId);
        return;
      }

      case "cancel": {
        if (this.isAwaitingRename(chatId)) {
          this.pendingRenameSessionIds.delete(chatId);
          await this.safeSendMessage(chatId, "已取消会话重命名。");
          return;
        }

        if (this.isAwaitingManualProjectPath(chatId)) {
          await this.returnToProjectPicker(chatId);
          return;
        }

        await this.safeSendMessage(chatId, "当前没有可取消的路径输入。");
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

      default: {
        await this.safeSendMessage(chatId, buildUnsupportedCommandText());
      }
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
      await this.safeSendMessage(chatId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    if (!text) {
      await this.safeSendHtmlMessage(chatId, buildProjectSelectedText(activeSession.projectName));
      return;
    }

    await this.startRealTurn(chatId, activeSession, text);
  }

  private async showProjectPicker(chatId: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const picker = await buildProjectPicker(this.paths.homeDir, this.store);
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
      projectPath: candidate.projectPath
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    await this.safeSendHtmlMessage(chatId, buildProjectSelectedText(candidate.projectName));
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

    await this.safeSendMessage(chatId, "正在扫描更多项目，请稍候…");
    const previousKeys = new Set([...pickerState.picker.projectMap.keys()]);
    const refreshed = await refreshProjectPicker(this.paths.homeDir, this.store, previousKeys);

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
    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const candidate = await validateManualProjectPath(text, this.paths.homeDir);
    if (!candidate) {
      await this.safeSendMessage(
        chatId,
        "这个路径不可用，请重新发送项目路径。\n也可以发送 /cancel 返回项目列表。"
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
      projectPath: candidate.projectPath
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    await this.safeSendHtmlMessage(chatId, buildProjectSelectedText(candidate.projectName));
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
    return this.pendingRenameSessionIds.has(chatId);
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
    await this.safeSendHtmlMessage(chatId, buildSessionSwitchedText(target.projectName));
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
          activeSession.projectName,
          nextActiveSession
            ? {
                displayName: nextActiveSession.displayName,
                projectName: nextActiveSession.projectName
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
      await this.safeSendHtmlMessage(chatId, buildUnarchiveSuccessText(target.projectName));
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
      this.pendingRenameSessionIds.set(chatId, activeSession.sessionId);
      await this.safeSendMessage(chatId, "请输入新的会话名称。\n发送 /cancel 取消。");
      return;
    }

    this.store.renameSession(activeSession.sessionId, name);
    this.pendingRenameSessionIds.delete(chatId);
    await this.safeSendHtmlMessage(chatId, buildSessionRenamedText(name));
  }

  private async handleRenameInput(chatId: string, text: string): Promise<void> {
    if (!this.store) {
      return;
    }

    const sessionId = this.pendingRenameSessionIds.get(chatId);
    if (!sessionId) {
      return;
    }

    const name = text.trim();
    if (!name) {
      await this.safeSendMessage(chatId, "请输入新的会话名称。\n发送 /cancel 取消。");
      return;
    }

    const session = this.store.getSessionById(sessionId);
    if (!session) {
      this.pendingRenameSessionIds.delete(chatId);
      await this.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    this.store.renameSession(sessionId, name);
    this.pendingRenameSessionIds.delete(chatId);
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
    await this.safeSendHtmlMessage(chatId, buildProjectPinnedText(activeSession.projectName));
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

  private async startRealTurn(chatId: string, session: SessionRow, text: string): Promise<void> {
    if (!this.store) {
      return;
    }

    try {
      await this.ensureAppServerAvailable();
      const threadId = await this.ensureSessionThread(session);
      const turn = await this.appServer?.startTurn({
        threadId,
        cwd: session.projectPath,
        text
      });

      if (!turn) {
        throw new Error("turn start returned no result");
      }

      this.activeTurn = {
        sessionId: session.sessionId,
        chatId,
        threadId,
        turnId: turn.turn.id,
        finalMessage: null,
        tracker: new ActivityTracker({
          threadId,
          turnId: turn.turn.id
        }),
        debugJournal: new TurnDebugJournal({
          debugRootDir: getDebugRuntimeDir(this.paths.runtimeDir),
          threadId,
          turnId: turn.turn.id
        }),
        statusCard: createStatusCardMessageState(),
        latestStatusProgressText: null,
        latestPlanFingerprint: "",
        latestAgentFingerprint: "",
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
        lastTurnId: turn.turn.id,
        lastTurnStatus: turn.turn.status
      });
      await this.syncRuntimeCards(this.activeTurn, null, null, this.activeTurn.tracker.getStatus(), {
        force: true,
        reason: "turn_initialized"
      });
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

  private async ensureSessionThread(session: SessionRow): Promise<string> {
    if (!this.store) {
      throw new Error("state store unavailable");
    }

    if (!this.appServer) {
      throw new Error("app-server unavailable");
    }

    if (!session.threadId) {
      const started = await this.appServer.startThread(session.projectPath);
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

    this.appServer.onExit((error) => {
      void this.handleAppServerExit(error);
    });
  }

  private async handleAppServerNotification(method: string, params: unknown): Promise<void> {
    const classified = classifyNotification(method, params);

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

    const inspectHtml = buildInspectText(payload.snapshot, {
      sessionName: activeSession.displayName,
      projectName: activeSession.projectName,
      commands: payload.commands,
      note: payload.note
    });

    // Keep `/inspect` usable even when Telegram rejects the richer HTML rendering.
    if (!await this.safeSendHtmlMessage(chatId, inspectHtml)) {
      await this.safeSendMessage(chatId, buildInspectPlainTextFallback(inspectHtml));
    }
  }

  private async getInspectRenderPayload(activeSession: SessionRow): Promise<InspectRenderPayload | null> {
    const activity = this.activeTurn?.sessionId === activeSession.sessionId
      ? {
          tracker: this.activeTurn.tracker,
          debugFilePath: this.activeTurn.debugJournal.filePath,
          statusCard: this.activeTurn.statusCard
        }
      : this.recentActivityBySessionId.get(activeSession.sessionId);

    if (activity) {
      const snapshot = activity.tracker.getInspectSnapshot();
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

    return await this.buildHistoricalInspectRenderPayload(activeSession);
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
      const targetTurn = turns.find((turn) => getString(turn, "id") === activeSession.lastTurnId)
        ?? turns.at(-1);
      if (!targetTurn) {
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
      state: formatVisibleRuntimeState(inspect),
      blockedReason: formatRuntimeBlockedReason(inspect.threadBlockedReason),
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
        this.bootstrapLogger
      );
      await client.initializeAndProbe();
      this.appServer = client;
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
      this.bootstrapLogger
    );
    await client.initializeAndProbe();
    this.appServer = client;
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
    const inspect = activeTurn.tracker.getInspectSnapshot();
    const context = this.getRuntimeCardContext(activeTurn.sessionId);
    const planFingerprint = inspect.planSnapshot.join("\n");
    const planChanged = planFingerprint !== activeTurn.latestPlanFingerprint;
    if (planChanged) {
      activeTurn.latestPlanFingerprint = planFingerprint;
    }
    const agentFingerprint = inspect.agentSnapshot
      .map((agent) => `${agent.threadId}|${agent.status}|${agent.progress ?? ""}`)
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
      projectName: session.projectName ?? null
    };
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
    if (!this.api) {
      return null;
    }

    try {
      const sent = await this.api.sendMessage(chatId, text, replyMarkup ? { replyMarkup } : undefined);
      await this.logger.info("telegram message sent", {
        chatId,
        messageId: sent.message_id,
        replyMarkup: replyMarkup ? "inline_keyboard" : null,
        preview: summarizeTextPreview(text)
      });
      return sent;
    } catch (error) {
      await this.logger.error("telegram message delivery failed", { chatId, error: `${error}` });
      return null;
    }
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
    if (!this.api) {
      return null;
    }

    try {
      const sent = await this.api.sendMessage(
        chatId,
        html,
        replyMarkup
          ? { parseMode: "HTML", replyMarkup }
          : { parseMode: "HTML" }
      );
      await this.logger.info("telegram html message sent", {
        chatId,
        messageId: sent.message_id,
        replyMarkup: replyMarkup ? "inline_keyboard" : null,
        preview: summarizeTextPreview(html)
      });
      return sent;
    } catch (error) {
      await this.logger.error("telegram HTML message delivery failed", { chatId, error: `${error}` });
      return null;
    }
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
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
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
  const turnRecord = getRecord(turn);
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
    const itemRecord = getRecord(item);
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
            const changeRecord = getRecord(change);
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
        const resultSummary = summarizeHistoryToolResult(getRecord(itemRecord?.result));
        const errorSummary = getString(getRecord(itemRecord?.error), "message");
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
          ?? getString(getRecord(itemRecord?.action), "query")
          ?? getString(getRecord(itemRecord?.action), "url")
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
    planSnapshot,
    agentSnapshot: [],
    completedCommentary
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

function cleanRuntimeErrorMessage(message: string | null | undefined): string {
  const normalized = `${message ?? "unknown error"}`.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, 240) : "unknown error";
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
  if (!value) {
    return null;
  }

  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  return normalized.length <= HISTORY_TEXT_LIMIT
    ? normalized
    : `${normalized.slice(0, HISTORY_TEXT_LIMIT)}…`;
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

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getString(value: unknown, key: string): string | null {
  const record = getRecord(value);
  const candidate = record?.[key];
  return typeof candidate === "string" ? candidate : null;
}

function getNumber(value: unknown, key: string): number | null {
  const record = getRecord(value);
  const candidate = record?.[key];
  return typeof candidate === "number" ? candidate : null;
}

function getArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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
