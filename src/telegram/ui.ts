import type {
  ProjectCandidate,
  ProjectPickerResult,
  ReadinessSnapshot,
  SessionRow
} from "../types.js";
import type { ActivityStatus, InspectSnapshot, StreamBlock, StreamSnapshot } from "../activity/types.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";

interface RuntimeCardContext {
  sessionName?: string | null;
  projectName?: string | null;
}

export interface RuntimeCommandEntryView {
  commandText: string;
  state: string;
  latestSummary?: string | null;
}

export type ParsedCallbackData =
  | { kind: "pick"; projectKey: string }
  | { kind: "scan_more" }
  | { kind: "path_manual" }
  | { kind: "path_back" }
  | { kind: "path_confirm"; projectKey: string }
  | { kind: "command_list_expand"; sessionId: string }
  | { kind: "command_list_collapse"; sessionId: string };

export function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [commandToken, ...rest] = trimmed.split(/\s+/u);
  if (!commandToken) {
    return null;
  }

  const commandName = commandToken.split("@")[0]?.slice(1).toLowerCase();
  if (!commandName) {
    return null;
  }

  return {
    name: commandName,
    args: rest.join(" ").trim()
  };
}

export function encodePickCallback(projectKey: string): string {
  return `v1:pick:${projectKey}`;
}

export function encodeScanMoreCallback(): string {
  return "v1:scan:more";
}

export function encodePathManualCallback(): string {
  return "v1:path:manual";
}

export function encodePathBackCallback(): string {
  return "v1:path:back";
}

export function encodePathConfirmCallback(projectKey: string): string {
  return `v1:path:confirm:${projectKey}`;
}

export function encodeCommandListExpandCallback(sessionId: string): string {
  return `v1:cmd:expand:${sessionId}`;
}

export function encodeCommandListCollapseCallback(sessionId: string): string {
  return `v1:cmd:collapse:${sessionId}`;
}

export function parseCallbackData(data: string): ParsedCallbackData | null {
  const parts = data.split(":");
  if (parts[0] !== "v1") {
    return null;
  }

  if (parts[1] === "pick" && parts[2]) {
    return { kind: "pick", projectKey: parts[2] };
  }

  if (parts[1] === "scan" && parts[2] === "more") {
    return { kind: "scan_more" };
  }

  if (parts[1] === "path" && parts[2] === "manual") {
    return { kind: "path_manual" };
  }

  if (parts[1] === "path" && parts[2] === "back") {
    return { kind: "path_back" };
  }

  if (parts[1] === "path" && parts[2] === "confirm" && parts[3]) {
    return { kind: "path_confirm", projectKey: parts[3] };
  }

  if (parts[1] === "cmd" && parts[2] === "expand" && parts[3]) {
    return { kind: "command_list_expand", sessionId: parts[3] };
  }

  if (parts[1] === "cmd" && parts[2] === "collapse" && parts[3]) {
    return { kind: "command_list_collapse", sessionId: parts[3] };
  }

  return null;
}

function primaryButtonCopy(candidate: ProjectCandidate): string {
  if (candidate.lastSuccessAt || candidate.lastUsedAt || candidate.hasExistingSession) {
    return `继续上次项目：${candidate.projectName}`;
  }

  return `进入项目：${candidate.projectName}`;
}

export function buildProjectPickerMessage(picker: ProjectPickerResult): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];

  if (picker.primary) {
    rows.push([
      {
        text: primaryButtonCopy(picker.primary),
        callback_data: encodePickCallback(picker.primary.projectKey)
      }
    ]);
  }

  for (const candidate of picker.frequent) {
    rows.push([
      {
        text: candidate.projectName,
        callback_data: encodePickCallback(candidate.projectKey)
      }
    ]);
  }

  rows.push([
    { text: "扫描更多仓库", callback_data: encodeScanMoreCallback() },
    { text: "手动输入路径", callback_data: encodePathManualCallback() }
  ]);

  const lines = [picker.title];
  if (picker.emptyText) {
    lines.push("", picker.emptyText);
  }

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildManualPathPrompt(): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: "请发送项目路径，例如：/home/ubuntu/Repo/openclaw\n发送 /cancel 返回项目列表。",
    replyMarkup: {
      inline_keyboard: [[{ text: "返回项目列表", callback_data: encodePathBackCallback() }]]
    }
  };
}

export function buildManualPathConfirmMessage(candidate: ProjectCandidate): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: `在这个项目中开始会话？\n项目：${candidate.projectName}\n路径：${candidate.projectPath}`,
    replyMarkup: {
      inline_keyboard: [
        [{ text: "确认进入项目", callback_data: encodePathConfirmCallback(candidate.projectKey) }],
        [{ text: "返回项目列表", callback_data: encodePathBackCallback() }]
      ]
    }
  };
}

export function buildNoNewProjectsMessage(): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: "没有发现更多可用项目，请手动输入路径。",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "手动输入路径", callback_data: encodePathManualCallback() }],
        [{ text: "返回项目列表", callback_data: encodePathBackCallback() }]
      ]
    }
  };
}

export function buildStatusText(
  snapshot: ReadinessSnapshot,
  activeSession: SessionRow | null
): string {
  const issueText = snapshot.details.issues.length === 0 ? "无" : snapshot.details.issues.join("；");
  const activeSessionText = activeSession
    ? [
        activeSession.projectName,
        activeSession.displayName,
        formatSessionState(activeSession),
        formatLastTurnSummary(activeSession)
      ]
        .filter((value): value is string => Boolean(value))
        .join(" / ")
    : "无";

  return [
    "服务状态",
    `桥接状态：${snapshot.state}`,
    `Telegram 连通：${snapshot.details.telegramTokenValid ? "正常" : "异常"}`,
    `Codex 可用：${snapshot.details.codexAuthenticated && snapshot.details.appServerAvailable ? "正常" : "异常"}`,
    `当前会话：${activeSessionText}`,
    `最近检查：${snapshot.checkedAt}`,
    `问题：${issueText}`
  ].join("\n");
}

export function buildWhereText(session: SessionRow | null): string {
  if (!session) {
    return "当前没有活动会话。";
  }

  const lines = [
    "当前会话",
    `会话名：${session.displayName}`,
    `项目：${session.projectName}`,
    `路径：${session.projectPath}`,
    `状态：${formatSessionState(session)}`
  ];

  const lastTurnSummary = formatLastTurnSummary(session);
  if (lastTurnSummary) {
    lines.push(`上次结果：${lastTurnSummary}`);
  }

  return lines.join("\n");
}

export function buildSessionsText(options: {
  sessions: SessionRow[];
  activeSessionId: string | null;
  archived?: boolean;
}): string {
  const title = options.archived ? "已归档会话" : "最近会话";
  if (options.sessions.length === 0) {
    return `${title}\n暂无会话。`;
  }

  const lines = [title];
  options.sessions.forEach((session, index) => {
    const marker = !options.archived && session.sessionId === options.activeSessionId ? "[当前] " : "";
    const parts = [
      `${marker}${session.displayName}`,
      session.projectName,
      formatSessionState(session),
      formatLastTurnSummary(session),
      formatRelativeTime(session.lastUsedAt)
    ].filter((value): value is string => Boolean(value));

    lines.push(`${index + 1}. ${parts.join(" | ")}`);
  });

  return lines.join("\n");
}

export function buildProjectSelectedText(projectName: string): string {
  return `当前项目：${projectName}`;
}

export function buildUnsupportedCommandText(): string {
  return "这个命令还没开放。";
}

export function buildRuntimeStatusCard(
  options: RuntimeCardContext & {
    state: string;
    progressText?: string | null;
    blockedReason?: string | null;
    commands?: RuntimeCommandEntryView[];
    commandsExpanded?: boolean;
  }
): string {
  const lines: string[] = ["Runtime Status"];
  pushRuntimeCardContext(lines, options);
  lines.push(`State: ${options.state}`);

  if (options.blockedReason) {
    lines.push(`Blocked on: ${options.blockedReason}`);
  }

  if (options.progressText) {
    lines.push(`Progress: ${truncateRuntimeCardText(options.progressText, 240)}`);
  }

  pushRuntimeCommandLines(lines, options.commands ?? [], options.commandsExpanded ?? false);
  lines.push("Use /inspect for full details");
  return lines.join("\n");
}

export function buildRuntimePlanCard(
  context: RuntimeCardContext,
  entries: string[]
): string {
  const lines: string[] = ["Plan"];
  pushRuntimeCardContext(lines, context);

  for (const [index, entry] of entries.slice(0, 10).entries()) {
    lines.push(`${index + 1}. ${truncateRuntimeCardText(entry, 200)}`);
  }

  if (entries.length > 10) {
    lines.push(`... ${entries.length - 10} more steps`);
  }

  return lines.join("\n");
}

export function buildRuntimeErrorCard(
  options: RuntimeCardContext & {
    title: string;
    detail?: string | null;
  }
): string {
  const lines: string[] = ["Error"];
  pushRuntimeCardContext(lines, options);
  lines.push(`Title: ${truncateRuntimeCardText(options.title, 200)}`);

  if (options.detail) {
    lines.push(`Detail: ${truncateRuntimeCardText(options.detail, 240)}`);
  }

  return lines.join("\n");
}

export function buildRuntimeCommandListReplyMarkup(
  sessionId: string,
  commandCount: number,
  expanded: boolean
): TelegramInlineKeyboardMarkup | undefined {
  if (commandCount <= 1) {
    return undefined;
  }

  return {
    inline_keyboard: [[{
      text: expanded ? "折叠命令" : `展开全部命令 (${commandCount})`,
      callback_data: expanded
        ? encodeCommandListCollapseCallback(sessionId)
        : encodeCommandListExpandCallback(sessionId)
    }]]
  };
}

export function buildTurnStatusCard(
  status: ActivityStatus,
  context?: {
    sessionName?: string | null;
    projectName?: string | null;
  }
): string {
  const lines: string[] = [];

  if (context?.sessionName) {
    lines.push(`Session: ${context.sessionName}`);
  }

  if (context?.projectName) {
    lines.push(`Project: ${context.projectName}`);
  }

  lines.push(`Status: ${formatTurnStatus(status.turnStatus)}`);

  const blockedOn = formatBlockedReason(status.threadBlockedReason);
  if (blockedOn) {
    lines.push(`Blocked on: ${blockedOn}`);
  }

  lines.push(`Current step: ${describeCurrentStep(status)}`);

  const latestUpdate = getLatestStatusUpdate(status);
  if (latestUpdate) {
    lines.push(`Update: ${latestUpdate}`);
  } else if (status.latestProgress) {
    lines.push(`Latest progress: ${status.latestProgress}`);
  }

  const milestone = shouldShowMilestone(status, latestUpdate !== null) ? formatLatestMilestone(status) : null;
  if (milestone) {
    lines.push(`Latest milestone: ${milestone}`);
  }

  if (status.finalMessageAvailable) {
    lines.push("Final answer: ready");
  }

  lines.push("Use /inspect for full details");
  return lines.join("\n");
}

export function buildInspectText(
  snapshot: InspectSnapshot,
  options?: {
    debugFilePath?: string | null;
    sessionName?: string | null;
    projectName?: string | null;
  }
): string {
  const lines = ["Task details"];

  if (options?.sessionName) {
    lines.push(`Session: ${options.sessionName}`);
  }

  if (options?.projectName) {
    lines.push(`Project: ${options.projectName}`);
  }

  lines.push(`Status: ${formatTurnStatus(snapshot.turnStatus)}`);

  const blockedOn = formatBlockedReason(snapshot.threadBlockedReason);
  if (blockedOn) {
    lines.push(`Blocked on: ${blockedOn}`);
  }

  lines.push(`Current step: ${describeCurrentStep(snapshot)}`);

  if (snapshot.currentItemDurationSec !== null) {
    lines.push(`Step elapsed: ${formatDuration(snapshot.currentItemDurationSec)}`);
  }

  if (snapshot.recentStatusUpdates.length > 0) {
    lines.push("Recent updates:");
    lines.push(...snapshot.recentStatusUpdates.slice(-3).map((update) => `- ${update}`));
  } else if (snapshot.latestProgress) {
    lines.push(`Latest progress: ${snapshot.latestProgress}`);
  }

  const milestone = shouldShowMilestone(snapshot, snapshot.recentStatusUpdates.length > 0)
    ? formatLatestMilestone(snapshot)
    : null;
  if (milestone) {
    lines.push(`Latest milestone: ${milestone}`);
  }

  if (snapshot.finalMessageAvailable) {
    lines.push("Final answer: ready");
  }

  lines.push("", "Recent activity");
  if (snapshot.recentTransitions.length === 0) {
    lines.push("- None");
  } else {
    snapshot.recentTransitions.slice(-5).forEach((transition, index) => {
      lines.push(`${index + 1}. ${transition.summary}`);
    });
  }

  lines.push("", "Recent commands");
  lines.push(...formatInspectSection(snapshot.recentCommandSummaries));

  lines.push("", "Recent file changes");
  lines.push(...formatInspectSection(snapshot.recentFileChangeSummaries));

  lines.push("", "Recent MCP activity");
  lines.push(...formatInspectSection(snapshot.recentMcpSummaries));

  lines.push("", "Recent web searches");
  lines.push(...formatInspectSection(snapshot.recentWebSearches));

  lines.push("", "Plan snapshot");
  lines.push(...formatInspectSection(snapshot.planSnapshot));

  if (snapshot.completedCommentary.length > 0) {
    lines.push("", "Completed commentary");
    lines.push(...formatInspectSection(snapshot.completedCommentary));
  }

  const notes: string[] = [];
  if (options?.debugFilePath) {
    notes.push(`Debug file: ${options.debugFilePath}`);
  }

  if (notes.length > 0) {
    lines.push("", "Notes");
    lines.push(...formatInspectSection(notes));
  }

  return lines.join("\n");
}

function formatRelativeTime(isoTime: string): string {
  const diffMs = Math.max(0, Date.now() - Date.parse(isoTime));
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) {
    return "刚刚";
  }

  if (minutes < 60) {
    return `${minutes}分钟前`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}小时前`;
  }

  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

function pushRuntimeCardContext(lines: string[], context: RuntimeCardContext): void {
  if (context.sessionName) {
    lines.push(`Session: ${context.sessionName}`);
  }

  if (context.projectName && context.projectName !== context.sessionName) {
    lines.push(`Project: ${context.projectName}`);
  }
}

function truncateRuntimeCardText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}…`;
}

function pushRuntimeCommandLines(
  lines: string[],
  commands: RuntimeCommandEntryView[],
  expanded: boolean
): void {
  if (commands.length === 0) {
    return;
  }

  const visibleCommands = expanded ? commands : commands.slice(-1);
  lines.push(expanded ? `Commands: ${commands.length}` : "Latest command");

  let rendered = 0;
  for (const [index, command] of visibleCommands.entries()) {
    const commandLines = buildRuntimeCommandLines(command, expanded ? index + 1 : null);
    const nextLength = lines.join("\n").length + commandLines.join("\n").length + 8;
    if (expanded && rendered > 0 && nextLength > 3500) {
      lines.push(`... ${visibleCommands.length - rendered} more commands hidden`);
      break;
    }

    lines.push(...commandLines);
    rendered += 1;
  }

  if (!expanded && commands.length > 1) {
    lines.push(`Earlier commands: ${commands.length - 1} hidden`);
  }
}

function buildRuntimeCommandLines(
  command: RuntimeCommandEntryView,
  index: number | null
): string[] {
  const prefix = index === null ? "" : `${index}. `;
  const detailPrefix = index === null ? "" : "   ";
  const lines = [`${prefix}Command: ${formatRuntimeCommandText(command.commandText)}`];
  lines.push(`${detailPrefix}State: ${command.state}`);

  if (command.latestSummary) {
    lines.push(`${detailPrefix}Output: ${truncateRuntimeCardText(command.latestSummary, 220)}`);
  }

  return lines;
}

function formatRuntimeCommandText(commandText: string): string {
  const trimmed = commandText.trim();
  if (trimmed.startsWith("$")) {
    return truncateRuntimeCardText(trimmed, 220);
  }

  return truncateRuntimeCardText(`$ ${trimmed}`, 220);
}

function formatSessionState(session: SessionRow): string {
  switch (session.status) {
    case "running":
      return "执行中";
    case "interrupted":
      return "已中断";
    case "failed":
      return session.failureReason
        ? `失败（${formatSessionFailureReason(session.failureReason)}）`
        : "失败";
    case "idle":
    default:
      return "空闲";
  }
}

function formatSessionFailureReason(reason: SessionRow["failureReason"]): string {
  switch (reason) {
    case "bridge_restart":
      return "桥接服务重启";
    case "app_server_lost":
      return "Codex 服务断开";
    case "turn_failed":
      return "执行失败";
    case "unknown":
    default:
      return "未知原因";
  }
}

function formatLastTurnSummary(session: SessionRow): string | null {
  if (session.status === "running" || session.status === "failed" || session.status === "interrupted") {
    return null;
  }

  switch (session.lastTurnStatus) {
    case "completed":
      return "上次已完成";
    case "interrupted":
      return "上次已中断";
    case "failed":
      return session.failureReason ? `上次失败（${formatSessionFailureReason(session.failureReason)}）` : "上次失败";
    default:
      return null;
  }
}

function formatInspectSection(values: string[]): string[] {
  if (values.length === 0) {
    return ["- None"];
  }

  return values.map((value) => `- ${value}`);
}

function formatTurnStatus(status: ActivityStatus["turnStatus"]): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "blocked":
      return "Blocked";
    case "interrupted":
      return "Interrupted";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return "Unknown";
  }
}

function formatBlockedReason(reason: ActivityStatus["threadBlockedReason"]): string | null {
  switch (reason) {
    case "waitingOnApproval":
      return "approval";
    case "waitingOnUserInput":
      return "user input";
    default:
      return null;
  }
}

function describeCurrentStep(status: ActivityStatus): string {
  if (status.threadBlockedReason === "waitingOnApproval") {
    return "Waiting for approval";
  }

  if (status.threadBlockedReason === "waitingOnUserInput") {
    return "Waiting for user input";
  }

  switch (status.activeItemType) {
    case "planning":
      return "Updating the plan";
    case "commandExecution":
      return appendSpecificLabel("Running command", status.activeItemLabel, ["command"]);
    case "fileChange":
      return appendSpecificLabel("Editing files", status.activeItemLabel, ["file changes"]);
    case "mcpToolCall":
      return appendSpecificLabel("Calling MCP tool", status.activeItemLabel, ["MCP tool call"]);
    case "webSearch":
      return appendSpecificLabel("Searching the web", status.activeItemLabel, ["web search"]);
    case "agentMessage":
      return appendSpecificLabel("Drafting the response", status.activeItemLabel, ["assistant response"]);
    case "reasoning":
      return "Thinking";
    case "other":
      return appendSpecificLabel("Working on", status.activeItemLabel, ["work item", "other"]);
    default:
      return defaultStepForStatus(status.turnStatus);
  }
}

function appendSpecificLabel(base: string, label: string | null, genericLabels: string[]): string {
  if (!label || genericLabels.includes(label)) {
    return base;
  }

  return `${base}: ${label}`;
}

function defaultStepForStatus(status: ActivityStatus["turnStatus"]): string {
  switch (status) {
    case "starting":
      return "Waiting for first activity";
    case "running":
      return "Processing";
    case "blocked":
      return "Waiting";
    case "completed":
      return "No active step";
    case "interrupted":
      return "No active step";
    case "failed":
      return "No active step";
    case "idle":
      return "Ready";
    default:
      return "Waiting for activity";
  }
}

function formatLatestMilestone(status: ActivityStatus): string | null {
  if (!status.lastHighValueEventType || !status.lastHighValueTitle) {
    return null;
  }

  if (
    status.latestProgress &&
    status.lastHighValueEventType !== "done" &&
    status.lastHighValueEventType !== "blocked"
  ) {
    return null;
  }

  const value = buildMilestoneText(status);
  if (!value) {
    return null;
  }

  return status.latestProgress === value ? null : value;
}

function shouldShowMilestone(status: ActivityStatus, hasRecentUpdates: boolean): boolean {
  if (!hasRecentUpdates) {
    return true;
  }

  return status.lastHighValueEventType === "done" || status.lastHighValueEventType === "blocked";
}

function getLatestStatusUpdate(status: ActivityStatus): string | null {
  return status.recentStatusUpdates.at(-1) ?? null;
}

function buildMilestoneText(status: ActivityStatus): string | null {
  const title = status.lastHighValueTitle;
  if (!title) {
    return null;
  }

  switch (status.lastHighValueEventType) {
    case "ran_cmd": {
      const command = stripPrefix(title, "Ran cmd: ");
      return status.lastHighValueDetail
        ? `Command result: ${command} -> ${status.lastHighValueDetail}`
        : `Command started: ${command}`;
    }
    case "changed":
      return `File change: ${status.lastHighValueDetail ?? stripPrefix(title, "Changed: ")}`;
    case "found":
      return `Discovery: ${status.lastHighValueDetail ?? stripPrefix(title, "Found: ")}`;
    case "blocked":
      return `Blocker: ${status.lastHighValueDetail ?? stripPrefix(title, "Blocked: ")}`;
    case "done":
      return status.lastHighValueDetail
        ? `Assistant reply: ${status.lastHighValueDetail}`
        : `Completion: ${stripPrefix(title, "Done: ")}`;
    default:
      return null;
  }
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
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

type FinalAnswerBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[]; ordered: boolean; startIndex: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string; language: string | null };

const FINAL_ANSWER_CONTINUATION_PREFIX_BUDGET = 12;

export function renderFinalAnswerHtmlChunks(markdown: string, maxChars: number): string[] {
  const safeLimit = Math.max(1, maxChars - FINAL_ANSWER_CONTINUATION_PREFIX_BUDGET);
  // Render block-by-block first so continuation chunks never cut through HTML tags or fenced code blocks.
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

  return chunks.map((chunk, index) => {
    if (index === 0) {
      return chunk;
    }

    return `(${index + 1}/${chunks.length}) ${chunk}`;
  });
}

const STREAM_CHAR_LIMIT = 4000;
const STREAM_BLOCK_TEXT_LIMIT = 200;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
        startIndex: 1
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

function renderInlineMarkdown(text: string): string {
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

    // Require simple punctuation/whitespace boundaries so snake_case and lone * stay literal.
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

  for (let i = fromBlock; i < snapshot.blocks.length; i++) {
    const rendered = renderStreamBlock(snapshot.blocks[i]!);
    const candidateLength = parts.join("\n").length + 1 + rendered.length + 80;
    if (candidateLength > STREAM_CHAR_LIMIT && renderedCount > 0) {
      truncated = true;
      break;
    }
    parts.push(rendered);
    renderedCount++;
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

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…`;
}
