import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { buildProjectPicker, refreshProjectPicker, validateManualProjectPath } from "../project/discovery.js";
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
  buildProjectSelectedText,
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
  RuntimeStatusField,
  SessionRow
} from "../types.js";
import type { TelegramInlineKeyboardMarkup } from "../telegram/api.js";

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
  ) => Promise<unknown>;
  safeSendHtmlMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<unknown>;
}

export class SessionProjectCoordinator {
  private readonly pickerStates = new Map<string, PickerState>();
  private readonly pendingRenameStates = new Map<string, PendingRenameState>();

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
      await this.deps.safeSendMessage(
        chatId,
        pendingRename?.kind === "project" ? "已取消项目别名修改。" : "已取消会话重命名。"
      );
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
    this.pickerStates.set(chatId, {
      picker,
      awaitingManualProjectPath: false,
      resolved: false
    });

    const rendered = buildProjectPickerMessage(picker);
    await this.deps.safeSendMessage(chatId, rendered.text, rendered.replyMarkup);
  }

  async handleProjectPick(chatId: string, projectKey: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
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
      telegramChatId: chatId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      displayName: candidate.displayName
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    await this.deps.safeSendHtmlMessage(chatId, buildSessionCreatedText(candidate.displayName));
  }

  async handleScanMore(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    await this.deps.safeSendMessage(chatId, "正在扫描本地项目，请稍候…");
    const previousKeys = new Set([...pickerState.picker.projectMap.keys()]);
    const refreshed = await refreshProjectPicker(
      this.deps.paths.homeDir,
      this.deps.config.projectScanRoots,
      store,
      previousKeys
    );

    this.pickerStates.set(chatId, {
      picker: refreshed.picker,
      awaitingManualProjectPath: false,
      resolved: false
    });

    if (!refreshed.hasNewResults) {
      const noNewProjects = buildNoNewProjectsMessage();
      await this.deps.safeSendMessage(chatId, noNewProjects.text, noNewProjects.replyMarkup);
      return;
    }

    const rendered = buildProjectPickerMessage(refreshed.picker);
    await this.deps.safeSendMessage(chatId, rendered.text, rendered.replyMarkup);
  }

  async enterManualPathMode(chatId: string): Promise<void> {
    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    pickerState.awaitingManualProjectPath = true;
    const prompt = buildManualPathPrompt();
    await this.deps.safeSendMessage(chatId, prompt.text, prompt.replyMarkup);
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
    await this.deps.safeSendHtmlMessage(chatId, confirmation.text, confirmation.replyMarkup);
  }

  async confirmManualProject(chatId: string, projectKey: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
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
      telegramChatId: chatId,
      projectName: candidate.projectName,
      projectPath: candidate.projectPath,
      displayName: candidate.displayName
    });

    pickerState.resolved = true;
    pickerState.awaitingManualProjectPath = false;
    await this.deps.safeSendHtmlMessage(chatId, buildSessionCreatedText(candidate.displayName));
  }

  async returnToProjectPicker(chatId: string): Promise<void> {
    const pickerState = this.pickerStates.get(chatId);
    if (!pickerState) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    pickerState.awaitingManualProjectPath = false;
    const rendered = buildProjectPickerMessage(pickerState.picker);
    await this.deps.safeSendMessage(chatId, rendered.text, rendered.replyMarkup);
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
    await this.deps.safeSendHtmlMessage(chatId, buildSessionSwitchedText(this.projectDisplayName(target)));
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
      await this.deps.safeSendHtmlMessage(chatId, picker.text, picker.replyMarkup);
      return;
    }

    store.renameSession(activeSession.sessionId, name);
    this.pendingRenameStates.delete(chatId);
    await this.deps.safeSendHtmlMessage(chatId, buildSessionRenamedText(name));
  }

  async beginSessionRename(chatId: string, sessionId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    this.pendingRenameStates.set(chatId, {
      kind: "session",
      sessionId: activeSession.sessionId,
      projectPath: activeSession.projectPath
    });
    await this.deps.safeSendMessage(chatId, "请输入新的会话名称。\n发送 /cancel 取消。");
  }

  async beginProjectRename(chatId: string, sessionId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    this.pendingRenameStates.set(chatId, {
      kind: "project",
      sessionId: activeSession.sessionId,
      projectPath: activeSession.projectPath
    });
    await this.deps.safeSendMessage(chatId, "请输入新的项目别名。\n发送 /cancel 取消。");
  }

  async clearProjectAlias(chatId: string, sessionId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      await this.deps.safeSendMessage(chatId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (!activeSession.projectAlias?.trim()) {
      await this.deps.safeSendMessage(chatId, "当前项目还没有设置别名。");
      return;
    }

    store.clearProjectAlias(activeSession.projectPath);
    this.pendingRenameStates.delete(chatId);
    await this.deps.safeSendHtmlMessage(chatId, buildProjectAliasClearedText(activeSession.projectName));
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
      await this.deps.safeSendMessage(
        chatId,
        pendingRename.kind === "project" ? "请输入新的项目别名。\n发送 /cancel 取消。" : "请输入新的会话名称。\n发送 /cancel 取消。"
      );
      return;
    }

    const session = store.getSessionById(pendingRename.sessionId);
    if (!session) {
      this.pendingRenameStates.delete(chatId);
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
      await this.deps.safeSendHtmlMessage(chatId, buildProjectAliasRenamedText(name));
      return;
    }

    store.renameSession(session.sessionId, name);
    this.pendingRenameStates.delete(chatId);
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

    const verb = nextPlanMode ? "开启" : "关闭";
    const suffix = activeSession.status === "running"
      ? "当前任务不受影响，下次任务开始时生效。"
      : "下次任务开始时生效。";
    await this.deps.safeSendMessage(chatId, `已为当前会话${verb} Plan mode。${suffix}`);
  }
}
