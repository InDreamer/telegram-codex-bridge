import type {
  PendingInteractionState,
  RuntimeStatusField,
  UiLanguage
} from "../types.js";
import { BRIDGE_EXTENSION_RUNTIME_STATUS_FIELDS, CODEX_CLI_RUNTIME_STATUS_FIELDS } from "../types.js";
import type { ActivityStatus, CollabAgentStateSnapshot, InspectSnapshot } from "../activity/types.js";
import { truncateText } from "../util/text.js";
import { BLOCKED_PROGRESS_APPROVAL, BLOCKED_PROGRESS_USER_INPUT } from "../util/blocked-progress.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import {
  encodeAgentCollapseCallback,
  encodeAgentExpandCallback,
  encodeInspectCollapseCallback,
  encodeInspectExpandCallback,
  encodeInspectPageCallback,
  encodeInteractionAnswerCollapseCallback,
  encodeInteractionAnswerExpandCallback,
  encodeInteractionCancelCallback,
  encodeInteractionDecisionCallback,
  encodeInteractionQuestionCallback,
  encodeInteractionTextCallback,
  encodePlanCollapseCallback,
  encodePlanExpandCallback,
  encodeRollbackBackCallback,
  encodeRollbackConfirmCallback,
  encodeRollbackPageCallback,
  encodeRollbackPickCallback,
  encodeRuntimePageCallback,
  encodeRuntimeResetCallback,
  encodeRuntimeSaveCallback,
  encodeRuntimeToggleCallback
} from "./ui-callbacks.js";
import { renderInlineMarkdown } from "./ui-final-answer.js";
import {
  chunkButtons,
  escapeHtml,
  formatHtmlField,
  formatHtmlHeading,
  formatRelativeTime
} from "./ui-shared.js";

interface RuntimeCardContext {
  sessionName?: string | null;
  projectName?: string | null;
}

export interface RuntimeCommandEntryView {
  commandText: string;
  state: string;
  latestSummary?: string | null;
  cwd?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

export interface RuntimeStatusFieldOptionView {
  field: RuntimeStatusField;
  label: string;
  selected: boolean;
}

export interface RollbackTargetView {
  index: number;
  sequenceNumber: number;
  label: string;
  rollbackCount: number;
}

const RUNTIME_FIELD_PAGE_SIZE = 4;
const ROLLBACK_TARGET_PAGE_SIZE = 6;
const INSPECT_PAGE_CHAR_LIMIT = 3200;

export function buildRuntimeStatusCard(
  options: RuntimeCardContext & {
    language?: UiLanguage;
    state: string;
    statusLine?: string | null;
    optionalFieldLines?: string[];
    progressText?: string | null;
    blockedReason?: string | null;
    planEntries?: string[];
    planExpanded?: boolean;
    agentEntries?: CollabAgentStateSnapshot[];
    agentsExpanded?: boolean;
  }
): string {
  const language = options.language ?? "zh";
  const lines: string[] = [formatHtmlHeading(language === "en" ? "Runtime Status" : "运行状态")];
  pushHtmlRuntimeCardContext(lines, options, language);

  lines.push(formatRuntimeCardRow(language === "en" ? "State" : "状态", options.state));

  for (const line of options.optionalFieldLines ?? []) {
    lines.push(formatRuntimeStatusOptionalField(line, language));
  }

  if (options.progressText) {
    const progressText = renderInlineMarkdown(truncateText(options.progressText, 240));
    if (stripHtml(progressText).length > 72) {
      lines.push(formatHtmlHeading(language === "en" ? "Progress" : "进度"));
      lines.push(progressText);
    } else {
      lines.push(formatRuntimeCardRow(language === "en" ? "Progress" : "进度", progressText, { valueIsHtml: true }));
    }
  }

  if (options.planExpanded && options.planEntries && options.planEntries.length > 0) {
    lines.push("", "<b>计划清单:</b>");

    for (const [index, entry] of options.planEntries.slice(0, 10).entries()) {
      lines.push(`${index + 1}. ${renderInlineMarkdown(truncateText(entry, 200))}`);
    }

    if (options.planEntries.length > 10) {
      lines.push(`... ${options.planEntries.length - 10} more steps`);
    }
  }

  if (options.agentsExpanded && options.agentEntries && options.agentEntries.length > 0) {
    lines.push("", "<b>Agents:</b>");

    for (const [index, entry] of options.agentEntries.slice(0, 10).entries()) {
      lines.push(renderAgentRuntimeLine(entry, index + 1));
    }

    if (options.agentEntries.length > 10) {
      lines.push(`... ${options.agentEntries.length - 10} more agents`);
    }
  }

  lines.push(language === "en" ? "Use /inspect for full details" : "使用 /inspect 查看完整详情");
  return lines.join("\n");
}

export function buildRuntimeStatusReplyMarkup(options: {
  sessionId: string;
  planEntries: string[];
  planExpanded: boolean;
  agentEntries: CollabAgentStateSnapshot[];
  agentsExpanded: boolean;
}): TelegramInlineKeyboardMarkup | undefined {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];

  if (options.planEntries.length > 0) {
    rows.push([{
      text: options.planExpanded ? "收起计划清单" : buildCollapsedPlanButtonLabel(options.planEntries),
      callback_data: options.planExpanded
        ? encodePlanCollapseCallback(options.sessionId)
        : encodePlanExpandCallback(options.sessionId)
    }]);
  }

  if (options.agentEntries.length > 0) {
    rows.push([{
      text: options.agentsExpanded ? "收起 Agent" : buildCollapsedAgentButtonLabel(options.agentEntries),
      callback_data: options.agentsExpanded
        ? encodeAgentCollapseCallback(options.sessionId)
        : encodeAgentExpandCallback(options.sessionId)
    }]);
  }

  if (rows.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: rows
  };
}

export function buildRuntimeStatusFieldLabel(field: RuntimeStatusField): string {
  switch (field) {
    case "model-name":
      return "模型名";
    case "model-with-reasoning":
      return "模型 + 推理强度";
    case "current-dir":
      return "当前目录";
    case "project-root":
      return "项目根目录";
    case "git-branch":
      return "Git 分支";
    case "context-remaining":
      return "剩余上下文";
    case "context-used":
      return "已用上下文";
    case "five-hour-limit":
      return "5 小时额度";
    case "weekly-limit":
      return "周额度";
    case "codex-version":
      return "Codex 版本";
    case "context-window-size":
      return "上下文窗口大小";
    case "used-tokens":
      return "已用 Token";
    case "total-input-tokens":
      return "累计输入 Token";
    case "total-output-tokens":
      return "累计输出 Token";
    case "session-id":
      return "会话 ID";
    case "session_name":
      return "会话名";
    case "project_name":
      return "项目名";
    case "project_path":
      return "项目路径（旧）";
    case "plan_mode":
      return "Plan mode";
    case "model_reasoning":
      return "模型 + 强度（旧）";
    case "thread_id":
      return "线程 ID（旧）";
    case "turn_id":
      return "Turn ID";
    case "blocked_reason":
      return "阻塞原因";
    case "current_step":
      return "当前步骤";
    case "last_token_usage":
      return "本次 Token";
    case "total_token_usage":
      return "累计 Token";
    case "context_window":
      return "上下文窗口";
    case "final_answer_ready":
      return "最终答复已就绪";
  }
}

export function buildRuntimePreferencesAppliedMessage(fields: RuntimeStatusField[]): string {
  const summary = fields.length > 0
    ? fields.map((field) => buildRuntimeStatusFieldLabel(field)).join("、")
    : "无";

  return [
    "<b>已应用 Runtime 卡片字段</b>",
    formatHtmlField("当前字段：", summary)
  ].join("\n");
}

export function buildRuntimePreferencesMessage(options: {
  token: string;
  fields: RuntimeStatusField[];
  page: number;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const pages = buildRuntimePreferencePages();
  const totalPages = Math.max(1, pages.length);
  const safePage = Math.min(Math.max(options.page, 0), totalPages - 1);
  const currentPage = pages[safePage] ?? {
    groupLabel: "Codex CLI",
    groupPage: 0,
    groupPageCount: 1,
    fields: [...CODEX_CLI_RUNTIME_STATUS_FIELDS].slice(0, RUNTIME_FIELD_PAGE_SIZE)
  };
  const pageFields = currentPage.fields;
  const selectedSet = new Set(options.fields);

  const selectedSummary = options.fields.length > 0
    ? options.fields.map((field, index) => `${index + 1}. ${buildRuntimeStatusFieldLabel(field)}`).join("\n")
    : "当前没有已选字段。";

  const rows = pageFields.map((field) => [{
    text: `${selectedSet.has(field) ? "✓" : "＋"} ${buildRuntimeStatusFieldLabel(field)}`,
    callback_data: encodeRuntimeToggleCallback(options.token, field)
  }]);

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navigation.push({ text: "上一页", callback_data: encodeRuntimePageCallback(options.token, safePage - 1) });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({ text: "下一页", callback_data: encodeRuntimePageCallback(options.token, safePage + 1) });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }

  rows.push([{ text: "保存并应用", callback_data: encodeRuntimeSaveCallback(options.token) }]);
  rows.push([{ text: "恢复默认", callback_data: encodeRuntimeResetCallback(options.token) }]);

  return {
    text: [
      formatHtmlHeading("Runtime 卡片字段"),
      "按按钮选择要显示的字段。",
      "选择顺序就是显示顺序；新选中的字段会追加到末尾。",
      formatHtmlField("Codex CLI：", buildRuntimeStatusFieldGroupSummary(SELECTABLE_CODEX_CLI_RUNTIME_STATUS_FIELDS)),
      formatHtmlField("Bridge Extensions：", buildRuntimeStatusFieldGroupSummary(BRIDGE_EXTENSION_RUNTIME_STATUS_FIELDS)),
      formatHtmlField("当前分组：", currentPage.groupLabel),
      formatHtmlField("已选字段：", `${options.fields.length} 个`),
      selectedSummary,
      formatHtmlField("分组页码：", `${currentPage.groupPage + 1}/${currentPage.groupPageCount}`),
      formatHtmlField("总页码：", `${safePage + 1}/${totalPages}`)
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: rows
    }
  };
}

export function buildInspectViewMessage(options: {
  sessionId: string;
  html: string;
  page: number;
  collapsed: boolean;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
  totalPages: number;
} {
  const pages = paginateInspectHtml(options.html);
  const safePage = Math.min(Math.max(options.page, 0), pages.length - 1);

  if (options.collapsed) {
    return {
      text: buildCollapsedInspectText(options.html),
      replyMarkup: {
        inline_keyboard: [[{
          text: "展开详情",
          callback_data: encodeInspectExpandCallback(options.sessionId, safePage)
        }]]
      },
      totalPages: pages.length
    };
  }

  const buttons: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    buttons.push({ text: "上一页", callback_data: encodeInspectPageCallback(options.sessionId, safePage - 1) });
  }
  if (safePage + 1 < pages.length) {
    buttons.push({ text: "下一页", callback_data: encodeInspectPageCallback(options.sessionId, safePage + 1) });
  }

  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  if (buttons.length > 0) {
    rows.push(buttons);
  }
  rows.push([{ text: "收起详情", callback_data: encodeInspectCollapseCallback(options.sessionId) }]);

  return {
    text: `${pages[safePage]}\n\n${formatHtmlField("详情页：", `${safePage + 1}/${pages.length}`)}`,
    replyMarkup: {
      inline_keyboard: rows
    },
    totalPages: pages.length
  };
}

export function buildRollbackPickerMessage(options: {
  sessionId: string;
  page: number;
  targets: RollbackTargetView[];
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
  totalPages: number;
} {
  const totalPages = Math.max(1, Math.ceil(options.targets.length / ROLLBACK_TARGET_PAGE_SIZE));
  const safePage = Math.min(Math.max(options.page, 0), totalPages - 1);
  const pageTargets = options.targets.slice(safePage * ROLLBACK_TARGET_PAGE_SIZE, (safePage + 1) * ROLLBACK_TARGET_PAGE_SIZE);
  const rows = pageTargets.map((target) => [{
    text: `${target.sequenceNumber}. ${truncateText(target.label, 24)}`,
    callback_data: encodeRollbackPickCallback(options.sessionId, safePage, target.index)
  }]);

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navigation.push({ text: "上一页", callback_data: encodeRollbackPageCallback(options.sessionId, safePage - 1) });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({ text: "下一页", callback_data: encodeRollbackPageCallback(options.sessionId, safePage + 1) });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }

  const lines = [
    formatHtmlHeading("选择回滚目标"),
    "只展示用户输入，不展示 agent 输出。",
    formatHtmlField("页码：", `${safePage + 1}/${totalPages}`)
  ];

  pageTargets.forEach((target) => {
    lines.push(`${target.sequenceNumber}. ${escapeHtml(target.label)}`);
  });

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: rows
    },
    totalPages
  };
}

export function buildRollbackConfirmMessage(options: {
  sessionId: string;
  page: number;
  target: RollbackTargetView;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: [
      formatHtmlHeading("确认回滚"),
      formatHtmlField("目标：", `${options.target.sequenceNumber}. ${options.target.label}`),
      formatHtmlField("将删除的 turn 数：", `${options.target.rollbackCount}`),
      "本地文件改动不会自动撤销。"
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "确认回滚", callback_data: encodeRollbackConfirmCallback(options.sessionId, options.target.index) }],
        [{ text: "返回列表", callback_data: encodeRollbackBackCallback(options.sessionId, options.page) }]
      ]
    }
  };
}

export function buildRuntimeErrorCard(
  options: RuntimeCardContext & {
    title: string;
    detail?: string | null;
  }
): string {
  const lines: string[] = [formatHtmlHeading("Error")];
  pushHtmlRuntimeCardContext(lines, options);
  if (options.projectName && options.projectName !== options.sessionName) {
    lines.push(formatHtmlField("Project:", options.projectName));
  }
  lines.push(formatHtmlField("Title:", truncateText(options.title, 200)));

  if (options.detail) {
    lines.push(formatHtmlField("Detail:", truncateText(options.detail, 240)));
  }

  return lines.join("\n");
}

export function buildInteractionApprovalCard(options: {
  interactionId: string;
  title: string;
  subtitle: string;
  body?: string | null;
  detail?: string | null;
  actions: Array<{
    text: string;
    decisionKey: string;
  }>;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const lines = [formatHtmlHeading(options.title), formatHtmlField("类型：", options.subtitle)];
  if (options.body) {
    lines.push(formatHtmlField("内容：", options.body));
  }
  if (options.detail) {
    lines.push(formatHtmlField("说明：", options.detail));
  }

  const actionRow = options.actions.map((action, index) => ({
    text: action.text,
    callback_data: encodeInteractionDecisionCallback(options.interactionId, index)
  }));

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [
        actionRow,
        [{ text: "取消本次交互", callback_data: encodeInteractionCancelCallback(options.interactionId) }]
      ]
    }
  };
}

export function buildInteractionQuestionCard(options: {
  interactionId: string;
  title: string;
  questionId: string;
  header: string;
  question: string;
  questionIndex: number;
  totalQuestions: number;
  options: Array<{ label: string; description: string }> | null;
  isOther: boolean;
  isSecret: boolean;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const lines = [
    formatHtmlHeading(options.title),
    formatHtmlField("问题：", `${options.questionIndex}/${options.totalQuestions}`),
    formatHtmlField("标题：", options.header),
    escapeHtml(options.question)
  ];

  if (options.isSecret) {
    lines.push("<i>这条回答会按敏感输入处理，不会进入可见摘要。</i>");
  }

  if (!options.options || options.options.length === 0) {
    lines.push("<i>点击下方按钮后，直接在聊天里发送你的回答。</i>");
    return {
      text: lines.join("\n"),
      replyMarkup: {
        inline_keyboard: [
          [{ text: "发送文字回答", callback_data: encodeInteractionTextCallback(options.interactionId, options.questionIndex - 1) }],
          [{ text: "取消本次交互", callback_data: encodeInteractionCancelCallback(options.interactionId) }]
        ]
      }
    };
  }

  for (const [index, option] of options.options.entries()) {
    lines.push(`${index + 1}. ${escapeHtml(option.label)}: ${escapeHtml(option.description)}`);
  }

  const optionButtons = options.options.map((option, index) => ({
    text: option.label,
    callback_data: encodeInteractionQuestionCallback(options.interactionId, options.questionIndex - 1, index)
  }));
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = chunkButtons(optionButtons, 2);

  if (options.isOther) {
    rows.push([
      {
        text: "其他",
        callback_data: encodeInteractionTextCallback(options.interactionId, options.questionIndex - 1)
      }
    ]);
  }

  rows.push([{ text: "取消本次交互", callback_data: encodeInteractionCancelCallback(options.interactionId) }]);

  return {
    text: lines.join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildInteractionResolvedCard(options: {
  title: string;
  state: "answered" | "canceled" | "failed";
  summary?: string | null;
  details?: string[];
  expandable?: boolean;
  expanded?: boolean;
  interactionId?: string;
}): {
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
} {
  const stateText = options.state === "answered"
    ? "已处理"
    : options.state === "canceled"
      ? "已取消"
      : "处理失败";
  const lines = [
    formatHtmlHeading(options.title),
    formatHtmlField("状态：", stateText)
  ];
  if (options.summary) {
    lines.push(formatHtmlField("结果：", options.summary));
  }
  if (options.expanded && options.details && options.details.length > 0) {
    lines.push("", formatHtmlHeading("已提交回答"));
    for (const detail of options.details) {
      lines.push(escapeHtml(detail));
    }
  }

  if (!options.expandable || !options.interactionId) {
    return { text: lines.join("\n") };
  }

  return {
    text: lines.join("\n"),
    replyMarkup: {
      inline_keyboard: [[{
        text: options.expanded ? "收起已提交回答" : "查看已提交回答",
        callback_data: options.expanded
          ? encodeInteractionAnswerCollapseCallback(options.interactionId)
          : encodeInteractionAnswerExpandCallback(options.interactionId)
      }]]
    }
  };
}

export function buildInteractionExpiredCard(options: {
  title: string;
  reason?: string | null;
}): {
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
} {
  const lines = [
    formatHtmlHeading(options.title),
    formatHtmlField("状态：", "已过期")
  ];
  if (options.reason) {
    lines.push(formatHtmlField("说明：", options.reason));
  }
  return { text: lines.join("\n") };
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
    commands?: RuntimeCommandEntryView[];
    note?: string | null;
  }
): string {
  const lines = [formatHtmlHeading("当前任务详情")];

  if (options?.sessionName) {
    lines.push(formatHtmlField("会话：", options.sessionName));
  }

  if (options?.projectName && options.projectName !== options.sessionName) {
    lines.push(formatHtmlField("项目：", options.projectName));
  }

  lines.push(formatHtmlField("状态：", formatInspectTurnStatus(snapshot.turnStatus)));

  const blockedOn = formatInspectBlockedReason(snapshot.threadBlockedReason);
  if (blockedOn) {
    lines.push(formatHtmlField("阻塞原因：", blockedOn));
  }

  lines.push(formatHtmlField("当前动作：", describeInspectCurrentStep(snapshot)));

  if (snapshot.currentItemDurationSec !== null) {
    lines.push(formatHtmlField("已耗时：", formatDuration(snapshot.currentItemDurationSec)));
  }

  const conclusion = selectInspectConclusion(snapshot);
  if (conclusion) {
    lines.push(formatHtmlField("最近结论：", conclusion));
  }

  if (snapshot.finalMessageAvailable) {
    lines.push(formatHtmlField("最终答复：", "已就绪"));
  }

  if (options?.note) {
    lines.push(formatHtmlField("说明：", options.note));
  }

  const timelineLines = formatInspectTimelineSection(snapshot.recentTransitions);
  if (timelineLines.length > 0) {
    lines.push("", formatHtmlHeading("最近动作"));
    lines.push(...timelineLines);
  }

  const commandLines = formatInspectCommandSection(options?.commands ?? [], snapshot.recentCommandSummaries);
  if (commandLines.length > 0) {
    lines.push("", formatHtmlHeading("最近命令"));
    lines.push(...commandLines);
  }

  const fileChangeLines = formatInspectSummarySection(snapshot.recentFileChangeSummaries);
  if (fileChangeLines.length > 0) {
    lines.push("", formatHtmlHeading("最近文件变更"));
    lines.push(...fileChangeLines);
  }

  const toolLines = formatInspectSummarySection([
    ...snapshot.recentMcpSummaries,
    ...snapshot.recentWebSearches
  ]);
  if (toolLines.length > 0) {
    lines.push("", formatHtmlHeading("最近工具与搜索"));
    lines.push(...toolLines);
  }

  const hookLines = formatInspectSummarySection(snapshot.recentHookSummaries);
  if (hookLines.length > 0) {
    lines.push("", formatHtmlHeading("最近 Hook"));
    lines.push(...hookLines);
  }

  const noticeLines = formatInspectSummarySection(
    [
      ...snapshot.recentNoticeSummaries,
      snapshot.terminalInteractionSummary
    ].filter((value): value is string => Boolean(value))
  );
  if (noticeLines.length > 0) {
    lines.push("", formatHtmlHeading("提示与告警"));
    lines.push(...noticeLines);
  }

  const tokenUsageLines = formatTokenUsageSection(snapshot.tokenUsage);
  if (tokenUsageLines.length > 0) {
    lines.push("", formatHtmlHeading("Token 用量"));
    lines.push(...tokenUsageLines);
  }

  if (snapshot.latestDiffSummary) {
    lines.push("", formatHtmlHeading("最近差异"));
    lines.push(formatHtmlListItem(snapshot.latestDiffSummary));
  }

  const planLines = formatInspectSummarySection(snapshot.planSnapshot);
  if (planLines.length > 0) {
    lines.push("", formatHtmlHeading("计划清单"));
    lines.push(...planLines);
  }

  const proposedPlanLines = formatInspectSummarySection(snapshot.proposedPlanSnapshot);
  if (proposedPlanLines.length > 0) {
    lines.push("", formatHtmlHeading("方案草稿"));
    lines.push(...proposedPlanLines);
  }

  const commentaryLines = formatInspectSummarySection(snapshot.completedCommentary);
  if (commentaryLines.length > 0) {
    lines.push("", formatHtmlHeading("补充说明"));
    lines.push(...commentaryLines);
  }

  const pendingInteractionLines = formatPendingInteractionSection(snapshot.pendingInteractions);
  if (pendingInteractionLines.length > 0) {
    lines.push("", formatHtmlHeading("待处理交互"));
    lines.push(...pendingInteractionLines);
  }

  const answeredInteractionLines = formatInspectSummarySection(snapshot.answeredInteractions);
  if (answeredInteractionLines.length > 0) {
    lines.push("", formatHtmlHeading("最近已答交互"));
    lines.push(...answeredInteractionLines);
  }

  return lines.join("\n");
}

export function summarizePendingInteractionState(state: PendingInteractionState): string {
  switch (state) {
    case "pending":
      return "待处理";
    case "awaiting_text":
      return "等待文字回答";
    case "answered":
      return "已处理";
    case "canceled":
      return "已取消";
    case "expired":
      return "已过期";
    case "failed":
      return "处理失败";
    default:
      return state;
  }
}

function buildRuntimeStatusFieldGroupSummary(fields: readonly RuntimeStatusField[]): string {
  return fields.map((field) => buildRuntimeStatusFieldLabel(field)).join("、");
}

const SELECTABLE_CODEX_CLI_RUNTIME_STATUS_FIELDS: readonly RuntimeStatusField[] = [
  "model-name",
  "model-with-reasoning",
  "current-dir",
  "project-root",
  "context-remaining",
  "context-used",
  "context-window-size",
  "used-tokens",
  "total-input-tokens",
  "total-output-tokens",
  "session-id"
] as const;

function buildRuntimePreferencePages(): Array<{
  groupLabel: string;
  groupPage: number;
  groupPageCount: number;
  fields: RuntimeStatusField[];
}> {
  const groups = [
    { groupLabel: "Codex CLI", fields: [...SELECTABLE_CODEX_CLI_RUNTIME_STATUS_FIELDS] },
    { groupLabel: "Bridge Extensions", fields: [...BRIDGE_EXTENSION_RUNTIME_STATUS_FIELDS] }
  ];

  return groups.flatMap(({ groupLabel, fields }) => {
    const groupPageCount = Math.max(1, Math.ceil(fields.length / RUNTIME_FIELD_PAGE_SIZE));
    return Array.from({ length: groupPageCount }, (_value, groupPage) => ({
      groupLabel,
      groupPage,
      groupPageCount,
      fields: fields.slice(groupPage * RUNTIME_FIELD_PAGE_SIZE, (groupPage + 1) * RUNTIME_FIELD_PAGE_SIZE)
    }));
  });
}

function buildCollapsedInspectText(html: string): string {
  const blocks = html.split("\n\n");
  const summary = blocks[0] ?? html;
  return `${summary}\n${formatHtmlField("说明：", "详情已折叠，点击按钮展开。")}`;
}

function paginateInspectHtml(html: string): string[] {
  const blocks = html.split("\n\n");
  const summary = blocks[0] ?? html;
  const sections = blocks.slice(1);
  if (sections.length === 0) {
    return [html];
  }

  const sectionLengthLimit = Math.max(200, INSPECT_PAGE_CHAR_LIMIT - summary.length - 2);
  const normalizedSections = sections.flatMap((section) => splitOversizedInspectSection(section, sectionLengthLimit));
  const pages: string[] = [];
  let current = summary;

  for (const section of normalizedSections) {
    const candidate = `${current}\n\n${section}`;
    if (candidate.length <= INSPECT_PAGE_CHAR_LIMIT) {
      current = candidate;
      continue;
    }

    pages.push(current);
    current = `${summary}\n\n${section}`;
  }

  pages.push(current);
  return pages;
}

function splitOversizedInspectSection(section: string, maxLength: number): string[] {
  if (section.length <= maxLength) {
    return [section];
  }

  const lines = section.split("\n");
  const header = isStandaloneInspectHeading(lines[0] ?? "") ? lines[0] ?? null : null;
  const bodyLines = header ? lines.slice(1) : lines;
  if (bodyLines.length === 0) {
    return [section];
  }

  const chunks: string[] = [];
  const lineLengthLimit = Math.max(32, maxLength - (header ? header.length + 1 : 0));
  let currentLines = header ? [header] : [];

  for (const line of bodyLines) {
    const lineChunks = splitOversizedInspectLine(line, lineLengthLimit);
    for (const lineChunk of lineChunks) {
      const candidateLines = [...currentLines, lineChunk];
      const candidate = candidateLines.join("\n");
      if (candidate.length <= maxLength) {
        currentLines = candidateLines;
        continue;
      }

      if (currentLines.length > (header ? 1 : 0)) {
        chunks.push(currentLines.join("\n"));
      }
      currentLines = header ? [header, lineChunk] : [lineChunk];
    }
  }

  if (currentLines.length > (header ? 1 : 0)) {
    chunks.push(currentLines.join("\n"));
  }

  return chunks.length > 0 ? chunks : [section];
}

function splitOversizedInspectLine(line: string, maxLength: number): string[] {
  if (line.length <= maxLength) {
    return [line];
  }

  const { prefix, content } = splitInspectLinePrefix(line);
  const contentLengthLimit = Math.max(16, maxLength - prefix.length);
  if (!content || prefix.length >= maxLength) {
    return splitEscapedInspectText(line, maxLength);
  }

  return splitEscapedInspectText(content, contentLengthLimit).map((chunk) => `${prefix}${chunk}`);
}

function splitInspectLinePrefix(line: string): { prefix: string; content: string } {
  const patterns = [
    /^(\d+\.\s+<b>[^<]+<\/b>\s+)(.+)$/u,
    /^(-\s+<b>[^<]+<\/b>\s+)(.+)$/u,
    /^(\d+\.\s+)(.+)$/u,
    /^(-\s+)(.+)$/u,
    /^(<b>[^<]+<\/b>\s+)(.+)$/u
  ];

  for (const pattern of patterns) {
    const match = line.match(pattern);
    if (match) {
      return {
        prefix: match[1] ?? "",
        content: match[2] ?? ""
      };
    }
  }

  return {
    prefix: "",
    content: line
  };
}

function splitEscapedInspectText(text: string, maxLength: number): string[] {
  const tokens = text.match(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);|\s+|./giu) ?? [text];
  const chunks: string[] = [];
  let current = "";

  for (const token of tokens) {
    if (current.length + token.length <= maxLength) {
      current += token;
      continue;
    }

    if (current.length > 0) {
      chunks.push(current.trimEnd());
      current = token.trimStart();
      continue;
    }

    chunks.push(token);
  }

  if (current.length > 0) {
    chunks.push(current.trimEnd());
  }

  return chunks.filter((chunk) => chunk.length > 0);
}

function isStandaloneInspectHeading(line: string): boolean {
  return /^<b>[^<]+<\/b>$/u.test(line.trim());
}

function pushHtmlRuntimeCardContext(lines: string[], context: RuntimeCardContext, language: UiLanguage = "zh"): void {
  if (context.sessionName) {
    lines.push(formatRuntimeCardRow(language === "en" ? "Session" : "会话", context.sessionName));
  }
}

function formatRuntimeStatusOptionalField(line: string, language: UiLanguage): string {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) {
    return escapeHtml(line);
  }

  const rawLabel = line.slice(0, separatorIndex).trim();
  const rawValue = line.slice(separatorIndex + 1).trimStart();
  if (!rawLabel) {
    return escapeHtml(line);
  }

  return formatRuntimeCardRow(
    language === "en" ? formatRuntimeStatusOptionalLabel(rawLabel) : formatRuntimeStatusOptionalLabelZh(rawLabel),
    rawValue
  );
}

function formatRuntimeStatusOptionalLabel(label: string): string {
  const uppercaseTokens = new Set(["api", "cli", "html", "id", "json", "mcp", "url", "uuid"]);
  return label
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (uppercaseTokens.has(lower)) {
        return lower.toUpperCase();
      }

      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function formatRuntimeStatusOptionalLabelZh(label: string): string {
  switch (label) {
    case "model-with-reasoning":
      return "模型";
    case "plan_mode":
      return "Plan Mode";
    case "current-dir":
      return "目录";
    default:
      return formatRuntimeStatusOptionalLabel(label);
  }
}

function buildCollapsedPlanButtonLabel(entries: string[]): string {
  const currentEntry = selectCurrentPlanEntry(entries);
  if (!currentEntry) {
    return "查看计划清单";
  }

  return `计划清单：${truncateText(stripPlanEntryStatus(currentEntry), 40)}`;
}

function buildCollapsedAgentButtonLabel(entries: CollabAgentStateSnapshot[]): string {
  return `Agent：${entries.length} 个运行中`;
}

function renderAgentRuntimeLine(entry: CollabAgentStateSnapshot, index: number): string {
  const prefix = `${index}. ${escapeHtml(entry.label)} (${escapeHtml(formatAgentStatus(entry.status))})`;
  if (!entry.progress) {
    return prefix;
  }

  return `${prefix}: ${renderInlineMarkdown(truncateText(entry.progress, 160))}`;
}

function selectCurrentPlanEntry(entries: string[]): string | null {
  return entries.find((entry) => /\(inProgress\)$/u.test(entry))
    ?? entries.find((entry) => /\((pending|todo)\)$/u.test(entry))
    ?? entries[0]
    ?? entries.at(-1)
    ?? null;
}

function stripPlanEntryStatus(entry: string): string {
  return entry
    .replace(/\s+\((inProgress|pending|todo|completed|failed|blocked)\)$/u, "")
    .replace(/^#+\s*/u, "")
    .trim();
}

function formatAgentStatus(status: CollabAgentStateSnapshot["status"]): string {
  switch (status) {
    case "pendingInit":
      return "pending";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "errored":
      return "errored";
    case "shutdown":
      return "shutdown";
    case "notFound":
      return "not found";
    default:
      return status;
  }
}

function buildDetailedRuntimeCommandLines(
  command: RuntimeCommandEntryView,
  index: number | null
): string[] {
  const prefix = index === null ? "" : `${index}. `;
  const detailPrefix = index === null ? "" : "- ";
  const lines = [`${prefix}${formatHtmlField("命令：", formatRuntimeCommandText(command.commandText))}`];
  lines.push(`${detailPrefix}${formatHtmlField("状态：", formatInspectCommandState(command.state))}`);

  if (command.latestSummary) {
    lines.push(`${detailPrefix}${formatHtmlField("结果：", truncateText(command.latestSummary, 220))}`);
  }

  if (command.cwd) {
    lines.push(`${detailPrefix}${formatHtmlField("目录：", truncateText(command.cwd, 220))}`);
  }

  if (typeof command.exitCode === "number") {
    lines.push(`${detailPrefix}${formatHtmlField("退出码：", `${command.exitCode}`)}`);
  }

  if (typeof command.durationMs === "number") {
    lines.push(`${detailPrefix}${formatHtmlField("耗时：", formatCommandDuration(command.durationMs))}`);
  }

  return lines;
}

function formatInspectCommandSection(commands: RuntimeCommandEntryView[], fallbackSummaries: string[]): string[] {
  if (commands.length === 0) {
    return formatInspectSummarySection(fallbackSummaries);
  }

  return commands.flatMap((command, index) => buildDetailedRuntimeCommandLines(command, index + 1));
}

function formatPendingInteractionSection(snapshot: InspectSnapshot["pendingInteractions"]): string[] {
  return snapshot.map((interaction, index) => {
    const suffix = interaction.awaitingText ? "，等待文字回答" : "";
    return `${index + 1}. ${escapeHtml(interaction.interactionKind)} / ${escapeHtml(interaction.requestMethod)} / ${escapeHtml(summarizePendingInteractionState(interaction.state))}${suffix}`;
  });
}

function formatTokenUsageSection(tokenUsage: InspectSnapshot["tokenUsage"]): string[] {
  if (!tokenUsage) {
    return [];
  }

  const lines = [
    formatHtmlListItem(`本次：${tokenUsage.lastTotalTokens}（输入 ${tokenUsage.lastInputTokens}，输出 ${tokenUsage.lastOutputTokens}，缓存 ${tokenUsage.lastCachedInputTokens}，推理 ${tokenUsage.lastReasoningOutputTokens}）`),
    formatHtmlListItem(`累计：${tokenUsage.totalTokens}（输入 ${tokenUsage.totalInputTokens}，输出 ${tokenUsage.totalOutputTokens}，缓存 ${tokenUsage.totalCachedInputTokens}，推理 ${tokenUsage.totalReasoningOutputTokens}）`)
  ];
  if (tokenUsage.modelContextWindow !== null) {
    lines.push(formatHtmlListItem(`上下文窗口：${tokenUsage.modelContextWindow}`));
  }

  return lines;
}

function formatRuntimeCommandText(commandText: string): string {
  const trimmed = commandText.trim();
  if (trimmed.startsWith("$")) {
    return truncateText(trimmed, 220);
  }

  return truncateText(`$ ${trimmed}`, 220);
}

function formatInspectSummarySection(values: string[]): string[] {
  return values
    .filter((value) => value.trim().length > 0)
    .map((value) => formatHtmlListItem(value));
}

function formatInspectTimelineSection(transitions: InspectSnapshot["recentTransitions"]): string[] {
  return transitions
    .slice(-5)
    .reverse()
    .map((transition, index) => `${index + 1}. ${escapeHtml(`${formatRelativeTime(transition.at)}：${translateInspectSummary(transition.summary)}`)}`);
}

function formatRuntimeCardRow(
  label: string,
  value: string,
  options: {
    valueIsHtml?: boolean;
  } = {}
): string {
  const renderedValue = options.valueIsHtml ? value : escapeHtml(value);
  return `${formatHtmlHeading(label)} · ${renderedValue}`;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/gu, "");
}

function formatHtmlListItem(value: string): string {
  return `- ${escapeHtml(value)}`;
}

function formatInspectTurnStatus(status: ActivityStatus["turnStatus"]): string {
  switch (status) {
    case "idle":
      return "空闲";
    case "starting":
      return "准备中";
    case "running":
      return "执行中";
    case "blocked":
      return "等待中";
    case "interrupted":
      return "已中断";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    default:
      return "未知";
  }
}

function formatInspectCommandState(state: string): string {
  switch (state.toLowerCase()) {
    case "running":
      return "进行中";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "interrupted":
      return "已中断";
    default:
      return "未知";
  }
}

function formatInspectBlockedReason(reason: ActivityStatus["threadBlockedReason"]): string | null {
  switch (reason) {
    case "waitingOnApproval":
      return "等待批准";
    case "waitingOnUserInput":
      return "等待输入";
    default:
      return null;
  }
}

function describeInspectCurrentStep(status: ActivityStatus): string {
  if (status.threadBlockedReason === "waitingOnApproval") {
    return "等待批准";
  }

  if (status.threadBlockedReason === "waitingOnUserInput") {
    return "等待输入";
  }

  switch (status.activeItemType) {
    case "planning":
      return "正在更新计划";
    case "commandExecution":
      return appendSpecificLabel("正在运行命令", status.activeItemLabel, ["command"], "：");
    case "fileChange":
      return appendSpecificLabel("正在修改文件", status.activeItemLabel, ["file changes"], "：");
    case "mcpToolCall":
      return appendSpecificLabel("正在调用 MCP 工具", status.activeItemLabel, ["MCP tool call"], "：");
    case "webSearch":
      return appendSpecificLabel("正在进行网页搜索", status.activeItemLabel, ["web search"], "：");
    case "agentMessage":
      return appendSpecificLabel("正在整理回复", status.activeItemLabel, ["assistant response"], "：");
    case "reasoning":
      return "正在思考";
    case "other":
      return appendSpecificLabel("正在处理任务", status.activeItemLabel, ["work item", "other"], "：");
    default:
      return defaultInspectStepForStatus(status.turnStatus);
  }
}

function selectInspectConclusion(status: ActivityStatus): string | null {
  const latestUpdate = getLatestStatusUpdate(status);
  if (latestUpdate) {
    return latestUpdate;
  }

  if (status.latestProgress) {
    return status.latestProgress;
  }

  return formatInspectMilestone(status);
}

function translateInspectSummary(summary: string): string {
  if (summary === "turn started") {
    return "开始执行";
  }

  const completedMatch = summary.match(/^turn completed \((.+)\)$/u);
  if (completedMatch) {
    return `执行结束（${formatInspectTurnStatus(mapCompletionWord(completedMatch[1] ?? "unknown"))}）`;
  }

  const blockedMatch = summary.match(/^thread blocked \((.+)\)$/u);
  if (blockedMatch) {
    return `线程阻塞（${translateBlockedToken(blockedMatch[1] ?? "")}）`;
  }

  const statusMatch = summary.match(/^thread status (.+)$/u);
  if (statusMatch) {
    return `线程状态：${translateThreadStatusToken(statusMatch[1] ?? "")}`;
  }

  const startedMatch = summary.match(/^(.+) started$/u);
  if (startedMatch) {
    return `开始：${startedMatch[1] ?? ""}`;
  }

  const itemCompletedMatch = summary.match(/^(.+) completed$/u);
  if (itemCompletedMatch) {
    return `完成：${itemCompletedMatch[1] ?? ""}`;
  }

  return summary;
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
    return BLOCKED_PROGRESS_APPROVAL;
  }

  if (status.threadBlockedReason === "waitingOnUserInput") {
    return BLOCKED_PROGRESS_USER_INPUT;
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

function appendSpecificLabel(base: string, label: string | null, genericLabels: string[], separator = ": "): string {
  if (!label || genericLabels.includes(label)) {
    return base;
  }

  return `${base}${separator}${label}`;
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

function defaultInspectStepForStatus(status: ActivityStatus["turnStatus"]): string {
  switch (status) {
    case "starting":
      return "等待第一条活动";
    case "running":
      return "正在处理中";
    case "blocked":
      return "等待继续";
    case "completed":
      return "当前没有进行中的步骤";
    case "interrupted":
      return "已中断，没有进行中的步骤";
    case "failed":
      return "执行失败，没有进行中的步骤";
    case "idle":
      return "当前没有进行中的步骤";
    default:
      return "等待活动";
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

function formatInspectMilestone(status: ActivityStatus): string | null {
  const title = status.lastHighValueTitle;
  if (!title) {
    return null;
  }

  switch (status.lastHighValueEventType) {
    case "ran_cmd": {
      const command = stripPrefix(title, "Ran cmd: ");
      return status.lastHighValueDetail
        ? `命令结果：${command} -> ${status.lastHighValueDetail}`
        : `开始运行命令：${command}`;
    }
    case "changed":
      return `文件变更：${status.lastHighValueDetail ?? stripPrefix(title, "Changed: ")}`;
    case "found":
      return `发现：${status.lastHighValueDetail ?? stripPrefix(title, "Found: ")}`;
    case "blocked":
      return `阻塞：${status.lastHighValueDetail ?? stripPrefix(title, "Blocked: ")}`;
    case "done":
      return status.lastHighValueDetail ? "最终答复已生成" : `执行结束：${stripPrefix(title, "Done: ")}`;
    default:
      return null;
  }
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

function formatCommandDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const seconds = Math.round((durationMs / 1000) * 10) / 10;
  return `${seconds}s`;
}

function mapCompletionWord(status: string): ActivityStatus["turnStatus"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

function translateBlockedToken(token: string): string {
  switch (token) {
    case "waitingOnApproval":
      return "等待批准";
    case "waitingOnUserInput":
      return "等待输入";
    default:
      return token;
  }
}

function translateThreadStatusToken(token: string): string {
  switch (token) {
    case "notLoaded":
      return "未加载";
    case "idle":
      return "空闲";
    case "active":
      return "活跃";
    case "systemError":
      return "系统错误";
    default:
      return token;
  }
}
