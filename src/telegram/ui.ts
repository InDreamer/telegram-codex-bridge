import type {
  ProjectCandidate,
  ProjectPickerResult,
  ReadinessSnapshot,
  SessionRow
} from "../types.js";
import type { ActivityStatus, InspectSnapshot } from "../activity/types.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";

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

export function buildTurnStatusCard(status: ActivityStatus): string {
  const lines = [defaultActivityHeadline(status)];
  const detail = defaultActivityDetail(status);
  if (detail) {
    lines.push(`结果：${detail}`);
  }

  lines.push("发送 /inspect 查看更多细节");
  return lines.join("\n");
}

export function buildInspectText(snapshot: InspectSnapshot, options?: { debugFilePath?: string | null }): string {
  const lines = ["当前任务详情"];

  if (snapshot.lastHighValueTitle) {
    const latestUsefulProgress = snapshot.lastHighValueDetail &&
      snapshot.lastHighValueDetail !== snapshot.lastHighValueTitle &&
      !snapshot.lastHighValueTitle.includes(snapshot.lastHighValueDetail)
      ? `${snapshot.lastHighValueTitle} -> ${snapshot.lastHighValueDetail}`
      : snapshot.lastHighValueTitle;
    lines.push(`最近有用进展：${latestUsefulProgress}`);
  } else {
    lines.push(`状态：${snapshot.turnStatus}`);
  }

  if (snapshot.latestProgress) {
    lines.push(`最近进度：${snapshot.latestProgress}`);
  }

  lines.push("", "最近活动");
  if (snapshot.recentTransitions.length === 0) {
    lines.push("- 无");
  } else {
    snapshot.recentTransitions.slice(-5).forEach((transition, index) => {
      lines.push(`${index + 1}. ${transition.summary}`);
    });
  }

  lines.push("", "最近命令");
  lines.push(...formatInspectSection(snapshot.recentCommandSummaries));

  lines.push("", "最近文件变更");
  lines.push(...formatInspectSection(snapshot.recentFileChangeSummaries));

  lines.push("", "最近 MCP");
  lines.push(...formatInspectSection(snapshot.recentMcpSummaries));

  lines.push("", "最近网页搜索");
  lines.push(...formatInspectSection(snapshot.recentWebSearches));

  lines.push("", "计划概览");
  lines.push(...formatInspectSection(snapshot.planSnapshot));

  if (snapshot.commentarySnippets.length > 0) {
    lines.push("", "可选 commentary（best-effort）");
    lines.push(...formatInspectSection(snapshot.commentarySnippets));
  }

  const notes: string[] = [];
  if (options?.debugFilePath) {
    notes.push(`Debug 文件：${options.debugFilePath}`);
  }

  if (notes.length > 0) {
    lines.push("", "备注");
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

function defaultActivityHeadline(status: ActivityStatus): string {
  if (status.lastHighValueTitle) {
    return status.lastHighValueTitle;
  }

  if (status.turnStatus === "blocked" && status.threadBlockedReason) {
    return `Blocked: ${status.threadBlockedReason}`;
  }

  if (status.turnStatus === "completed") {
    return "Done: completed";
  }

  if (status.turnStatus === "failed") {
    return "Blocked: turn failed";
  }

  if (status.turnStatus === "interrupted") {
    return "Blocked: interrupted";
  }

  return "等待有用进展...";
}

function defaultActivityDetail(status: ActivityStatus): string | null {
  if (!status.lastHighValueDetail) {
    return null;
  }

  if (status.lastHighValueTitle?.includes(status.lastHighValueDetail)) {
    return null;
  }

  return status.lastHighValueDetail;
}

function formatInspectSection(values: string[]): string[] {
  if (values.length === 0) {
    return ["- 无"];
  }

  return values.map((value) => `- ${value}`);
}
