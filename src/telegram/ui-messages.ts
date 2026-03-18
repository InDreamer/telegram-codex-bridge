import type {
  ProjectCandidate,
  ProjectPickerResult,
  ReasoningEffort,
  ReadinessSnapshot,
  SessionRow
} from "../types.js";
import { truncateText } from "../util/text.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import {
  encodeModelDefaultCallback,
  encodeModelEffortCallback,
  encodeModelPageCallback,
  encodeModelPickCallback,
  encodePathBackCallback,
  encodePathConfirmCallback,
  encodePathManualCallback,
  encodePickCallback,
  encodeRenameProjectCallback,
  encodeRenameProjectClearCallback,
  encodeRenameSessionCallback,
  encodeScanMoreCallback
} from "./ui-callbacks.js";
import {
  chunkButtons,
  formatHtmlField,
  formatHtmlHeading,
  formatReasoningEffortLabel,
  formatRelativeTime,
  formatSessionModelReasoningConfig
} from "./ui-shared.js";

function displayProjectName(projectName: string, projectAlias: string | null | undefined): string {
  return projectAlias?.trim() || projectName;
}

function buildProjectBadgeLabels(candidate: ProjectCandidate): string[] {
  const labels: string[] = [];
  if (candidate.group !== "recent" && candidate.isRecent) {
    labels.push("最近");
  }
  if (candidate.group !== "discovered" && candidate.fromScan) {
    labels.push("本地发现");
  }
  if (candidate.hasExistingSession) {
    labels.push("有历史会话");
  }

  return labels;
}

function buildProjectButtonLabel(candidate: ProjectCandidate, duplicateDisplayNames: Set<string>): string {
  if (!duplicateDisplayNames.has(candidate.displayName)) {
    return candidate.displayName;
  }

  return `${candidate.displayName} · ${candidate.pathLabel}`;
}

export function buildProjectPickerMessage(picker: ProjectPickerResult): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  const visibleCandidates = picker.groups.flatMap((group) => group.candidates);
  const duplicateDisplayNames = new Set(
    visibleCandidates
      .map((candidate) => candidate.displayName)
      .filter((name, index, names) => names.indexOf(name) !== index)
  );

  for (const candidate of visibleCandidates) {
    rows.push([
      {
        text: buildProjectButtonLabel(candidate, duplicateDisplayNames),
        callback_data: encodePickCallback(candidate.projectKey)
      }
    ]);
  }

  rows.push([
    { text: "扫描本地项目", callback_data: encodeScanMoreCallback() },
    { text: "手动输入路径", callback_data: encodePathManualCallback() }
  ]);

  const lines = [picker.title];
  for (const noticeLine of picker.noticeLines) {
    lines.push("", noticeLine);
  }
  if (picker.emptyText) {
    lines.push("", picker.emptyText);
  }

  let itemIndex = 1;
  for (const group of picker.groups) {
    lines.push("", group.title);
    for (const candidate of group.candidates) {
      const badges = buildProjectBadgeLabels(candidate);
      lines.push(`${itemIndex}. ${candidate.displayName}`);
      lines.push(`   ${candidate.pathLabel}`);
      if (badges.length > 0) {
        lines.push(`   ${badges.join(" · ")}`);
      }
      itemIndex += 1;
    }
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
    text: "请发送要开始会话的目录路径，例如：/home/ubuntu/Repo/openclaw\n发送 /cancel 返回项目列表。",
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
    text: [
      "要在这个目录中新建会话吗？",
      formatHtmlField("项目：", candidate.displayName),
      formatHtmlField("路径：", candidate.projectPath)
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "确认新建会话", callback_data: encodePathConfirmCallback(candidate.projectKey) }],
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
    text: "没有发现新的本地项目。",
    replyMarkup: {
      inline_keyboard: [
        [{ text: "手动输入路径", callback_data: encodePathManualCallback() }],
        [{ text: "返回项目列表", callback_data: encodePathBackCallback() }]
      ]
    }
  };
}

interface ModelPickerOption {
  id: string;
  displayName: string;
  isDefault: boolean;
}

interface ReasoningEffortOption {
  reasoningEffort: ReasoningEffort;
  description: string;
}

const MODEL_PAGE_SIZE = 5;

export function buildModelPickerMessage(options: {
  session: SessionRow;
  models: ModelPickerOption[];
  page: number;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const totalPages = Math.max(1, Math.ceil(options.models.length / MODEL_PAGE_SIZE));
  const safePage = Math.min(Math.max(options.page, 0), totalPages - 1);
  const pageModels = options.models.slice(safePage * MODEL_PAGE_SIZE, (safePage + 1) * MODEL_PAGE_SIZE);
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [
    [{ text: buildDefaultModelButtonLabel(options.models, options.session), callback_data: encodeModelDefaultCallback(options.session.sessionId) }],
    ...pageModels.map((model, index) => [{
      text: buildModelButtonLabel(model, options.session),
      callback_data: encodeModelPickCallback(options.session.sessionId, safePage * MODEL_PAGE_SIZE + index)
    }])
  ];
  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navigation.push({ text: "上一页", callback_data: encodeModelPageCallback(options.session.sessionId, safePage - 1) });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({ text: "下一页", callback_data: encodeModelPageCallback(options.session.sessionId, safePage + 1) });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }

  return {
    text: [
      "选择模型",
      `当前配置：${formatSessionModelReasoningConfig(options.session)}`,
      `第 ${safePage + 1}/${totalPages} 页`,
      "先选模型，再按该模型支持情况选择思考强度。"
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildReasoningEffortPickerMessage(options: {
  session: SessionRow;
  model: ModelPickerOption & {
    defaultReasoningEffort: ReasoningEffort;
    supportedReasoningEfforts: ReasoningEffortOption[];
  };
  modelIndex: number;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const isCurrentModel = options.session.selectedModel === options.model.id;
  const effortButtons = options.model.supportedReasoningEfforts.map((option) => ({
    text: buildReasoningEffortButtonLabel(option.reasoningEffort, options.session, isCurrentModel),
    callback_data: encodeModelEffortCallback(options.session.sessionId, options.modelIndex, option.reasoningEffort)
  }));
  const rows = [
    [{
      text: buildDefaultEffortButtonLabel(options.model.defaultReasoningEffort, options.session, isCurrentModel),
      callback_data: encodeModelEffortCallback(options.session.sessionId, options.modelIndex, null)
    }],
    ...chunkButtons(effortButtons, 2)
  ];

  return {
    text: [
      "选择思考强度",
      `模型：${options.model.id}`,
      `当前配置：${formatSessionModelReasoningConfig(options.session)}`,
      "仅展示这个模型实际支持的档位。"
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildStatusText(
  snapshot: ReadinessSnapshot,
  activeSession: SessionRow | null
): string {
  const issueText = snapshot.details.issues.length === 0 ? "无" : snapshot.details.issues.join("；");
  const activeSessionText = activeSession
    ? [
        displayProjectName(activeSession.projectName, activeSession.projectAlias),
        activeSession.displayName,
        formatSessionState(activeSession),
        formatSessionModelReasoningConfig(activeSession),
        formatLastTurnSummary(activeSession)
      ]
        .filter((value): value is string => Boolean(value))
        .join(" / ")
    : "无";

  return [
    formatHtmlHeading("服务状态"),
    formatHtmlField("桥接状态：", snapshot.state),
    formatHtmlField("Telegram 连通：", snapshot.details.telegramTokenValid ? "正常" : "异常"),
    formatHtmlField(
      "Codex 可用：",
      snapshot.details.codexAuthenticated && snapshot.details.appServerAvailable ? "正常" : "异常"
    ),
    formatHtmlField("当前会话：", activeSessionText),
    formatHtmlField("最近检查：", snapshot.checkedAt),
    formatHtmlField("问题：", issueText)
  ].join("\n");
}

export function buildWhereText(session: SessionRow | null): string {
  if (!session) {
    return "当前没有活动会话。";
  }

  const lines = [
    formatHtmlHeading("当前会话"),
    formatHtmlField("会话名：", session.displayName),
    formatHtmlField("项目：", displayProjectName(session.projectName, session.projectAlias)),
    formatHtmlField("路径：", session.projectPath),
    formatHtmlField("状态：", formatSessionState(session)),
    formatHtmlField("模型 + 思考强度：", formatSessionModelReasoningConfig(session)),
    formatHtmlField("plan mode:", session.planMode ? "on" : "off")
  ];

  lines.push(formatHtmlField("Bridge 会话 ID：", session.sessionId));
  lines.push(formatHtmlField("Codex 线程 ID：", session.threadId ?? "尚未创建（首次发送任务后生成）"));
  lines.push(formatHtmlField("最近 Turn ID：", session.lastTurnId ?? "暂无"));
  const lastTurnSummary = formatLastTurnSummary(session);
  if (lastTurnSummary) {
    lines.push(formatHtmlField("上次结果：", lastTurnSummary));
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
      displayProjectName(session.projectName, session.projectAlias),
      formatSessionState(session),
      formatLastTurnSummary(session),
      formatRelativeTime(session.lastUsedAt)
    ].filter((value): value is string => Boolean(value));

    lines.push(`${index + 1}. ${parts.join(" | ")}`);
  });

  return lines.join("\n");
}

export function buildProjectSelectedText(projectName: string): string {
  return formatHtmlField("当前项目：", projectName);
}

export function buildSessionCreatedText(projectName: string): string {
  return formatHtmlField("已新建会话：", projectName);
}

export function buildSessionSwitchedText(projectName: string): string {
  return formatHtmlField("已切换到项目：", projectName);
}

export function buildArchiveSuccessText(
  projectName: string,
  nextActiveSession?: {
    displayName: string;
    projectName: string;
    projectAlias?: string | null;
  } | null
): string {
  const lines = [formatHtmlField("已归档当前会话：", projectName)];
  if (nextActiveSession) {
    lines.push(formatHtmlField("当前会话：", nextActiveSession.displayName));
    lines.push(
      formatHtmlField(
        "当前项目：",
        displayProjectName(nextActiveSession.projectName, nextActiveSession.projectAlias ?? null)
      )
    );
  } else {
    lines.push("当前没有活动会话，请发送 /new 选择项目。");
  }

  return lines.join("\n");
}

export function buildUnarchiveSuccessText(projectName: string): string {
  return formatHtmlField("已恢复会话：", projectName);
}

export function buildSessionRenamedText(name: string): string {
  return formatHtmlField("当前会话已重命名为：", name);
}

export function buildProjectAliasRenamedText(name: string): string {
  return formatHtmlField("当前项目别名已更新为：", name);
}

export function buildProjectAliasClearedText(projectName: string): string {
  return formatHtmlField("已清除项目别名：", projectName);
}

export function buildProjectPinnedText(projectName: string): string {
  return formatHtmlField("已收藏项目：", projectName);
}

export function buildRenameTargetPicker(options: {
  sessionId: string;
  projectName: string;
  hasProjectAlias: boolean;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [
    [{ text: "重命名会话", callback_data: encodeRenameSessionCallback(options.sessionId) }],
    [{ text: "设置项目别名", callback_data: encodeRenameProjectCallback(options.sessionId) }]
  ];

  if (options.hasProjectAlias) {
    rows.push([{ text: "清除项目别名", callback_data: encodeRenameProjectClearCallback(options.sessionId) }]);
  }

  return {
    text: [
      "要修改哪个名称？",
      formatHtmlField("当前项目：", options.projectName)
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildUnsupportedCommandText(): string {
  return "这个命令还没开放。";
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

function buildDefaultModelButtonLabel(models: ModelPickerOption[], session: SessionRow): string {
  const defaultModel = models.find((model) => model.isDefault);
  const suffix = defaultModel ? `（${defaultModel.displayName}）` : "";
  const marker = session.selectedModel === null ? " [当前]" : "";
  return `默认模型${suffix}${marker}`;
}

function buildModelButtonLabel(model: ModelPickerOption, session: SessionRow): string {
  const markers: string[] = [];
  if (session.selectedModel === model.id || (session.selectedModel === null && model.isDefault)) {
    markers.push("当前");
  }
  if (model.isDefault) {
    markers.push("默认");
  }
  const markerText = markers.length > 0 ? ` [${markers.join("/")}]` : "";
  return `${model.displayName}${markerText}`;
}

function buildDefaultEffortButtonLabel(
  defaultReasoningEffort: ReasoningEffort,
  session: SessionRow,
  isCurrentModel: boolean
): string {
  const marker = isCurrentModel && session.selectedReasoningEffort === null ? " [当前]" : "";
  return `默认（${formatReasoningEffortLabel(defaultReasoningEffort)}）${marker}`;
}

function buildReasoningEffortButtonLabel(
  effort: ReasoningEffort,
  session: SessionRow,
  isCurrentModel: boolean
): string {
  const marker = isCurrentModel && session.selectedReasoningEffort === effort ? " [当前]" : "";
  return `${formatReasoningEffortLabel(effort)}${marker}`;
}
