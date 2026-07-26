import { basename } from "node:path";

import type {
  ProjectCandidate,
  ProjectPickerResult,
  ReasoningEffort,
  ReadinessSnapshot,
  SessionRow,
  UiLanguage
} from "../types.js";
import { truncateText } from "../util/text.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import {
  encodeNewBrowseBackCallback,
  encodeNewBrowseOpenCallback,
  encodeNewBrowseRootCallback,
  encodeModelCloseCallback,
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
  encodeResumeCloseCallback,
  encodeResumePageCallback,
  encodeResumePickCallback
} from "./ui-callbacks.js";
import {
  chunkButtons,
  escapeHtml,
  formatHtmlField,
  formatHtmlHeading,
  formatReasoningEffortLabel,
  formatRelativeTime
} from "./ui-shared.js";

function displayProjectName(projectName: string, projectAlias: string | null | undefined): string {
  return projectAlias?.trim() || projectName;
}

function buildSessionProjectContextBlock(title: string, sessionName: string, projectName: string): string {
  return [
    formatHtmlHeading(title),
    formatHtmlField("Name:", sessionName),
    formatHtmlField("Project: ", projectName)
  ].join("\n");
}

function buildProjectBadgeLabels(candidate: ProjectCandidate): string[] {
  const labels: string[] = [];
  if (candidate.group !== "recent" && candidate.isRecent) {
    labels.push("Recent");
  }
  if (candidate.group !== "discovered" && candidate.fromScan) {
    labels.push("Local");
  }
  if (candidate.hasExistingSession) {
    labels.push("Has history");
  }

  return labels;
}

export function buildProjectPickerMessage(picker: ProjectPickerResult): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  const visibleCandidates = picker.groups.flatMap((group) => group.candidates);
  const candidateButtons = visibleCandidates.map((candidate, index) => ({
    text: String(index + 1),
    callback_data: encodePickCallback(candidate.projectKey)
  }));

  rows.push(...chunkButtons(candidateButtons, 5));
  rows.push([
    {
        text: "Browse Directory", callback_data: encodeNewBrowseOpenCallback() },
    { text: "Manual Path Entry", callback_data: encodePathManualCallback() }
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

export function buildProjectBrowseRootPickerMessage(options: {
  roots: Array<{ index: number; label: string; pathLabel: string }>;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = options.roots.map((root) => [{
    text: `${root.index + 1}`,
    callback_data: encodeNewBrowseRootCallback(root.index)
  }]);
  rows.push([{ text: "Back to Project List", callback_data: encodeNewBrowseBackCallback() }]);

  const lines = ["Select a root directory to browse"];
  for (const root of options.roots) {
    lines.push("");
    lines.push(`${root.index + 1}. ${root.label}`);
    lines.push(`   ${root.pathLabel}`);
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
    text: "Enter the directory path to start a session, e.g.: /home/ubuntu/Repo/openclaw\nSend /cancel to return to the project list.",
    replyMarkup: {
      inline_keyboard: [[{ text: "Back to Project List", callback_data: encodePathBackCallback() }]]
    }
  };
}

export function buildManualPathConfirmMessage(candidate: ProjectCandidate): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: [
      "Create a new session in this directory?",
      formatHtmlField("Project: ", candidate.displayName),
      formatHtmlField("Path: ", candidate.projectPath)
    ].join("\n"),
    replyMarkup: {
      inline_keyboard: [
        [{ text: "Confirm New Session", callback_data: encodePathConfirmCallback(candidate.projectKey) }],
        [{ text: "Back to Project List", callback_data: encodePathBackCallback() }]
      ]
    }
  };
}

export function buildNoNewProjectsMessage(): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  return {
    text: "This entry is offline. Browse directory or enter a path manually.",
    replyMarkup: {
      inline_keyboard: [
        [{
        text: "Browse Directory", callback_data: encodeNewBrowseOpenCallback() }],
        [{ text: "Manual Path Entry", callback_data: encodePathManualCallback() }],
        [{ text: "Back to Project List", callback_data: encodePathBackCallback() }]
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

const MODEL_PAGE_SIZE = 8;

export interface SessionModelDisplayState {
  configuredModel: string | null;
  configuredReasoningEffort: ReasoningEffort | null;
  effectiveModel: string | null;
  effectiveReasoningEffort: ReasoningEffort | null;
}

export function buildModelPickerMessage(options: {
  session: SessionRow;
  models: ModelPickerOption[];
  page: number;
  modelState?: SessionModelDisplayState;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const state = resolveModelDisplayState(options.session, options.modelState);
  const totalPages = Math.max(1, Math.ceil(options.models.length / MODEL_PAGE_SIZE));
  const safePage = Math.min(Math.max(options.page, 0), totalPages - 1);
  const pageModels = options.models.slice(safePage * MODEL_PAGE_SIZE, (safePage + 1) * MODEL_PAGE_SIZE);
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [
    [{ text: buildDefaultModelButtonLabel(state), callback_data: encodeModelDefaultCallback(options.session.sessionId) }],
    ...pageModels.map((model, index) => [{
      text: buildModelButtonLabel(model, state),
      callback_data: encodeModelPickCallback(options.session.sessionId, safePage * MODEL_PAGE_SIZE + index)
    }])
  ];
  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (safePage > 0) {
    navigation.push({ text: "Previous", callback_data: encodeModelPageCallback(options.session.sessionId, safePage - 1) });
  }
  if (safePage + 1 < totalPages) {
    navigation.push({ text: "Next", callback_data: encodeModelPageCallback(options.session.sessionId, safePage + 1) });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }
  rows.push([{ text: "Close", callback_data: encodeModelCloseCallback(options.session.sessionId) }]);

  return {
    text: [
      "Select Model",
      `当前配置：${formatModelReasoning(state.configuredModel, state.configuredReasoningEffort)}`,
      `当前生效：${formatModelReasoning(state.effectiveModel, state.effectiveReasoningEffort)}`,
      `第 ${safePage + 1}/${totalPages} 页`,
      "Pick a model first, then choose reasoning effort."
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
  modelState?: SessionModelDisplayState;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const state = resolveModelDisplayState(options.session, options.modelState);
  const isConfiguredModel = state.configuredModel === options.model.id;
  const isEffectiveModel = state.effectiveModel === options.model.id;
  const effortButtons = options.model.supportedReasoningEfforts.map((option) => ({
    text: buildReasoningEffortButtonLabel(option.reasoningEffort, state, isConfiguredModel, isEffectiveModel),
    callback_data: encodeModelEffortCallback(options.session.sessionId, options.modelIndex, option.reasoningEffort)
  }));
  const rows = [
    [{
      text: buildDefaultEffortButtonLabel(options.model.defaultReasoningEffort, state, isConfiguredModel, isEffectiveModel),
      callback_data: encodeModelEffortCallback(options.session.sessionId, options.modelIndex, null)
    }],
    ...chunkButtons(effortButtons, 2),
    [{ text: "Close", callback_data: encodeModelCloseCallback(options.session.sessionId) }]
  ];

  return {
    text: [
      "Select Reasoning Effort",
      `模型：${options.model.id}`,
      `当前配置：${formatModelReasoning(state.configuredModel, state.configuredReasoningEffort)}`,
      `当前生效：${formatModelReasoning(state.effectiveModel, state.effectiveReasoningEffort)}`,
      "Only showing tiers this model supports."
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildStatusText(
  snapshot: ReadinessSnapshot,
  activeSession: SessionRow | null,
  runtimeStatusText?: string | null,
  modelState?: SessionModelDisplayState | null
): string {
  const issueText = snapshot.details.issues.length === 0 ? "None" : snapshot.details.issues.join("; ");
  const resolvedModelState = activeSession ? resolveModelDisplayState(activeSession, modelState ?? undefined) : null;
  const activeSessionText = activeSession
    ? [
        displayProjectName(activeSession.projectName, activeSession.projectAlias),
        activeSession.displayName,
        formatSessionState(activeSession),
        `配置 ${formatModelReasoning(
          resolvedModelState?.configuredModel ?? null,
          resolvedModelState?.configuredReasoningEffort ?? null
        )}`,
        `生效 ${formatModelReasoning(
          resolvedModelState?.effectiveModel ?? null,
          resolvedModelState?.effectiveReasoningEffort ?? null
        )}`,
        formatLastTurnSummary(activeSession)
      ]
        .filter((value): value is string => Boolean(value))
        .join(" / ")
    : "None";

  const lines = [
    formatHtmlHeading("Service Status"),
    formatHtmlField("Bridge status:", snapshot.state),
    formatHtmlField("Platform:", snapshot.details.packState === "pack_unhealthy" ? "Unavailable" : "OK"),
    formatHtmlField("Setup:", snapshot.details.setupState === "incomplete" ? "No" : "Yes"),
    formatHtmlField(
      "Codex:",
      snapshot.details.codexAuthenticated && snapshot.details.appServerAvailable ? "OK" : "Unavailable"
    ),
    formatHtmlField("Current session:", activeSessionText),
    formatHtmlField("Last checked:", snapshot.checkedAt),
    formatHtmlField("Issues:", issueText)
  ];

  if (runtimeStatusText) {
    lines.push("", runtimeStatusText);
  }

  return lines.join("\n");
}

export function buildWhereText(session: SessionRow | null, modelState?: SessionModelDisplayState): string {
  if (!session) {
    return "No active sessions.";
  }

  const state = resolveModelDisplayState(session, modelState);
  const lines = [
    formatHtmlHeading("Current Session"),
    formatHtmlField("Name:", session.displayName),
    formatHtmlField("Project: ", displayProjectName(session.projectName, session.projectAlias)),
    formatHtmlField("Path: ", session.projectPath),
    formatHtmlField("Status:", formatSessionState(session)),
    formatHtmlField("Model config:", formatModelReasoning(state.configuredModel, state.configuredReasoningEffort)),
    formatHtmlField("Model active:", formatModelReasoning(state.effectiveModel, state.effectiveReasoningEffort)),
    formatHtmlField("plan mode:", session.planMode ? "on" : "off")
  ];

  lines.push(formatHtmlField("Bridge Session ID:", session.sessionId));
  lines.push(formatHtmlField("Codex Thread ID:", session.threadId ?? "Not yet created (generated on first task)"));
  lines.push(formatHtmlField("Last Turn ID:", session.lastTurnId ?? "None"));
  const lastTurnSummary = formatLastTurnSummary(session);
  if (lastTurnSummary) {
    lines.push(formatHtmlField("Last result:", lastTurnSummary));
  }

  return lines.join("\n");
}

export function buildCurrentSessionCardText(
  session: SessionRow,
  language: UiLanguage,
  modelState?: SessionModelDisplayState
): string {
  const projectName = displayProjectName(session.projectName, session.projectAlias);
  const state = resolveModelDisplayState(session, modelState);
  return [
    `${escapeHtml(projectName)} / ${escapeHtml(session.displayName)}`,
    `${escapeHtml(formatSessionStateForCard(session, language))} · ${escapeHtml(formatSessionModelReasoningConfigForCard(state, language))}`
  ].join("\n");
}

export function buildSessionsText(options: {
  sessions: SessionRow[];
  activeSessionId: string | null;
  archived?: boolean;
}): string {
  const title = options.archived ? "Archived sessions" : "Recent";
  if (options.sessions.length === 0) {
    return `${title}\n暂无会话。`;
  }

  const lines = [title];
  options.sessions.forEach((session, index) => {
    const marker = !options.archived && session.sessionId === options.activeSessionId ? "[current] " : "";
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
  return formatHtmlField("Current project:", projectName);
}

export function buildSessionCreatedText(sessionName: string, projectPath: string): string {
  return [
    formatHtmlHeading("New session created"),
    formatHtmlField("Name:", sessionName),
    formatHtmlField("Path: ", projectPath)
  ].join("\n");
}

export function buildSessionSwitchedText(sessionName: string, projectName: string): string {
  return buildSessionProjectContextBlock("Session switched", sessionName, projectName);
}

export function buildSessionResumedText(sessionName: string, projectName: string): string {
  return buildSessionProjectContextBlock("Codex session resumed", sessionName, projectName);
}

export function buildResumeThreadListText(threads: Array<{
  name?: string | null;
  cwd: string;
  preview?: string;
  updatedAt: number | string;
}>, options: {
  page?: number;
  pageSize?: number;
  hasNext?: boolean;
  includeAll?: boolean;
} = {}): string {
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? 10));
  const includeAll = options.includeAll ?? false;
  if (threads.length === 0) {
    return escapeHtml(`可恢复的 Codex 会话（第 ${page} 页)\n暂无会话。${page > 1 ? `\n上一页：/resume ${includeAll ? "all " : ""}page ${page - 1}` : ""}`);
  }

  const lines = [`可恢复的 Codex 会话（第 ${page} 页)`, `发送 /resume ${includeAll ? "all " : ""}<序号> 恢复。`];
  threads.forEach((thread, index) => {
    const ordinal = (page - 1) * pageSize + index + 1;
    const projectName = basename(thread.cwd);
    const title = thread.name?.trim() || thread.preview?.trim() || projectName;
    const preview = thread.preview?.trim() && thread.preview.trim() !== title ? ` | ${thread.preview.trim()}` : "";
    const updatedAt = formatResumeThreadRelativeTime(thread.updatedAt);
    lines.push(`${ordinal}. ${title} | ${projectName}${preview}${updatedAt ? ` | ${updatedAt}` : ""}`);
  });
  if (page > 1) {
    lines.push(`上一页：/resume ${includeAll ? "all " : ""}page ${page - 1}`);
  }
  if (options.hasNext) {
    lines.push(`下一页：/resume ${includeAll ? "all " : ""}page ${page + 1}`);
  }

  return escapeHtml(lines.join("\n"));
}

export function buildResumeThreadListMessage(threads: Array<{
  name?: string | null;
  cwd: string;
  preview?: string;
  updatedAt: number | string;
}>, options: {
  page?: number;
  pageSize?: number;
  hasNext?: boolean;
  includeAll?: boolean;
} = {}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const page = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.max(1, Math.trunc(options.pageSize ?? 10));
  const includeAll = options.includeAll ?? false;
  const selectionButtons = threads.map((thread, index) => ({
    text: String((page - 1) * pageSize + index + 1),
    callback_data: encodeResumePickCallback(includeAll, page, index)
  }));
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  rows.push(...chunkButtons(selectionButtons, 5));

  const navigation: Array<{ text: string; callback_data: string }> = [];
  if (page > 1) {
    navigation.push({ text: "Previous", callback_data: encodeResumePageCallback(includeAll, page - 1) });
  }
  if (options.hasNext) {
    navigation.push({ text: "Next", callback_data: encodeResumePageCallback(includeAll, page + 1) });
  }
  if (navigation.length > 0) {
    rows.push(navigation);
  }
  rows.push([{ text: "Close", callback_data: encodeResumeCloseCallback() }]);

  return {
    text: buildResumeThreadListText(threads, options),
    replyMarkup: {
      inline_keyboard: rows
    }
  };
}

function formatResumeThreadRelativeTime(value: number | string): string | null {
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return formatResumeThreadRelativeTime(numeric);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? formatRelativeTime(new Date(parsed).toISOString()) : null;
  }

  if (!Number.isFinite(value)) {
    return null;
  }

  const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
  return formatRelativeTime(new Date(milliseconds).toISOString());
}

export function buildArchiveSuccessText(
  session: {
    displayName: string;
    projectName: string;
    projectAlias?: string | null;
  },
  nextActiveSession?: {
    displayName: string;
    projectName: string;
    projectAlias?: string | null;
  } | null
): string {
  const lines = [
    formatHtmlHeading("Archived sessions"),
    formatHtmlField("Name:", session.displayName),
    formatHtmlField("Project: ", displayProjectName(session.projectName, session.projectAlias ?? null))
  ];
  if (nextActiveSession) {
    lines.push(formatHtmlField("Current session:", nextActiveSession.displayName));
    lines.push(
      formatHtmlField(
        "Current project:",
        displayProjectName(nextActiveSession.projectName, nextActiveSession.projectAlias ?? null)
      )
    );
  } else {
    lines.push("No active sessions. Send /new to select a project.");
  }

  return lines.join("\n");
}

export function buildArchiveAllSuccessText(options: {
  archivedCount: number;
  skippedRunningCount: number;
  failedCount: number;
  nextActiveSession?: {
    displayName: string;
    projectName: string;
    projectAlias?: string | null;
  } | null;
}): string {
  const lines = [
    formatHtmlHeading("Batch archived sessions"),
    formatHtmlField("Archived:", `${options.archivedCount} 个`)
  ];

  if (options.skippedRunningCount > 0) {
    lines.push(formatHtmlField("Skipped running:", `${options.skippedRunningCount} 个`));
  }

  if (options.failedCount > 0) {
    lines.push(formatHtmlField("Failed:", `${options.failedCount} 个`));
  }

  if (options.nextActiveSession) {
    lines.push(formatHtmlField("Current session:", options.nextActiveSession.displayName));
    lines.push(
      formatHtmlField(
        "Current project:",
        displayProjectName(options.nextActiveSession.projectName, options.nextActiveSession.projectAlias ?? null)
      )
    );
  } else {
    lines.push("No active sessions. Send /new to select a project.");
  }

  return lines.join("\n");
}

export function buildUnarchiveSuccessText(sessionName: string, projectName: string): string {
  return buildSessionProjectContextBlock("Session resumed", sessionName, projectName);
}

export function buildSessionRenamedText(name: string): string {
  return formatHtmlField("Session renamed to:", name);
}

export function buildProjectAliasRenamedText(name: string): string {
  return formatHtmlField("Project alias updated to:", name);
}

export function buildProjectAliasClearedText(projectName: string): string {
  return formatHtmlField("Project alias cleared:", projectName);
}

export function buildProjectPinnedText(projectName: string): string {
  return formatHtmlField("Project bookmarked:", projectName);
}

export function buildModelPickerClosedText(session: SessionRow, modelState?: SessionModelDisplayState): string {
  const state = resolveModelDisplayState(session, modelState);
  return [
    formatHtmlHeading("Model picker closed"),
    formatHtmlField("Current config:", formatModelReasoning(state.configuredModel, state.configuredReasoningEffort)),
    formatHtmlField("Currently active:", formatModelReasoning(state.effectiveModel, state.effectiveReasoningEffort))
  ].join("\n");
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
    [
      { text: "Rename Session", callback_data: encodeRenameSessionCallback(options.sessionId) },
      { text: "Set Project Alias", callback_data: encodeRenameProjectCallback(options.sessionId) }
    ]
  ];

  if (options.hasProjectAlias) {
    rows.push([{ text: "Clear Project Alias", callback_data: encodeRenameProjectClearCallback(options.sessionId) }]);
  }

  return {
    text: [
      "Which name would you like to change?",
      formatHtmlField("Current project:", options.projectName)
    ].join("\n"),
    replyMarkup: { inline_keyboard: rows }
  };
}

export function buildUnsupportedCommandText(): string {
  return "This command is not yet available.";
}

function formatSessionState(session: SessionRow): string {
  switch (session.status) {
    case "running":
      return "Running";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return session.failureReason
        ? `失败（${formatSessionFailureReason(session.failureReason)})`
        : "Failed";
    case "idle":
    default:
      return "Idle";
  }
}

function formatSessionStateForCard(session: SessionRow, language: UiLanguage): string {
  if (language !== "en") {
    return formatSessionState(session);
  }

  switch (session.status) {
    case "running":
      return "Running";
    case "interrupted":
      return "Interrupted";
    case "failed":
      return "Failed";
    case "idle":
    default:
      return "Idle";
  }
}

function formatReasoningEffortLabelForCard(effort: ReasoningEffort, language: UiLanguage): string {
  if (language !== "en") {
    return formatReasoningEffortLabel(effort);
  }

  switch (effort) {
    case "none":
      return "off";
    case "minimal":
      return "minimal";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "very high";
  }
}

function formatSessionModelReasoningConfigForCard(state: SessionModelDisplayState, language: UiLanguage): string {
  if (language !== "en") {
    return `配置 ${formatModelReasoning(state.configuredModel, state.configuredReasoningEffort)} / 生效 ${formatModelReasoning(state.effectiveModel, state.effectiveReasoningEffort)}`;
  }

  return `configured ${formatModelReasoningForCard(state.configuredModel, state.configuredReasoningEffort, language)} / effective ${formatModelReasoningForCard(state.effectiveModel, state.effectiveReasoningEffort, language)}`;
}

function formatSessionFailureReason(reason: SessionRow["failureReason"]): string {
  switch (reason) {
    case "bridge_restart":
      return "Bridge service restart";
    case "app_server_lost":
      return "Codex disconnected";
    case "turn_failed":
      return "Execution failed";
    case "unknown":
    default:
      return "Unknown reason";
  }
}

function formatLastTurnSummary(session: SessionRow): string | null {
  if (session.status === "running" || session.status === "failed" || session.status === "interrupted") {
    return null;
  }

  switch (session.lastTurnStatus) {
    case "completed":
      return "Last completed";
    case "interrupted":
      return "Last interrupted";
    case "failed":
      return session.failureReason ? `上次失败（${formatSessionFailureReason(session.failureReason)})` : "上次失败";
    default:
      return null;
  }
}

function buildDefaultModelButtonLabel(state: SessionModelDisplayState): string {
  const marker = state.configuredModel === null && state.configuredReasoningEffort === null ? " [已配置]" : "";
  return `清除模型/强度覆盖${marker}`;
}

function buildModelButtonLabel(model: ModelPickerOption, state: SessionModelDisplayState): string {
  const markers: string[] = [];
  if (state.configuredModel === model.id) {
    markers.push("Configured");
  }
  if (state.effectiveModel === model.id) {
    markers.push("Active");
  }
  const markerText = markers.length > 0 ? ` [${markers.join("/")}]` : "";
  return `${model.displayName}${markerText}`;
}

function buildDefaultEffortButtonLabel(
  defaultReasoningEffort: ReasoningEffort,
  state: SessionModelDisplayState,
  isConfiguredModel: boolean,
  isEffectiveModel: boolean
): string {
  const markers: string[] = [];
  if (isConfiguredModel && state.configuredReasoningEffort === null) {
    markers.push("Configured");
  }
  if (isEffectiveModel && state.effectiveReasoningEffort === null) {
    markers.push("Active");
  }
  const markerText = markers.length > 0 ? ` [${markers.join("/")}]` : "";
  return `默认（${formatReasoningEffortLabel(defaultReasoningEffort)})${markerText}`;
}

function buildReasoningEffortButtonLabel(
  effort: ReasoningEffort,
  state: SessionModelDisplayState,
  isConfiguredModel: boolean,
  isEffectiveModel: boolean
): string {
  const markers: string[] = [];
  if (isConfiguredModel && state.configuredReasoningEffort === effort) {
    markers.push("Configured");
  }
  if (isEffectiveModel && state.effectiveReasoningEffort === effort) {
    markers.push("Active");
  }
  const markerText = markers.length > 0 ? ` [${markers.join("/")}]` : "";
  return `${formatReasoningEffortLabel(effort)}${markerText}`;
}

function resolveModelDisplayState(
  session: SessionRow,
  state?: SessionModelDisplayState
): SessionModelDisplayState {
  if (state) {
    return state;
  }

  return {
    configuredModel: session.selectedModel ?? null,
    configuredReasoningEffort: session.selectedReasoningEffort ?? null,
    effectiveModel: session.selectedModel ?? null,
    effectiveReasoningEffort: session.selectedReasoningEffort ?? null
  };
}

function formatModelReasoning(model: string | null, effort: ReasoningEffort | null): string {
  const modelLabel = model ?? "Default Model";
  const effortLabel = effort ? formatReasoningEffortLabel(effort) : "Default";
  return `${modelLabel} + ${effortLabel}`;
}

function formatModelReasoningForCard(model: string | null, effort: ReasoningEffort | null, language: UiLanguage): string {
  const modelLabel = model ?? (language === "en" ? "Default model" : "Default Model");
  const effortLabel = effort
    ? formatReasoningEffortLabelForCard(effort, language)
    : language === "en" ? "default" : "Default";
  return `${modelLabel} + ${effortLabel}`;
}
