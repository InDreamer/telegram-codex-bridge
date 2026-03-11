import { createLogger, type Logger } from "./logger.js";
import { TurnDebugJournal, type DebugJournalWriter } from "./activity/debug-journal.js";
import { ensureBridgeDirectories, getBridgePaths, type BridgePaths } from "./paths.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { probeReadiness } from "./readiness.js";
import { BridgeStateStore } from "./state/store.js";
import {
  TelegramApi,
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
  buildSessionsText,
  buildStatusText,
  buildTurnStatusCard,
  buildUnsupportedCommandText,
  buildWhereText,
  parseCallbackData,
  parseCommand
} from "./telegram/ui.js";
import { buildHelpText, syncTelegramCommands } from "./telegram/commands.js";
import type { ProjectCandidate, ProjectPickerResult, ReadinessSnapshot, SessionRow } from "./types.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import { buildProjectPicker, refreshProjectPicker, validateManualProjectPath } from "./project/discovery.js";

interface PickerState {
  picker: ProjectPickerResult;
  awaitingManualProjectPath: boolean;
  resolved: boolean;
}

interface ActiveTurnState {
  sessionId: string;
  chatId: string;
  threadId: string;
  turnId: string;
  finalMessage: string | null;
  tracker: ActivityTracker;
  debugJournal: DebugJournalWriter;
  statusCard: {
    messageId: number;
    lastRenderedText: string;
    lastSentAt: number;
    editBlockedUntil: number | null;
  } | null;
  statusCardQueue: Promise<void>;
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
  private readonly recentActivityBySessionId = new Map<string, { tracker: ActivityTracker; debugFilePath: string | null }>();
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
          debugRootDir: this.paths.debugRuntimeDir,
          threadId,
          turnId: turn.turn.id
        }),
        statusCard: null,
        statusCardQueue: Promise.resolve()
      };
      this.recentActivityBySessionId.set(session.sessionId, {
        tracker: this.activeTurn.tracker,
        debugFilePath: this.activeTurn.debugJournal.filePath
      });
      this.store.updateSessionStatus(session.sessionId, "running", {
        lastTurnId: turn.turn.id,
        lastTurnStatus: turn.turn.status
      });
      await this.ensureStatusCard(this.activeTurn);
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

    if (method === "codex/event/task_complete") {
      const message = extractTaskCompleteFinalMessage(params);
      if (message) {
        activeTurn.finalMessage = message;
      }
    }

    activeTurn.tracker.apply(classified);
    const after = activeTurn.tracker.getStatus();
    await this.updateStatusCard(activeTurn, before, after);

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
      await this.sendFinalAnswer(activeTurn.chatId, finalMessage);
      return;
    }

    if (classified.status === "interrupted") {
      this.store.updateSessionStatus(activeTurn.sessionId, "interrupted", {
        lastTurnId: activeTurn.turnId,
        lastTurnStatus: "interrupted"
      });
      return;
    }

    this.store.updateSessionStatus(activeTurn.sessionId, "failed", {
      failureReason: "turn_failed",
      lastTurnId: activeTurn.turnId,
      lastTurnStatus: classified.status
    });
    await this.safeSendMessage(activeTurn.chatId, "这次操作未成功完成，请重试。");
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

    await this.safeSendMessage(chatId, buildInspectText(snapshot, { debugFilePath: activity.debugFilePath }));
  }

  private async handleAppServerExit(error: Error): Promise<void> {
    if (this.stopping || !this.store) {
      return;
    }

    await this.logger.warn("app-server exit observed", { error: `${error}` });

    if (this.activeTurn) {
      const runningTurn = this.activeTurn;
      this.activeTurn = null;
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

    for (const chunk of chunks) {
      await this.safeSendMessage(chatId, chunk);
    }
  }

  private async ensureStatusCard(activeTurn: ActiveTurnState): Promise<void> {
    await this.runStatusCardOperation(activeTurn, async () => {
      if (activeTurn.statusCard) {
        return;
      }

      const renderedText = buildTurnStatusCard(activeTurn.tracker.getStatus());
      const sent = await this.safeSendMessageResult(activeTurn.chatId, renderedText);
      if (!sent) {
        return;
      }

      activeTurn.statusCard = {
        messageId: sent.message_id,
        lastRenderedText: renderedText,
        lastSentAt: Date.now(),
        editBlockedUntil: null
      };
    });
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

  private async updateStatusCard(
    activeTurn: ActiveTurnState,
    previousStatus: ActivityStatus,
    nextStatus: ActivityStatus
  ): Promise<void> {
    await this.runStatusCardOperation(activeTurn, async () => {
      const renderedText = buildTurnStatusCard(nextStatus);

      if (!this.shouldUpdateStatusCard(activeTurn, previousStatus, nextStatus, renderedText)) {
        return;
      }

      if (!activeTurn.statusCard) {
        const sent = await this.safeSendMessageResult(activeTurn.chatId, renderedText);
        if (!sent) {
          return;
        }

        activeTurn.statusCard = {
          messageId: sent.message_id,
          lastRenderedText: renderedText,
          lastSentAt: Date.now(),
          editBlockedUntil: null
        };
        return;
      }

      const editResult = await this.safeEditMessageText(activeTurn.chatId, activeTurn.statusCard.messageId, renderedText);
      if (editResult.outcome === "edited") {
        activeTurn.statusCard.lastRenderedText = renderedText;
        activeTurn.statusCard.lastSentAt = Date.now();
        activeTurn.statusCard.editBlockedUntil = null;
        return;
      }

      if (editResult.outcome === "rate_limited") {
        activeTurn.statusCard.editBlockedUntil = Date.now() + editResult.retryAfterMs;
        return;
      }

      const fallback = await this.safeSendMessageResult(activeTurn.chatId, renderedText);
      if (!fallback) {
        return;
      }

      activeTurn.statusCard = {
        messageId: fallback.message_id,
        lastRenderedText: renderedText,
        lastSentAt: Date.now(),
        editBlockedUntil: null
      };
    });
  }

  private async runStatusCardOperation(activeTurn: ActiveTurnState, operation: () => Promise<void>): Promise<void> {
    const queuedOperation = activeTurn.statusCardQueue.then(operation, operation);
    activeTurn.statusCardQueue = queuedOperation.catch(() => {});
    await queuedOperation;
  }

  private shouldUpdateStatusCard(
    activeTurn: ActiveTurnState,
    previousStatus: ActivityStatus,
    nextStatus: ActivityStatus,
    renderedText: string
  ): boolean {
    if (!activeTurn.statusCard) {
      return true;
    }

    if (renderedText === activeTurn.statusCard.lastRenderedText) {
      return false;
    }

    if (
      activeTurn.statusCard.editBlockedUntil !== null &&
      Date.now() < activeTurn.statusCard.editBlockedUntil
    ) {
      return false;
    }

    if (
      previousStatus.turnStatus !== nextStatus.turnStatus ||
      previousStatus.threadBlockedReason !== nextStatus.threadBlockedReason ||
      previousStatus.lastHighValueEventType !== nextStatus.lastHighValueEventType ||
      previousStatus.lastHighValueTitle !== nextStatus.lastHighValueTitle ||
      previousStatus.lastHighValueDetail !== nextStatus.lastHighValueDetail
    ) {
      return true;
    }

    return false;
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
      return await this.api.sendMessage(chatId, text, replyMarkup ? { replyMarkup } : undefined);
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
      return { outcome: "edited" };
    } catch (error) {
      await this.logger.warn("telegram message edit failed", { chatId, messageId, error: `${error}` });
      const retryAfterMs = parseTelegramRetryAfterMs(error);
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

function extractTaskCompleteFinalMessage(params: unknown): string | null {
  if (!params || typeof params !== "object") {
    return null;
  }

  const msg = (params as { msg?: { last_agent_message?: unknown } }).msg;
  return typeof msg?.last_agent_message === "string" ? msg.last_agent_message : null;
}

function parseTelegramRetryAfterMs(error: unknown): number | null {
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

function extractTurnCompletion(params: unknown): { turnId: string; status: string } | null {
  if (!params || typeof params !== "object") {
    return null;
  }

  const turn = (params as { turn?: { id?: unknown; status?: unknown } }).turn;
  if (typeof turn?.id !== "string" || typeof turn.status !== "string") {
    return null;
  }

  return {
    turnId: turn.id,
    status: turn.status
  };
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
