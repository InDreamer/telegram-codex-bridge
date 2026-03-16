import type {
  PendingInteractionState,
  ProjectCandidate,
  ProjectPickerResult,
  ReasoningEffort,
  ReadinessSnapshot,
  SessionRow
} from "../types.js";
import type { ActivityStatus, CollabAgentStateSnapshot, InspectSnapshot, StreamBlock, StreamSnapshot } from "../activity/types.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import { truncateText } from "../util/text.js";
import { BLOCKED_PROGRESS_APPROVAL, BLOCKED_PROGRESS_USER_INPUT } from "../util/blocked-progress.js";

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

export type ParsedCallbackData =
  | { kind: "pick"; projectKey: string }
  | { kind: "scan_more" }
  | { kind: "path_manual" }
  | { kind: "path_back" }
  | { kind: "path_confirm"; projectKey: string }
  | { kind: "rename_session"; sessionId: string }
  | { kind: "rename_project"; sessionId: string }
  | { kind: "rename_project_clear"; sessionId: string }
  | { kind: "model_default"; sessionId: string }
  | { kind: "model_page"; sessionId: string; page: number }
  | { kind: "model_pick"; sessionId: string; modelIndex: number }
  | { kind: "model_effort"; sessionId: string; modelIndex: number; effort: ReasoningEffort | null }
  | { kind: "plan_expand"; sessionId: string }
  | { kind: "plan_collapse"; sessionId: string }
  | { kind: "agent_expand"; sessionId: string }
  | { kind: "agent_collapse"; sessionId: string }
  | { kind: "final_open"; answerId: string }
  | { kind: "final_close"; answerId: string }
  | { kind: "final_page"; answerId: string; page: number }
  | { kind: "interaction_decision"; interactionId: string; decisionKey: string | null; decisionIndex: number | null }
  | {
      kind: "interaction_question";
      interactionId: string;
      questionId: string | null;
      questionIndex: number | null;
      optionIndex: number;
    }
  | { kind: "interaction_text"; interactionId: string; questionId: string | null; questionIndex: number | null }
  | { kind: "interaction_cancel"; interactionId: string };

const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

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

export function encodeRenameSessionCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v1:rename:session:${sessionId}`);
}

export function encodeRenameProjectCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v1:rename:project:${sessionId}`);
}

export function encodeRenameProjectClearCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v1:rename:project:clear:${sessionId}`);
}

export function encodeModelDefaultCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v2:model:default:${sessionId}`);
}

export function encodeModelPageCallback(sessionId: string, page: number): string {
  return ensureTelegramCallbackDataLimit(`v2:model:page:${sessionId}:${encodeInteractionIndex(page)}`);
}

export function encodeModelPickCallback(sessionId: string, modelIndex: number): string {
  return ensureTelegramCallbackDataLimit(`v2:model:pick:${sessionId}:${encodeInteractionIndex(modelIndex)}`);
}

export function encodeModelEffortCallback(
  sessionId: string,
  modelIndex: number,
  effort: ReasoningEffort | null
): string {
  return ensureTelegramCallbackDataLimit(
    `v2:model:effort:${sessionId}:${encodeInteractionIndex(modelIndex)}:${effort ?? "default"}`
  );
}

export function encodePlanExpandCallback(sessionId: string): string {
  return `v1:plan:expand:${sessionId}`;
}

export function encodePlanCollapseCallback(sessionId: string): string {
  return `v1:plan:collapse:${sessionId}`;
}

export function encodeAgentExpandCallback(sessionId: string): string {
  return `v1:agent:expand:${sessionId}`;
}

export function encodeAgentCollapseCallback(sessionId: string): string {
  return `v1:agent:collapse:${sessionId}`;
}

export function encodeFinalAnswerOpenCallback(answerId: string): string {
  return `v1:final:open:${answerId}`;
}

export function encodeFinalAnswerCloseCallback(answerId: string): string {
  return `v1:final:close:${answerId}`;
}

export function encodeFinalAnswerPageCallback(answerId: string, page: number): string {
  return `v1:final:page:${answerId}:${page}`;
}

function encodeInteractionToken(interactionId: string): string {
  return Buffer.from(interactionId, "utf8").toString("base64url");
}

function decodeInteractionToken(token: string): string | null {
  try {
    const interactionId = Buffer.from(token, "base64url").toString("utf8");
    return interactionId.length > 0 ? interactionId : null;
  } catch {
    return null;
  }
}

function encodeInteractionIndex(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`interaction callback index must be a non-negative safe integer: ${index}`);
  }

  return index.toString(36);
}

function decodeInteractionIndex(value: string): number | null {
  if (!/^[0-9a-z]+$/iu.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function ensureTelegramCallbackDataLimit(data: string): string {
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
    throw new Error(`Telegram callback_data exceeds ${TELEGRAM_CALLBACK_DATA_LIMIT_BYTES} bytes: ${data}`);
  }

  return data;
}

export function encodeInteractionDecisionCallback(interactionId: string, decisionIndex: number): string {
  return ensureTelegramCallbackDataLimit(
    `v3:ix:d:${encodeInteractionToken(interactionId)}:${encodeInteractionIndex(decisionIndex)}`
  );
}

export function encodeInteractionQuestionCallback(interactionId: string, questionIndex: number, optionIndex: number): string {
  return ensureTelegramCallbackDataLimit(
    `v3:ix:q:${encodeInteractionToken(interactionId)}:${encodeInteractionIndex(questionIndex)}:${encodeInteractionIndex(optionIndex)}`
  );
}

export function encodeInteractionTextCallback(interactionId: string, questionIndex: number): string {
  return ensureTelegramCallbackDataLimit(
    `v3:ix:t:${encodeInteractionToken(interactionId)}:${encodeInteractionIndex(questionIndex)}`
  );
}

export function encodeInteractionCancelCallback(interactionId: string): string {
  return ensureTelegramCallbackDataLimit(`v3:ix:c:${encodeInteractionToken(interactionId)}`);
}

export function parseCallbackData(data: string): ParsedCallbackData | null {
  const parts = data.split(":");
  if (parts[0] === "v2" && parts[1] === "model") {
    if (parts[2] === "default" && parts[3]) {
      return { kind: "model_default", sessionId: parts[3] };
    }

    if (parts[2] === "page" && parts[3] && parts[4]) {
      const page = decodeInteractionIndex(parts[4]);
      if (page !== null) {
        return { kind: "model_page", sessionId: parts[3], page };
      }
    }

    if (parts[2] === "pick" && parts[3] && parts[4]) {
      const modelIndex = decodeInteractionIndex(parts[4]);
      if (modelIndex !== null) {
        return { kind: "model_pick", sessionId: parts[3], modelIndex };
      }
    }

    if (parts[2] === "effort" && parts[3] && parts[4] && parts[5]) {
      const modelIndex = decodeInteractionIndex(parts[4]);
      if (modelIndex !== null) {
        const effort = parts[5] === "default" ? null : parseReasoningEffort(parts[5]);
        if (parts[5] === "default" || effort) {
          return { kind: "model_effort", sessionId: parts[3], modelIndex, effort };
        }
      }
    }

    return null;
  }

  if (parts[0] !== "v1") {
    if (parts[0] === "v3" && parts[1] === "ix") {
      if (parts[2] === "d" && parts[3] && parts[4]) {
        const interactionId = decodeInteractionToken(parts[3]);
        const decisionIndex = decodeInteractionIndex(parts[4]);
        if (interactionId && decisionIndex !== null) {
          return {
            kind: "interaction_decision",
            interactionId,
            decisionKey: null,
            decisionIndex
          };
        }
      }

      if (parts[2] === "q" && parts[3] && parts[4] && parts[5]) {
        const interactionId = decodeInteractionToken(parts[3]);
        const questionIndex = decodeInteractionIndex(parts[4]);
        const optionIndex = decodeInteractionIndex(parts[5]);
        if (interactionId && questionIndex !== null && optionIndex !== null) {
          return {
            kind: "interaction_question",
            interactionId,
            questionId: null,
            questionIndex,
            optionIndex
          };
        }
      }

      if (parts[2] === "t" && parts[3] && parts[4]) {
        const interactionId = decodeInteractionToken(parts[3]);
        const questionIndex = decodeInteractionIndex(parts[4]);
        if (interactionId && questionIndex !== null) {
          return {
            kind: "interaction_text",
            interactionId,
            questionId: null,
            questionIndex
          };
        }
      }

      if (parts[2] === "c" && parts[3]) {
        const interactionId = decodeInteractionToken(parts[3]);
        if (interactionId) {
          return {
            kind: "interaction_cancel",
            interactionId
          };
        }
      }

      if (parts[2] === "decision" && parts[3] && parts[4]) {
        return {
          kind: "interaction_decision",
          interactionId: parts[3],
          decisionKey: parts[4],
          decisionIndex: null
        };
      }

      if (parts[2] === "question" && parts[3] && parts[4] && parts[5]) {
        const optionIndex = Number.parseInt(parts[5], 10);
        if (Number.isFinite(optionIndex) && optionIndex >= 0) {
          return {
            kind: "interaction_question",
            interactionId: parts[3],
            questionId: parts[4],
            questionIndex: null,
            optionIndex
          };
        }
      }

      if (parts[2] === "text" && parts[3] && parts[4]) {
        return {
          kind: "interaction_text",
          interactionId: parts[3],
          questionId: parts[4],
          questionIndex: null
        };
      }

      if (parts[2] === "cancel" && parts[3]) {
        return {
          kind: "interaction_cancel",
          interactionId: parts[3]
        };
      }
    }

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

  if (parts[1] === "rename" && parts[2] === "session" && parts[3]) {
    return { kind: "rename_session", sessionId: parts[3] };
  }

  if (parts[1] === "rename" && parts[2] === "project" && parts[3] === "clear" && parts[4]) {
    return { kind: "rename_project_clear", sessionId: parts[4] };
  }

  if (parts[1] === "rename" && parts[2] === "project" && parts[3]) {
    return { kind: "rename_project", sessionId: parts[3] };
  }

  if (parts[1] === "plan" && parts[2] === "expand" && parts[3]) {
    return { kind: "plan_expand", sessionId: parts[3] };
  }

  if (parts[1] === "plan" && parts[2] === "collapse" && parts[3]) {
    return { kind: "plan_collapse", sessionId: parts[3] };
  }

  if (parts[1] === "agent" && parts[2] === "expand" && parts[3]) {
    return { kind: "agent_expand", sessionId: parts[3] };
  }

  if (parts[1] === "agent" && parts[2] === "collapse" && parts[3]) {
    return { kind: "agent_collapse", sessionId: parts[3] };
  }

  if (parts[1] === "final" && parts[2] === "open" && parts[3]) {
    return { kind: "final_open", answerId: parts[3] };
  }

  if (parts[1] === "final" && parts[2] === "close" && parts[3]) {
    return { kind: "final_close", answerId: parts[3] };
  }

  if (parts[1] === "final" && parts[2] === "page" && parts[3] && parts[4]) {
    const page = Number.parseInt(parts[4], 10);
    if (Number.isFinite(page) && page >= 1) {
      return { kind: "final_page", answerId: parts[3], page };
    }
  }

  return null;
}

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
    formatHtmlField("模型 + 思考强度：", formatSessionModelReasoningConfig(session))
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

export function buildRuntimeStatusCard(
  options: RuntimeCardContext & {
    state: string;
    progressText?: string | null;
    blockedReason?: string | null;
    planEntries?: string[];
    planExpanded?: boolean;
    agentEntries?: CollabAgentStateSnapshot[];
    agentsExpanded?: boolean;
  }
): string {
  const lines: string[] = ["<b>Runtime Status</b>"];
  pushHtmlRuntimeCardContext(lines, options);
  lines.push(`<b>State:</b> ${escapeHtml(options.state)}`);

  if (options.blockedReason) {
    lines.push(`<b>Blocked on:</b> ${escapeHtml(options.blockedReason)}`);
  }

  if (options.progressText) {
    lines.push("<b>Progress:</b>");
    lines.push(renderInlineMarkdown(truncateText(options.progressText, 240)));
  }

  if (options.planExpanded && options.planEntries && options.planEntries.length > 0) {
    lines.push("", "<b>Current Plan:</b>");

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

  lines.push("Use /inspect for full details");
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
      text: options.planExpanded ? "收起当前计划" : buildCollapsedPlanButtonLabel(options.planEntries),
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

export function buildRuntimeErrorCard(
  options: RuntimeCardContext & {
    title: string;
    detail?: string | null;
  }
): string {
  const lines: string[] = [formatHtmlHeading("Error")];
  pushHtmlRuntimeCardContext(lines, options);
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
  return { text: lines.join("\n") };
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
    lines.push("", formatHtmlHeading("当前计划"));
    lines.push(...planLines);
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

function pushHtmlRuntimeCardContext(lines: string[], context: RuntimeCardContext): void {
  if (context.sessionName) {
    lines.push(`<b>Session:</b> ${escapeHtml(context.sessionName)}`);
  }

  if (context.projectName && context.projectName !== context.sessionName) {
    lines.push(`<b>Project:</b> ${escapeHtml(context.projectName)}`);
  }
}

function buildCollapsedPlanButtonLabel(entries: string[]): string {
  const currentEntry = selectCurrentPlanEntry(entries);
  if (!currentEntry) {
    return "查看当前计划";
  }

  return `当前计划：${truncateText(stripPlanEntryStatus(currentEntry), 40)}`;
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
    ?? entries.at(-1)
    ?? entries[0]
    ?? null;
}

function stripPlanEntryStatus(entry: string): string {
  return entry.replace(/\s+\((inProgress|pending|todo|completed|failed|blocked)\)$/u, "").trim();
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

function chunkButtons<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
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

function formatRuntimeCommandText(commandText: string): string {
  const trimmed = commandText.trim();
  if (trimmed.startsWith("$")) {
    return truncateText(trimmed, 220);
  }

  return truncateText(`$ ${trimmed}`, 220);
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

function parseReasoningEffort(value: string): ReasoningEffort | null {
  switch (value) {
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return null;
  }
}

export function formatReasoningEffortLabel(effort: ReasoningEffort): string {
  switch (effort) {
    case "none":
      return "关闭";
    case "minimal":
      return "极省";
    case "low":
      return "低";
    case "medium":
      return "中";
    case "high":
      return "高";
    case "xhigh":
      return "极高";
  }
}

export function formatSessionModelReasoningConfig(session: Pick<SessionRow, "selectedModel" | "selectedReasoningEffort">): string {
  const modelLabel = session.selectedModel ?? "默认模型";
  const effortLabel = session.selectedReasoningEffort ? formatReasoningEffortLabel(session.selectedReasoningEffort) : "默认";
  return `${modelLabel} + ${effortLabel}`;
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

function formatHtmlHeading(text: string): string {
  return `<b>${escapeHtml(text)}</b>`;
}

function formatHtmlFieldLabel(label: string): string {
  return `<b>${escapeHtml(label)}</b>`;
}

function formatHtmlField(label: string, value: string): string {
  return `${formatHtmlFieldLabel(label)} ${escapeHtml(value)}`;
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

type FinalAnswerBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[]; ordered: boolean; startIndex: number }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string; language: string | null };

const FINAL_ANSWER_CONTINUATION_PREFIX_BUDGET = 12;
const FINAL_ANSWER_PREVIEW_MAX_CHARS = 350;
const FINAL_ANSWER_PREVIEW_MAX_BLOCKS = 3;

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

export function buildCollapsibleFinalAnswerView(markdown: string): FinalAnswerViewRender {
  const rawPages = renderFinalAnswerHtmlChunks(markdown, 3000, { prefixContinuations: false });
  const pages = rawPages.map((page, index) =>
    rawPages.length > 1 ? `<i>第 ${index + 1}/${rawPages.length} 页</i>\n\n${page}` : page
  );
  const preview = renderCollapsedFinalAnswerPreview(markdown);

  if (!preview.truncated) {
    return {
      previewHtml: pages[0] ?? escapeHtml(markdown),
      pages,
      truncated: false
    };
  }

  const note = rawPages.length > 1
    ? `已折叠，共 ${rawPages.length} 页，点击“展开全文”查看。`
    : "已折叠，点击“展开全文”查看剩余内容。";

  return {
    previewHtml: `${preview.html}\n\n<i>${escapeHtml(note)}</i>`,
    pages,
    truncated: true
  };
}

export function buildFinalAnswerReplyMarkup(options: {
  answerId: string;
  totalPages: number;
  expanded: boolean;
  currentPage?: number;
}): TelegramInlineKeyboardMarkup {
  if (!options.expanded) {
    return {
      inline_keyboard: [[{
        text: "展开全文",
        callback_data: encodeFinalAnswerOpenCallback(options.answerId)
      }]]
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
    inline_keyboard: [buttons]
  };
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
