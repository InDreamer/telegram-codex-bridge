import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { buildProjectPicker, refreshProjectPicker, validateManualProjectPath } from "../project/discovery.js";
import {
  isTelegramDeleteCommitted,
  isTelegramEditCommitted,
  type TelegramDeleteResult,
  type TelegramEditResult
} from "./runtime-surface-state.js";
import type { BridgeStateStore } from "../state/store.js";
import {
  buildArchiveSuccessText,
  buildManualPathConfirmMessage,
  buildManualPathPrompt,
  buildNoNewProjectsMessage,
  buildProjectAliasClearedText,
  buildProjectAliasRenamedText,
  buildProjectPickerMessage,
  buildProjectPinnedText,
  buildRenameTargetPicker,
  buildSessionCreatedText,
  buildSessionRenamedText,
  buildSessionsText,
  buildSessionSwitchedText,
  buildStatusText,
  buildUnarchiveSuccessText,
  buildWhereText
} from "../telegram/ui.js";
import type {
  ProjectPickerResult,
  ReadinessSnapshot,
  SessionRow
} from "../types.js";
import type { TelegramInlineKeyboardMarkup } from "../telegram/api.js";

interface PickerState {
  picker: ProjectPickerResult;
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
}

interface SessionProjectCoordinatorDeps {
  logger: Pick<Logger, "warn">;
  paths: Pick<BridgePaths, "homeDir">;
  config: Pick<BridgeConfig, "projectScanRoots">;
  getStore: () => BridgeStateStore | null;
  getSnapshot: () => ReadinessSnapshot | null;
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
  ) => Promise<{ message_id: number } | null>;
  safeSendHtmlMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendHtmlMessageResult: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<{ message_id: number } | null>;
  safeEditMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<TelegramEditResult>;
  safeEditHtmlMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<TelegramEditResult>;
  safeDeleteMessage: (chatId: string, messageId: number) => Promise<TelegramDeleteResult>;
  reanchorRuntimeAfterBridgeReply: (chatId: string, sessionId: string, reason: string) => Promise<void>;
}

export class SessionProjectCoordinator {
  private readonly pickerStates = new Map<string, PickerState>();
  private readonly pendingRenameStates = new Map<string, PendingRenameState>();
  private readonly renameSurfaceMessageIds = new Map<string, number>();

  constructor(private readonly deps: SessionProjectCoordinatorDeps) {}

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

    if (this.pickerStates.get(chatId)?.awaitingManualProjectPath) {
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
      awaitingManualProjectPath: false,
      resolved: false,
      interactiveMessageId: this.pickerStates.get(chatId)?.interactiveMessageId ?? null
    };
    this.pickerStates.set(chatId, pickerState);

    const rendered = buildProjectPickerMessage(picker);
    await this.replaceInteractivePickerMessage(chatId, pickerState, {
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

    const session = store.createSession({
      telegramChatId: chatId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      displayName: candidate.displayName
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    this.pickerStates.delete(chatId);
    const delivered = await this.consumeEphemeralMessage(
      chatId,
      messageId,
      buildSessionCreatedText(candidate.displayName, candidate.projectPath),
      { html: true }
    );
    await this.reanchorRuntimeAfterBridgeReply(chatId, session.sessionId, delivered, "session_created");
  }

  async handleScanMore(chatId: string, messageId: number): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pickerState = await this.requireActivePickerState(chatId, messageId);
    if (!pickerState) {
      return;
    }

    await this.deps.safeEditMessageText(chatId, messageId, "正在扫描本地项目，请稍候…");
    const previousKeys = new Set([...pickerState.picker.projectMap.keys()]);
    const refreshed = await refreshProjectPicker(
      this.deps.paths.homeDir,
      this.deps.config.projectScanRoots,
      store,
      previousKeys
    );

    if (!refreshed.hasNewResults) {
      const noNewProjects = buildNoNewProjectsMessage();
      await this.replaceInteractivePickerMessage(chatId, pickerState, {
        text: noNewProjects.text,
        replyMarkup: noNewProjects.replyMarkup
      });
      this.pickerStates.set(chatId, {
        picker: refreshed.picker,
        awaitingManualProjectPath: false,
        resolved: false,
        interactiveMessageId: pickerState.interactiveMessageId
      });
      return;
    }

    const rendered = buildProjectPickerMessage(refreshed.picker);
    await this.replaceInteractivePickerMessage(chatId, pickerState, {
      text: rendered.text,
      replyMarkup: rendered.replyMarkup
    });
    this.pickerStates.set(chatId, {
      picker: refreshed.picker,
      awaitingManualProjectPath: false,
      resolved: false,
      interactiveMessageId: pickerState.interactiveMessageId
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
        "这个目录不可用，请重新发送目录路径。\n也可以发送 /cancel 返回项目列表。"
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
      telegramChatId: chatId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      displayName: candidate.displayName
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    this.pickerStates.delete(chatId);
    const delivered = await this.consumeEphemeralMessage(
      chatId,
      messageId,
      buildSessionCreatedText(candidate.displayName, candidate.projectPath),
      { html: true }
    );
    await this.reanchorRuntimeAfterBridgeReply(chatId, session.sessionId, delivered, "session_created");
  }

  async returnToProjectPicker(chatId: string, messageId?: number): Promise<void> {
    const pickerState = messageId ? await this.requireActivePickerState(chatId, messageId) : this.pickerStates.get(chatId);
    if (!pickerState) {
      if (!messageId) {
        await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      }
      return;
    }

    pickerState.awaitingManualProjectPath = false;
    const rendered = buildProjectPickerMessage(pickerState.picker);
    if (messageId && messageId > 0) {
      pickerState.interactiveMessageId = messageId;
    }
    await this.replaceInteractivePickerMessage(chatId, pickerState, {
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

    await this.deps.safeSendHtmlMessage(chatId, buildStatusText(snapshot, activeSession));
  }

  async sendWhere(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    await this.deps.safeSendHtmlMessage(chatId, buildWhereText(store.getActiveSession(chatId)));
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
    const delivered = await this.deps.safeSendHtmlMessage(chatId, buildSessionSwitchedText(this.projectDisplayName(target)));
    await this.reanchorRuntimeAfterBridgeReply(chatId, target.sessionId, delivered, "session_switched");
  }

  async handleArchive(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "当前项目仍在执行，请先等待完成或停止当前操作。");
      return;
    }

    let mirroredRemotely = false;
    let pendingOpId: number | null = null;
    try {
      if (activeSession.threadId) {
        pendingOpId = this.deps.registerPendingThreadArchiveOp(
          activeSession.threadId,
          activeSession.sessionId,
          "archived",
          "telegram_archive"
        );
        const appServer = await this.deps.ensureAppServerAvailable();
        await appServer.archiveThread(activeSession.threadId);
        mirroredRemotely = true;
      }

      store.archiveSession(activeSession.sessionId);
      if (activeSession.threadId) {
        await this.deps.markPendingThreadArchiveCommit(activeSession.threadId, pendingOpId);
      }
      const nextActiveSession = store.getActiveSession(chatId);
      await this.deps.safeSendHtmlMessage(
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
      if (activeSession.threadId && pendingOpId !== null) {
        this.deps.dropPendingThreadArchiveOp(activeSession.threadId, pendingOpId);
      }
      if (mirroredRemotely && activeSession.threadId) {
        try {
          const appServer = await this.deps.ensureAppServerAvailable();
          await appServer.unarchiveThread(activeSession.threadId);
        } catch (rollbackError) {
          await this.deps.logger.warn("archive rollback failed after local persistence error", {
            sessionId: activeSession.sessionId,
            threadId: activeSession.threadId,
            error: `${rollbackError}`
          });
        }
      }

      await this.deps.safeSendMessage(chatId, "当前无法归档这个会话，请稍后重试。");
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
      await this.deps.safeSendHtmlMessage(chatId, buildUnarchiveSuccessText(this.projectDisplayName(target)));
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
        this.renameSurfaceMessageIds.set(chatId, sent.message_id);
      }
      return;
    }

    const pendingRename = this.pendingRenameStates.get(chatId);
    store.renameSession(activeSession.sessionId, name);
    this.pendingRenameStates.delete(chatId);
    this.renameSurfaceMessageIds.delete(chatId);
    if (pendingRename?.sourceMessageId) {
      const delivered = await this.consumeEphemeralMessage(
        chatId,
        pendingRename.sourceMessageId,
        buildSessionRenamedText(name),
        { html: true }
      );
      await this.reanchorRuntimeAfterBridgeReply(chatId, activeSession.sessionId, delivered, "session_renamed");
      return;
    }
    const delivered = await this.deps.safeSendHtmlMessage(chatId, buildSessionRenamedText(name));
    await this.reanchorRuntimeAfterBridgeReply(chatId, activeSession.sessionId, delivered, "session_renamed");
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
    this.pendingRenameStates.delete(chatId);
    this.renameSurfaceMessageIds.delete(chatId);
    const delivered = await this.consumeEphemeralMessage(
      chatId,
      messageId,
      buildProjectAliasClearedText(activeSession.projectName),
      { html: true }
    );
    await this.reanchorRuntimeAfterBridgeReply(chatId, activeSession.sessionId, delivered, "project_alias_cleared");
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
      this.pendingRenameStates.delete(chatId);
      this.renameSurfaceMessageIds.delete(chatId);
      if (pendingRename.sourceMessageId) {
        const delivered = await this.consumeEphemeralMessage(
          chatId,
          pendingRename.sourceMessageId,
          buildProjectAliasRenamedText(name),
          { html: true }
        );
        await this.reanchorRuntimeAfterBridgeReply(chatId, session.sessionId, delivered, "project_alias_renamed");
        return;
      }
      const delivered = await this.deps.safeSendHtmlMessage(chatId, buildProjectAliasRenamedText(name));
      await this.reanchorRuntimeAfterBridgeReply(chatId, session.sessionId, delivered, "project_alias_renamed");
      return;
    }

    store.renameSession(session.sessionId, name);
    this.pendingRenameStates.delete(chatId);
    this.renameSurfaceMessageIds.delete(chatId);
    if (pendingRename.sourceMessageId) {
      const delivered = await this.consumeEphemeralMessage(
        chatId,
        pendingRename.sourceMessageId,
        buildSessionRenamedText(name),
        { html: true }
      );
      await this.reanchorRuntimeAfterBridgeReply(chatId, session.sessionId, delivered, "session_renamed");
      return;
    }
    const delivered = await this.deps.safeSendHtmlMessage(chatId, buildSessionRenamedText(name));
    await this.reanchorRuntimeAfterBridgeReply(chatId, session.sessionId, delivered, "session_renamed");
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
    const delivered = await this.deps.safeSendHtmlMessage(chatId, buildProjectPinnedText(this.projectDisplayName(activeSession)));
    await this.reanchorRuntimeAfterBridgeReply(chatId, activeSession.sessionId, delivered, "project_pinned");
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

    const verb = nextPlanMode ? "开启" : "关闭";
    const suffix = activeSession.status === "running"
      ? "当前任务不受影响，下次任务开始时生效。"
      : "下次任务开始时生效。";
    const delivered = await this.deps.safeSendMessage(chatId, `已为当前会话${verb} Plan mode。${suffix}`);
    await this.reanchorRuntimeAfterBridgeReply(chatId, activeSession.sessionId, delivered, "plan_mode_toggled");
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

  private async reanchorRuntimeAfterBridgeReply(
    chatId: string,
    sessionId: string,
    delivered: boolean,
    reason: string
  ): Promise<void> {
    if (!delivered) {
      return;
    }

    await this.deps.reanchorRuntimeAfterBridgeReply(chatId, sessionId, reason);
  }

  private getRenamePromptText(kind: PendingRenameState["kind"]): string {
    return kind === "project" ? "请输入新的项目别名。\n发送 /cancel 取消。" : "请输入新的会话名称。\n发送 /cancel 取消。";
  }

  private async editOrSendRenamePrompt(chatId: string, messageId: number, promptText: string): Promise<number> {
    const result = await this.deps.safeEditMessageText(chatId, messageId, promptText);
    if (isTelegramEditCommitted(result)) {
      return messageId;
    }

    const sent = await this.deps.safeSendMessageResult(chatId, promptText);
    if (sent) {
      await this.cleanupSupersededInteractiveMessage(chatId, messageId, sent.message_id);
      return sent.message_id;
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

    pickerState.interactiveMessageId = sent.message_id;
    await this.cleanupSupersededInteractiveMessage(chatId, previousMessageId, sent.message_id);
    return sent.message_id;
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
      pickerState.interactiveMessageId = sent.message_id;
      await this.cleanupSupersededInteractiveMessage(chatId, previousMessageId, sent.message_id);
      return sent.message_id;
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
