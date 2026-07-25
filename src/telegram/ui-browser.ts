import type { UiLanguage } from "../types.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import {
  encodeBrowseBackCallback,
  encodeBrowseCloseCallback,
  encodeBrowseOpenCallback,
  encodeBrowsePageCallback,
  encodeBrowseRefreshCallback,
  encodeBrowseRootCallback,
  encodeBrowseUseCurrentDirCallback,
  encodeBrowseUseCurrentDirCancelCallback,
  encodeBrowseUseCurrentDirConfirmCallback,
  encodeBrowseUpCallback
} from "./ui-callbacks.js";
import { escapeHtml, formatHtmlField, formatHtmlHeading } from "./ui-shared.js";

export interface ProjectBrowserDirectoryEntryView {
  index: number;
  name: string;
  kind: "directory" | "file" | "symlink";
  sizeLabel: string | null;
}

function browserCopy(language: UiLanguage) {
  return language === "en"
    ? {
        title: "File Browser",
        project: "Project:",
        location: "Location:",
        page: "Page:",
        mode: "Mode:",
        readonly: "Read-only browser",
        root: "Project Root",
        empty: "This directory is empty.",
        previous: "Previous",
        next: "Next",
        up: "Up",
        backToRoot: "Project Root",
        refresh: "Refresh",
        useCurrentDirectory: "Use Current Directory",
        close: "Close",
        previewTitle: "File Preview",
        file: "File:",
        path: "Path:",
        size: "Size:",
        modified: "Modified:",
        previewPage: "Preview Page:",
        previewTruncated: "Previewing only the first 48 KB.",
        returnToDirectory: "Back to Directory",
        infoTitle: "File Info",
        type: "Type:",
        binary: "Binary or unsupported preview",
        imagePreview: "Image Preview"
      }
    : {
        title: "文件浏览",
        project: "Project: ",
        location: "当前位置：",
        page: "Page: ",
        mode: "Mode: ",
        readonly: "只读浏览",
        root: "Project Root",
        empty: "当前目录为空。",
        previous: "Prev",
        next: "Next",
        up: "Up",
        backToRoot: "回到项目根",
        refresh: "Refresh",
        useCurrentDirectory: "在当前目录新建会话",
        close: "Close",
        previewTitle: "文件预览",
        file: "File: ",
        path: "Path: ",
        size: "Size: ",
        modified: "修改时间：",
        previewPage: "预览页：",
        previewTruncated: "仅预览前 48 KB。",
        returnToDirectory: "返回目录",
        infoTitle: "文件信息",
        type: "Type: ",
        binary: "二进制或暂不支持预览",
        imagePreview: "图片预览"
      };
}

function entryListLabel(entry: ProjectBrowserDirectoryEntryView): string {
  switch (entry.kind) {
    case "directory":
      return `${entry.name}/`;
    case "symlink":
      return `${entry.name} @`;
    case "file":
      return entry.name;
  }
}

function entryButtonLabel(entry: ProjectBrowserDirectoryEntryView): string {
  return entry.kind === "directory" ? `${entry.name}/` : entry.name;
}

export function buildProjectBrowserDirectoryMessage(options: {
  language?: UiLanguage;
  token: string;
  projectName: string;
  relativePathLabel: string;
  page: number;
  totalPages: number;
  entries: ProjectBrowserDirectoryEntryView[];
  canGoUp: boolean;
  allowUseCurrentDirectory?: boolean;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const language = options.language ?? "zh";
  const copy = browserCopy(language);
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = options.entries.map((entry) => [{
    text: entryButtonLabel(entry),
    callback_data: encodeBrowseOpenCallback(options.token, entry.index)
  }]);

  const pagerRow: Array<{ text: string; callback_data: string }> = [];
  if (options.page > 0) {
    pagerRow.push({
      text: copy.previous,
      callback_data: encodeBrowsePageCallback(options.token, options.page - 1)
    });
  }
  if (options.page + 1 < options.totalPages) {
    pagerRow.push({
      text: copy.next,
      callback_data: encodeBrowsePageCallback(options.token, options.page + 1)
    });
  }
  if (pagerRow.length > 0) {
    rows.push(pagerRow);
  }

  if (options.canGoUp) {
    rows.push([
      { text: copy.up, callback_data: encodeBrowseUpCallback(options.token) },
      { text: copy.backToRoot, callback_data: encodeBrowseRootCallback(options.token) }
    ]);
  } else {
    rows.push([{ text: copy.backToRoot, callback_data: encodeBrowseRootCallback(options.token) }]);
  }

  if (options.allowUseCurrentDirectory) {
    rows.push([{ text: copy.useCurrentDirectory, callback_data: encodeBrowseUseCurrentDirCallback(options.token) }]);
  }

  rows.push([
    { text: copy.refresh, callback_data: encodeBrowseRefreshCallback(options.token) },
    { text: copy.close, callback_data: encodeBrowseCloseCallback(options.token) }
  ]);

  const lines = [
    formatHtmlHeading(copy.title),
    formatHtmlField(copy.project, options.projectName),
    formatHtmlField(copy.location, options.relativePathLabel),
    formatHtmlField(copy.page, `${options.page + 1}/${options.totalPages}`),
    formatHtmlField(copy.mode, copy.readonly)
  ];

  if (options.entries.length === 0) {
    lines.push("", copy.empty);
  } else {
    for (const [index, entry] of options.entries.entries()) {
      const details = entry.sizeLabel && entry.kind === "file" ? ` · ${entry.sizeLabel}` : "";
      lines.push("", `${index + 1}. ${escapeHtml(entryListLabel(entry))}${escapeHtml(details)}`);
    }
  }

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildProjectBrowserUseCurrentDirectoryConfirmMessage(options: {
  token: string;
  projectName: string;
  directoryPath: string;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: [
      formatHtmlHeading("Confirm"),
      formatHtmlField("Dir: ", options.directoryPath),
      formatHtmlField("显示名：", options.projectName),
      "要在This 目录新建会话吗？"
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "Confirm", callback_data: encodeBrowseUseCurrentDirConfirmCallback(options.token) }],
        [{ text: "返回目录", callback_data: encodeBrowseUseCurrentDirCancelCallback(options.token) }]
      ]
    }
  };
}

export function buildProjectBrowserTextPreviewMessage(options: {
  language?: UiLanguage;
  token: string;
  projectName: string;
  relativeFilePath: string;
  fileName: string;
  sizeLabel: string;
  modifiedAtLabel: string;
  page: number;
  totalPages: number;
  pageText: string;
  truncated: boolean;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const language = options.language ?? "zh";
  const copy = browserCopy(language);
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  const pagerRow: Array<{ text: string; callback_data: string }> = [];

  if (options.page > 0) {
    pagerRow.push({
      text: copy.previous,
      callback_data: encodeBrowsePageCallback(options.token, options.page - 1)
    });
  }
  if (options.page + 1 < options.totalPages) {
    pagerRow.push({
      text: copy.next,
      callback_data: encodeBrowsePageCallback(options.token, options.page + 1)
    });
  }
  if (pagerRow.length > 0) {
    rows.push(pagerRow);
  }

  rows.push([{ text: copy.returnToDirectory, callback_data: encodeBrowseBackCallback(options.token) }]);

  const lines = [
    formatHtmlHeading(copy.previewTitle),
    formatHtmlField(copy.project, options.projectName),
    formatHtmlField(copy.file, options.fileName),
    formatHtmlField(copy.path, options.relativeFilePath),
    formatHtmlField(copy.size, options.sizeLabel),
    formatHtmlField(copy.modified, options.modifiedAtLabel),
    formatHtmlField(copy.previewPage, `${options.page + 1}/${options.totalPages}`)
  ];

  if (options.truncated) {
    lines.push(copy.previewTruncated);
  }

  lines.push("", `<pre>${escapeHtml(options.pageText)}</pre>`);

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildProjectBrowserFileInfoMessage(options: {
  language?: UiLanguage;
  projectName: string;
  relativeFilePath: string;
  fileName: string;
  sizeLabel: string;
  modifiedAtLabel: string;
}): string {
  const language = options.language ?? "zh";
  const copy = browserCopy(language);

  return [
    formatHtmlHeading(copy.infoTitle),
    formatHtmlField(copy.project, options.projectName),
    formatHtmlField(copy.file, options.fileName),
    formatHtmlField(copy.path, options.relativeFilePath),
    formatHtmlField(copy.size, options.sizeLabel),
    formatHtmlField(copy.modified, options.modifiedAtLabel),
    formatHtmlField(copy.type, copy.binary)
  ].join("\n");
}

export function buildProjectBrowserImageCaption(options: {
  language?: UiLanguage;
  projectName: string;
  relativeFilePath: string;
  fileName: string;
  sizeLabel: string;
}): string {
  const language = options.language ?? "zh";
  const copy = browserCopy(language);

  return [
    formatHtmlHeading(copy.imagePreview),
    formatHtmlField(copy.project, options.projectName),
    formatHtmlField(copy.file, options.fileName),
    formatHtmlField(copy.path, options.relativeFilePath),
    formatHtmlField(copy.size, options.sizeLabel)
  ].join("\n");
}

export function formatProjectBrowserRootLabel(language: UiLanguage = "zh"): string {
  return browserCopy(language).root;
}
