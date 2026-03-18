import { randomBytes } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { BridgeStateStore } from "../state/store.js";
import type { TelegramInlineKeyboardMarkup, TelegramMessage } from "../telegram/api.js";
import {
  buildProjectBrowserDirectoryMessage,
  buildProjectBrowserFileInfoMessage,
  buildProjectBrowserImageCaption,
  buildProjectBrowserTextPreviewMessage,
  formatProjectBrowserRootLabel,
  type ParsedCallbackData
} from "../telegram/ui.js";
import type { SessionRow, UiLanguage } from "../types.js";

const DIRECTORY_PAGE_SIZE = 6;
const TEXT_DETECTION_MAX_BYTES = 4096;
const TEXT_PREVIEW_MAX_BYTES = 48 * 1024;
const TEXT_PREVIEW_PAGE_CHAR_LIMIT = 3000;
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

interface BrowserDirectoryEntryState {
  absolutePath: string;
  name: string;
  kind: "directory" | "file" | "symlink";
  sizeBytes: number;
  modifiedAtLabel: string;
}

interface BrowserDirectoryViewState {
  kind: "directory";
  currentPath: string;
  entries: BrowserDirectoryEntryState[];
  page: number;
}

interface BrowserTextPreviewViewState {
  kind: "text_preview";
  directoryPath: string;
  filePath: string;
  fileName: string;
  relativeFilePath: string;
  sizeLabel: string;
  modifiedAtLabel: string;
  pages: string[];
  page: number;
  truncated: boolean;
}

type BrowserViewState = BrowserDirectoryViewState | BrowserTextPreviewViewState;

interface BrowserSessionState {
  token: string;
  chatId: string;
  messageId: number;
  sessionId: string;
  projectPath: string;
  projectRoot: string;
  projectDisplayName: string;
  view: BrowserViewState;
}

interface ProjectBrowserCoordinatorDeps {
  getStore: () => BridgeStateStore | null;
  safeSendMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendHtmlMessage: (
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendHtmlMessageResult: (
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<TelegramMessage | null>;
  safeEditHtmlMessageText: (
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<{ outcome: "edited" } | { outcome: "rate_limited"; retryAfterMs: number } | { outcome: "failed" }>;
  safeDeleteMessage: (chatId: string, messageId: number) => Promise<boolean>;
  safeAnswerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
  safeSendPhoto: (
    chatId: string,
    photoPath: string,
    options?: { caption?: string; parseMode?: "HTML" }
  ) => Promise<boolean>;
  getUiLanguage: () => UiLanguage;
}

function browserCopy(language: UiLanguage) {
  return language === "en"
    ? {
        noSession: "There is no active session. Use /new or /use first.",
        unavailableProject: "The current project directory is unavailable. Re-select the project and try again.",
        expired: "This button has expired. Send /browse again.",
        updateFailed: "Unable to update this browser message. Send /browse again.",
        symlinkUnsupported: "Phase 1 does not support browsing symlinks.",
        imagePreviewSent: "Image preview sent.",
        imagePreviewFailed: "Unable to send this image preview right now.",
        fileInfoFailed: "Unable to inspect this file right now.",
        closeFailed: "Unable to close this browser message right now."
      }
    : {
        noSession: "当前没有活动会话，请先发送 /new 或 /use 进入项目。",
        unavailableProject: "当前项目目录不可用，请重新选择项目后再试。",
        expired: "这个按钮已过期，请重新发送 /browse。",
        updateFailed: "当前无法更新这个浏览消息，请重新发送 /browse。",
        symlinkUnsupported: "Phase 1 暂不支持浏览符号链接。",
        imagePreviewSent: "已发送图片预览。",
        imagePreviewFailed: "暂时无法发送这张图片预览，请稍后重试。",
        fileInfoFailed: "暂时无法读取这个文件，请稍后重试。",
        closeFailed: "当前无法关闭这个浏览消息。"
      };
}

function projectDisplayName(session: Pick<SessionRow, "projectName" | "projectAlias">): string {
  return session.projectAlias?.trim() || session.projectName;
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeRelativePath(rootPath: string, targetPath: string): string {
  const relativePath = relative(rootPath, targetPath);
  return relativePath.split(sep).join("/");
}

function formatBrowserRelativePath(rootPath: string, targetPath: string, language: UiLanguage): string {
  const rootLabel = formatProjectBrowserRootLabel(language);
  const relativePath = normalizeRelativePath(rootPath, targetPath);
  return relativePath ? `${rootLabel}/${relativePath}` : rootLabel;
}

function formatByteSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = sizeBytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

function formatTimestampLabel(valueMs: number): string {
  return new Date(valueMs).toISOString();
}

function paginatePreviewText(text: string): string[] {
  if (text.length === 0) {
    return [""];
  }

  const pages: string[] = [];
  for (let start = 0; start < text.length; start += TEXT_PREVIEW_PAGE_CHAR_LIMIT) {
    pages.push(text.slice(start, start + TEXT_PREVIEW_PAGE_CHAR_LIMIT));
  }
  return pages;
}

function classifyDirectoryEntrySortRank(kind: BrowserDirectoryEntryState["kind"]): number {
  switch (kind) {
    case "directory":
      return 0;
    case "file":
      return 1;
    case "symlink":
      return 2;
  }
}

function looksLikeTextBuffer(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return false;
  }

  return !buffer.toString("utf8").includes("\uFFFD");
}

export class ProjectBrowserCoordinator {
  private readonly browseStates = new Map<string, BrowserSessionState>();

  constructor(private readonly deps: ProjectBrowserCoordinatorDeps) {}

  async handleBrowse(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    const language = this.deps.getUiLanguage();
    const copy = browserCopy(language);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, copy.noSession);
      return;
    }

    const projectRoot = await this.resolveProjectRoot(activeSession.projectPath);
    if (!projectRoot) {
      await this.deps.safeSendMessage(chatId, copy.unavailableProject);
      return;
    }

    const token = this.createBrowseToken();
    const state: BrowserSessionState = {
      token,
      chatId,
      messageId: 0,
      sessionId: activeSession.sessionId,
      projectPath: activeSession.projectPath,
      projectRoot,
      projectDisplayName: projectDisplayName(activeSession),
      view: {
        kind: "directory",
        currentPath: projectRoot,
        entries: [],
        page: 0
      }
    };

    const rendered = await this.renderDirectoryState(state, projectRoot, 0);
    if (!rendered) {
      await this.deps.safeSendMessage(chatId, copy.unavailableProject);
      return;
    }

    const sent = await this.deps.safeSendHtmlMessageResult(chatId, rendered.text, rendered.replyMarkup);
    if (!sent) {
      return;
    }

    state.messageId = sent.message_id;
    this.browseStates.set(token, state);
  }

  async handleBrowseCallback(
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
    const state = this.getValidatedState(parsed.token, chatId, messageId);
    const language = this.deps.getUiLanguage();
    const copy = browserCopy(language);
    if (!state) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, copy.expired);
      return;
    }

    switch (parsed.kind) {
      case "browse_open":
        await this.handleOpenEntry(callbackQueryId, state, parsed.entryIndex, language);
        return;
      case "browse_page":
        await this.deps.safeAnswerCallbackQuery(callbackQueryId);
        await this.handlePageChange(state, parsed.page, language);
        return;
      case "browse_up":
        await this.deps.safeAnswerCallbackQuery(callbackQueryId);
        await this.handleUp(state, language);
        return;
      case "browse_root":
        await this.deps.safeAnswerCallbackQuery(callbackQueryId);
        await this.handleRoot(state, language);
        return;
      case "browse_refresh":
        await this.deps.safeAnswerCallbackQuery(callbackQueryId);
        await this.handleRefresh(state, language);
        return;
      case "browse_back":
        await this.deps.safeAnswerCallbackQuery(callbackQueryId);
        await this.handleBack(state, language);
        return;
      case "browse_close":
        if (await this.deps.safeDeleteMessage(chatId, messageId)) {
          this.browseStates.delete(state.token);
          await this.deps.safeAnswerCallbackQuery(callbackQueryId);
          return;
        }
        await this.deps.safeAnswerCallbackQuery(callbackQueryId, copy.closeFailed);
        return;
    }
  }

  private getValidatedState(token: string, chatId: string, messageId: number): BrowserSessionState | null {
    const state = this.browseStates.get(token);
    if (!state || state.chatId !== chatId || state.messageId !== messageId) {
      return null;
    }

    const store = this.deps.getStore();
    const activeSession = store?.getActiveSession(chatId) ?? null;
    if (!activeSession || activeSession.sessionId !== state.sessionId || activeSession.projectPath !== state.projectPath) {
      this.browseStates.delete(token);
      return null;
    }

    return state;
  }

  private async handleOpenEntry(
    callbackQueryId: string,
    state: BrowserSessionState,
    entryIndex: number,
    language: UiLanguage
  ): Promise<void> {
    const copy = browserCopy(language);
    if (state.view.kind !== "directory") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, copy.expired);
      return;
    }

    const entry = state.view.entries[entryIndex];
    if (!entry) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, copy.expired);
      return;
    }

    if (entry.kind === "symlink") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, copy.symlinkUnsupported);
      return;
    }

    if (entry.kind === "directory") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      await this.handleDirectoryOpen(state, entry.absolutePath, 0, language);
      return;
    }

    const preview = await this.readFilePreview(entry.absolutePath);
    if (!preview) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, copy.fileInfoFailed);
      return;
    }

    if (preview.kind === "image") {
      const sent = await this.deps.safeSendPhoto(state.chatId, entry.absolutePath, {
        caption: buildProjectBrowserImageCaption({
          language,
          projectName: state.projectDisplayName,
          relativeFilePath: formatBrowserRelativePath(state.projectRoot, entry.absolutePath, language),
          fileName: entry.name,
          sizeLabel: formatByteSize(entry.sizeBytes)
        }),
        parseMode: "HTML"
      });
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, sent ? copy.imagePreviewSent : copy.imagePreviewFailed);
      return;
    }

    if (preview.kind === "binary") {
      const sent = await this.deps.safeSendHtmlMessage(
        state.chatId,
        buildProjectBrowserFileInfoMessage({
          language,
          projectName: state.projectDisplayName,
          relativeFilePath: formatBrowserRelativePath(state.projectRoot, entry.absolutePath, language),
          fileName: entry.name,
          sizeLabel: formatByteSize(entry.sizeBytes),
          modifiedAtLabel: entry.modifiedAtLabel
        })
      );
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, sent ? undefined : copy.fileInfoFailed);
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    state.view = {
      kind: "text_preview",
      directoryPath: state.view.currentPath,
      filePath: entry.absolutePath,
      fileName: entry.name,
      relativeFilePath: formatBrowserRelativePath(state.projectRoot, entry.absolutePath, language),
      sizeLabel: formatByteSize(entry.sizeBytes),
      modifiedAtLabel: entry.modifiedAtLabel,
      pages: preview.pages,
      page: 0,
      truncated: preview.truncated
    };
    await this.renderExistingState(state, language);
  }

  private async handlePageChange(state: BrowserSessionState, page: number, language: UiLanguage): Promise<void> {
    if (state.view.kind === "directory") {
      state.view.page = page;
      await this.renderExistingState(state, language);
      return;
    }

    state.view.page = clampPage(page, state.view.pages.length);
    await this.renderExistingState(state, language);
  }

  private async handleUp(state: BrowserSessionState, language: UiLanguage): Promise<void> {
    if (state.view.kind !== "directory") {
      return;
    }

    const parentPath = resolve(state.view.currentPath, "..");
    const nextPath = isPathWithinRoot(state.projectRoot, parentPath) ? parentPath : state.projectRoot;
    await this.handleDirectoryOpen(state, nextPath, 0, language);
  }

  private async handleRoot(state: BrowserSessionState, language: UiLanguage): Promise<void> {
    await this.handleDirectoryOpen(state, state.projectRoot, 0, language);
  }

  private async handleRefresh(state: BrowserSessionState, language: UiLanguage): Promise<void> {
    if (state.view.kind === "directory") {
      await this.handleDirectoryOpen(state, state.view.currentPath, state.view.page, language);
      return;
    }

    const currentPage = state.view.page;
    const preview = await this.readFilePreview(state.view.filePath);
    if (!preview || preview.kind !== "text") {
      return;
    }

    state.view.pages = preview.pages;
    state.view.truncated = preview.truncated;
    state.view.page = clampPage(currentPage, preview.pages.length);
    await this.renderExistingState(state, language);
  }

  private async handleBack(state: BrowserSessionState, language: UiLanguage): Promise<void> {
    if (state.view.kind !== "text_preview") {
      return;
    }

    await this.handleDirectoryOpen(state, state.view.directoryPath, 0, language);
  }

  private async handleDirectoryOpen(
    state: BrowserSessionState,
    directoryPath: string,
    page: number,
    language: UiLanguage
  ): Promise<void> {
    const rendered = await this.renderDirectoryState(state, directoryPath, page);
    if (!rendered) {
      this.browseStates.delete(state.token);
      await this.deps.safeSendMessage(state.chatId, browserCopy(language).updateFailed);
      return;
    }

    await this.editStateMessage(state, rendered.text, rendered.replyMarkup, language);
  }

  private async renderExistingState(state: BrowserSessionState, language: UiLanguage): Promise<void> {
    const rendered = this.buildRenderedState(state, language);
    await this.editStateMessage(state, rendered.text, rendered.replyMarkup, language);
  }

  private async renderDirectoryState(
    state: BrowserSessionState,
    directoryPath: string,
    page: number
  ): Promise<{ text: string; replyMarkup: TelegramInlineKeyboardMarkup } | null> {
    const language = this.deps.getUiLanguage();
    const entries = await this.readDirectoryEntries(state.projectRoot, directoryPath);
    if (!entries) {
      return null;
    }

    state.view = {
      kind: "directory",
      currentPath: directoryPath,
      entries,
      page: clampPage(page, Math.max(1, Math.ceil(entries.length / DIRECTORY_PAGE_SIZE)))
    };

    return this.buildRenderedState(state, language);
  }

  private buildRenderedState(
    state: BrowserSessionState,
    language: UiLanguage
  ): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } {
    if (state.view.kind === "directory") {
      const totalPages = Math.max(1, Math.ceil(state.view.entries.length / DIRECTORY_PAGE_SIZE));
      const page = clampPage(state.view.page, totalPages);
      state.view.page = page;
      const pageEntries = state.view.entries.slice(page * DIRECTORY_PAGE_SIZE, (page + 1) * DIRECTORY_PAGE_SIZE);

      return buildProjectBrowserDirectoryMessage({
        language,
        token: state.token,
        projectName: state.projectDisplayName,
        relativePathLabel: formatBrowserRelativePath(state.projectRoot, state.view.currentPath, language),
        page,
        totalPages,
        entries: pageEntries.map((entry, index) => ({
          index: page * DIRECTORY_PAGE_SIZE + index,
          name: entry.name,
          kind: entry.kind,
          sizeLabel: entry.kind === "file" ? formatByteSize(entry.sizeBytes) : null
        })),
        canGoUp: state.view.currentPath !== state.projectRoot
      });
    }

    const totalPages = Math.max(1, state.view.pages.length);
    const page = clampPage(state.view.page, totalPages);
    state.view.page = page;
    return buildProjectBrowserTextPreviewMessage({
      language,
      token: state.token,
      projectName: state.projectDisplayName,
      relativeFilePath: state.view.relativeFilePath,
      fileName: state.view.fileName,
      sizeLabel: state.view.sizeLabel,
      modifiedAtLabel: state.view.modifiedAtLabel,
      page,
      totalPages,
      pageText: state.view.pages[page] ?? "",
      truncated: state.view.truncated
    });
  }

  private async editStateMessage(
    state: BrowserSessionState,
    text: string,
    replyMarkup: TelegramInlineKeyboardMarkup,
    language: UiLanguage
  ): Promise<void> {
    const result = await this.deps.safeEditHtmlMessageText(state.chatId, state.messageId, text, replyMarkup);
    if (result.outcome === "edited") {
      return;
    }

    this.browseStates.delete(state.token);
    await this.deps.safeSendMessage(state.chatId, browserCopy(language).updateFailed);
  }

  private async resolveProjectRoot(projectPath: string): Promise<string | null> {
    try {
      const resolved = await realpath(projectPath);
      const stats = await lstat(resolved);
      return stats.isDirectory() ? resolved : null;
    } catch {
      return null;
    }
  }

  private async readDirectoryEntries(
    projectRoot: string,
    directoryPath: string
  ): Promise<BrowserDirectoryEntryState[] | null> {
    if (!isPathWithinRoot(projectRoot, directoryPath)) {
      return null;
    }

    try {
      const stats = await lstat(directoryPath);
      if (!stats.isDirectory()) {
        return null;
      }

      const entries = await readdir(directoryPath, { withFileTypes: true });
      const results = await Promise.all(entries.map(async (entry) => {
        const absolutePath = resolve(directoryPath, entry.name);
        if (!isPathWithinRoot(projectRoot, absolutePath)) {
          return null;
        }

        const entryStats = await lstat(absolutePath);
        const kind = entryStats.isSymbolicLink()
          ? "symlink"
          : entryStats.isDirectory()
            ? "directory"
            : "file";

        return {
          absolutePath,
          name: entry.name,
          kind,
          sizeBytes: entryStats.size,
          modifiedAtLabel: formatTimestampLabel(entryStats.mtimeMs)
        } satisfies BrowserDirectoryEntryState;
      }));

      return results
        .filter((entry): entry is BrowserDirectoryEntryState => entry !== null)
        .sort((left, right) => {
          const leftRank = classifyDirectoryEntrySortRank(left.kind);
          const rightRank = classifyDirectoryEntrySortRank(right.kind);
          if (leftRank !== rightRank) {
            return leftRank - rightRank;
          }

          return left.name.localeCompare(right.name, "en", { sensitivity: "base" });
        });
    } catch {
      return null;
    }
  }

  private async readFilePreview(filePath: string): Promise<
    | { kind: "image" }
    | { kind: "binary" }
    | { kind: "text"; pages: string[]; truncated: boolean }
    | null
  > {
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile()) {
        return null;
      }

      const extension = extname(filePath).toLowerCase();
      if (SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
        return { kind: "image" };
      }

      const fileHandle = await open(filePath, "r");
      try {
        const detectionLength = Math.min(TEXT_DETECTION_MAX_BYTES, stats.size);
        const detectionBuffer = Buffer.alloc(detectionLength);
        if (detectionLength > 0) {
          await fileHandle.read(detectionBuffer, 0, detectionLength, 0);
        }

        if (!looksLikeTextBuffer(detectionBuffer)) {
          return { kind: "binary" };
        }

        const previewLength = Math.min(TEXT_PREVIEW_MAX_BYTES, stats.size);
        const previewBuffer = Buffer.alloc(previewLength);
        if (previewLength > 0) {
          await fileHandle.read(previewBuffer, 0, previewLength, 0);
        }

        const previewText = previewBuffer.toString("utf8");
        if (previewText.includes("\uFFFD")) {
          return { kind: "binary" };
        }

        return {
          kind: "text",
          pages: paginatePreviewText(previewText),
          truncated: stats.size > TEXT_PREVIEW_MAX_BYTES
        };
      } finally {
        await fileHandle.close();
      }
    } catch {
      return null;
    }
  }

  private createBrowseToken(): string {
    return randomBytes(6).toString("base64url");
  }
}

function clampPage(page: number, totalPages: number): number {
  return Math.min(Math.max(page, 0), Math.max(totalPages - 1, 0));
}
