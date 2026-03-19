import { randomUUID } from "node:crypto";

import type { ActivityStatus, CollabAgentStateSnapshot, InspectSnapshot } from "../activity/types.js";
import type { Logger } from "../logger.js";
import type { BridgeStateStore } from "../state/store.js";
import type { TelegramInlineKeyboardMarkup, TelegramMessage } from "../telegram/api.js";
import {
  buildFinalAnswerReplyMarkup,
  buildInspectClosedMessage,
  buildInspectText,
  buildInspectViewMessage,
  buildRuntimeHubMessage,
  buildRuntimeHubReplyMarkup,
  buildPlanResultConsumedNotice,
  buildPlanResultReplyMarkup,
  buildRuntimePreferencesAppliedMessage,
  buildRuntimePreferencesClosedMessage,
  buildRuntimePreferencesMessage,
  buildRuntimeErrorCard,
  buildRuntimeStatusCard,
  buildRuntimeStatusReplyMarkup,
  type RuntimeCommandEntryView
} from "../telegram/ui.js";
import {
  formatHtmlField,
  formatHtmlHeading
} from "../telegram/ui-shared.js";
import {
  DEFAULT_RUNTIME_STATUS_FIELDS,
  type PendingInteractionSummary,
  type RuntimeStatusField,
  type SessionRow,
  type UiLanguage
} from "../types.js";
import { normalizeAndTruncate, truncateText } from "../util/text.js";
import { classifyNotification } from "../codex/notification-classifier.js";
import {
  applyRuntimeCommandDelta,
  cleanRuntimeErrorMessage,
  createErrorCardMessageState,
  type ErrorCardState,
  formatVisibleRuntimeState,
  getRuntimeCardThrottleMs,
  type RuntimeCardMessageState,
  type RuntimeCommandState,
  selectStatusProgressText,
  serializeReplyMarkup,
  summarizeRuntimeCardSurface,
  summarizeRuntimeCommands,
  type StatusCardState,
  type TelegramEditResult
} from "./runtime-surface-state.js";

const INSPECT_PLAIN_TEXT_FALLBACK_LIMIT = 3500;
const FAILED_EDIT_RETRY_MS = 5000;
const RUNTIME_HUB_WINDOW_SIZE = 5;
const RUNTIME_HUB_TERMINAL_SUMMARY_LIMIT = 3;

interface RuntimePreferencesDraftState {
  chatId: string;
  messageId: number;
  fields: RuntimeStatusField[];
  page: number;
}

interface RuntimeSurfaceTracker {
  getInspectSnapshot(): InspectSnapshot;
  getStatus(): ActivityStatus;
}

interface RuntimeSurfaceActiveTurn {
  sessionId: string;
  chatId: string;
  threadId: string;
  turnId: string;
  tracker: RuntimeSurfaceTracker;
  statusCard: StatusCardState;
  latestStatusProgressText: string | null;
  latestPlanFingerprint: string;
  latestAgentFingerprint: string;
  subagentIdentityBackfillStates: Map<string, "pending" | "resolved" | "exhausted">;
  errorCards: ErrorCardState[];
  nextErrorCardId: number;
  surfaceQueue: Promise<void>;
}

interface InspectActivityEntry {
  tracker: {
    getInspectSnapshot(): InspectSnapshot;
  };
  statusCard: StatusCardState | null;
}

interface RuntimeSurfaceInspectRenderPayload {
  snapshot: InspectSnapshot;
  commands: RuntimeCommandEntryView[];
  note: string | null;
}

interface RuntimeHubTerminalSummary {
  sessionId: string;
  sessionName: string;
  projectName: string | null;
  state: string;
}

interface RuntimeHubState {
  token: string;
  chatId: string;
  kind: "live" | "recovery";
  windowIndex: number;
  messageId: number;
  callbackVersion: number;
  focusedSessionId: string | null;
  sessionIds: string[];
  planExpanded: boolean;
  agentsExpanded: boolean;
  lastRenderedText: string;
  lastRenderedReplyMarkupKey: string | null;
  lastRenderedAtMs: number | null;
  rateLimitUntilAtMs: number | null;
  pendingText: string | null;
  pendingReplyMarkup: TelegramInlineKeyboardMarkup | null;
  pendingReason: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RuntimeHubChatState {
  liveHubs: Map<number, RuntimeHubState>;
  recoveryHub: RuntimeHubState | null;
  runningOrder: string[];
  terminalSummaries: RuntimeHubTerminalSummary[];
}

interface RuntimeSurfaceControllerDeps {
  logger: Logger;
  getStore: () => BridgeStateStore | null;
  listActiveTurns: () => RuntimeSurfaceActiveTurn[];
  getActiveInspectActivity: (sessionId: string) => InspectActivityEntry | null;
  getRecentActivity: (sessionId: string) => InspectActivityEntry | null;
  getHistoricalInspectPayload: (
    activeSession: SessionRow
  ) => Promise<RuntimeSurfaceInspectRenderPayload | null>;
  buildPendingInteractionSummaries: (activeSession: SessionRow) => PendingInteractionSummary[];
  buildAnsweredInteractionSummaries: (activeSession: SessionRow) => string[];
  safeSendMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendHtmlMessage: (
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendHtmlMessageResult: (
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<TelegramMessage | null>;
  safeSendMessageResult: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<TelegramMessage | null>;
  safeEditHtmlMessageText: (
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<TelegramEditResult>;
  safeEditMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<TelegramEditResult>;
  safeDeleteMessage: (chatId: string, messageId: number) => Promise<boolean>;
  safeAnswerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
  getUiLanguage: () => UiLanguage;
  getRuntimeCardContext: (sessionId: string) => {
    sessionName: string | null;
    projectName: string | null;
  };
  buildRuntimeStatusLine: (sessionId: string, inspect: InspectSnapshot) => string[];
  runtimeTraceSink: {
    logRuntimeCardEvent: (
      activeTurn: RuntimeSurfaceActiveTurn,
      surface: RuntimeCardMessageState,
      event: string,
      meta?: Record<string, unknown>
    ) => Promise<void>;
  };
  backfillSubagentIdentities: (
    activeTurn: RuntimeSurfaceActiveTurn,
    agentEntries: CollabAgentStateSnapshot[]
  ) => Promise<boolean>;
  refreshActiveRuntimeStatusCard: (chatId: string, reason: string) => Promise<void>;
}

export class RuntimeSurfaceController {
  private readonly runtimePreferenceDrafts = new Map<string, RuntimePreferencesDraftState>();
  private readonly runtimeHubStates = new Map<string, RuntimeHubChatState>();

  constructor(private readonly deps: RuntimeSurfaceControllerDeps) {}

  private getOrCreateHubChatState(chatId: string): RuntimeHubChatState {
    let state = this.runtimeHubStates.get(chatId);
    if (!state) {
      state = {
        liveHubs: new Map(),
        recoveryHub: null,
        runningOrder: [],
        terminalSummaries: []
      };
      this.runtimeHubStates.set(chatId, state);
    }

    return state;
  }

  private createRuntimeHubState(chatId: string, kind: "live" | "recovery", windowIndex: number): RuntimeHubState {
    return {
      token: randomUUID().replace(/-/gu, "").slice(0, 8),
      chatId,
      kind,
      windowIndex,
      messageId: 0,
      callbackVersion: 0,
      focusedSessionId: null,
      sessionIds: [],
      planExpanded: false,
      agentsExpanded: false,
      lastRenderedText: "",
      lastRenderedReplyMarkupKey: null,
      lastRenderedAtMs: null,
      rateLimitUntilAtMs: null,
      pendingText: null,
      pendingReplyMarkup: null,
      pendingReason: null,
      timer: null
    };
  }

  private getLiveHubState(chatId: string, messageId: number): RuntimeHubState | null {
    const chatState = this.runtimeHubStates.get(chatId);
    if (chatState) {
      for (const state of chatState.liveHubs.values()) {
        if (state.messageId === messageId) {
          return state;
        }
      }

      if (chatState.recoveryHub?.messageId === messageId) {
        return chatState.recoveryHub;
      }
    }

    for (const state of this.runtimeHubStates.values()) {
      for (const hubState of state.liveHubs.values()) {
        if (hubState.messageId === messageId) {
          return hubState;
        }
      }
      if (state.recoveryHub?.messageId === messageId) {
        return state.recoveryHub;
      }
    }

    return null;
  }

  async handleRuntime(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const token = this.createRuntimePreferencesDraftToken();
    const draft: RuntimePreferencesDraftState = {
      chatId,
      messageId: 0,
      fields: [...store.getRuntimeCardPreferences().fields],
      page: 0
    };
    const rendered = buildRuntimePreferencesMessage({
      token,
      fields: draft.fields,
      page: draft.page
    });
    const sent = await this.deps.safeSendHtmlMessageResult(chatId, rendered.text, rendered.replyMarkup);
    if (!sent) {
      return;
    }

    draft.messageId = sent.message_id;
    this.runtimePreferenceDrafts.set(token, draft);
  }

  async handleRuntimePreferencesPageCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    page: number
  ): Promise<void> {
    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    draft.page = Math.max(0, page);
    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.renderRuntimePreferencesDraft(token, draft);
  }

  async handleRuntimePreferencesToggleCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    field: RuntimeStatusField
  ): Promise<void> {
    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    draft.fields = draft.fields.includes(field)
      ? draft.fields.filter((candidate) => candidate !== field)
      : [...draft.fields, field];
    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.renderRuntimePreferencesDraft(token, draft);
  }

  async handleRuntimePreferencesSaveCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "状态存储当前不可用。");
      return;
    }

    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    const saved = store.setRuntimeCardPreferences(draft.fields);
    draft.fields = [...saved.fields];
    await this.deps.safeAnswerCallbackQuery(callbackQueryId, "已保存。");
    this.runtimePreferenceDrafts.delete(token);
    await this.deps.safeEditHtmlMessageText(chatId, messageId, buildRuntimePreferencesAppliedMessage(saved.fields));
    await this.deps.refreshActiveRuntimeStatusCard(chatId, "runtime_preferences_saved");
  }

  async handleRuntimePreferencesResetCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string
  ): Promise<void> {
    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    draft.fields = [...DEFAULT_RUNTIME_STATUS_FIELDS];
    draft.page = 0;
    await this.deps.safeAnswerCallbackQuery(callbackQueryId, "已恢复默认，记得保存。");
    await this.renderRuntimePreferencesDraft(token, draft);
  }

  async handleRuntimePreferencesCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string
  ): Promise<void> {
    const draft = this.getRuntimePreferencesDraft(token, chatId, messageId);
    if (!draft) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /runtime。");
      return;
    }

    const fields = this.deps.getStore()?.getRuntimeCardPreferences().fields ?? draft.fields;
    this.runtimePreferenceDrafts.delete(token);
    const result = await this.deps.safeEditHtmlMessageText(
      chatId,
      messageId,
      buildRuntimePreferencesClosedMessage(fields)
    );
    if (result.outcome === "edited") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法关闭这条消息，请稍后再试。");
  }

  buildStatusCardRenderPayload(
    sessionId: string,
    tracker: RuntimeSurfaceTracker,
    statusCard: StatusCardState
  ): {
    text: string;
    replyMarkup?: TelegramInlineKeyboardMarkup;
  } {
    const inspect = tracker.getInspectSnapshot();
    const text = buildRuntimeStatusCard({
      ...this.deps.getRuntimeCardContext(sessionId),
      language: this.deps.getUiLanguage(),
      optionalFieldLines: this.deps.buildRuntimeStatusLine(sessionId, inspect),
      state: formatVisibleRuntimeState(inspect),
      progressText: selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null),
      planEntries: inspect.planSnapshot,
      planExpanded: statusCard.planExpanded,
      agentEntries: inspect.agentSnapshot,
      agentsExpanded: statusCard.agentsExpanded
    });
    const replyMarkup = buildRuntimeStatusReplyMarkup({
      sessionId,
      language: this.deps.getUiLanguage(),
      planEntries: inspect.planSnapshot,
      planExpanded: statusCard.planExpanded,
      agentEntries: inspect.agentSnapshot,
      agentsExpanded: statusCard.agentsExpanded
    });

    return replyMarkup ? { text, replyMarkup } : { text };
  }

  private getOrderedActiveTurns(chatId: string, excludedSessionId?: string | null): RuntimeSurfaceActiveTurn[] {
    const chatState = this.getOrCreateHubChatState(chatId);
    const turnMap = new Map(
      this.deps
        .listActiveTurns()
        .filter((activeTurn) => activeTurn.chatId === chatId && activeTurn.sessionId !== excludedSessionId)
        .map((activeTurn) => [activeTurn.sessionId, activeTurn] as const)
    );

    chatState.runningOrder = chatState.runningOrder.filter((sessionId) => turnMap.has(sessionId));
    for (const activeTurn of turnMap.values()) {
      if (!chatState.runningOrder.includes(activeTurn.sessionId)) {
        chatState.runningOrder.push(activeTurn.sessionId);
      }
    }

    return chatState.runningOrder
      .map((sessionId) => turnMap.get(sessionId) ?? null)
      .filter((activeTurn): activeTurn is RuntimeSurfaceActiveTurn => Boolean(activeTurn));
  }

  private updateHubFocus(
    hubState: RuntimeHubState,
    sessionIds: string[],
    preferredSessionId: string | null,
    activeSessionId: string | null
  ): boolean {
    let nextFocus = hubState.focusedSessionId;
    if (preferredSessionId && sessionIds.includes(preferredSessionId)) {
      nextFocus = preferredSessionId;
    } else if (!nextFocus || !sessionIds.includes(nextFocus)) {
      nextFocus = activeSessionId && sessionIds.includes(activeSessionId)
        ? activeSessionId
        : (sessionIds[0] ?? null);
    }

    const changed = nextFocus !== hubState.focusedSessionId || sessionIds.join("\u0000") !== hubState.sessionIds.join("\u0000");
    hubState.focusedSessionId = nextFocus;
    hubState.sessionIds = [...sessionIds];
    if (changed) {
      hubState.callbackVersion += 1;
    }
    return changed;
  }

  private getSingleSessionHubActiveTurn(hubState: RuntimeHubState): RuntimeSurfaceActiveTurn | null {
    if (hubState.kind !== "live" || hubState.sessionIds.length !== 1) {
      return null;
    }

    const sessionId = hubState.sessionIds[0];
    if (!sessionId) {
      return null;
    }

    return this.deps.listActiveTurns().find((candidate) => candidate.chatId === hubState.chatId && candidate.sessionId === sessionId) ?? null;
  }

  private hydrateSingleSessionHubStateFromTurn(
    hubState: RuntimeHubState,
    activeTurn: RuntimeSurfaceActiveTurn | null
  ): void {
    if (hubState.kind !== "live" || hubState.messageId !== 0 || hubState.sessionIds.length !== 1 || !activeTurn) {
      return;
    }

    if (activeTurn.statusCard.messageId === 0) {
      return;
    }

    hubState.messageId = activeTurn.statusCard.messageId;
    hubState.planExpanded = activeTurn.statusCard.planExpanded;
    hubState.agentsExpanded = activeTurn.statusCard.agentsExpanded;
    hubState.lastRenderedText = activeTurn.statusCard.lastRenderedText;
    hubState.lastRenderedReplyMarkupKey = activeTurn.statusCard.lastRenderedReplyMarkupKey;
    hubState.lastRenderedAtMs = activeTurn.statusCard.lastRenderedAtMs;
    hubState.rateLimitUntilAtMs = activeTurn.statusCard.rateLimitUntilAtMs;
    hubState.pendingText = activeTurn.statusCard.pendingText;
    hubState.pendingReplyMarkup = activeTurn.statusCard.pendingReplyMarkup;
    hubState.pendingReason = activeTurn.statusCard.pendingReason;
  }

  private buildFocusedRuntimeHubSection(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    hubState: RuntimeHubState
  ): {
    text: string;
    planEntries: string[];
    agentEntries: CollabAgentStateSnapshot[];
    inspectEnabled: boolean;
    interruptEnabled: boolean;
  } {
    if (!activeTurn) {
      const context = hubState.focusedSessionId
        ? this.deps.getRuntimeCardContext(hubState.focusedSessionId)
        : { sessionName: null, projectName: null };
      return {
        text: buildRuntimeStatusCard({
          ...context,
          language: this.deps.getUiLanguage(),
          state: "Unavailable",
          progressText: "当前没有可展示的运行详情。"
        }),
        planEntries: [],
        agentEntries: [],
        inspectEnabled: Boolean(hubState.focusedSessionId),
        interruptEnabled: false
      };
    }

    const inspect = activeTurn.tracker.getInspectSnapshot();
    const status = activeTurn.tracker.getStatus();
    const progressText = status.activeItemType === "agentMessage" && !inspect.completedCommentary.at(-1)
      ? null
      : selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null);
    return {
      text: buildRuntimeStatusCard({
        ...this.deps.getRuntimeCardContext(activeTurn.sessionId),
        language: this.deps.getUiLanguage(),
        optionalFieldLines: this.deps.buildRuntimeStatusLine(activeTurn.sessionId, inspect),
        state: formatVisibleRuntimeState(inspect),
        progressText,
        planEntries: inspect.planSnapshot,
        planExpanded: hubState.planExpanded,
        agentEntries: inspect.agentSnapshot,
        agentsExpanded: hubState.agentsExpanded
      }),
      planEntries: inspect.planSnapshot,
      agentEntries: inspect.agentSnapshot,
      inspectEnabled: true,
      interruptEnabled: true
    };
  }

  private buildRecoveryHubSection(sessionId: string | null): string {
    const session = sessionId ? this.deps.getStore()?.getSessionById(sessionId) ?? null : null;
    if (!session) {
      return buildRuntimeStatusCard({
        language: this.deps.getUiLanguage(),
        state: "Recovered",
        progressText: "桥已重启。请选择一个会话并继续新的任务。"
      });
    }

    return [
      formatHtmlHeading("恢复后会话"),
      formatHtmlField("会话：", session.displayName),
      formatHtmlField("项目：", session.projectAlias?.trim() || session.projectName),
      formatHtmlField("状态：", session.failureReason === "bridge_restart" ? "上次任务因桥重启而停止" : session.status),
      "发送新任务会基于已有线程上下文继续。"
    ].join("\n");
  }

  private buildLiveHubRenderPayload(
    chatId: string,
    hubState: RuntimeHubState,
    totalWindows: number
  ): { text: string; replyMarkup: TelegramInlineKeyboardMarkup } {
    const turns = this.getOrderedActiveTurns(chatId);
    const turnMap = new Map(turns.map((activeTurn) => [activeTurn.sessionId, activeTurn] as const));
    const activeSessionId = this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null;
    const sessions = hubState.sessionIds
      .map((sessionId) => {
        const activeTurn = turnMap.get(sessionId);
        if (!activeTurn) {
          return null;
        }
        const context = this.deps.getRuntimeCardContext(sessionId);
        const inspect = activeTurn.tracker.getInspectSnapshot();
        return {
          sessionId,
          sessionName: context.sessionName ?? "session",
          projectName: context.projectName ?? null,
          state: formatVisibleRuntimeState(inspect),
          progressText: inspect.completedCommentary.at(-1) ?? null,
          isFocused: sessionId === hubState.focusedSessionId,
          isActiveInputTarget: sessionId === activeSessionId
        };
      })
      .filter((session): session is NonNullable<typeof session> => Boolean(session));

    const focusedTurn = hubState.focusedSessionId ? (turnMap.get(hubState.focusedSessionId) ?? null) : null;
    const focused = this.buildFocusedRuntimeHubSection(focusedTurn, hubState);
    const activeContext = activeSessionId ? this.deps.getRuntimeCardContext(activeSessionId) : { sessionName: null };
    const text = buildRuntimeHubMessage({
      language: this.deps.getUiLanguage(),
      windowIndex: hubState.windowIndex,
      totalWindows,
      sessions,
      focusedSessionText: focused.text,
      activeInputTargetName: activeContext.sessionName ?? null,
      activeInputTargetInWindow: sessions.some((session) => session.sessionId === activeSessionId),
      terminalSummaries: hubState.windowIndex === 0 ? this.getOrCreateHubChatState(chatId).terminalSummaries : [],
      isMainHub: hubState.windowIndex === 0
    });

    return {
      text,
      replyMarkup: buildRuntimeHubReplyMarkup({
        token: hubState.token,
        callbackVersion: hubState.callbackVersion,
        language: this.deps.getUiLanguage(),
        sessions,
        focusedSessionId: hubState.focusedSessionId,
        planEntries: focused.planEntries,
        planExpanded: hubState.planExpanded,
        agentEntries: focused.agentEntries,
        agentsExpanded: hubState.agentsExpanded,
        inspectEnabled: focused.inspectEnabled,
        interruptEnabled: focused.interruptEnabled
      })
    };
  }

  private buildRecoveryHubRenderPayload(chatId: string, hubState: RuntimeHubState): {
    text: string;
    replyMarkup: TelegramInlineKeyboardMarkup;
  } {
    const store = this.deps.getStore();
    const sessions = hubState.sessionIds
      .map((sessionId) => store?.getSessionById(sessionId) ?? null)
      .filter((session): session is SessionRow => Boolean(session))
      .map((session) => ({
        sessionId: session.sessionId,
        sessionName: session.displayName,
        projectName: session.projectAlias?.trim() || session.projectName,
        state: session.failureReason === "bridge_restart" ? "Recovered" : session.status,
        progressText: session.failureReason === "bridge_restart" ? "上次运行因桥重启而停止" : null,
        isFocused: session.sessionId === hubState.focusedSessionId,
        isActiveInputTarget: session.sessionId === (store?.getActiveSession(chatId)?.sessionId ?? null)
      }));

    const activeContext = store?.getActiveSession(chatId)
      ? this.deps.getRuntimeCardContext(store.getActiveSession(chatId)?.sessionId ?? "")
      : { sessionName: null };
    const text = buildRuntimeHubMessage({
      language: this.deps.getUiLanguage(),
      windowIndex: 0,
      totalWindows: 1,
      sessions,
      focusedSessionText: this.buildRecoveryHubSection(hubState.focusedSessionId),
      activeInputTargetName: activeContext.sessionName ?? null,
      activeInputTargetInWindow: sessions.some((session) => session.isActiveInputTarget),
      terminalSummaries: [],
      isMainHub: true
    });

    return {
      text,
      replyMarkup: buildRuntimeHubReplyMarkup({
        token: hubState.token,
        callbackVersion: hubState.callbackVersion,
        language: this.deps.getUiLanguage(),
        sessions,
        focusedSessionId: hubState.focusedSessionId,
        planEntries: [],
        planExpanded: false,
        agentEntries: [],
        agentsExpanded: false,
        inspectEnabled: Boolean(hubState.focusedSessionId),
        interruptEnabled: false
      })
    };
  }

  private async deleteHubState(hubState: RuntimeHubState): Promise<void> {
    this.clearHubTimer(hubState);
    if (hubState.messageId > 0) {
      await this.deps.safeDeleteMessage(hubState.chatId, hubState.messageId);
    }
  }

  async refreshLiveRuntimeHubs(
    chatId: string,
    reason: string,
    preferredSessionId?: string | null,
    excludedSessionId?: string | null
  ): Promise<void> {
    const chatState = this.getOrCreateHubChatState(chatId);
    const turns = this.getOrderedActiveTurns(chatId, excludedSessionId);
    const activeSessionId = this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null;

    if (turns.length === 0) {
      for (const hubState of chatState.liveHubs.values()) {
        await this.deleteHubState(hubState);
      }
      chatState.liveHubs.clear();
      return;
    }

    if (chatState.recoveryHub) {
      await this.deleteHubState(chatState.recoveryHub);
      chatState.recoveryHub = null;
    }

    const totalWindows = Math.ceil(turns.length / RUNTIME_HUB_WINDOW_SIZE);
    for (let windowIndex = 0; windowIndex < totalWindows; windowIndex += 1) {
      const sessionIds = turns
        .slice(windowIndex * RUNTIME_HUB_WINDOW_SIZE, (windowIndex + 1) * RUNTIME_HUB_WINDOW_SIZE)
        .map((activeTurn) => activeTurn.sessionId);
      const hubState = chatState.liveHubs.get(windowIndex) ?? this.createRuntimeHubState(chatId, "live", windowIndex);
      this.updateHubFocus(hubState, sessionIds, preferredSessionId ?? null, activeSessionId);
      chatState.liveHubs.set(windowIndex, hubState);
      const singleSessionTurn = this.getSingleSessionHubActiveTurn(hubState);
      this.hydrateSingleSessionHubStateFromTurn(hubState, singleSessionTurn);
      const rendered = this.buildLiveHubRenderPayload(chatId, hubState, totalWindows);
      if (singleSessionTurn) {
        await this.logRuntimeCardEvent(singleSessionTurn, singleSessionTurn.statusCard, "state_transition", {
          reason,
          renderedText: rendered.text,
          replyMarkup: rendered.replyMarkup
        });
      }
      await this.requestHubRender(hubState, rendered.text, rendered.replyMarkup, {
        force: reason !== "runtime_progress",
        reason
      });
    }

    for (const [windowIndex, hubState] of [...chatState.liveHubs.entries()]) {
      if (windowIndex < totalWindows) {
        continue;
      }
      await this.deleteHubState(hubState);
      chatState.liveHubs.delete(windowIndex);
    }
  }

  async sendRecoveryHub(chatId: string, sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) {
      return;
    }

    const chatState = this.getOrCreateHubChatState(chatId);
    for (const liveHub of chatState.liveHubs.values()) {
      await this.deleteHubState(liveHub);
    }
    chatState.liveHubs.clear();

    const store = this.deps.getStore();
    const activeSessionId = store?.getActiveSession(chatId)?.sessionId ?? null;
    const hubState = chatState.recoveryHub ?? this.createRuntimeHubState(chatId, "recovery", 0);
    this.updateHubFocus(hubState, sessionIds, activeSessionId, activeSessionId);
    chatState.recoveryHub = hubState;
    const rendered = this.buildRecoveryHubRenderPayload(chatId, hubState);
    await this.requestHubRender(hubState, rendered.text, rendered.replyMarkup, {
      force: true,
      reason: "bridge_restart_recovery"
    });
  }

  resolveFocusedRuntimeHubSession(
    chatId: string,
    messageId: number,
    sessionId: string,
    options?: { requireLive?: boolean }
  ): RuntimeHubState | null {
    const hubState = this.getLiveHubState(chatId, messageId);
    if (!hubState) {
      return null;
    }
    if (options?.requireLive && hubState.kind !== "live") {
      return null;
    }
    return hubState.focusedSessionId === sessionId ? hubState : null;
  }

  async handleHubSelectCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    version: number,
    slot: number
  ): Promise<void> {
    const hubState = this.getLiveHubState(chatId, messageId);
    if (!hubState || hubState.token !== token || hubState.callbackVersion !== version) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const sessionId = hubState.sessionIds[slot];
    const store = this.deps.getStore();
    if (!store || !sessionId || !store.getSessionById(sessionId)) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    store.setActiveSession(hubState.chatId, sessionId);
    hubState.focusedSessionId = sessionId;
    hubState.planExpanded = false;
    hubState.agentsExpanded = false;
    hubState.callbackVersion += 1;
    await this.deps.safeAnswerCallbackQuery(callbackQueryId, "已切换当前会话。");

    if (hubState.kind === "live") {
      await this.refreshLiveRuntimeHubs(hubState.chatId, "hub_session_selected", sessionId);
      return;
    }

    const rendered = this.buildRecoveryHubRenderPayload(hubState.chatId, hubState);
    await this.requestHubRender(hubState, rendered.text, rendered.replyMarkup, {
      force: true,
      reason: "recovery_hub_session_selected"
    });
  }

  private scheduleHubRetry(hubState: RuntimeHubState, delayMs: number): void {
    this.clearHubTimer(hubState);
    hubState.timer = setTimeout(() => {
      hubState.timer = null;
      void this.flushHubRender(hubState);
    }, delayMs);
    hubState.timer.unref?.();
  }

  private async requestHubRender(
    hubState: RuntimeHubState,
    text: string,
    replyMarkup: TelegramInlineKeyboardMarkup,
    options: {
      force?: boolean;
      reason: string;
    }
  ): Promise<void> {
    const replyMarkupKey = serializeReplyMarkup(replyMarkup);
    const pendingChanged = hubState.pendingText !== text
      || serializeReplyMarkup(hubState.pendingReplyMarkup) !== replyMarkupKey;
    hubState.pendingText = text;
    hubState.pendingReplyMarkup = replyMarkup;
    hubState.pendingReason = options.reason;
    this.syncSingleSessionHubState(hubState);

    const singleSessionTurn = this.getSingleSessionHubActiveTurn(hubState);
    if (singleSessionTurn) {
      await this.logRuntimeCardEvent(singleSessionTurn, singleSessionTurn.statusCard, "render_requested", {
        reason: options.reason,
        renderedText: text,
        replyMarkup
      });
    }

    if (!pendingChanged && text === hubState.lastRenderedText && hubState.lastRenderedReplyMarkupKey === replyMarkupKey) {
      return;
    }

    const now = Date.now();
    const throttleMs = options.force || hubState.messageId === 0 ? 0 : getRuntimeCardThrottleMs("status");
    const throttleRemainingMs = hubState.lastRenderedAtMs === null
      ? 0
      : Math.max(0, hubState.lastRenderedAtMs + throttleMs - now);
    const rateLimitRemainingMs = hubState.rateLimitUntilAtMs === null
      ? 0
      : Math.max(0, hubState.rateLimitUntilAtMs - now);
    const remainingMs = Math.max(throttleRemainingMs, rateLimitRemainingMs);
    if (remainingMs > 0) {
      this.scheduleHubRetry(hubState, remainingMs);
      return;
    }

    await this.flushHubRender(hubState);
  }

  private async flushHubRender(hubState: RuntimeHubState): Promise<void> {
    const text = hubState.pendingText;
    const replyMarkup = hubState.pendingReplyMarkup ?? undefined;
    if (!text || !replyMarkup) {
      return;
    }

    const replyMarkupKey = serializeReplyMarkup(replyMarkup);
    if (text === hubState.lastRenderedText && hubState.lastRenderedReplyMarkupKey === replyMarkupKey) {
      hubState.pendingText = null;
      hubState.pendingReplyMarkup = null;
      hubState.pendingReason = null;
      this.syncSingleSessionHubState(hubState);
      return;
    }

    hubState.pendingText = null;
    hubState.pendingReplyMarkup = null;
    hubState.pendingReason = null;

    if (hubState.messageId === 0) {
      const sent = await this.deps.safeSendHtmlMessageResult(hubState.chatId, text, replyMarkup);
      if (!sent) {
        hubState.pendingText = text;
        hubState.pendingReplyMarkup = replyMarkup;
        this.syncSingleSessionHubState(hubState);
        return;
      }

      hubState.messageId = sent.message_id;
      hubState.lastRenderedText = text;
      hubState.lastRenderedReplyMarkupKey = replyMarkupKey;
      hubState.lastRenderedAtMs = Date.now();
      hubState.rateLimitUntilAtMs = null;
      this.syncSingleSessionHubState(hubState);
      return;
    }

    const result = await this.deps.safeEditHtmlMessageText(hubState.chatId, hubState.messageId, text, replyMarkup);
    if (result.outcome === "edited") {
      hubState.lastRenderedText = text;
      hubState.lastRenderedReplyMarkupKey = replyMarkupKey;
      hubState.lastRenderedAtMs = Date.now();
      hubState.rateLimitUntilAtMs = null;
      this.syncSingleSessionHubState(hubState);
      return;
    }

    hubState.pendingText = text;
    hubState.pendingReplyMarkup = replyMarkup;
    if (result.outcome === "rate_limited") {
      hubState.rateLimitUntilAtMs = Date.now() + result.retryAfterMs;
      this.syncSingleSessionHubState(hubState);
      this.scheduleHubRetry(hubState, result.retryAfterMs);
      return;
    }

    this.syncSingleSessionHubState(hubState);
    this.scheduleHubRetry(hubState, FAILED_EDIT_RETRY_MS);
  }

  private clearHubTimer(hubState: RuntimeHubState): void {
    if (!hubState.timer) {
      return;
    }
    clearTimeout(hubState.timer);
    hubState.timer = null;
  }

  private syncSingleSessionHubState(hubState: RuntimeHubState): void {
    if (hubState.kind !== "live" || hubState.sessionIds.length !== 1 || hubState.messageId === 0) {
      return;
    }

    const sessionId = hubState.sessionIds[0];
    if (!sessionId) {
      return;
    }

    const activeTurn = this.deps.listActiveTurns().find((candidate) => candidate.chatId === hubState.chatId && candidate.sessionId === sessionId);
    if (!activeTurn) {
      return;
    }

    activeTurn.statusCard.messageId = hubState.messageId;
    activeTurn.statusCard.lastRenderedText = hubState.lastRenderedText;
    activeTurn.statusCard.lastRenderedReplyMarkupKey = hubState.lastRenderedReplyMarkupKey;
    activeTurn.statusCard.lastRenderedAtMs = hubState.lastRenderedAtMs;
    activeTurn.statusCard.rateLimitUntilAtMs = hubState.rateLimitUntilAtMs;
    activeTurn.statusCard.pendingText = hubState.pendingText;
    activeTurn.statusCard.pendingReplyMarkup = hubState.pendingReplyMarkup;
    activeTurn.statusCard.pendingReason = hubState.pendingReason;
  }

  async refreshActiveRuntimeStatusCard(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    chatId: string,
    reason: string
  ): Promise<void> {
    if (activeTurn && activeTurn.chatId !== chatId) {
      return;
    }
    await this.refreshLiveRuntimeHubs(chatId, reason, activeTurn?.sessionId ?? null);
  }

  async handleStatusCardSectionToggle(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    expanded: boolean,
    section: "plan" | "agents"
  ): Promise<void> {
    const hubState = this.resolveFocusedRuntimeHubSession(chatId, messageId, sessionId, { requireLive: true });
    if (!hubState) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const activeTurn = this.deps.listActiveTurns().find((candidate) => candidate.sessionId === sessionId) ?? null;
    if (!activeTurn) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const inspect = activeTurn.tracker.getInspectSnapshot();
    const snapshotData = section === "plan" ? inspect.planSnapshot : inspect.agentSnapshot;
    if (snapshotData.length === 0) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const expandedField = section === "plan" ? "planExpanded" : "agentsExpanded";
    if (hubState[expandedField] === expanded) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个操作已处理。");
      return;
    }

    hubState[expandedField] = expanded;
    hubState.callbackVersion += 1;
    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.refreshLiveRuntimeHubs(hubState.chatId, `${section}_${expanded ? "expanded" : "collapsed"}`, sessionId);
  }

  async syncRuntimeCards(
    activeTurn: RuntimeSurfaceActiveTurn,
    classified: ReturnType<typeof classifyNotification> | null,
    previousStatus: ActivityStatus | null,
    nextStatus: ActivityStatus,
    options: {
      force?: boolean;
      reason: string;
    }
  ): Promise<void> {
    let inspect = activeTurn.tracker.getInspectSnapshot();
    if (inspect.agentSnapshot.length > 0) {
      const identityChanged = await this.deps.backfillSubagentIdentities(activeTurn, inspect.agentSnapshot);
      if (identityChanged) {
        inspect = activeTurn.tracker.getInspectSnapshot();
      }
    }

    const planFingerprint = inspect.planSnapshot.join("\n");
    const planChanged = planFingerprint !== activeTurn.latestPlanFingerprint;
    if (planChanged) {
      activeTurn.latestPlanFingerprint = planFingerprint;
    }

    const agentFingerprint = inspect.agentSnapshot
      .map((agent) => `${agent.threadId}|${agent.label}|${agent.status}|${agent.progress ?? ""}`)
      .join("\n");
    const agentsChanged = agentFingerprint !== activeTurn.latestAgentFingerprint;
    if (agentsChanged) {
      activeTurn.latestAgentFingerprint = agentFingerprint;
    }

    if (inspect.agentSnapshot.length === 0 && activeTurn.statusCard.agentsExpanded) {
      activeTurn.statusCard.agentsExpanded = false;
    }

    const commandStateChanged = classified && classified.threadId && classified.threadId !== activeTurn.threadId
      ? false
      : applyRuntimeCommandDelta(activeTurn.statusCard, classified, nextStatus);
    const nextStatusProgressText = selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null);
    const statusProgressTextChanged = nextStatusProgressText !== activeTurn.latestStatusProgressText;
    if (statusProgressTextChanged) {
      activeTurn.latestStatusProgressText = nextStatusProgressText;
    }

    const statusChanged = previousStatus === null
      || previousStatus.turnStatus !== nextStatus.turnStatus
      || previousStatus.threadBlockedReason !== nextStatus.threadBlockedReason
      || previousStatus.activeItemType !== nextStatus.activeItemType
      || previousStatus.activeItemLabel !== nextStatus.activeItemLabel
      || previousStatus.lastHighValueEventType !== nextStatus.lastHighValueEventType
      || previousStatus.lastHighValueTitle !== nextStatus.lastHighValueTitle
      || previousStatus.lastHighValueDetail !== nextStatus.lastHighValueDetail
      || previousStatus.latestProgress !== nextStatus.latestProgress
      || previousStatus.finalMessageAvailable !== nextStatus.finalMessageAvailable
      || previousStatus.errorState !== nextStatus.errorState
      || commandStateChanged
      || planChanged
      || agentsChanged
      || statusProgressTextChanged
      || options.force;
    const shouldReanchorOnRecovery = activeTurn.statusCard.needsReanchorOnActive
      && previousStatus?.turnStatus === "blocked"
      && nextStatus.turnStatus === "running";

    if (statusChanged) {
      await this.refreshLiveRuntimeHubs(activeTurn.chatId, options.reason, activeTurn.sessionId);
    }

    if (shouldReanchorOnRecovery) {
      activeTurn.statusCard.needsReanchorOnActive = false;
      await this.reanchorRuntimeAfterBridgeReply(activeTurn, activeTurn.chatId, "recovered_active");
    }

    if (classified?.kind === "error") {
      activeTurn.statusCard.needsReanchorOnActive = true;
      const errorCard = createErrorCardMessageState(`error-${activeTurn.nextErrorCardId++}`);
      errorCard.title = "Runtime error";
      errorCard.detail = cleanRuntimeErrorMessage(classified.message);
      activeTurn.errorCards.push(errorCard);
      const renderedErrorText = buildRuntimeErrorCard({
        ...this.deps.getRuntimeCardContext(activeTurn.sessionId),
        title: errorCard.title,
        detail: errorCard.detail
      });
      await this.logRuntimeCardEvent(activeTurn, errorCard, "card_created", {
        reason: "runtime_error",
        triggerKind: classified.kind,
        triggerMethod: classified.method,
        title: errorCard.title,
        detail: errorCard.detail,
        card: summarizeRuntimeCardSurface(errorCard),
        renderedText: renderedErrorText
      });
      await this.requestRuntimeCardRender(activeTurn, errorCard, renderedErrorText, undefined, {
        force: true,
        reason: "runtime_error"
      });
    }

    if (classified?.kind === "turn_completed" && classified.status === "failed" && activeTurn.errorCards.length === 0) {
      const errorCard = createErrorCardMessageState(`error-${activeTurn.nextErrorCardId++}`);
      errorCard.title = "Turn failed";
      errorCard.detail = "This operation did not complete successfully.";
      activeTurn.errorCards.push(errorCard);
      const renderedErrorText = buildRuntimeErrorCard({
        ...this.deps.getRuntimeCardContext(activeTurn.sessionId),
        title: errorCard.title,
        detail: errorCard.detail
      });
      await this.logRuntimeCardEvent(activeTurn, errorCard, "card_created", {
        reason: "turn_failed",
        triggerKind: classified.kind,
        triggerMethod: classified.method,
        title: errorCard.title,
        detail: errorCard.detail,
        card: summarizeRuntimeCardSurface(errorCard),
        renderedText: renderedErrorText
      });
      await this.requestRuntimeCardRender(activeTurn, errorCard, renderedErrorText, undefined, {
        force: true,
        reason: "turn_failed"
      });
    }

    if (nextStatus.turnStatus === "completed" || nextStatus.turnStatus === "failed" || nextStatus.turnStatus === "interrupted") {
      const chatState = this.getOrCreateHubChatState(activeTurn.chatId);
      chatState.runningOrder = chatState.runningOrder.filter((sessionId) => sessionId !== activeTurn.sessionId);
      const context = this.deps.getRuntimeCardContext(activeTurn.sessionId);
      chatState.terminalSummaries = [
        {
          sessionId: activeTurn.sessionId,
          sessionName: context.sessionName ?? activeTurn.sessionId,
          projectName: context.projectName ?? null,
          state: nextStatus.turnStatus === "completed"
            ? "Completed"
            : nextStatus.turnStatus === "interrupted"
              ? "Interrupted"
              : "Failed"
        },
        ...chatState.terminalSummaries.filter((entry) => entry.sessionId !== activeTurn.sessionId)
      ].slice(0, RUNTIME_HUB_TERMINAL_SUMMARY_LIMIT);
      await this.refreshLiveRuntimeHubs(activeTurn.chatId, "turn_terminal", null, activeTurn.sessionId);
    }
  }

  async requestRuntimeCardRender(
    activeTurn: RuntimeSurfaceActiveTurn,
    surface: RuntimeCardMessageState,
    text: string,
    replyMarkup: TelegramInlineKeyboardMarkup | undefined,
    options: {
      force?: boolean;
      reason: string;
    }
  ): Promise<void> {
    const replyMarkupKey = serializeReplyMarkup(replyMarkup);
    const pendingChanged = surface.pendingText !== text
      || serializeReplyMarkup(surface.pendingReplyMarkup) !== replyMarkupKey;
    surface.pendingText = text;
    surface.pendingReplyMarkup = replyMarkup ?? null;
    surface.pendingReason = options.reason;
    await this.logRuntimeCardEvent(activeTurn, surface, "render_requested", {
      reason: options.reason,
      forced: options.force ?? false,
      pendingChanged,
      renderedText: text,
      replyMarkup: replyMarkup ?? null,
      card: summarizeRuntimeCardSurface(surface)
    });

    if (!pendingChanged && text === surface.lastRenderedText && surface.lastRenderedReplyMarkupKey === replyMarkupKey) {
      await this.logRuntimeCardEvent(activeTurn, surface, "render_skipped", {
        reason: "text_unchanged",
        renderedText: text,
        replyMarkup: replyMarkup ?? null,
        card: summarizeRuntimeCardSurface(surface)
      });
      await this.deps.logger.info("runtime card update skipped", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        reason: "text_unchanged"
      });
      return;
    }

    const now = Date.now();
    const throttleMs = options.force || surface.messageId === 0 ? 0 : getRuntimeCardThrottleMs(surface.surface);
    const lastRenderedAtMs = surface.lastRenderedAtMs ?? null;
    const throttleRemainingMs = lastRenderedAtMs === null
      ? 0
      : Math.max(0, lastRenderedAtMs + throttleMs - now);
    const rateLimitRemainingMs = surface.rateLimitUntilAtMs === null
      ? 0
      : Math.max(0, surface.rateLimitUntilAtMs - now);
    const remainingMs = Math.max(throttleRemainingMs, rateLimitRemainingMs);

    if (remainingMs > 0) {
      this.scheduleRuntimeCardRetry(activeTurn, surface, remainingMs, options.reason);
      await this.logRuntimeCardEvent(activeTurn, surface, "render_scheduled", {
        reason: options.reason,
        forced: options.force ?? false,
        remainingMs,
        throttleRemainingMs,
        rateLimitRemainingMs,
        card: summarizeRuntimeCardSurface(surface)
      });
      await this.deps.logger.info("runtime card update scheduled", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        reason: options.reason,
        remainingMs
      });
      return;
    }

    await this.flushRuntimeCardRender(activeTurn, surface);
  }

  async flushRuntimeCardRender(
    activeTurn: RuntimeSurfaceActiveTurn,
    surface: RuntimeCardMessageState
  ): Promise<void> {
    await this.runRuntimeCardOperation(activeTurn, async () => {
      const text = surface.pendingText;
      const replyMarkup = surface.pendingReplyMarkup ?? undefined;
      const replyMarkupKey = serializeReplyMarkup(replyMarkup);
      const reason = surface.pendingReason;
      if (!text) {
        return;
      }

      if (text === surface.lastRenderedText && surface.lastRenderedReplyMarkupKey === replyMarkupKey) {
        surface.pendingText = null;
        surface.pendingReplyMarkup = null;
        surface.pendingReason = null;
        await this.logRuntimeCardEvent(activeTurn, surface, "render_skipped", {
          reason: "render_unchanged",
          renderedText: text,
          replyMarkup: replyMarkup ?? null,
          card: summarizeRuntimeCardSurface(surface)
        });
        await this.deps.logger.info("runtime card update skipped", {
          sessionId: activeTurn.sessionId,
          turnId: activeTurn.turnId,
          surface: surface.surface,
          key: surface.key,
          reason: "render_unchanged"
        });
        return;
      }

      surface.pendingText = null;
      surface.pendingReplyMarkup = null;
      surface.pendingReason = null;

      if (surface.messageId === 0) {
        const sent = surface.parseMode === "HTML"
          ? await this.deps.safeSendHtmlMessageResult(activeTurn.chatId, text, replyMarkup)
          : await this.deps.safeSendMessageResult(activeTurn.chatId, text, replyMarkup);
        if (!sent) {
          surface.pendingText = text;
          surface.pendingReplyMarkup = replyMarkup ?? null;
          surface.pendingReason = reason;
          await this.logRuntimeCardEvent(activeTurn, surface, "send_failed_requeued", {
            reason,
            renderedText: text,
            replyMarkup: replyMarkup ?? null,
            card: summarizeRuntimeCardSurface(surface)
          });
          return;
        }

        surface.messageId = sent.message_id;
        surface.lastRenderedText = text;
        surface.lastRenderedReplyMarkupKey = replyMarkupKey;
        surface.lastRenderedAtMs = Date.now();
        surface.rateLimitUntilAtMs = null;
        await this.logRuntimeCardEvent(activeTurn, surface, "render_sent", {
          reason,
          renderedText: text,
          replyMarkup: replyMarkup ?? null,
          card: summarizeRuntimeCardSurface(surface)
        });
        await this.deps.logger.info("runtime card sent", {
          sessionId: activeTurn.sessionId,
          turnId: activeTurn.turnId,
          surface: surface.surface,
          key: surface.key,
          messageId: surface.messageId,
          reason,
          preview: summarizeTextPreview(text)
        });
        return;
      }

      const editResult = surface.parseMode === "HTML"
        ? await this.deps.safeEditHtmlMessageText(activeTurn.chatId, surface.messageId, text, replyMarkup)
        : await this.deps.safeEditMessageText(activeTurn.chatId, surface.messageId, text, replyMarkup);
      await this.logRuntimeCardEvent(activeTurn, surface, "edit_attempted", {
        reason,
        outcome: editResult.outcome,
        renderedText: text,
        replyMarkup: replyMarkup ?? null,
        retryAfterMs: editResult.outcome === "rate_limited" ? editResult.retryAfterMs : null,
        card: summarizeRuntimeCardSurface(surface)
      });
      await this.deps.logger.info("runtime card edit attempted", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        messageId: surface.messageId,
        outcome: editResult.outcome,
        reason,
        preview: summarizeTextPreview(text),
        retryAfterMs: editResult.outcome === "rate_limited" ? editResult.retryAfterMs : undefined
      });

      if (editResult.outcome === "edited") {
        surface.lastRenderedText = text;
        surface.lastRenderedReplyMarkupKey = replyMarkupKey;
        surface.lastRenderedAtMs = Date.now();
        surface.rateLimitUntilAtMs = null;
        await this.logRuntimeCardEvent(activeTurn, surface, "render_edited", {
          reason,
          renderedText: text,
          replyMarkup: replyMarkup ?? null,
          card: summarizeRuntimeCardSurface(surface)
        });
        return;
      }

      surface.pendingText = text;
      surface.pendingReplyMarkup = replyMarkup ?? null;
      surface.pendingReason = reason;
      if (editResult.outcome === "rate_limited") {
        surface.rateLimitUntilAtMs = Date.now() + editResult.retryAfterMs;
      }
      const retryMs = editResult.outcome === "rate_limited" ? editResult.retryAfterMs : FAILED_EDIT_RETRY_MS;
      await this.logRuntimeCardEvent(activeTurn, surface, "edit_requeued", {
        reason,
        outcome: editResult.outcome,
        retryMs,
        renderedText: text,
        replyMarkup: replyMarkup ?? null,
        card: summarizeRuntimeCardSurface(surface)
      });
      this.scheduleRuntimeCardRetry(activeTurn, surface, retryMs, reason ?? "edit_retry");
    });
  }

  async reanchorStatusCardToLatestMessage(
    activeTurn: RuntimeSurfaceActiveTurn,
    reason: string
  ): Promise<void> {
    const previousMessageId = activeTurn.statusCard.messageId;
    const rendered = this.buildStatusCardRenderPayload(activeTurn.sessionId, activeTurn.tracker, activeTurn.statusCard);
    const sent = await this.deps.safeSendHtmlMessageResult(activeTurn.chatId, rendered.text, rendered.replyMarkup);
    if (!sent) {
      return;
    }

    const replyMarkupKey = serializeReplyMarkup(rendered.replyMarkup);
    activeTurn.statusCard.messageId = sent.message_id;
    activeTurn.statusCard.lastRenderedText = rendered.text;
    activeTurn.statusCard.lastRenderedReplyMarkupKey = replyMarkupKey;
    activeTurn.statusCard.lastRenderedAtMs = Date.now();
    activeTurn.statusCard.rateLimitUntilAtMs = null;
    activeTurn.statusCard.pendingText = null;
    activeTurn.statusCard.pendingReplyMarkup = null;
    activeTurn.statusCard.pendingReason = null;
    await this.logRuntimeCardEvent(activeTurn, activeTurn.statusCard, "card_reanchored", {
      reason,
      renderedText: rendered.text,
      replyMarkup: rendered.replyMarkup ?? null,
      card: summarizeRuntimeCardSurface(activeTurn.statusCard)
    });
    await this.deps.logger.info("runtime status card reanchored", {
      sessionId: activeTurn.sessionId,
      turnId: activeTurn.turnId,
      messageId: activeTurn.statusCard.messageId,
      reason,
      preview: summarizeTextPreview(rendered.text)
    });

    if (previousMessageId > 0 && previousMessageId !== sent.message_id) {
      await this.deps.safeDeleteMessage(activeTurn.chatId, previousMessageId);
    }
  }

  async runRuntimeCardOperation(
    activeTurn: RuntimeSurfaceActiveTurn,
    operation: () => Promise<void>
  ): Promise<void> {
    const queuedOperation = activeTurn.surfaceQueue.then(operation, operation);
    activeTurn.surfaceQueue = queuedOperation.catch(() => {});
    await queuedOperation;
  }

  clearRuntimeCardTimer(surface: RuntimeCardMessageState): void {
    if (!surface.timer) {
      return;
    }

    clearTimeout(surface.timer);
    surface.timer = null;
  }

  disposeRuntimeCards(activeTurn: RuntimeSurfaceActiveTurn): void {
    void this.logRuntimeCardEvent(activeTurn, activeTurn.statusCard, "card_disposed", {
      card: summarizeRuntimeCardSurface(activeTurn.statusCard)
    });
    this.clearRuntimeCardTimer(activeTurn.statusCard);

    for (const errorCard of activeTurn.errorCards) {
      void this.logRuntimeCardEvent(activeTurn, errorCard, "card_disposed", {
        card: summarizeRuntimeCardSurface(errorCard)
      });
      this.clearRuntimeCardTimer(errorCard);
    }
  }

  disposeAllRuntimeHubs(): void {
    for (const chatState of this.runtimeHubStates.values()) {
      for (const hubState of chatState.liveHubs.values()) {
        this.clearHubTimer(hubState);
      }
      if (chatState.recoveryHub) {
        this.clearHubTimer(chatState.recoveryHub);
      }
    }
  }

  async reanchorRuntimeAfterBridgeReply(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    chatId: string,
    reason: string
  ): Promise<void> {
    const chatState = this.runtimeHubStates.get(chatId);
    if (!chatState || chatState.liveHubs.size === 0) {
      return;
    }

    const targetSessionId = activeTurn?.chatId === chatId
      ? activeTurn.sessionId
      : (this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null);

    const targetSession = targetSessionId ? this.deps.getStore()?.getSessionById(targetSessionId) ?? null : null;
    if (
      activeTurn?.tracker.getStatus().turnStatus === "blocked"
      && targetSession
      && this.deps.buildPendingInteractionSummaries(targetSession).length > 0
    ) {
      return;
    }

    await this.refreshLiveRuntimeHubs(chatId, reason, targetSessionId);

    const targetHub = [...chatState.liveHubs.values()].find((hubState) =>
      targetSessionId ? hubState.sessionIds.includes(targetSessionId) : false
    ) ?? chatState.liveHubs.get(0) ?? [...chatState.liveHubs.values()][0];

    if (!targetHub) {
      return;
    }

    await this.reanchorRuntimeHubToLatestMessage(targetHub, reason);
  }

  private async reanchorRuntimeHubToLatestMessage(hubState: RuntimeHubState, _reason: string): Promise<void> {
    const previousMessageId = hubState.messageId;
    const rendered = hubState.kind === "live"
      ? this.buildLiveHubRenderPayload(hubState.chatId, hubState, this.getOrCreateHubChatState(hubState.chatId).liveHubs.size)
      : this.buildRecoveryHubRenderPayload(hubState.chatId, hubState);
    const sent = await this.deps.safeSendHtmlMessageResult(hubState.chatId, rendered.text, rendered.replyMarkup);
    if (!sent) {
      return;
    }

    hubState.messageId = sent.message_id;
    hubState.lastRenderedText = rendered.text;
    hubState.lastRenderedReplyMarkupKey = serializeReplyMarkup(rendered.replyMarkup);
    hubState.lastRenderedAtMs = Date.now();
    hubState.rateLimitUntilAtMs = null;
    hubState.pendingText = null;
    hubState.pendingReplyMarkup = null;
    hubState.pendingReason = null;
    this.syncSingleSessionHubState(hubState);
    if (previousMessageId > 0 && previousMessageId !== sent.message_id) {
      await this.deps.safeDeleteMessage(hubState.chatId, previousMessageId);
    }
  }

  async renderPersistedFinalAnswer(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    answerId: string,
    mode: {
      expanded: boolean;
      page?: number;
    }
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const view = store.getFinalAnswerView(answerId, chatId);
    if (!view) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (!mode.expanded) {
      const result = await this.deps.safeEditHtmlMessageText(
        chatId,
        messageId,
        view.previewHtml,
        buildFinalAnswerReplyMarkup({
          answerId,
          totalPages: view.pages.length,
          expanded: false
        })
      );
      await this.finishPersistedFinalAnswerRender(callbackQueryId, answerId, messageId, result);
      return;
    }

    const page = mode.page ?? 1;
    const pageHtml = view.pages[page - 1];
    if (!pageHtml) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const result = await this.deps.safeEditHtmlMessageText(
      chatId,
      messageId,
      pageHtml,
      buildFinalAnswerReplyMarkup({
        answerId,
        totalPages: view.pages.length,
        expanded: true,
        currentPage: page
      })
    );
    await this.finishPersistedFinalAnswerRender(callbackQueryId, answerId, messageId, result);
  }

  async renderPersistedPlanResult(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    answerId: string,
    mode: {
      expanded: boolean;
      page?: number;
    }
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const view = store.getFinalAnswerView(answerId, chatId);
    if (!view) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (!mode.expanded) {
      const result = await this.deps.safeEditHtmlMessageText(
        chatId,
        messageId,
        this.buildPlanResultHtml(view.previewHtml, view.primaryActionConsumed),
        buildPlanResultReplyMarkup({
          answerId,
          totalPages: view.pages.length,
          expanded: false,
          primaryActionConsumed: view.primaryActionConsumed
        })
      );
      await this.finishPersistedFinalAnswerRender(callbackQueryId, answerId, messageId, result);
      return;
    }

    const page = mode.page ?? 1;
    const pageHtml = view.pages[page - 1];
    if (!pageHtml) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const result = await this.deps.safeEditHtmlMessageText(
      chatId,
      messageId,
      this.buildPlanResultHtml(pageHtml, view.primaryActionConsumed),
      buildPlanResultReplyMarkup({
        answerId,
        totalPages: view.pages.length,
        expanded: true,
        currentPage: page,
        primaryActionConsumed: view.primaryActionConsumed
      })
    );
    await this.finishPersistedFinalAnswerRender(callbackQueryId, answerId, messageId, result);
  }

  async handleInspect(chatId: string, sessionId?: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = sessionId
      ? this.getInspectableSession(chatId, sessionId)
      : store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const payload = await this.getInspectRenderPayload(activeSession);
    if (!payload) {
      await this.deps.safeSendMessage(chatId, "当前没有可用的活动详情。");
      return;
    }

    const inspectHtml = this.buildInspectHtml(activeSession, payload);
    const rendered = buildInspectViewMessage({
      sessionId: activeSession.sessionId,
      html: inspectHtml,
      page: 0,
      collapsed: false
    });

    if (!await this.deps.safeSendHtmlMessage(chatId, rendered.text, rendered.replyMarkup)) {
      await this.deps.safeSendMessage(chatId, buildInspectPlainTextFallback(inspectHtml));
    }
  }

  async handleInspectViewCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    options: {
      collapsed: boolean;
      page: number;
    }
  ): Promise<void> {
    const session = this.getInspectableSession(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /inspect。");
      return;
    }

    const payload = await this.getInspectRenderPayload(session);
    if (!payload) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "当前没有可用的活动详情。");
      return;
    }

    const inspectHtml = this.buildInspectHtml(session, payload);
    const rendered = buildInspectViewMessage({
      sessionId,
      html: inspectHtml,
      page: options.page,
      collapsed: options.collapsed
    });

    const editResult = await this.deps.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
    if (editResult.outcome === "edited") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    const fallbackSent = await this.deps.safeSendMessage(chatId, buildInspectPlainTextFallback(rendered.text));
    await this.deps.safeAnswerCallbackQuery(
      callbackQueryId,
      fallbackSent ? "详情过长，已改为纯文本发送。" : "暂时无法更新详情，请稍后重试。"
    );
  }

  async handleInspectCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const session = this.getInspectableSession(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新发送 /inspect。");
      return;
    }

    const result = await this.deps.safeEditHtmlMessageText(chatId, messageId, buildInspectClosedMessage());
    if (result.outcome === "edited") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法关闭这条消息，请稍后再试。");
  }

  private scheduleRuntimeCardRetry(
    activeTurn: RuntimeSurfaceActiveTurn,
    surface: RuntimeCardMessageState,
    delayMs: number,
    reason: string
  ): void {
    this.clearRuntimeCardTimer(surface);
    surface.timer = setTimeout(() => {
      surface.timer = null;
      void this.logRuntimeCardEvent(activeTurn, surface, "retry_fired", {
        reason,
        delayMs,
        card: summarizeRuntimeCardSurface(surface)
      });
      void this.deps.logger.info("runtime card retry fired", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        reason
      });
      void this.flushRuntimeCardRender(activeTurn, surface);
    }, delayMs);
    surface.timer.unref?.();
  }

  private async logRuntimeCardEvent(
    activeTurn: RuntimeSurfaceActiveTurn,
    surface: RuntimeCardMessageState,
    event: string,
    meta?: Record<string, unknown>
  ): Promise<void> {
    await this.deps.runtimeTraceSink.logRuntimeCardEvent(activeTurn, surface, event, meta);
  }

  private createRuntimePreferencesDraftToken(): string {
    return randomUUID().replace(/-/gu, "").slice(0, 10);
  }

  private getRuntimePreferencesDraft(
    token: string,
    chatId: string,
    messageId: number
  ): RuntimePreferencesDraftState | null {
    const draft = this.runtimePreferenceDrafts.get(token);
    if (!draft || draft.chatId !== chatId || draft.messageId !== messageId) {
      return null;
    }

    return draft;
  }

  private async renderRuntimePreferencesDraft(token: string, draft: RuntimePreferencesDraftState): Promise<void> {
    const rendered = buildRuntimePreferencesMessage({
      token,
      fields: draft.fields,
      page: draft.page
    });
    await this.deps.safeEditHtmlMessageText(draft.chatId, draft.messageId, rendered.text, rendered.replyMarkup);
  }

  private buildPlanResultHtml(html: string, primaryActionConsumed: boolean): string {
    return primaryActionConsumed ? `${buildPlanResultConsumedNotice()}\n\n${html}` : html;
  }

  private async finishPersistedFinalAnswerRender(
    callbackQueryId: string,
    answerId: string,
    messageId: number,
    result: TelegramEditResult
  ): Promise<void> {
    switch (result.outcome) {
      case "edited":
        this.deps.getStore()?.setFinalAnswerMessageId(answerId, messageId);
        await this.deps.safeAnswerCallbackQuery(callbackQueryId);
        return;
      case "rate_limited":
        await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Telegram 正在限流，请稍后再试。");
        return;
      default:
        await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法更新这条消息，请稍后再试。");
        return;
    }
  }

  private getInspectableSession(chatId: string, sessionId: string): SessionRow | null {
    const session = this.deps.getStore()?.getSessionById(sessionId) ?? null;
    if (!session || session.telegramChatId !== chatId) {
      return null;
    }

    return session;
  }

  private buildInspectHtml(activeSession: SessionRow, payload: RuntimeSurfaceInspectRenderPayload): string {
    return buildInspectText(payload.snapshot, {
      sessionName: activeSession.displayName,
      projectName: activeSession.projectName,
      commands: payload.commands,
      note: payload.note
    });
  }

  private async getInspectRenderPayload(activeSession: SessionRow): Promise<RuntimeSurfaceInspectRenderPayload | null> {
    const pendingInteractions = this.deps.buildPendingInteractionSummaries(activeSession);
    const answeredInteractions = this.deps.buildAnsweredInteractionSummaries(activeSession);
    const activity = this.deps.getActiveInspectActivity(activeSession.sessionId)
      ?? this.deps.getRecentActivity(activeSession.sessionId);

    if (activity) {
      const snapshot = {
        ...activity.tracker.getInspectSnapshot(),
        pendingInteractions,
        answeredInteractions
      };
      if (snapshot.inspectAvailable) {
        return {
          snapshot,
          commands: buildInspectCommandEntries(activity.statusCard),
          note: null
        };
      }

      if (shouldRetryInspectFromHistory(activeSession, snapshot)) {
        const historicalPayload = await this.deps.getHistoricalInspectPayload(activeSession);
        if (historicalPayload) {
          return {
            ...historicalPayload,
            snapshot: {
              ...historicalPayload.snapshot,
              pendingInteractions,
              answeredInteractions
            }
          };
        }
      }

      if (snapshot.turnStatus !== "starting") {
        return {
          snapshot,
          commands: buildInspectCommandEntries(activity.statusCard),
          note: null
        };
      }
    }

    const historicalPayload = await this.deps.getHistoricalInspectPayload(activeSession);
    if (historicalPayload) {
      return {
        ...historicalPayload,
        snapshot: {
          ...historicalPayload.snapshot,
          pendingInteractions,
          answeredInteractions
        }
      };
    }

    if (pendingInteractions.length > 0 || answeredInteractions.length > 0) {
      return {
        snapshot: buildPendingInteractionOnlyInspectSnapshot(pendingInteractions, answeredInteractions),
        commands: [],
        note: null
      };
    }

    return null;
  }
}

function summarizeActivityStatus(status: ActivityStatus): Record<string, unknown> {
  return {
    turnStatus: status.turnStatus,
    threadRuntimeState: status.threadRuntimeState,
    activeItemType: status.activeItemType,
    activeItemId: status.activeItemId,
    activeItemLabel: summarizeTextPreview(status.activeItemLabel, 160) || null,
    lastActivityAt: status.lastActivityAt,
    currentItemStartedAt: status.currentItemStartedAt,
    currentItemDurationSec: status.currentItemDurationSec,
    lastHighValueEventType: status.lastHighValueEventType,
    lastHighValueTitle: summarizeTextPreview(status.lastHighValueTitle, 160) || null,
    lastHighValueDetail: summarizeTextPreview(status.lastHighValueDetail, 160) || null,
    latestProgress: summarizeTextPreview(status.latestProgress, 160) || null,
    recentStatusUpdates: summarizeActivityStatusList(status.recentStatusUpdates),
    blockedReason: status.threadBlockedReason,
    finalMessageAvailable: status.finalMessageAvailable,
    inspectAvailable: status.inspectAvailable,
    debugAvailable: status.debugAvailable,
    errorState: status.errorState
  };
}

function summarizeActivityStatusList(values: string[]): string[] {
  return values.map((value) => summarizeTextPreview(value, 160));
}

function summarizeTextPreview(text: string | null | undefined, limit = 160): string {
  return normalizeAndTruncate(text, limit, "...") ?? "";
}

function formatRuntimeCommandState(status: RuntimeCommandState["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      return "Unknown";
  }
}

function buildInspectCommandEntries(statusCard: StatusCardState | null | undefined): RuntimeCommandEntryView[] {
  if (!statusCard) {
    return [];
  }

  return statusCard.commandOrder.map((command) => ({
    commandText: command.commandText,
    state: formatRuntimeCommandState(command.status),
    latestSummary: command.latestSummary
  }));
}

function buildPendingInteractionOnlyInspectSnapshot(
  pendingInteractions: PendingInteractionSummary[],
  answeredInteractions: string[]
): InspectSnapshot {
  return {
    turnStatus: "blocked",
    threadRuntimeState: null,
    activeItemType: null,
    activeItemId: null,
    activeItemLabel: null,
    lastActivityAt: null,
    currentItemStartedAt: null,
    currentItemDurationSec: null,
    lastHighValueEventType: "blocked",
    lastHighValueTitle: "Blocked: waiting on interaction",
    lastHighValueDetail: null,
    latestProgress: null,
    recentStatusUpdates: [],
    threadBlockedReason: null,
    finalMessageAvailable: false,
    inspectAvailable: true,
    debugAvailable: true,
    errorState: null,
    recentTransitions: [],
    recentCommandSummaries: [],
    recentFileChangeSummaries: [],
    recentMcpSummaries: [],
    recentWebSearches: [],
    recentHookSummaries: [],
    recentNoticeSummaries: [],
    planSnapshot: [],
    proposedPlanSnapshot: [],
    agentSnapshot: [],
    completedCommentary: [],
    tokenUsage: null,
    latestDiffSummary: null,
    terminalInteractionSummary: null,
    pendingInteractions,
    answeredInteractions
  };
}

function shouldRetryInspectFromHistory(activeSession: SessionRow, snapshot: InspectSnapshot): boolean {
  if (!activeSession.threadId || !activeSession.lastTurnId) {
    return false;
  }

  return snapshot.turnStatus === "completed"
    || snapshot.turnStatus === "interrupted"
    || snapshot.turnStatus === "failed"
    || activeSession.status !== "running";
}

function buildInspectPlainTextFallback(html: string): string {
  const plainText = html
    .replace(/<\/?b>/gu, "")
    .replace(/<\/?i>/gu, "")
    .replace(/<br\s*\/?>/gu, "\n")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&amp;/gu, "&");

  return truncateText(plainText, INSPECT_PLAIN_TEXT_FALLBACK_LIMIT, "…");
}
