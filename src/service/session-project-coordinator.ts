import { basename, relative, sep } from "node:path";

import type { BridgeConfig } from "../config.js";
import type { BridgeCommandActionView } from "../core/interaction-model/bridge-actions.js";
import { buildFeishuStatusReplyMarkup, buildFeishuStatusText } from "../feishu/ui.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { buildProjectPicker, validateManualProjectPath } from "../project/discovery.js";
import type { EgressMessageSendResult } from "../packs/contract.js";
import {
  isTelegramDeleteCommitted,
  isTelegramEditCommitted,
  type EgressDeleteResult,
  type EgressEditResult
} from "./runtime-surface-state.js";
import type { BridgeStateStore } from "../state/store.js";
import {
  buildArchiveAllSuccessText,
  buildArchiveSuccessText,
  buildManualPathConfirmMessage,
  buildManualPathPrompt,
  buildNoNewProjectsMessage,
  buildProjectBrowseRootPickerMessage,
  buildProjectAliasClearedText,
  buildProjectAliasRenamedText,
  buildProjectPickerMessage,
  buildProjectPinnedText,
  buildRenameTargetPicker,
  buildResumeThreadListMessage,
  buildSessionCreatedText,
  buildSessionRenamedText,
  buildSessionResumedText,
  buildSessionsText,
  buildSessionSwitchedText,
  buildStatusText,
  buildUnarchiveSuccessText,
  buildWhereText,
  buildBridgeCommandReplyMarkup
} from "../telegram/ui.js";
import type {
  ReasoningEffort,
  ProjectPickerResult,
  ReadinessSnapshot,
  SessionRow,
  UiLanguage
} from "../types.js";
import type { TelegramInlineKeyboardMarkup } from "../telegram/api.js";

interface PickerState {
  picker: ProjectPickerResult;
  browseRoots: string[];
  inBrowseRootPicker: boolean;
  awaitingManualProjectPath: boolean;
  resolved: boolean;
  interactiveMessageId: number | null;
}

interface PendingRenameState {
  kind: "session" | "project";
  sessionId: string;
  projectPath: string;
  sourceMessageId: number | null;
}

interface SessionProjectArchiveAppServer {
  archiveThread(threadId: string): Promise<void>;
  unarchiveThread(threadId: string): Promise<void>;
  listThreads(options?: {
    archived?: boolean;
    cursor?: string;
    cwd?: string;
    limit?: number;
    sortKey?: "created_at" | "updated_at";
  }): Promise<{
    data: Array<{
      id: string;
      name?: string | null;
      cwd: string;
      preview?: string;
      updatedAt: number | string;
      createdAt: number | string;
      status: unknown;
    }>;
    nextCursor?: string | null;
  }>;
  resumeThread(threadId: string): Promise<{
    model?: string | null;
    reasoningEffort?: ReasoningEffort | null;
    thread: {
      id: string;
      name?: string | null;
      preview?: string;
      turns: Array<{
        id: string;
        status?: string | null;
      }>;
    };
  }>;
}

interface SessionProjectCoordinatorDeps {
  logger: Pick<Logger, "warn">;
  paths: Pick<BridgePaths, "homeDir">;
  config: Pick<BridgeConfig, "projectScanRoots">;
  activePack: BridgeConfig["activePack"];
  preferBridgeCommandButtons: boolean;
  getStore: () => BridgeStateStore | null;
  getSnapshot: () => ReadinessSnapshot | null;
  getUiLanguage: () => UiLanguage;
  ensureAppServerAvailable: () => Promise<SessionProjectArchiveAppServer>;
  registerPendingThreadArchiveOp: (
    threadId: string,
    sessionId: string,
    expectedRemoteState: "archived" | "unarchived",
    origin: "telegram_archive" | "telegram_unarchive"
  ) => number;
  markPendingThreadArchiveCommit: (threadId: string, opId: number | null) => Promise<void>;
  dropPendingThreadArchiveOp: (threadId: string, opId: number | null) => void;
  safeSendMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendMessageResult: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<EgressMessageSendResult | null>;
  safeSendHtmlMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendHtmlMessageResult: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<EgressMessageSendResult | null>;
  safeEditMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<EgressEditResult>;
  safeEditHtmlMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<EgressEditResult>;
  safeDeleteMessage: (chatId: string, messageId: number) => Promise<EgressDeleteResult>;
  getActiveRuntimeStatusText: (chatId: string) => string | null;
  resolveSessionModelState: (session: SessionRow) => Promise<{
    configuredModel: string | null;
    configuredReasoningEffort: ReasoningEffort | null;
    effectiveModel: string | null;
    effectiveReasoningEffort: ReasoningEffort | null;
  }>;
  reanchorRuntimeAfterBridgeReply: (chatId: string, sessionId: string, reason: string) => Promise<void>;
  syncCurrentSessionCard: (chatId: string, reason: string) => Promise<void>;
  handleSessionArchived: (chatId: string, sessionId: string, reason: string) => Promise<void>;
  handleSessionUnarchived: (chatId: string, sessionId: string, reason: string) => Promise<void>;
  openPreSessionBrowse: (chatId: string, sourceMessageId: number, rootPath: string) => Promise<boolean>;
}

function isStaleRemoteThreadArchiveError(error: unknown): boolean {
  const normalized = `${error}`.toLowerCase();
  return normalized.includes("thread not loaded") || normalized.includes("stale rollout path");
}

const RESUME_THREAD_PAGE_SIZE = 10;

type ResumeArgs =
  | { kind: "list"; includeAll: boolean; page: number }
  | { kind: "select"; includeAll: boolean; index: number }
  | { kind: "invalid"; includeAll: boolean };

function parseResumeArgs(args: string): ResumeArgs {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  const includeAll = tokens[0]?.toLowerCase() === "all";
  const rest = includeAll ? tokens.slice(1) : tokens;
  if (rest.length === 0) {
    return { kind: "list", includeAll, page: 1 };
  }

  const first = rest[0]?.toLowerCase();
  if ((first === "page" || first === "p") && rest[1]) {
    const page = Number.parseInt(rest[1], 10);
    return Number.isFinite(page) && page >= 1
      ? { kind: "list", includeAll, page }
      : { kind: "invalid", includeAll };
  }

  const index = Number.parseInt(rest[0] ?? "", 10);
  return Number.isFinite(index) && index >= 1
    ? { kind: "select", includeAll, index }
    : { kind: "invalid", includeAll };
}

async function listResumeThreadPage(
  appServer: SessionProjectArchiveAppServer,
  options: {
    cwd?: string;
    page: number;
  }
): Promise<{
  threads: Awaited<ReturnType<SessionProjectArchiveAppServer["listThreads"]>>["data"];
  hasNext: boolean;
}> {
  let cursor: string | undefined;
  for (let currentPage = 1; currentPage <= options.page; currentPage += 1) {
    const result = await appServer.listThreads({
      archived: false,
      limit: RESUME_THREAD_PAGE_SIZE,
      sortKey: "updated_at",
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(cursor ? { cursor } : {})
    });
    if (currentPage === options.page) {
      return {
        threads: result.data,
        hasNext: Boolean(result.nextCursor)
      };
    }
    if (!result.nextCursor) {
      return { threads: [], hasNext: false };
    }
    cursor = result.nextCursor;
  }

  return { threads: [], hasNext: false };
}

export class SessionProjectCoordinator {
  private readonly pickerStates = new Map<string, PickerState>();
  private readonly pendingRenameStates = new Map<string, PendingRenameState>();
  private readonly renameSurfaceMessageIds = new Map<string, number>();

  constructor(private readonly deps: SessionProjectCoordinatorDeps) {}

  private buildBridgeCommandActionsReplyMarkup(actions: BridgeCommandActionView[]): TelegramInlineKeyboardMarkup | undefined {
    if (!this.deps.preferBridgeCommandButtons || actions.length === 0) {
      return undefined;
    }

    return buildBridgeCommandReplyMarkup(actions, "zh", { chunkSize: 2 });
  }

  async handleNew(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    await this.showProjectPicker(chatId);
  }

  async cancelPendingProjectInput(chatId: string): Promise<boolean> {
    if (this.pendingRenameStates.has(chatId)) {
      const pendingRename = this.pendingRenameStates.get(chatId);
      this.pendingRenameStates.delete(chatId);
      this.renameSurfaceMessageIds.delete(chatId);
      if (pendingRename?.sourceMessageId) {
        await this.consumeEphemeralMessage(
          chatId,
          pendingRename.sourceMessageId,
          pendingRename.kind === "project" ? "已取消项目别名修改。" : "已取消会话重命名。"
        );
      } else {
        await this.deps.safeSendMessage(
          chatId,
          pendingRename?.kind === "project" ? "已取消项目别名修改。" : "已取消会话重命名。"
        );
      }
      return true;
    }

    if (this.pickerStates.get(chatId)?.awaitingManualProjectPath || this.pickerStates.get(chatId)?.inBrowseRootPicker) {
      await this.returnToProjectPicker(chatId);
      return true;
    }

    return false;
  }

  async showProjectPicker(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const picker = await buildProjectPicker(this.deps.paths.homeDir, this.deps.config.projectScanRoots, store);
    const pickerState: PickerState = {
      picker,
      browseRoots: this.resolveBrowseRoots(),
      inBrowseRootPicker: false,
      awaitingManualProjectPath: false,
      resolved: false,
      interactiveMessageId: this.pickerStates.get(chatId)?.interactiveMessageId ?? null
    };
    this.pickerStates.set(chatId, pickerState);

    const rendered = buildProjectPickerMessage(picker);
    await this.recreateInteractivePickerMessage(chatId, pickerState, {
      text: rendered.text,
      replyMarkup: rendered.replyMarkup
    });
  }

  async handleProjectPick(chatId: string, messageId: number, projectKey: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pickerState = await this.requireActivePickerState(chatId, messageId);
    if (!pickerState) {
      return;
    }

    if (pickerState.resolved) {
      await this.deps.safeSendMessage(chatId, "这个操作已处理。");
      return;
    }

    const candidate = pickerState.picker.projectMap.get(projectKey);
    if (!candidate) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    store.createSession({
      chatId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      displayName: candidate.displayName
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    this.pickerStates.delete(chatId);
    await this.consumeEphemeralMessage(
      chatId,
      messageId,
      buildSessionCreatedText(candidate.displayName, candidate.projectPath),
      { html: true }
    );
    await this.deps.syncCurrentSessionCard(chatId, "session_created");
  }

  async handleScanMore(chatId: string, messageId: number): Promise<void> {
    const pickerState = await this.requireActivePickerState(chatId, messageId);
    if (!pickerState) {
      return;
    }
    const noNewProjects = buildNoNewProjectsMessage();
    await this.recreateInteractivePickerMessage(chatId, pickerState, {
      text: noNewProjects.text,
      replyMarkup: noNewProjects.replyMarkup
    });
  }

  async openBrowseRootPicker(chatId: string, messageId: number): Promise<void> {
    const pickerState = await this.requireActivePickerState(chatId, messageId);
    if (!pickerState) {
      return;
    }

    const roots = pickerState.browseRoots;
    if (roots.length === 0) {
      await this.deps.safeSendMessage(chatId, "当前没有可浏览的根目录。");
      return;
    }

    if (roots.length === 1) {
      pickerState.resolved = true;
      this.pickerStates.delete(chatId);
      await this.deps.openPreSessionBrowse(chatId, messageId, roots[0]!);
      return;
    }

    pickerState.inBrowseRootPicker = true;
    pickerState.awaitingManualProjectPath = false;
    const rendered = buildProjectBrowseRootPickerMessage({
      roots: roots.map((path, index) => ({
        index,
        label: this.renderBrowseRootLabel(path),
        pathLabel: this.renderPathLabel(path)
      }))
    });
    await this.replaceInteractivePickerMessage(chatId, pickerState, {
      text: rendered.text,
      replyMarkup: rendered.replyMarkup
    });
  }

  async handleBrowseRootPick(chatId: string, messageId: number, rootIndex: number): Promise<void> {
    const pickerState = await this.requireActivePickerState(chatId, messageId);
    if (!pickerState) {
      return;
    }

    if (!pickerState.inBrowseRootPicker) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const rootPath = pickerState.browseRoots[rootIndex];
    if (!rootPath) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    pickerState.resolved = true;
    this.pickerStates.delete(chatId);
    await this.deps.openPreSessionBrowse(chatId, messageId, rootPath);
  }

  async backFromBrowseRootPicker(chatId: string, messageId: number): Promise<void> {
    const pickerState = await this.requireActivePickerState(chatId, messageId);
    if (!pickerState) {
      return;
    }

    pickerState.inBrowseRootPicker = false;
    pickerState.awaitingManualProjectPath = false;
    const rendered = buildProjectPickerMessage(pickerState.picker);
    await this.replaceInteractivePickerMessage(chatId, pickerState, {
      text: rendered.text,
      replyMarkup: rendered.replyMarkup
    });
  }

  async enterManualPathMode(chatId: string, messageId: number): Promise<void> {
    const pickerState = await this.requireActivePickerState(chatId, messageId);
    if (!pickerState) {
      return;
    }

    pickerState.awaitingManualProjectPath = true;
    const prompt = buildManualPathPrompt();
    await this.replaceInteractivePickerMessage(chatId, pickerState, {
      text: prompt.text,
      replyMarkup: prompt.replyMarkup
    });
  }

  async handleManualPathInput(chatId: string, text: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const candidate = await validateManualProjectPath(text, this.deps.paths.homeDir, store);
    if (!candidate) {
      await this.deps.safeSendMessage(
        chatId,
        "这个目录不可用，请重新发送目录路径。\n也可以发送 /cancel 返回项目列表。",
        this.buildBridgeCommandActionsReplyMarkup([{ command: "cancel" }])
      );
      return;
    }

    pickerState.picker.projectMap.set(candidate.projectKey, candidate);
    const confirmation = buildManualPathConfirmMessage(candidate);
    await this.sendNewestInteractivePickerMessage(chatId, pickerState, {
      text: confirmation.text,
      replyMarkup: confirmation.replyMarkup,
      html: true
    });
  }

  async confirmManualProject(chatId: string, messageId: number, projectKey: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pickerState = await this.requireActivePickerState(chatId, messageId);
    if (!pickerState) {
      return;
    }

    if (pickerState.resolved) {
      await this.deps.safeSendMessage(chatId, "这个操作已处理。");
      return;
    }

    const candidate = pickerState.picker.projectMap.get(projectKey);
    if (!candidate) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const session = store.createSession({
      chatId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      displayName: candidate.displayName
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    this.pickerStates.delete(chatId);
    await this.consumeEphemeralMessage(
      chatId,
      messageId,
      buildSessionCreatedText(candidate.displayName, candidate.projectPath),
      { html: true }
    );
    await this.deps.syncCurrentSessionCard(chatId, "session_created");
  }

  async returnToProjectPicker(chatId: string, messageId?: number): Promise<void> {
    const pickerState = messageId ? await this.requireActivePickerState(chatId, messageId) : this.pickerStates.get(chatId);
    if (!pickerState) {
      if (!messageId) {
        await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      }
      return;
    }

    pickerState.inBrowseRootPicker = false;
    pickerState.awaitingManualProjectPath = false;
    const rendered = buildProjectPickerMessage(pickerState.picker);
    await this.recreateInteractivePickerMessage(chatId, pickerState, {
      text: rendered.text,
      replyMarkup: rendered.replyMarkup
    });
  }

  isAwaitingManualProjectPath(chatId: string): boolean {
    return this.pickerStates.get(chatId)?.awaitingManualProjectPath ?? false;
  }

  isAwaitingRename(chatId: string): boolean {
    return this.pendingRenameStates.has(chatId);
  }

  projectDisplayName(project: Pick<SessionRow, "projectName" | "projectAlias">): string {
    return project.projectAlias?.trim() || project.projectName;
  }

  async sendStatus(chatId: string, fallbackSnapshot: ReadinessSnapshot | null): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const snapshot = store.getReadinessSnapshot() ?? this.deps.getSnapshot() ?? fallbackSnapshot;
    const activeSession = store.getActiveSession(chatId);
    if (!snapshot) {
      await this.deps.safeSendMessage(chatId, "桥接状态未知，请在本机运行 ctb doctor。");
      return;
    }

    if (this.deps.activePack === "feishu") {
      await this.deps.safeSendHtmlMessage(
        chatId,
        buildFeishuStatusText({
          language: this.deps.getUiLanguage(),
          snapshot,
          activeSession,
          runtimeStatusText: this.deps.getActiveRuntimeStatusText(chatId)
        }),
        buildFeishuStatusReplyMarkup({
          language: this.deps.getUiLanguage(),
          activeSession
        })
      );
      return;
    }

    const modelState = activeSession ? await this.deps.resolveSessionModelState(activeSession) : null;
    await this.deps.safeSendHtmlMessage(
      chatId,
      buildStatusText(snapshot, activeSession, this.deps.getActiveRuntimeStatusText(chatId), modelState)
    );
  }

  async sendWhere(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    const modelState = activeSession ? await this.deps.resolveSessionModelState(activeSession) : undefined;
    await this.deps.safeSendHtmlMessage(chatId, buildWhereText(activeSession, modelState));
  }

  async handleSessions(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const archived = args.trim() === "archived";
    const sessions = store.listSessions(chatId, { archived, limit: 10 });
    const activeSession = archived ? null : store.getActiveSession(chatId);
    await this.deps.safeSendMessage(
      chatId,
      buildSessionsText({
        sessions,
        activeSessionId: activeSession?.sessionId ?? null,
        archived
      })
    );
  }

  async handleResume(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const activeSession = store.getActiveSession(chatId);
    const parsedArgs = parseResumeArgs(args);
    const cwd = parsedArgs.includeAll ? undefined : activeSession?.projectPath;
    if (!cwd && !parsedArgs.includeAll) {
      await this.deps.safeSendMessage(chatId, "请先用 /new 选择项目，或用 /resume all 查看全部 Codex 会话。");
      return;
    }

    if (parsedArgs.kind === "invalid") {
      await this.deps.safeSendMessage(chatId, "找不到这个 Codex 会话。");
      return;
    }

    if (parsedArgs.kind === "list") {
      const page = await listResumeThreadPage(appServer, {
        page: parsedArgs.page,
        ...(cwd ? { cwd } : {})
      });
      const message = buildResumeThreadListMessage(page.threads, {
        page: parsedArgs.page,
        pageSize: RESUME_THREAD_PAGE_SIZE,
        hasNext: page.hasNext,
        includeAll: parsedArgs.includeAll
      });
      await this.deps.safeSendHtmlMessage(chatId, message.text, message.replyMarkup);
      return;
    }

    const targetPage = await listResumeThreadPage(appServer, {
      page: Math.floor((parsedArgs.index - 1) / RESUME_THREAD_PAGE_SIZE) + 1,
      ...(cwd ? { cwd } : {})
    });
    const target = targetPage.threads[(parsedArgs.index - 1) % RESUME_THREAD_PAGE_SIZE];
    if (!target) {
      await this.deps.safeSendMessage(chatId, "找不到这个 Codex 会话。");
      return;
    }

    const existingSession = store.getSessionByThreadId(target.id);
    if (existingSession) {
      if (existingSession.chatId !== chatId) {
        await this.deps.safeSendMessage(chatId, "这个 Codex 会话已绑定到另一个聊天。");
        return;
      }
      if (existingSession.archived) {
        store.unarchiveSession(existingSession.sessionId);
      }
      store.setActiveSession(chatId, existingSession.sessionId);
      await this.deps.syncCurrentSessionCard(chatId, "session_resumed");
      await this.deps.safeSendHtmlMessage(
        chatId,
        buildSessionResumedText(existingSession.displayName, this.projectDisplayName(existingSession))
      );
      return;
    }

    const resumed = await appServer.resumeThread(target.id);
    const lastTurn = resumed.thread.turns.at(-1);
    const projectName = basename(target.cwd);
    const displayName = resumed.thread.name?.trim() || target.name?.trim() || target.preview?.trim() || projectName;
    const session = store.createSession({
      chatId,
      projectName,
      projectPath: target.cwd,
      displayName,
      selectedModel: resumed.model ?? null,
      selectedReasoningEffort: resumed.reasoningEffort ?? null,
      threadId: resumed.thread.id,
      lastTurnId: lastTurn?.id ?? null,
      lastTurnStatus: lastTurn?.status ?? null
    });
    store.setActiveSession(chatId, session.sessionId);
    await this.deps.syncCurrentSessionCard(chatId, "session_resumed");
    await this.deps.safeSendHtmlMessage(
      chatId,
      buildSessionResumedText(session.displayName, this.projectDisplayName(session))
    );
  }

  async handleResumePageCallback(
    chatId: string,
    messageId: number,
    options: { includeAll: boolean; page: number }
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const activeSession = store.getActiveSession(chatId);
    const cwd = options.includeAll ? undefined : activeSession?.projectPath;
    if (!cwd && !options.includeAll) {
      await this.deps.safeSendMessage(chatId, "请先用 /new 选择项目，或用 /resume all 查看全部 Codex 会话。");
      return;
    }

    const page = await listResumeThreadPage(appServer, {
      page: options.page,
      ...(cwd ? { cwd } : {})
    });
    const message = buildResumeThreadListMessage(page.threads, {
      page: options.page,
      pageSize: RESUME_THREAD_PAGE_SIZE,
      hasNext: page.hasNext,
      includeAll: options.includeAll
    });
    await this.deps.safeEditHtmlMessageText(chatId, messageId, message.text, message.replyMarkup);
  }

  async handleResumePickCallback(
    chatId: string,
    options: { includeAll: boolean; page: number; itemIndex: number }
  ): Promise<void> {
    const globalIndex = (options.page - 1) * RESUME_THREAD_PAGE_SIZE + options.itemIndex + 1;
    await this.handleResume(chatId, `${options.includeAll ? "all " : ""}${globalIndex}`);
  }

  async handleUse(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const index = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(index) || index < 1) {
      await this.deps.safeSendMessage(chatId, "找不到这个会话。");
      return;
    }

    const sessions = store.listSessions(chatId);
    const target = sessions[index - 1];
    if (!target) {
      await this.deps.safeSendMessage(chatId, "找不到这个会话。");
      return;
    }

    store.setActiveSession(chatId, target.sessionId);
    await this.deps.syncCurrentSessionCard(chatId, "session_switched");
    await this.deps.safeSendHtmlMessage(
      chatId,
      buildSessionSwitchedText(target.displayName, this.projectDisplayName(target))
    );
  }

  async handleArchive(chatId: string, args = ""): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const normalizedArgs = args.trim().toLowerCase();
    if (normalizedArgs === "") {
      await this.handleArchiveActiveSession(chatId, store);
      return;
    }

    if (normalizedArgs === "all") {
      await this.handleArchiveAllSessions(chatId, store);
      return;
    }

    await this.deps.safeSendMessage(chatId, "只支持 /archive 或 /archive all。");
  }

  private async handleArchiveActiveSession(chatId: string, store: BridgeStateStore): Promise<void> {
    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    const result = await this.archiveSession(chatId, store, activeSession);
    if (!result.ok) {
      await this.deps.safeSendMessage(chatId, "当前无法归档这个会话，请稍后重试。");
      return;
    }

    await this.deps.syncCurrentSessionCard(chatId, "session_archived");
    const nextActiveSession = store.getActiveSession(chatId);
    await this.deps.safeSendHtmlMessage(
      chatId,
      buildArchiveSuccessText(
        {
          displayName: activeSession.displayName,
          projectName: activeSession.projectName,
          projectAlias: activeSession.projectAlias
        },
        nextActiveSession
          ? {
              displayName: nextActiveSession.displayName,
              projectName: nextActiveSession.projectName,
              projectAlias: nextActiveSession.projectAlias
            }
          : null
      )
    );
  }

  private async handleArchiveAllSessions(chatId: string, store: BridgeStateStore): Promise<void> {
    const visibleSessions = store.listSessions(chatId, { archived: false, limit: 2_147_483_647 });
    if (visibleSessions.length === 0) {
      await this.deps.safeSendMessage(chatId, "当前没有可归档会话。");
      return;
    }

    let archivedCount = 0;
    let skippedRunningCount = 0;
    let failedCount = 0;

    for (const session of visibleSessions) {
      if (session.status === "running") {
        skippedRunningCount += 1;
        continue;
      }

      const result = await this.archiveSession(chatId, store, session);
      if (result.ok) {
        archivedCount += 1;
      } else {
        failedCount += 1;
      }
    }

    await this.deps.syncCurrentSessionCard(chatId, "session_archived");
    const nextActiveSession = store.getActiveSession(chatId);
    await this.deps.safeSendHtmlMessage(
      chatId,
      buildArchiveAllSuccessText({
        archivedCount,
        skippedRunningCount,
        failedCount,
        nextActiveSession: nextActiveSession
          ? {
              displayName: nextActiveSession.displayName,
              projectName: nextActiveSession.projectName,
              projectAlias: nextActiveSession.projectAlias
            }
          : null
      })
    );
  }

  private async archiveSession(
    chatId: string,
    store: BridgeStateStore,
    session: Pick<
      SessionRow,
      "sessionId" | "threadId" | "displayName" | "projectName" | "projectAlias" | "status"
    >
  ): Promise<{ ok: boolean }> {
    let mirroredRemotely = false;
    let pendingOpId: number | null = null;
    try {
      if (session.threadId) {
        pendingOpId = this.deps.registerPendingThreadArchiveOp(
          session.threadId,
          session.sessionId,
          "archived",
          "telegram_archive"
        );
        const appServer = await this.deps.ensureAppServerAvailable();
        await appServer.archiveThread(session.threadId);
        mirroredRemotely = true;
      }

      store.archiveSession(session.sessionId);
      if (session.threadId) {
        await this.deps.markPendingThreadArchiveCommit(session.threadId, pendingOpId);
      }

      try {
        await this.deps.handleSessionArchived(chatId, session.sessionId, "telegram_archive");
      } catch (error) {
        await this.deps.logger.warn("runtime hub archive cleanup failed", {
          chatId,
          sessionId: session.sessionId,
          error: `${error}`
        });
      }

      return { ok: true };
    } catch (error) {
      if (session.threadId && pendingOpId !== null) {
        this.deps.dropPendingThreadArchiveOp(session.threadId, pendingOpId);
      }
      if (!mirroredRemotely && isStaleRemoteThreadArchiveError(error)) {
        await this.deps.logger.warn("archive falling back to local-only state after stale remote thread", {
          chatId,
          sessionId: session.sessionId,
          threadId: session.threadId ?? null,
          error: `${error}`
        });

        try {
          store.archiveSession(session.sessionId);
          try {
            await this.deps.handleSessionArchived(chatId, session.sessionId, "telegram_archive");
          } catch (hookError) {
            await this.deps.logger.warn("runtime hub archive cleanup failed", {
              chatId,
              sessionId: session.sessionId,
              error: `${hookError}`
            });
          }

          return { ok: true };
        } catch (localArchiveError) {
          await this.deps.logger.warn("local-only archive fallback failed after stale remote thread", {
            chatId,
            sessionId: session.sessionId,
            threadId: session.threadId ?? null,
            error: `${localArchiveError}`
          });
        }
      }
      if (mirroredRemotely && session.threadId) {
        try {
          const appServer = await this.deps.ensureAppServerAvailable();
          await appServer.unarchiveThread(session.threadId);
        } catch (rollbackError) {
          await this.deps.logger.warn("archive rollback failed after local persistence error", {
            sessionId: session.sessionId,
            threadId: session.threadId,
            error: `${rollbackError}`
          });
        }
      }

      return { ok: false };
    }
  }

  async handleUnarchive(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const index = Number.parseInt(args.trim(), 10);
    if (!Number.isFinite(index) || index < 1) {
      await this.deps.safeSendMessage(chatId, "找不到这个会话。");
      return;
    }

    const archivedSessions = store.listSessions(chatId, { archived: true, limit: 10 });
    const target = archivedSessions[index - 1];
    if (!target) {
      await this.deps.safeSendMessage(chatId, "找不到这个会话。");
      return;
    }

    let mirroredRemotely = false;
    let pendingOpId: number | null = null;
    try {
      if (target.threadId) {
        pendingOpId = this.deps.registerPendingThreadArchiveOp(
          target.threadId,
          target.sessionId,
          "unarchived",
          "telegram_unarchive"
        );
        const appServer = await this.deps.ensureAppServerAvailable();
        await appServer.unarchiveThread(target.threadId);
        mirroredRemotely = true;
      }

      store.unarchiveSession(target.sessionId);
      if (target.threadId) {
        await this.deps.markPendingThreadArchiveCommit(target.threadId, pendingOpId);
      }
      try {
        await this.deps.handleSessionUnarchived(chatId, target.sessionId, "telegram_unarchive");
      } catch (error) {
        await this.deps.logger.warn("runtime hub unarchive cleanup failed", {
          chatId,
          sessionId: target.sessionId,
          error: `${error}`
        });
      }
      await this.deps.syncCurrentSessionCard(chatId, "session_unarchived");
      await this.deps.safeSendHtmlMessage(
        chatId,
        buildUnarchiveSuccessText(target.displayName, this.projectDisplayName(target))
      );
    } catch {
      if (target.threadId && pendingOpId !== null) {
        this.deps.dropPendingThreadArchiveOp(target.threadId, pendingOpId);
      }
      if (mirroredRemotely && target.threadId) {
        try {
          const appServer = await this.deps.ensureAppServerAvailable();
          await appServer.archiveThread(target.threadId);
        } catch (rollbackError) {
          await this.deps.logger.warn("unarchive rollback failed after local persistence error", {
            sessionId: target.sessionId,
            threadId: target.threadId,
            error: `${rollbackError}`
          });
        }
      }

      await this.deps.safeSendMessage(chatId, "当前无法恢复这个会话，请稍后重试。");
    }
  }

  async handleRename(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const name = args.trim();
    if (!name) {
      const picker = buildRenameTargetPicker({
        sessionId: activeSession.sessionId,
        projectName: this.projectDisplayName(activeSession),
        hasProjectAlias: Boolean(activeSession.projectAlias?.trim())
      });
      const sent = await this.deps.safeSendHtmlMessageResult(chatId, picker.text, picker.replyMarkup);
      if (sent) {
        this.renameSurfaceMessageIds.set(chatId, sent.messageId);
      }
      return;
    }

    const pendingRename = this.pendingRenameStates.get(chatId);
    store.renameSession(activeSession.sessionId, name);
    await this.deps.syncCurrentSessionCard(chatId, "session_renamed");
    this.pendingRenameStates.delete(chatId);
    this.renameSurfaceMessageIds.delete(chatId);
    if (pendingRename?.sourceMessageId) {
      await this.consumeEphemeralMessage(
        chatId,
        pendingRename.sourceMessageId,
        buildSessionRenamedText(name),
        { html: true }
      );
      return;
    }
    await this.deps.safeSendHtmlMessage(chatId, buildSessionRenamedText(name));
  }

  async beginSessionRename(chatId: string, messageId: number, sessionId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId || this.renameSurfaceMessageIds.get(chatId) !== messageId) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const promptMessageId = await this.editOrSendRenamePrompt(chatId, messageId, this.getRenamePromptText("session"));
    this.renameSurfaceMessageIds.set(chatId, promptMessageId);
    this.pendingRenameStates.set(chatId, {
      kind: "session",
      sessionId: activeSession.sessionId,
      projectPath: activeSession.projectPath,
      sourceMessageId: promptMessageId
    });
  }

  async beginProjectRename(chatId: string, messageId: number, sessionId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId || this.renameSurfaceMessageIds.get(chatId) !== messageId) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    const promptMessageId = await this.editOrSendRenamePrompt(chatId, messageId, this.getRenamePromptText("project"));
    this.renameSurfaceMessageIds.set(chatId, promptMessageId);
    this.pendingRenameStates.set(chatId, {
      kind: "project",
      sessionId: activeSession.sessionId,
      projectPath: activeSession.projectPath,
      sourceMessageId: promptMessageId
    });
  }

  async clearProjectAlias(chatId: string, messageId: number, sessionId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId || this.renameSurfaceMessageIds.get(chatId) !== messageId) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (!activeSession.projectAlias?.trim()) {
      await this.deps.safeSendMessage(chatId, "当前项目还没有设置别名。");
      return;
    }

    store.clearProjectAlias(activeSession.projectPath);
    await this.deps.syncCurrentSessionCard(chatId, "project_alias_cleared");
    this.pendingRenameStates.delete(chatId);
    this.renameSurfaceMessageIds.delete(chatId);
    await this.consumeEphemeralMessage(
      chatId,
      messageId,
      buildProjectAliasClearedText(activeSession.projectName),
      { html: true }
    );
  }

  async handleRenameInput(chatId: string, text: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pendingRename = this.pendingRenameStates.get(chatId);
    if (!pendingRename) {
      return;
    }

    const name = text.trim();
    if (!name) {
      if (pendingRename.sourceMessageId) {
        const result = await this.deps.safeEditMessageText(chatId, pendingRename.sourceMessageId, this.getRenamePromptText(pendingRename.kind));
        if (isTelegramEditCommitted(result)) {
          return;
        }
      }
      await this.deps.safeSendMessage(chatId, this.getRenamePromptText(pendingRename.kind));
      return;
    }

    const session = store.getSessionById(pendingRename.sessionId);
    if (!session) {
      this.pendingRenameStates.delete(chatId);
      this.renameSurfaceMessageIds.delete(chatId);
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    if (pendingRename.kind === "project") {
      store.setProjectAlias({
        projectPath: pendingRename.projectPath,
        projectName: session.projectName,
        projectAlias: name,
        sessionId: session.sessionId
      });
      await this.deps.syncCurrentSessionCard(chatId, "project_alias_updated");
      this.pendingRenameStates.delete(chatId);
      this.renameSurfaceMessageIds.delete(chatId);
      if (pendingRename.sourceMessageId) {
        await this.consumeEphemeralMessage(
          chatId,
          pendingRename.sourceMessageId,
          buildProjectAliasRenamedText(name),
          { html: true }
        );
        return;
      }
      await this.deps.safeSendHtmlMessage(chatId, buildProjectAliasRenamedText(name));
      return;
    }

    store.renameSession(session.sessionId, name);
    await this.deps.syncCurrentSessionCard(chatId, "session_renamed");
    this.pendingRenameStates.delete(chatId);
    this.renameSurfaceMessageIds.delete(chatId);
    if (pendingRename.sourceMessageId) {
      await this.consumeEphemeralMessage(
        chatId,
        pendingRename.sourceMessageId,
        buildSessionRenamedText(name),
        { html: true }
      );
      return;
    }
    await this.deps.safeSendHtmlMessage(chatId, buildSessionRenamedText(name));
  }

  async handlePin(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    if (store.isProjectPinned(activeSession.projectPath)) {
      await this.deps.safeSendMessage(chatId, "这个项目已经收藏。");
      return;
    }

    store.pinProject({
      projectPath: activeSession.projectPath,
      projectName: activeSession.projectName,
      sessionId: activeSession.sessionId
    });
    await this.deps.safeSendHtmlMessage(chatId, buildProjectPinnedText(this.projectDisplayName(activeSession)));
  }

  async handlePlan(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const nextPlanMode = !activeSession.planMode;
    store.setSessionPlanMode(activeSession.sessionId, nextPlanMode);

    const verb = this.deps.getUiLanguage() === "en" ? (nextPlanMode ? "enable" : "disable") : (nextPlanMode ? "开启" : "关闭");
    const suffix = activeSession.status === "running"
      ? "当前任务不受影响，下次任务开始时生效。"
      : "下次任务开始时生效。";
    await this.deps.safeSendMessage(chatId, `已为会话「${activeSession.displayName}」${verb} Plan mode。${suffix}`);
  }

  private resolveBrowseRoots(): string[] {
    if (this.deps.config.projectScanRoots.length > 0) {
      return this.deps.config.projectScanRoots;
    }
    return [this.deps.paths.homeDir];
  }

  private renderPathLabel(path: string): string {
    if (path === this.deps.paths.homeDir) {
      return "~";
    }
    if (path.startsWith(`${this.deps.paths.homeDir}${sep}`)) {
      return `~/${relative(this.deps.paths.homeDir, path).split(sep).join("/")}`;
    }
    return path.split(sep).join("/");
  }

  private renderBrowseRootLabel(path: string): string {
    if (path === this.deps.paths.homeDir) {
      return "Home";
    }
    return basename(path) || path;
  }

  private async requireActivePickerState(chatId: string, messageId: number): Promise<PickerState | null> {
    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState || pickerState.interactiveMessageId !== messageId) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return null;
    }

    return pickerState;
  }

  private async consumeEphemeralMessage(
    chatId: string,
    messageId: number,
    text: string,
    options?: {
      html?: boolean;
    }
  ): Promise<boolean> {
    if (messageId > 0 && isTelegramDeleteCommitted(await this.deps.safeDeleteMessage(chatId, messageId))) {
      if (options?.html) {
        return await this.deps.safeSendHtmlMessage(chatId, text);
      } else {
        return await this.deps.safeSendMessage(chatId, text);
      }
    }

    if (messageId > 0) {
      const result = options?.html
        ? await this.deps.safeEditHtmlMessageText(chatId, messageId, text)
        : await this.deps.safeEditMessageText(chatId, messageId, text);
      if (isTelegramEditCommitted(result)) {
        return true;
      }
    }

    if (options?.html) {
      return await this.deps.safeSendHtmlMessage(chatId, text);
    } else {
      return await this.deps.safeSendMessage(chatId, text);
    }
  }

  private getRenamePromptText(kind: PendingRenameState["kind"]): string {
    return kind === "project" ? (this.deps.getUiLanguage() === "en" ? "Enter a new project alias.\nSend /cancel to cancel." : "请输入新的项目别名。\n发送 /cancel 取消。") : (this.deps.getUiLanguage() === "en" ? "Enter a new session name.\nSend /cancel to cancel." : "请输入新的会话名称。\n发送 /cancel 取消。");
  }

  private async editOrSendRenamePrompt(chatId: string, messageId: number, promptText: string): Promise<number> {
    const replyMarkup = this.buildBridgeCommandActionsReplyMarkup([{ command: "cancel" }]);
    const result = await this.deps.safeEditMessageText(chatId, messageId, promptText, replyMarkup);
    if (isTelegramEditCommitted(result)) {
      return messageId;
    }

    const sent = await this.deps.safeSendMessageResult(chatId, promptText, replyMarkup);
    if (sent) {
      await this.cleanupSupersededInteractiveMessage(chatId, messageId, sent.messageId);
      return sent.messageId;
    }

    return messageId;
  }

  private async replaceInteractivePickerMessage(
    chatId: string,
    pickerState: PickerState,
    message: {
      text: string;
      replyMarkup?: TelegramInlineKeyboardMarkup;
      html?: boolean;
    }
  ): Promise<number | null> {
    const previousMessageId = pickerState.interactiveMessageId;
    if (previousMessageId && previousMessageId > 0) {
      const result = message.html
        ? await this.deps.safeEditHtmlMessageText(chatId, previousMessageId, message.text, message.replyMarkup)
        : await this.deps.safeEditMessageText(chatId, previousMessageId, message.text, message.replyMarkup);
      if (isTelegramEditCommitted(result)) {
        pickerState.interactiveMessageId = previousMessageId;
        return previousMessageId;
      }
    }

    const sent = message.html
      ? await this.deps.safeSendHtmlMessageResult(chatId, message.text, message.replyMarkup)
      : await this.deps.safeSendMessageResult(chatId, message.text, message.replyMarkup);
    if (!sent) {
      return previousMessageId ?? null;
    }

    pickerState.interactiveMessageId = sent.messageId;
    await this.cleanupSupersededInteractiveMessage(chatId, previousMessageId, sent.messageId);
    return sent.messageId;
  }

  private async recreateInteractivePickerMessage(
    chatId: string,
    pickerState: PickerState,
    message: {
      text: string;
      replyMarkup?: TelegramInlineKeyboardMarkup;
      html?: boolean;
    }
  ): Promise<number | null> {
    const previousMessageId = pickerState.interactiveMessageId;
    if (previousMessageId && previousMessageId > 0) {
      await this.deps.safeDeleteMessage(chatId, previousMessageId);
    }

    const sent = message.html
      ? await this.deps.safeSendHtmlMessageResult(chatId, message.text, message.replyMarkup)
      : await this.deps.safeSendMessageResult(chatId, message.text, message.replyMarkup);
    if (!sent) {
      return previousMessageId ?? null;
    }

    pickerState.interactiveMessageId = sent.messageId;
    return sent.messageId;
  }

  private async sendNewestInteractivePickerMessage(
    chatId: string,
    pickerState: PickerState,
    message: {
      text: string;
      replyMarkup?: TelegramInlineKeyboardMarkup;
      html?: boolean;
    }
  ): Promise<number | null> {
    const previousMessageId = pickerState.interactiveMessageId;
    const sent = message.html
      ? await this.deps.safeSendHtmlMessageResult(chatId, message.text, message.replyMarkup)
      : await this.deps.safeSendMessageResult(chatId, message.text, message.replyMarkup);
    if (sent) {
      pickerState.interactiveMessageId = sent.messageId;
      await this.cleanupSupersededInteractiveMessage(chatId, previousMessageId, sent.messageId);
      return sent.messageId;
    }

    if (previousMessageId && previousMessageId > 0) {
      const result = message.html
        ? await this.deps.safeEditHtmlMessageText(chatId, previousMessageId, message.text, message.replyMarkup)
        : await this.deps.safeEditMessageText(chatId, previousMessageId, message.text, message.replyMarkup);
      if (isTelegramEditCommitted(result)) {
        pickerState.interactiveMessageId = previousMessageId;
        return previousMessageId;
      }
    }

    return previousMessageId ?? null;
  }

  private async cleanupSupersededInteractiveMessage(
    chatId: string,
    previousMessageId: number | null,
    replacementMessageId: number
  ): Promise<void> {
    if (!previousMessageId || previousMessageId <= 0 || previousMessageId === replacementMessageId) {
      return;
    }

    await this.deps.safeDeleteMessage(chatId, previousMessageId);
  }
}
