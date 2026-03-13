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

export type ParsedCallbackData =
  | { kind: "pick"; projectKey: string }
  | { kind: "scan_more" }
  | { kind: "path_manual" }
  | { kind: "path_back" }
  | { kind: "path_confirm"; projectKey: string };

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
    ? `${activeSession.projectName} / ${activeSession.displayName} / ${activeSession.status}${activeSession.failureReason ? ` / ${activeSession.failureReason}` : ""}`
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

  return [
    "当前会话",
    `会话名：${session.displayName}`,
    `项目：${session.projectName}`,
    `路径：${session.projectPath}`,
    `状态：${session.status}`
  ].join("\n");
}

export function buildSessionsText(sessions: SessionRow[]): string {
  if (sessions.length === 0) {
    return "最近会话\n暂无会话。";
  }

  const lines = ["最近会话"];
  sessions.forEach((session, index) => {
    const runningMarker = session.status === "running" ? " [running]" : "";
    lines.push(
      `${index + 1}. ${session.displayName} | ${session.projectName} | ${formatRelativeTime(session.lastUsedAt)}${runningMarker}`
    );
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

export function buildRuntimeCommandCard(
  options: RuntimeCardContext & {
    commandName: string;
    state: string;
    latestSummary?: string | null;
  }
): string {
  const lines: string[] = ["Command"];
  pushRuntimeCardContext(lines, options);
  lines.push(`Name: ${truncateRuntimeCardText(options.commandName, 200)}`);
  lines.push(`State: ${options.state}`);

  if (options.latestSummary) {
    lines.push(`Latest: ${truncateRuntimeCardText(options.latestSummary, 240)}`);
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

  if (snapshot.commentarySnippets.length > 0) {
    lines.push("", "Commentary snippets (best-effort)");
    lines.push(...formatInspectSection(snapshot.commentarySnippets));
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
    return `${minutes} 分钟前`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }

  const days = Math.floor(hours / 24);
  return `${days} 天前`;
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

const STREAM_CHAR_LIMIT = 4000;
const STREAM_BLOCK_TEXT_LIMIT = 200;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
