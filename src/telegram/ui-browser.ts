import type { UiLanguage } from "../types.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import {
  encodeBrowseBackCallback,
  encodeBrowseCloseCallback,
  encodeBrowseOpenCallback,
  encodeBrowsePageCallback,
  encodeBrowseRefreshCallback,
  encodeBrowseRootCallback,
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
        project: "当前项目：",
        location: "当前位置：",
        page: "页码：",
        mode: "模式：",
        readonly: "只读浏览",
        root: "项目根",
        empty: "当前目录为空。",
        previous: "上一页",
        next: "下一页",
        up: "上一级",
        backToRoot: "回到项目根",
        refresh: "刷新",
        close: "关闭",
        previewTitle: "文件预览",
        file: "文件：",
        path: "路径：",
        size: "大小：",
        modified: "修改时间：",
        previewPage: "预览页：",
        previewTruncated: "仅预览前 48 KB。",
        returnToDirectory: "返回目录",
        infoTitle: "文件信息",
        type: "类型：",
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
