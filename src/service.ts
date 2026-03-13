import { createLogger, type Logger } from "./logger.js";
import { TurnDebugJournal, type DebugJournalWriter } from "./activity/debug-journal.js";
import { ensureBridgeDirectories, getBridgePaths, getDebugRuntimeDir, type BridgePaths } from "./paths.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { probeReadiness } from "./readiness.js";
import { BridgeStateStore } from "./state/store.js";
import { TelegramApi, TelegramApiError,
  type TelegramCallbackQuery,
  type TelegramInlineKeyboardMarkup,
  type TelegramMessage,
  type TelegramUpdate
} from "./telegram/api.js";
import { TelegramPoller } from "./telegram/poller.js";
import { ActivityTracker } from "./activity/tracker.js";
import type { ActivityStatus, DebugJournalRecord } from "./activity/types.js";
import { classifyNotification } from "./codex/notification-classifier.js";
import {
  buildInspectText,
  buildManualPathConfirmMessage,
  buildManualPathPrompt,
  buildNoNewProjectsMessage,
  buildProjectPickerMessage,
  buildProjectSelectedText,
  buildRuntimeCommandCard,
  buildRuntimeErrorCard,
  buildRuntimePlanCard,
  buildRuntimeStatusCard,
  buildSessionsText,
  buildStatusText,
  buildUnsupportedCommandText,
  buildWhereText,
  parseCallbackData,
  parseCommand
} from "./telegram/ui.js";
import { buildHelpText, syncTelegramCommands } from "./telegram/commands.js";
import type { ProjectCandidate, ProjectPickerResult, ReadinessSnapshot, SessionRow } from "./types.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import { buildProjectPicker, refreshProjectPicker, validateManualProjectPath } from "./project/discovery.js";

interface RecentActivityEntry {
  tracker: ActivityTracker;
  debugFilePath: string | null;
}

const MAX_RECENT_ACTIVITY_ENTRIES = 20;
const RUNTIME_CARD_THROTTLE_MS = 2000;
const FAILED_EDIT_RETRY_MS = 5000;

interface PickerState {
  picker: ProjectPickerResult;
  awaitingManualProjectPath: boolean;
  resolved: boolean;
}

interface RuntimeCardMessageState {
  surface: "status" | "plan" | "command" | "error";
  key: string;
  messageId: number;
  lastRenderedText: string;
  lastRenderedAtMs: number | null;
  pendingText: string | null;
  pendingReason: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface CommandCardState extends RuntimeCardMessageState {
  itemId: string;
  commandName: string;
  latestSummary: string | null;
  status: "running" | "completed" | "failed" | "interrupted";
}

interface ErrorCardState extends RuntimeCardMessageState {
  title: string;
  detail: string | null;
}

interface ActiveTurnState {
  sessionId: string;
  chatId: string;
  threadId: string;
  turnId: string;
  finalMessage: string | null;
  tracker: ActivityTracker;
  debugJournal: DebugJournalWriter;
  statusCard: RuntimeCardMessageState;
  planCard: RuntimeCardMessageState | null;
  latestProgressUnit: string | null;
  latestPlanFingerprint: string | null;
  commandCards: Map<string, CommandCardState>;
  errorCards: ErrorCardState[];
  nextErrorCardId: number;
  surfaceQueue: Promise<void>;
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
  private poller: TelegramPoller | null = null;
  private api: TelegramApi | null = null;
  private store: BridgeStateStore | null = null;
  private snapshot: ReadinessSnapshot | null = null;
  private appServer: CodexAppServerClient | null = null;
  private readonly unauthorizedReplyAt = new Map<string, number>();
  private readonly pickerStates = new Map<string, PickerState>();
  private readonly pendingRenameSessionIds = new Map<string, string>();
  private readonly recentActivityBySessionId = new Map<string, RecentActivityEntry>();
  private activeTurn: ActiveTurnState | null = null;
  private stopping = false;

  constructor(
    private readonly paths: BridgePaths,
    private readonly config: BridgeConfig
  ) {
    this.logger = createLogger("bridge", paths.bridgeLogPath);
    this.bootstrapLogger = createLogger("bootstrap", paths.bootstrapLogPath);
  }

  async run(): Promise<void> {
    this.store = await BridgeStateStore.open(this.paths, this.bootstrapLogger);
    const recovered = this.store.recoveredFromCorruption;
    const recoveryNotices = this.store.markRunningSessionsFailedWithNotices("bridge_restart");
    const failedSessions = recoveryNotices.length;

    if (failedSessions > 0 || recovered) {
      await this.bootstrapLogger.warn("startup recovery applied", { failedSessions, recovered });
    }

    const { snapshot, appServer } = await probeReadiness({
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

    if (snapshot.state === "telegram_token_invalid") {
      throw new Error("telegram token invalid; service will not enter run loop");
    }

    this.api = new TelegramApi(this.config.telegramBotToken, this.config.telegramApiBaseUrl);
    this.poller = new TelegramPoller(
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
        if (!this.store) {
          return;
        }

        await this.safeSendMessage(chatId, buildSessionsText(this.store.listSessions(chatId)));
        return;
      }

      case "where": {
        if (!this.store) {
          return;
        }

        await this.safeSendMessage(chatId, buildWhereText(this.store.getActiveSession(chatId)));
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
      await this.safeSendMessage(chatId, buildProjectSelectedText(activeSession.projectName));
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
    await this.safeSendMessage(chatId, buildProjectSelectedText(candidate.projectName));
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
    await this.safeSendMessage(chatId, confirmation.text, confirmation.replyMarkup);
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
    await this.safeSendMessage(chatId, buildProjectSelectedText(candidate.projectName));
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
    await this.safeSendMessage(
      chatId,
      snapshot ? buildStatusText(snapshot, activeSession) : "桥接状态未知，请在本机运行 ctb doctor。"
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
    await this.safeSendMessage(chatId, `已切换到项目：${target.projectName}`);
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
    await this.safeSendMessage(chatId, `当前会话已重命名为：${name}`);
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
    await this.safeSendMessage(chatId, `当前会话已重命名为：${name}`);
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
    await this.safeSendMessage(chatId, `已收藏项目：${activeSession.projectName}`);
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
        statusCard: createRuntimeCardMessageState("status", "status"),
        planCard: null,
        latestProgressUnit: null,
        latestPlanFingerprint: null,
        commandCards: new Map(),
        errorCards: [],
        nextErrorCardId: 1,
        surfaceQueue: Promise.resolve()
      };
      const recentActivity: RecentActivityEntry = {
        tracker: this.activeTurn.tracker,
        debugFilePath: this.activeTurn.debugJournal.filePath
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
    if (!this.activeTurn) {
      return;
    }

    const activeTurn = this.activeTurn;
    await this.appendDebugJournal(activeTurn, method, params);
    const before = activeTurn.tracker.getStatus();
    const classified = classifyNotification(method, params);

    if (classified.kind === "final_message_available" && classified.message) {
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
      await this.sendFinalAnswer(activeTurn.chatId, finalMessage);
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

    const activity = this.activeTurn?.sessionId === activeSession.sessionId
      ? {
          tracker: this.activeTurn.tracker,
          debugFilePath: this.activeTurn.debugJournal.filePath
        }
      : this.recentActivityBySessionId.get(activeSession.sessionId);

    if (!activity) {
      await this.safeSendMessage(chatId, "当前没有可用的活动详情。");
      return;
    }

    const snapshot = activity.tracker.getInspectSnapshot();
    if (!snapshot.inspectAvailable && snapshot.turnStatus === "starting") {
      await this.safeSendMessage(chatId, "当前没有可用的活动详情。");
      return;
    }

    await this.safeSendMessage(
      chatId,
      buildInspectText(snapshot, {
        debugFilePath: activity.debugFilePath,
        sessionName: activeSession.displayName,
        projectName: activeSession.projectName
      })
    );
  }

  private async handleAppServerExit(error: Error): Promise<void> {
    if (this.stopping || !this.store) {
      return;
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

  private async sendFinalAnswer(chatId: string, finalMessage: string | null): Promise<void> {
    const text = finalMessage || "本次操作已完成，但没有可返回的最终答复。";
    const chunks = chunkFinalAnswer(text, 3000);
    await this.logger.info("sending final answer", {
      chatId,
      chunkCount: chunks.length,
      hasFinalMessage: finalMessage !== null,
      preview: summarizeTextPreview(text)
    });

    for (const chunk of chunks) {
      await this.safeSendMessage(chatId, chunk);
    }
  }

  private async appendDebugJournal(activeTurn: ActiveTurnState, method: string, params: unknown): Promise<void> {
    const record: DebugJournalRecord = {
      receivedAt: new Date().toISOString(),
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
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

    const latestProgressUnit = inspect.commentarySnippets.at(-1) ?? null;
    const progressUnitChanged = latestProgressUnit !== activeTurn.latestProgressUnit;
    if (progressUnitChanged) {
      activeTurn.latestProgressUnit = latestProgressUnit;
    }

    const statusChanged = previousStatus === null ||
      previousStatus.turnStatus !== nextStatus.turnStatus ||
      previousStatus.threadBlockedReason !== nextStatus.threadBlockedReason ||
      progressUnitChanged ||
      options.force;
    if (statusChanged) {
      await this.requestRuntimeCardRender(
        activeTurn,
        activeTurn.statusCard,
        buildRuntimeStatusCard({
          ...context,
          state: formatVisibleRuntimeState(nextStatus),
          blockedReason: formatRuntimeBlockedReason(nextStatus.threadBlockedReason),
          progressText: selectStatusProgressText(nextStatus, activeTurn.latestProgressUnit)
        }),
        options.force
          ? { force: true, reason: options.reason }
          : { reason: options.reason }
      );
    }

    const planFingerprint = inspect.planSnapshot.join("\n");
    if (inspect.planSnapshot.length > 0) {
      if (!activeTurn.planCard) {
        activeTurn.planCard = createRuntimeCardMessageState("plan", "plan");
      }
      const planChanged = planFingerprint !== activeTurn.latestPlanFingerprint;
      if (planChanged) {
        activeTurn.latestPlanFingerprint = planFingerprint;
      }
      if (planChanged || options.force) {
        await this.requestRuntimeCardRender(
          activeTurn,
          activeTurn.planCard,
          buildRuntimePlanCard(context, inspect.planSnapshot),
          options.force
            ? { force: true, reason: planChanged ? "plan_changed" : options.reason }
            : { reason: planChanged ? "plan_changed" : options.reason }
        );
      }
    }

    if (classified?.kind === "item_started" && classified.itemType === "commandExecution" && classified.itemId) {
      const commandCard = this.getOrCreateCommandCard(activeTurn, classified.itemId, classified.label ?? "command");
      commandCard.commandName = normalizeCommandName(classified.label ?? commandCard.commandName);
      commandCard.status = "running";
      await this.requestRuntimeCardRender(
        activeTurn,
        commandCard,
        buildRuntimeCommandCard({
          ...context,
          commandName: commandCard.commandName,
          state: formatRuntimeCommandState(commandCard.status),
          latestSummary: commandCard.latestSummary
        }),
        {
          force: true,
          reason: "command_started"
        }
      );
    }

    if (classified?.kind === "command_output" && classified.itemId) {
      const parsed = summarizeRuntimeCommandOutput(classified.text);
      const commandCard = this.getOrCreateCommandCard(activeTurn, classified.itemId, parsed.command);
      commandCard.commandName = normalizeCommandName(
        commandCard.commandName === "command" ? parsed.command : commandCard.commandName
      );
      commandCard.latestSummary = parsed.detail;
      await this.requestRuntimeCardRender(
        activeTurn,
        commandCard,
        buildRuntimeCommandCard({
          ...context,
          commandName: commandCard.commandName,
          state: formatRuntimeCommandState(commandCard.status),
          latestSummary: commandCard.latestSummary
        }),
        {
          force: false,
          reason: "command_output"
        }
      );
    }

    if (classified?.kind === "item_completed" && classified.itemType === "commandExecution" && classified.itemId) {
      const commandCard = activeTurn.commandCards.get(classified.itemId);
      if (commandCard) {
        commandCard.status = nextStatus.turnStatus === "interrupted" ? "interrupted" : "completed";
        await this.requestRuntimeCardRender(
          activeTurn,
          commandCard,
          buildRuntimeCommandCard({
            ...context,
            commandName: commandCard.commandName,
            state: formatRuntimeCommandState(commandCard.status),
            latestSummary: commandCard.latestSummary
          }),
          {
            force: true,
            reason: "command_completed"
          }
        );
      }
    }

    if (classified?.kind === "error") {
      const errorCard = createRuntimeCardMessageState("error", `error-${activeTurn.nextErrorCardId++}`) as ErrorCardState;
      errorCard.title = "Runtime error";
      errorCard.detail = cleanRuntimeErrorMessage(classified.message);
      activeTurn.errorCards.push(errorCard);
      await this.requestRuntimeCardRender(
        activeTurn,
        errorCard,
        buildRuntimeErrorCard({
          ...context,
          title: errorCard.title,
          detail: errorCard.detail
        }),
        {
          force: true,
          reason: "runtime_error"
        }
      );
    }

    if (classified?.kind === "turn_completed") {
      for (const commandCard of activeTurn.commandCards.values()) {
        if (commandCard.status !== "running") {
          continue;
        }
        commandCard.status = classified.status === "interrupted"
          ? "interrupted"
          : classified.status === "completed"
            ? "completed"
            : "failed";
        await this.requestRuntimeCardRender(
          activeTurn,
          commandCard,
          buildRuntimeCommandCard({
            ...context,
            commandName: commandCard.commandName,
            state: formatRuntimeCommandState(commandCard.status),
            latestSummary: commandCard.latestSummary
          }),
          {
            force: true,
            reason: "turn_completed"
          }
        );
      }

      if (classified.status === "failed" && activeTurn.errorCards.length === 0) {
        const errorCard = createRuntimeCardMessageState("error", `error-${activeTurn.nextErrorCardId++}`) as ErrorCardState;
        errorCard.title = "Turn failed";
        errorCard.detail = "This operation did not complete successfully.";
        activeTurn.errorCards.push(errorCard);
        await this.requestRuntimeCardRender(
          activeTurn,
          errorCard,
          buildRuntimeErrorCard({
            ...context,
            title: errorCard.title,
            detail: errorCard.detail
          }),
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
    options: {
      force?: boolean;
      reason: string;
    }
  ): Promise<void> {
    const pendingChanged = surface.pendingText !== text;
    surface.pendingText = text;
    surface.pendingReason = options.reason;

    if (!pendingChanged && text === surface.lastRenderedText) {
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
    const remainingMs = options.force || lastRenderedAtMs === null
      ? 0
      : Math.max(0, lastRenderedAtMs + throttleMs - now);

    if (remainingMs > 0) {
      this.scheduleRuntimeCardRetry(activeTurn, surface, remainingMs, options.reason);
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
    this.clearRuntimeCardTimer(surface);
    surface.timer = setTimeout(() => {
      surface.timer = null;
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
      const text = surface.pendingText;
      const reason = surface.pendingReason;
      if (!text) {
        return;
      }

      if (text === surface.lastRenderedText) {
        surface.pendingText = null;
        surface.pendingReason = null;
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
      surface.pendingReason = null;

      if (surface.messageId === 0) {
        const sent = await this.safeSendMessageResult(activeTurn.chatId, text);
        if (!sent) {
          surface.pendingText = text;
          surface.pendingReason = reason;
          return;
        }
        surface.messageId = sent.message_id;
        surface.lastRenderedText = text;
        surface.lastRenderedAtMs = Date.now();
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

      const editResult = await this.safeEditMessageText(activeTurn.chatId, surface.messageId, text);
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
        surface.lastRenderedAtMs = Date.now();
        return;
      }

      surface.pendingText = text;
      surface.pendingReason = reason;
      const retryMs = editResult.outcome === "rate_limited" ? editResult.retryAfterMs : FAILED_EDIT_RETRY_MS;
      this.scheduleRuntimeCardRetry(activeTurn, surface, retryMs, reason ?? "edit_retry");
    });
  }

  private async runRuntimeCardOperation(activeTurn: ActiveTurnState, operation: () => Promise<void>): Promise<void> {
    const queuedOperation = activeTurn.surfaceQueue.then(operation, operation);
    activeTurn.surfaceQueue = queuedOperation.catch(() => {});
    await queuedOperation;
  }

  private getOrCreateCommandCard(
    activeTurn: ActiveTurnState,
    itemId: string,
    label: string
  ): CommandCardState {
    const existing = activeTurn.commandCards.get(itemId);
    if (existing) {
      return existing;
    }

    const created = createRuntimeCardMessageState("command", `command-${itemId}`) as CommandCardState;
    created.itemId = itemId;
    created.commandName = normalizeCommandName(label);
    created.latestSummary = null;
    created.status = "running";
    activeTurn.commandCards.set(itemId, created);
    return created;
  }

  private clearRuntimeCardTimer(surface: RuntimeCardMessageState): void {
    if (!surface.timer) {
      return;
    }

    clearTimeout(surface.timer);
    surface.timer = null;
  }

  private disposeRuntimeCards(activeTurn: ActiveTurnState): void {
    this.clearRuntimeCardTimer(activeTurn.statusCard);
    if (activeTurn.planCard) {
      this.clearRuntimeCardTimer(activeTurn.planCard);
    }

    for (const commandCard of activeTurn.commandCards.values()) {
      this.clearRuntimeCardTimer(commandCard);
    }

    for (const errorCard of activeTurn.errorCards) {
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

  private async safeEditMessageText(chatId: string, messageId: number, text: string): Promise<TelegramEditResult> {
    if (!this.api?.editMessageText) {
      return { outcome: "failed" };
    }

    try {
      await this.api.editMessageText(chatId, messageId, text);
      await this.logger.info("telegram message edited", {
        chatId,
        messageId,
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
    html: string
  ): Promise<TelegramMessage | null> {
    if (!this.api) {
      return null;
    }

    try {
      const sent = await this.api.sendMessage(chatId, html, { parseMode: "HTML" });
      await this.logger.info("telegram html message sent", {
        chatId,
        messageId: sent.message_id,
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
    html: string
  ): Promise<TelegramEditResult> {
    if (!this.api?.editMessageText) {
      return { outcome: "failed" };
    }

    try {
      await this.api.editMessageText(chatId, messageId, html, { parseMode: "HTML" });
      await this.logger.info("telegram html message edited", {
        chatId,
        messageId,
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
    activeItemType: status.activeItemType,
    activeItemLabel: status.activeItemLabel,
    latestProgress: status.latestProgress,
    recentStatusUpdates: status.recentStatusUpdates,
    blockedReason: status.threadBlockedReason,
    finalMessageAvailable: status.finalMessageAvailable
  };
}

function summarizeTextPreview(text: string, limit = 160): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}...`;
}

function createRuntimeCardMessageState(
  surface: RuntimeCardMessageState["surface"],
  key: string
): RuntimeCardMessageState {
  return {
    surface,
    key,
    messageId: 0,
    lastRenderedText: "",
    lastRenderedAtMs: null,
    pendingText: null,
    pendingReason: null,
    timer: null
  };
}

function getRuntimeCardThrottleMs(_surface: RuntimeCardMessageState["surface"]): number {
  return RUNTIME_CARD_THROTTLE_MS;
}

function formatVisibleRuntimeState(status: ActivityStatus): string {
  if (status.latestProgress && /^Reconnecting/i.test(status.latestProgress)) {
    return "Reconnecting";
  }

  switch (status.turnStatus) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
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

  if (status.lastHighValueEventType === "found" && status.lastHighValueDetail) {
    return status.lastHighValueDetail;
  }

  return null;
}

function normalizeCommandName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "command";
}

function summarizeRuntimeCommandOutput(text: string | null): { command: string; detail: string | null } {
  if (!text) {
    return {
      command: "command",
      detail: null
    };
  }

  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return {
      command: "command",
      detail: null
    };
  }

  const command = normalizeCommandName(lines[0]!.replace(/^[>$#]\s*/u, ""));
  const detailCandidate = lines.at(-1) ?? null;
  const detail = detailCandidate && detailCandidate !== lines[0]
    ? cleanRuntimeErrorMessage(detailCandidate)
    : null;

  return {
    command,
    detail
  };
}

function formatRuntimeCommandState(status: CommandCardState["status"]): string {
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

function chunkFinalAnswer(text: string, maxChars: number): string[] {
  const codePoints = [...text];
  if (codePoints.length <= maxChars) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += maxChars) {
    chunks.push(codePoints.slice(index, index + maxChars).join(""));
  }

  return chunks.map((chunk, index) => {
    if (index === 0) {
      return chunk;
    }

    return `(${index + 1}/${chunks.length}) ${chunk}`;
  });
}
