import type { StreamBlock, StreamSnapshot } from "../activity/types.js";
import { truncateText } from "../util/text.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import {
  encodeFinalAnswerCloseCallback,
  encodeFinalAnswerOpenCallback,
  encodeFinalAnswerPageCallback,
  encodePlanImplementCallback,
  encodePlanResultCloseCallback,
  encodePlanResultOpenCallback,
  encodePlanResultPageCallback
} from "./ui-callbacks.js";
import { escapeHtml } from "./ui-shared.js";

type FinalAnswerBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[]; ordered: boolean; startIndex: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string; language: string | null };

const FINAL_ANSWER_CONTINUATION_PREFIX_BUDGET = 12;
const FINAL_ANSWER_PREVIEW_MAX_CHARS = 350;
const FINAL_ANSWER_PREVIEW_MAX_BLOCKS = 3;
const STREAM_CHAR_LIMIT = 4000;
const STREAM_BLOCK_TEXT_LIMIT = 200;

export interface FinalAnswerViewRender {
  previewHtml: string;
  pages: string[];
  truncated: boolean;
}

export function renderFinalAnswerHtmlChunks(
  markdown: string,
  maxChars: number,
  options?: {
    prefixContinuations?: boolean;
  }
): string[] {
  const safeLimit = Math.max(1, maxChars - FINAL_ANSWER_CONTINUATION_PREFIX_BUDGET);
  const blocks = parseFinalAnswerBlocks(markdown)
    .flatMap((block) => splitFinalAnswerBlock(block, safeLimit));

  if (blocks.length === 0) {
    return [escapeHtml(markdown)];
  }

  const renderedBlocks = blocks.map((block) => renderFinalAnswerBlock(block));
  const chunks: string[] = [];
  let currentChunk = "";

  for (const rendered of renderedBlocks) {
    const nextChunk = currentChunk ? `${currentChunk}\n\n${rendered}` : rendered;
    if (nextChunk.length <= safeLimit) {
      currentChunk = nextChunk;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = rendered;
      continue;
    }

    chunks.push(rendered);
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  if (options?.prefixContinuations === false) {
    return chunks;
  }

  return chunks.map((chunk, index) => {
    if (index === 0) {
      return chunk;
    }

    return `(${index + 1}/${chunks.length}) ${chunk}`;
  });
}

export function buildCollapsibleFinalAnswerView(
  markdown: string,
  options?: {
    sessionName?: string | null;
    projectName?: string | null;
  }
): FinalAnswerViewRender {
  const headerHtml = buildFinalAnswerIdentityHeader(options);
  const rawPages = renderFinalAnswerHtmlChunks(markdown, 3000, { prefixContinuations: false });
  const pages = rawPages.map((page, index) => {
    const parts: string[] = [];
    if (headerHtml) {
      parts.push(headerHtml);
    }
    if (rawPages.length > 1) {
      parts.push(`<i>第 ${index + 1}/${rawPages.length} 页</i>`);
    }
    if (page) {
      parts.push(page);
    }
    return parts.join("\n\n");
  });
  const preview = renderCollapsedFinalAnswerPreview(markdown);

  if (!preview.truncated) {
    return {
      previewHtml: pages[0] ?? (headerHtml || escapeHtml(markdown)),
      pages,
      truncated: false
    };
  }

  const note = rawPages.length > 1
    ? `已折叠，共 ${rawPages.length} 页，点击“展开全文”查看。`
    : "已折叠，点击“展开全文”查看剩余内容。";

  return {
    previewHtml: [
      headerHtml,
      preview.html,
      `<i>${escapeHtml(note)}</i>`
    ].filter((part) => part.length > 0).join("\n\n"),
    pages,
    truncated: true
  };
}

export function buildFinalAnswerReplyMarkup(options: {
  answerId: string;
  totalPages: number;
  expanded: boolean;
  currentPage?: number;
  extraRows?: Array<Array<{ text: string; callback_data: string }>>;
}): TelegramInlineKeyboardMarkup {
  if (!options.expanded) {
    return {
      inline_keyboard: [
        ...(options.extraRows ?? []),
        [{
          text: "展开全文",
          callback_data: encodeFinalAnswerOpenCallback(options.answerId)
        }]
      ]
    };
  }

  const buttons: Array<{ text: string; callback_data: string }> = [];
  if (options.totalPages > 1 && options.currentPage && options.currentPage > 1) {
    buttons.push({
      text: "上一页",
      callback_data: encodeFinalAnswerPageCallback(options.answerId, options.currentPage - 1)
    });
  }

  if (options.totalPages > 1 && options.currentPage && options.currentPage < options.totalPages) {
    buttons.push({
      text: "下一页",
      callback_data: encodeFinalAnswerPageCallback(options.answerId, options.currentPage + 1)
    });
  }

  buttons.push({
    text: "收起",
    callback_data: encodeFinalAnswerCloseCallback(options.answerId)
  });

  return {
    inline_keyboard: [
      ...(options.extraRows ?? []),
      buttons
    ]
  };
}

export function buildPlanResultActionRows(answerId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: "实施这个计划", callback_data: encodePlanImplementCallback(answerId) }
  ]];
}

export function buildPlanResultReplyMarkup(options: {
  answerId: string;
  totalPages: number;
  expanded: boolean;
  currentPage?: number;
  primaryActionConsumed?: boolean;
}): TelegramInlineKeyboardMarkup {
  const actionRows = options.primaryActionConsumed ? [] : buildPlanResultActionRows(options.answerId);
  if (!options.expanded) {
    return {
      inline_keyboard: [
        ...actionRows,
        [{
          text: "展开方案",
          callback_data: encodePlanResultOpenCallback(options.answerId)
        }]
      ]
    };
  }

  const buttons: Array<{ text: string; callback_data: string }> = [];
  if (options.totalPages > 1 && options.currentPage && options.currentPage > 1) {
    buttons.push({
      text: "上一页",
      callback_data: encodePlanResultPageCallback(options.answerId, options.currentPage - 1)
    });
  }
  if (options.totalPages > 1 && options.currentPage && options.currentPage < options.totalPages) {
    buttons.push({
      text: "下一页",
      callback_data: encodePlanResultPageCallback(options.answerId, options.currentPage + 1)
    });
  }
  buttons.push({
    text: "收起方案",
    callback_data: encodePlanResultCloseCallback(options.answerId)
  });

  return {
    inline_keyboard: [
      ...actionRows,
      buttons
    ]
  };
}

export function buildPlanResultConsumedNotice(): string {
  return "<i>已开始实施。</i>";
}

export function renderStreamBlock(block: StreamBlock): string {
  switch (block.kind) {
    case "commentary":
      return escapeHtml(truncateText(block.text, STREAM_BLOCK_TEXT_LIMIT));
    case "tool_summary":
      return `<i>${escapeHtml(truncateText(block.text, STREAM_BLOCK_TEXT_LIMIT))}</i>`;
    case "command": {
      const cmd = escapeHtml(truncateText(block.text, STREAM_BLOCK_TEXT_LIMIT));
      const detail = block.detail ? `\n${escapeHtml(truncateText(block.detail, STREAM_BLOCK_TEXT_LIMIT))}` : "";
      return `<code>${cmd}</code>${detail}`;
    }
    case "file_change":
      return `<i>${escapeHtml(truncateText(block.text, STREAM_BLOCK_TEXT_LIMIT))}</i>`;
    case "plan": {
      const lines = block.text.split("\n").map((line) => `  ${escapeHtml(truncateText(line.trim(), STREAM_BLOCK_TEXT_LIMIT))}`);
      return `<i>${lines.join("\n")}</i>`;
    }
    case "status":
      return `<b>${escapeHtml(block.text)}</b>`;
    case "error":
      return `<b>Error:</b> ${escapeHtml(truncateText(block.text, STREAM_BLOCK_TEXT_LIMIT))}`;
    case "completion": {
      const durationText = block.durationSec != null ? ` (${formatDuration(block.durationSec)})` : "";
      return `<i>${escapeHtml(block.text)}${durationText}</i>`;
    }
    default:
      return escapeHtml(truncateText(block.text, STREAM_BLOCK_TEXT_LIMIT));
  }
}

export function buildStreamMessageHtml(
  snapshot: StreamSnapshot,
  options?: {
    sessionName?: string | null;
    projectName?: string | null;
    fromBlock?: number;
  }
): { html: string; renderedBlockCount: number; truncated: boolean } {
  const fromBlock = options?.fromBlock ?? 0;
  const parts: string[] = [];

  if (fromBlock === 0) {
    const headerParts: string[] = [];
    if (options?.sessionName) {
      headerParts.push(escapeHtml(options.sessionName));
    }
    if (options?.projectName && options.projectName !== options?.sessionName) {
      headerParts.push(escapeHtml(options.projectName));
    }
    if (headerParts.length > 0) {
      parts.push(`<b>${headerParts.join(" / ")}</b>`);
    }
  }

  let renderedCount = 0;
  let truncated = false;

  for (let i = fromBlock; i < snapshot.blocks.length; i += 1) {
    const rendered = renderStreamBlock(snapshot.blocks[i]!);
    const candidateLength = parts.join("\n").length + 1 + rendered.length + 80;
    if (candidateLength > STREAM_CHAR_LIMIT && renderedCount > 0) {
      truncated = true;
      break;
    }
    parts.push(rendered);
    renderedCount += 1;
  }

  const footer = buildStreamStatusFooter(snapshot.activeStatusLine);
  if (footer) {
    parts.push(footer);
  }

  return {
    html: parts.join("\n"),
    renderedBlockCount: renderedCount,
    truncated
  };
}

export function buildStreamStatusFooter(statusLine: string | null): string {
  if (!statusLine) {
    return "";
  }
  return `\n<b>▸</b> ${escapeHtml(truncateText(statusLine, STREAM_BLOCK_TEXT_LIMIT))}`;
}

function buildFinalAnswerIdentityHeader(options?: {
  sessionName?: string | null;
  projectName?: string | null;
}): string {
  const sessionName = options?.sessionName?.trim();
  const projectName = options?.projectName?.trim();
  const headerParts: string[] = [];

  if (sessionName) {
    headerParts.push(escapeHtml(sessionName));
  }
  if (projectName && projectName !== sessionName) {
    headerParts.push(escapeHtml(projectName));
  }

  return headerParts.length > 0 ? `<b>${headerParts.join(" / ")}</b>` : "";
}

export function renderInlineMarkdown(text: string): string {
  let result = "";

  for (let index = 0; index < text.length;) {
    const next = text[index] ?? "";

    if (next === "\n") {
      result += "\n";
      index += 1;
      continue;
    }

    if (next === "\\" && index + 1 < text.length) {
      result += escapeHtml(text[index + 1] ?? "");
      index += 2;
      continue;
    }

    if ((text.startsWith("**", index) || text.startsWith("__", index)) && canOpenInlineMarker(text, index, 2)) {
      const delimiter = text.slice(index, index + 2);
      const closeIndex = findClosingInlineMarker(text, index + 2, delimiter);
      if (closeIndex !== -1) {
        result += `<b>${renderInlineMarkdown(text.slice(index + 2, closeIndex))}</b>`;
        index = closeIndex + 2;
        continue;
      }
    }

    if (text.startsWith("~~", index)) {
      const closeIndex = findClosingInlineMarker(text, index + 2, "~~");
      if (closeIndex !== -1) {
        result += `<s>${renderInlineMarkdown(text.slice(index + 2, closeIndex))}</s>`;
        index = closeIndex + 2;
        continue;
      }
    }

    if (next === "`") {
      const closeIndex = text.indexOf("`", index + 1);
      if (closeIndex !== -1) {
        result += `<code>${escapeHtml(text.slice(index + 1, closeIndex))}</code>`;
        index = closeIndex + 1;
        continue;
      }
    }

    if (next === "[") {
      const labelEnd = text.indexOf("]", index + 1);
      if (labelEnd !== -1 && text[labelEnd + 1] === "(") {
        const urlEnd = findClosingLinkTarget(text, labelEnd + 1);
        if (urlEnd !== -1) {
          const label = text.slice(index + 1, labelEnd);
          const url = text.slice(labelEnd + 2, urlEnd).trim();
          if (isSafeTelegramLink(url)) {
            result += `<a href="${escapeHtmlAttribute(url)}">${renderInlineMarkdown(label)}</a>`;
            index = urlEnd + 1;
            continue;
          }
        }
      }
    }

    if ((next === "*" || next === "_") && canOpenInlineMarker(text, index, 1)) {
      const closeIndex = findClosingInlineMarker(text, index + 1, next);
      if (closeIndex !== -1) {
        result += `<i>${renderInlineMarkdown(text.slice(index + 1, closeIndex))}</i>`;
        index = closeIndex + 1;
        continue;
      }
    }

    result += escapeHtml(next);
    index += 1;
  }

  return result;
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function parseFinalAnswerBlocks(markdown: string): FinalAnswerBlock[] {
  const normalized = markdown.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const lines = normalized.split("\n");
  const blocks: FinalAnswerBlock[] = [];

  for (let index = 0; index < lines.length;) {
    const rawLine = lines[index] ?? "";
    const trimmedLine = rawLine.trim();

    if (trimmedLine.length === 0) {
      index += 1;
      continue;
    }

    if (trimmedLine.startsWith("```")) {
      const language = trimmedLine.slice(3).trim() || null;
      index += 1;
      const codeLines: string[] = [];
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length && (lines[index] ?? "").trim().startsWith("```")) {
        index += 1;
      }
      blocks.push({ kind: "code", text: codeLines.join("\n"), language });
      continue;
    }

    if (/^>\s?/u.test(trimmedLine)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/u.test((lines[index] ?? "").trim())) {
        quoteLines.push((lines[index] ?? "").trim().replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quoteLines.join("\n").trim() });
      continue;
    }

    const headingMatch = trimmedLine.match(/^#{1,6}\s+(.+)$/u);
    if (headingMatch) {
      blocks.push({ kind: "heading", text: headingMatch[1]!.trim() });
      index += 1;
      continue;
    }

    if (/^[-*+]\s+/u.test(trimmedLine) || /^\d+\.\s+/u.test(trimmedLine)) {
      const ordered = /^\d+\.\s+/u.test(trimmedLine);
      const orderedStartMatch = ordered ? trimmedLine.match(/^(\d+)\.\s+/u) : null;
      const items: string[] = [];
      while (index < lines.length) {
        const candidateRaw = lines[index] ?? "";
        const candidate = (lines[index] ?? "").trim();
        if (ordered ? /^\d+\.\s+/u.test(candidate) : /^[-*+]\s+/u.test(candidate)) {
          const stripped = ordered
            ? candidate.replace(/^\d+\.\s+/u, "")
            : candidate.replace(/^[-*+]\s+/u, "");
          items.push(stripped);
          index += 1;
          continue;
        }

        if (items.length > 0 && /^\s{2,}\S/u.test(candidateRaw) && candidate.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]}\n${candidate}`;
          index += 1;
          continue;
        }

        if (candidate.length === 0) {
          break;
        }

        break;
      }

      blocks.push({
        kind: "list",
        items,
        ordered,
        startIndex: orderedStartMatch ? Number.parseInt(orderedStartMatch[1] ?? "1", 10) : 1
      });
      continue;
    }

    const paragraphLines: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      const trimmedCandidate = candidate.trim();
      if (
        trimmedCandidate.length === 0 ||
        trimmedCandidate.startsWith("```") ||
        /^>\s?/u.test(trimmedCandidate) ||
        /^#{1,6}\s+.+$/u.test(trimmedCandidate) ||
        /^[-*+]\s+/u.test(trimmedCandidate) ||
        /^\d+\.\s+/u.test(trimmedCandidate)
      ) {
        break;
      }

      paragraphLines.push(candidate);
      index += 1;
    }

    blocks.push({ kind: "paragraph", text: paragraphLines.join("\n").trim() });
  }

  return blocks;
}

function splitFinalAnswerBlock(block: FinalAnswerBlock, maxChars: number): FinalAnswerBlock[] {
  if (renderFinalAnswerBlock(block).length <= maxChars) {
    return [block];
  }

  switch (block.kind) {
    case "code":
      return splitCodeBlock(block, maxChars);
    case "list":
      return splitListBlock(block, maxChars);
    case "quote":
      return splitTextBlock(block, maxChars, "quote");
    case "paragraph":
      return splitTextBlock(block, maxChars, "paragraph");
    case "heading":
      return splitTextBlock({ kind: "paragraph", text: block.text }, maxChars, "paragraph");
    default:
      return [block];
  }
}

function splitCodeBlock(block: Extract<FinalAnswerBlock, { kind: "code" }>, maxChars: number): FinalAnswerBlock[] {
  const lines = block.text.split("\n");
  const chunks: FinalAnswerBlock[] = [];
  let currentLines: string[] = [];

  for (const line of lines) {
    const nextLines = currentLines.length === 0 ? [line] : [...currentLines, line];
    if (renderFinalAnswerBlock({ ...block, text: nextLines.join("\n") }).length <= maxChars) {
      currentLines = nextLines;
      continue;
    }

    if (currentLines.length > 0) {
      chunks.push({ ...block, text: currentLines.join("\n") });
      currentLines = [line];
      continue;
    }

    const hardSplit = splitLongText(line, Math.max(1, maxChars - 32));
    for (const part of hardSplit) {
      chunks.push({ ...block, text: part });
    }
    currentLines = [];
  }

  if (currentLines.length > 0) {
    chunks.push({ ...block, text: currentLines.join("\n") });
  }

  return chunks;
}

function splitListBlock(block: Extract<FinalAnswerBlock, { kind: "list" }>, maxChars: number): FinalAnswerBlock[] {
  const chunks: FinalAnswerBlock[] = [];
  let currentItems: string[] = [];
  let currentStartIndex = block.startIndex;

  for (const item of block.items) {
    const nextItems = [...currentItems, item];
    if (renderFinalAnswerBlock({ ...block, items: nextItems, startIndex: currentStartIndex }).length <= maxChars) {
      currentItems = nextItems;
      continue;
    }

    if (currentItems.length > 0) {
      chunks.push({ ...block, items: currentItems, startIndex: currentStartIndex });
      currentStartIndex += currentItems.length;
      currentItems = [item];
      continue;
    }

    const splitItems = splitLongText(item, Math.max(1, maxChars - 16));
    for (const splitItem of splitItems) {
      chunks.push({
        ...block,
        items: [splitItem],
        startIndex: currentStartIndex
      });
      currentStartIndex += 1;
    }
    currentItems = [];
  }

  if (currentItems.length > 0) {
    chunks.push({ ...block, items: currentItems, startIndex: currentStartIndex });
  }

  return chunks;
}

function splitTextBlock(
  block: Extract<FinalAnswerBlock, { kind: "paragraph" | "quote" }>,
  maxChars: number,
  kind: "paragraph" | "quote"
): FinalAnswerBlock[] {
  const lines = block.text.split("\n");
  const chunks: FinalAnswerBlock[] = [];
  let currentLines: string[] = [];

  for (const line of lines) {
    const candidateLines = currentLines.length === 0 ? [line] : [...currentLines, line];
    if (renderFinalAnswerBlock({ kind, text: candidateLines.join("\n") }).length <= maxChars) {
      currentLines = candidateLines;
      continue;
    }

    if (currentLines.length > 0) {
      chunks.push({ kind, text: currentLines.join("\n") });
      currentLines = [line];
      continue;
    }

    const hardSplit = splitLongText(line, Math.max(1, maxChars - 16));
    for (const part of hardSplit) {
      chunks.push({ kind, text: part });
    }
    currentLines = [];
  }

  if (currentLines.length > 0) {
    chunks.push({ kind, text: currentLines.join("\n") });
  }

  return chunks;
}

function splitLongText(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return [trimmed];
  }

  const words = trimmed.split(/\s+/u);
  if (words.length <= 1) {
    const slices: string[] = [];
    for (let index = 0; index < trimmed.length; index += maxChars) {
      slices.push(trimmed.slice(index, index + maxChars));
    }
    return slices;
  }

  const parts: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) {
      parts.push(current);
      current = word;
      continue;
    }

    for (const fragment of splitLongText(word, maxChars)) {
      parts.push(fragment);
    }
  }

  if (current) {
    parts.push(current);
  }

  return parts;
}

function renderCollapsedFinalAnswerPreview(markdown: string): { html: string; truncated: boolean } {
  const blocks = parseFinalAnswerBlocks(markdown)
    .flatMap((block) => splitFinalAnswerBlock(block, FINAL_ANSWER_PREVIEW_MAX_CHARS));

  if (blocks.length === 0) {
    const fallback = escapeHtml(markdown);
    return { html: fallback, truncated: false };
  }

  const selected: FinalAnswerBlock[] = [];
  let currentLength = 0;

  for (const block of blocks) {
    const rendered = renderFinalAnswerBlock(block);
    const nextLength = selected.length === 0 ? rendered.length : currentLength + 2 + rendered.length;

    if (selected.length === 0) {
      selected.push(block);
      currentLength = rendered.length;
      continue;
    }

    if (selected.length >= FINAL_ANSWER_PREVIEW_MAX_BLOCKS || nextLength > FINAL_ANSWER_PREVIEW_MAX_CHARS) {
      break;
    }

    selected.push(block);
    currentLength = nextLength;
  }

  const html = selected.map((block) => renderFinalAnswerBlock(block)).join("\n\n");
  return {
    html,
    truncated: selected.length < blocks.length
  };
}

function renderFinalAnswerBlock(block: FinalAnswerBlock): string {
  switch (block.kind) {
    case "heading":
      return `<b>${renderInlineMarkdown(block.text)}</b>`;
    case "paragraph":
      return renderInlineMarkdown(block.text);
    case "quote":
      return `<blockquote>${renderInlineMarkdown(block.text)}</blockquote>`;
    case "list":
      return block.items.map((item, index) => {
        const marker = block.ordered ? `${block.startIndex + index}.` : "•";
        return `${marker} ${renderInlineMarkdown(item)}`;
      }).join("\n");
    case "code": {
      const language = block.language ? ` class="language-${escapeHtmlAttribute(block.language)}"` : "";
      return `<pre><code${language}>${escapeHtml(block.text)}</code></pre>`;
    }
    default:
      return escapeHtml((block as { text?: string }).text ?? "");
  }
}

function isSafeTelegramLink(url: string): boolean {
  return /^(https?:\/\/|mailto:|tg:\/\/)/iu.test(url);
}

function canOpenInlineMarker(text: string, index: number, delimiterLength: number): boolean {
  const next = text[index + delimiterLength] ?? "";
  const previous = index > 0 ? text[index - 1] ?? "" : "";
  return next.length > 0 && !isWhitespaceCharacter(next) && (previous.length === 0 || isInlineBoundary(previous));
}

function findClosingInlineMarker(text: string, fromIndex: number, delimiter: string): number {
  for (let searchIndex = fromIndex; searchIndex < text.length; searchIndex += 1) {
    const closeIndex = text.indexOf(delimiter, searchIndex);
    if (closeIndex === -1) {
      return -1;
    }

    const previous = text[closeIndex - 1] ?? "";
    const next = text[closeIndex + delimiter.length] ?? "";
    if (!isWhitespaceCharacter(previous) && (next.length === 0 || isInlineBoundary(next))) {
      return closeIndex;
    }

    searchIndex = closeIndex + delimiter.length - 1;
  }

  return -1;
}

function findClosingLinkTarget(text: string, openParenIndex: number): number {
  let depth = 0;

  for (let index = openParenIndex; index < text.length; index += 1) {
    const current = text[index] ?? "";
    if (current === "\\") {
      index += 1;
      continue;
    }

    if (current === "(") {
      depth += 1;
      continue;
    }

    if (current === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function isInlineBoundary(value: string): boolean {
  return /[\s.,!?;:()[\]{}<>/"'`~\-+=*|\\/]/u.test(value);
}

function isWhitespaceCharacter(value: string): boolean {
  return /\s/u.test(value);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (remainder === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${remainder}s`;
}
