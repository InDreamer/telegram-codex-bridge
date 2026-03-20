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
  type RuntimeCommandEntryView,
  type RuntimeHubSessionView
} from "../telegram/ui.js";
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
  isTelegramDeleteCommitted,
  isTelegramEditCommitted,
  type RuntimeCardMessageState,
  type RuntimeCommandState,
  selectStatusProgressText,
  serializeReplyMarkup,
  summarizeRuntimeCardSurface,
  summarizeRuntimeCommands,
  type StatusCardState,
  type TelegramDeleteResult,
  type TelegramEditResult
} from "./runtime-surface-state.js";

const INSPECT_PLAIN_TEXT_FALLBACK_LIMIT = 3500;
const FAILED_EDIT_RETRY_MS = 5000;
const FAILED_HUB_DELETE_RETRY_MS = 5000;
const MAX_RETAINED_HUB_DELETE_FAILURES = 3;
const RUNTIME_HUB_WINDOW_SIZE = 5;
const RUNTIME_HUB_TERMINAL_SUMMARY_LIMIT = 3;
const RUNTIME_HUB_TEXT_SOFT_LIMIT = 3200;
const RUNTIME_HUB_SESSION_PROGRESS_TEXT_LIMIT = 120;
const RUNTIME_HUB_COMPACT_SESSION_PROGRESS_TEXT_LIMIT = 80;

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

interface RuntimeHubVisibleState {
  callbackVersion: number;
  focusedSessionId: string | null;
  sessionIds: string[];
  planExpanded: boolean;
  agentsExpanded: boolean;
}

interface RuntimeHubState {
  token: string;
  chatId: string;
  kind: "live" | "recovery";
  destroyed: boolean;
  windowIndex: number;
  messageId: number;
  requestedGeneration: number;
  committedGeneration: number;
  pendingGeneration: number | null;
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
  pendingVisibleState: RuntimeHubVisibleState | null;
  replacementMessageId: number | null;
  visibleState: RuntimeHubVisibleState;
  timer: ReturnType<typeof setTimeout> | null;
}

// When Telegram refuses to delete an old hub message, keep the message id around
// so the next hub can overwrite it in place instead of leaving stale hub cards in chat.
interface RetainedHubMessage {
  messageId: number;
  generation: number;
  failureCount: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface RuntimeHubChatState {
  liveHubs: Map<number, RuntimeHubState>;
  recoveryHub: RuntimeHubState | null;
  runningOrder: string[];
  terminalSummaries: RuntimeHubTerminalSummary[];
  retainedMessages: RetainedHubMessage[];
  operationQueue: Promise<void>;
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
  safeDeleteMessage: (chatId: string, messageId: number) => Promise<TelegramDeleteResult>;
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
  handleRecoveryHubVisible: (chatId: string) => void;
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
        terminalSummaries: [],
        retainedMessages: [],
        operationQueue: Promise.resolve()
      };
      this.runtimeHubStates.set(chatId, state);
    }

    return state;
  }

  private async runHubChatOperation<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const chatState = this.getOrCreateHubChatState(chatId);
    let result!: T;
    const queued = chatState.operationQueue.then(async () => {
      result = await operation();
    }, async () => {
      result = await operation();
    });
    chatState.operationQueue = queued.then(() => {}, () => {});
    await queued;
    return result;
  }

  private notifyRecoveryHubVisible(hubState: RuntimeHubState): void {
    if (hubState.kind !== "recovery" || hubState.messageId <= 0) {
      return;
    }

    this.deps.handleRecoveryHubVisible(hubState.chatId);
  }

  private chatHasActionablePendingInteractions(chatId: string, excludedSessionId?: string | null): boolean {
    const store = this.deps.getStore();
    if (!store) {
      return false;
    }

    return store
      .listSessions(chatId)
      .some((session) =>
        session.sessionId !== excludedSessionId
        && this.deps.buildPendingInteractionSummaries(session).length > 0
      );
  }

  private createRuntimeHubState(
    chatId: string,
    kind: "live" | "recovery",
    windowIndex: number,
    options?: { messageId?: number }
  ): RuntimeHubState {
    const visibleState: RuntimeHubVisibleState = {
      callbackVersion: 0,
      focusedSessionId: null,
      sessionIds: [],
      planExpanded: false,
      agentsExpanded: false
    };

    return {
      token: randomUUID().replace(/-/gu, "").slice(0, 8),
      chatId,
      kind,
      destroyed: false,
      windowIndex,
      messageId: options?.messageId ?? 0,
      requestedGeneration: 0,
      committedGeneration: 0,
      pendingGeneration: null,
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
      pendingVisibleState: null,
      replacementMessageId: null,
      visibleState,
      timer: null
    };
  }

  private cloneRuntimeHubVisibleState(state: RuntimeHubVisibleState): RuntimeHubVisibleState {
    return {
      callbackVersion: state.callbackVersion,
      focusedSessionId: state.focusedSessionId,
      sessionIds: [...state.sessionIds],
      planExpanded: state.planExpanded,
      agentsExpanded: state.agentsExpanded
    };
  }

  private getDesiredRuntimeHubVisibleState(hubState: RuntimeHubState): RuntimeHubVisibleState {
    return {
      callbackVersion: hubState.callbackVersion,
      focusedSessionId: hubState.focusedSessionId,
      sessionIds: [...hubState.sessionIds],
      planExpanded: hubState.planExpanded,
      agentsExpanded: hubState.agentsExpanded
    };
  }

  private commitRuntimeHubVisibleState(hubState: RuntimeHubState, state: RuntimeHubVisibleState): void {
    hubState.callbackVersion = state.callbackVersion;
    hubState.focusedSessionId = state.focusedSessionId;
    hubState.sessionIds = [...state.sessionIds];
    hubState.planExpanded = state.planExpanded;
    hubState.agentsExpanded = state.agentsExpanded;
    hubState.visibleState = this.cloneRuntimeHubVisibleState(state);
  }

  private runtimeHubVisibleStateEquals(
    left: RuntimeHubVisibleState | null,
    right: RuntimeHubVisibleState | null
  ): boolean {
    if (!left || !right) {
      return left === right;
    }

    return left.callbackVersion === right.callbackVersion
      && left.focusedSessionId === right.focusedSessionId
      && left.planExpanded === right.planExpanded
      && left.agentsExpanded === right.agentsExpanded
      && left.sessionIds.join("\u0000") === right.sessionIds.join("\u0000");
  }

  private clearRetainedHubTimer(retained: RetainedHubMessage): void {
    if (!retained.timer) {
      return;
    }

    clearTimeout(retained.timer);
    retained.timer = null;
  }

  private findRetainedHubMessage(
    chatState: RuntimeHubChatState,
    messageId: number,
    generation?: number
  ): RetainedHubMessage | null {
    return chatState.retainedMessages.find((entry) =>
      entry.messageId === messageId && (generation === undefined || entry.generation === generation)
    ) ?? null;
  }

  private removeRetainedHubMessage(chatState: RuntimeHubChatState, messageId: number, generation?: number): void {
    const index = chatState.retainedMessages.findIndex((entry) =>
      entry.messageId === messageId && (generation === undefined || entry.generation === generation)
    );
    if (index < 0) {
      return;
    }

    const [retained] = chatState.retainedMessages.splice(index, 1);
    if (retained) {
      this.clearRetainedHubTimer(retained);
    }
  }

  private scheduleRetainedHubDeleteRetry(
    chatId: string,
    retained: RetainedHubMessage,
    delayMs = FAILED_HUB_DELETE_RETRY_MS
  ): void {
    this.clearRetainedHubTimer(retained);
    retained.timer = setTimeout(() => {
      retained.timer = null;
      void this.runHubChatOperation(chatId, async () => {
        await this.retryRetainedHubDelete(chatId, retained.messageId, retained.generation);
      });
    }, delayMs);
    retained.timer.unref?.();
  }

  private async retryRetainedHubDelete(chatId: string, messageId: number, generation: number): Promise<void> {
    const chatState = this.runtimeHubStates.get(chatId);
    if (!chatState) {
      return;
    }

    const retained = this.findRetainedHubMessage(chatState, messageId, generation);
    if (!retained) {
      return;
    }

    const deleted = await this.deps.safeDeleteMessage(chatId, messageId);
    const currentChatState = this.runtimeHubStates.get(chatId);
    if (!currentChatState) {
      return;
    }

    const currentRetained = this.findRetainedHubMessage(currentChatState, messageId, generation);
    if (!currentRetained) {
      return;
    }

    if (isTelegramDeleteCommitted(deleted)) {
      this.removeRetainedHubMessage(currentChatState, messageId, generation);
      return;
    }

    if (deleted.outcome === "rate_limited") {
      this.scheduleRetainedHubDeleteRetry(chatId, currentRetained, deleted.retryAfterMs);
      return;
    }

    currentRetained.failureCount += 1;
    if (currentRetained.failureCount > MAX_RETAINED_HUB_DELETE_FAILURES) {
      this.removeRetainedHubMessage(currentChatState, messageId, generation);
      await this.deps.logger.warn("runtime hub delete retry exhausted", {
        chatId,
        messageId,
        generation,
        failureCount: currentRetained.failureCount
      });
      return;
    }

    this.scheduleRetainedHubDeleteRetry(chatId, currentRetained);
  }

  private retainHubMessage(
    chatId: string,
    messageId: number,
    generation: number,
    options?: {
      retryDelayMs?: number;
      failureCount?: number;
    }
  ): void {
    if (messageId <= 0) {
      return;
    }

    const chatState = this.getOrCreateHubChatState(chatId);
    const existing = this.findRetainedHubMessage(chatState, messageId, generation);
    if (existing) {
      if (options?.failureCount !== undefined) {
        existing.failureCount = options.failureCount;
      }
      this.scheduleRetainedHubDeleteRetry(chatId, existing, options?.retryDelayMs);
      return;
    }

    const retained: RetainedHubMessage = {
      messageId,
      generation,
      failureCount: options?.failureCount ?? 0,
      timer: null
    };
    chatState.retainedMessages.push(retained);
    this.scheduleRetainedHubDeleteRetry(chatId, retained, options?.retryDelayMs);
  }

  private claimRetainedHubMessageId(chatId: string): number {
    const chatState = this.getOrCreateHubChatState(chatId);
    const retained = chatState.retainedMessages.pop();
    if (!retained) {
      return 0;
    }

    this.clearRetainedHubTimer(retained);
    return retained.messageId;
  }

  private async deleteHubMessage(chatId: string, messageId: number, generation = 0): Promise<void> {
    if (messageId <= 0) {
      return;
    }

    const deleted = await this.deps.safeDeleteMessage(chatId, messageId);
    if (isTelegramDeleteCommitted(deleted)) {
      return;
    }

    if (deleted.outcome === "rate_limited") {
      this.retainHubMessage(chatId, messageId, generation, {
        retryDelayMs: deleted.retryAfterMs
      });
      return;
    }

    this.retainHubMessage(chatId, messageId, generation, {
      retryDelayMs: FAILED_HUB_DELETE_RETRY_MS,
      failureCount: 1
    });
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
    this.runtimePreferenceDrafts.delete(token);
    const delivered = await this.replaceBridgeOwnedHtmlMessage(
      chatId,
      messageId,
      buildRuntimePreferencesAppliedMessage(saved.fields)
    );
    await this.deps.safeAnswerCallbackQuery(
      callbackQueryId,
      delivered ? "已保存。" : "设置已保存，但消息暂时无法更新。"
    );
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
    const delivered = await this.replaceBridgeOwnedHtmlMessage(
      chatId,
      messageId,
      buildRuntimePreferencesClosedMessage(fields)
    );
    if (delivered) {
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
    activeSessionId: string | null,
    options?: {
      forcePreferred?: boolean;
    }
  ): boolean {
    let nextFocus = hubState.focusedSessionId;
    // Foreground actions may force the requested session into view, but ordinary
    // background progress should not steal focus from the session the operator is already watching.
    if (options?.forcePreferred && preferredSessionId && sessionIds.includes(preferredSessionId)) {
      nextFocus = preferredSessionId;
    } else if (!nextFocus || !sessionIds.includes(nextFocus)) {
      nextFocus = preferredSessionId && sessionIds.includes(preferredSessionId)
        ? preferredSessionId
        : activeSessionId && sessionIds.includes(activeSessionId)
          ? activeSessionId
          : (sessionIds[0] ?? null);
    }

    const orderedSessionIds = nextFocus
      ? [nextFocus, ...sessionIds.filter((sessionId) => sessionId !== nextFocus)]
      : [...sessionIds];
    const changed = nextFocus !== hubState.focusedSessionId
      || orderedSessionIds.join("\u0000") !== hubState.sessionIds.join("\u0000");
    hubState.focusedSessionId = nextFocus;
    hubState.sessionIds = orderedSessionIds;
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
    const adoptedGeneration = Math.max(1, hubState.requestedGeneration, hubState.committedGeneration);
    hubState.requestedGeneration = adoptedGeneration;
    hubState.committedGeneration = adoptedGeneration;
    hubState.pendingGeneration = null;
    this.commitRuntimeHubVisibleState(hubState, {
      callbackVersion: hubState.callbackVersion,
      focusedSessionId: hubState.focusedSessionId,
      sessionIds: hubState.sessionIds,
      planExpanded: activeTurn.statusCard.planExpanded,
      agentsExpanded: activeTurn.statusCard.agentsExpanded
    });
    hubState.lastRenderedText = activeTurn.statusCard.lastRenderedText;
    hubState.lastRenderedReplyMarkupKey = activeTurn.statusCard.lastRenderedReplyMarkupKey;
    hubState.lastRenderedAtMs = activeTurn.statusCard.lastRenderedAtMs;
    hubState.rateLimitUntilAtMs = activeTurn.statusCard.rateLimitUntilAtMs;
    hubState.pendingText = activeTurn.statusCard.pendingText;
    hubState.pendingReplyMarkup = activeTurn.statusCard.pendingReplyMarkup;
    hubState.pendingReason = activeTurn.statusCard.pendingReason;
    hubState.pendingVisibleState = this.cloneRuntimeHubVisibleState(hubState.visibleState);
  }

  private buildFocusedRuntimeHubSection(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    options?: {
      compact?: boolean;
    }
  ): {
    planEntries: string[];
    agentEntries: CollabAgentStateSnapshot[];
  } {
    const compact = options?.compact ?? false;
    if (!activeTurn) {
      return {
        planEntries: [],
        agentEntries: []
      };
    }

    const inspect = activeTurn.tracker.getInspectSnapshot();
    return {
      planEntries: inspect.planSnapshot,
      agentEntries: inspect.agentSnapshot
    };
  }

  private buildLiveHubRenderPayload(
    chatId: string,
    hubState: RuntimeHubState,
    totalWindows: number,
    turns: RuntimeSurfaceActiveTurn[]
  ): {
    text: string;
    replyMarkup: TelegramInlineKeyboardMarkup;
    visibleState: RuntimeHubVisibleState;
  } {
    const desiredVisibleState = this.getDesiredRuntimeHubVisibleState(hubState);
    const render = (
      visibleState: RuntimeHubVisibleState,
      options?: {
      compactFocused?: boolean;
      sessionProgressTextLimit?: number;
    }): {
      text: string;
      replyMarkup: TelegramInlineKeyboardMarkup;
      visibleState: RuntimeHubVisibleState;
    } => {
      const turnMap = new Map(turns.map((activeTurn) => [activeTurn.sessionId, activeTurn] as const));
      const activeSessionId = this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null;
      const sessions = visibleState.sessionIds
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
            progressText: selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null),
            isFocused: sessionId === visibleState.focusedSessionId,
            isActiveInputTarget: sessionId === activeSessionId
          };
        })
        .filter((session): session is NonNullable<typeof session> => Boolean(session));
      const activeInputSession = hubState.windowIndex === 0
        ? this.buildSeparateHubActiveInputSession(chatId, new Set(turnMap.keys()))
        : null;

      const focusedTurn = visibleState.focusedSessionId ? (turnMap.get(visibleState.focusedSessionId) ?? null) : null;
      const focused = this.buildFocusedRuntimeHubSection(focusedTurn, {
        compact: options?.compactFocused ?? false
      });
      const text = buildRuntimeHubMessage({
        language: this.deps.getUiLanguage(),
        windowIndex: hubState.windowIndex,
        totalWindows,
        totalSessions: turns.length,
        sessions,
        activeInputSession,
        sessionCollectionKind: "running",
        planEntries: focused.planEntries,
        planExpanded: !options?.compactFocused && visibleState.planExpanded,
        agentEntries: focused.agentEntries,
        agentsExpanded: !options?.compactFocused && visibleState.agentsExpanded,
        terminalSummaries: hubState.windowIndex === 0 ? this.getOrCreateHubChatState(chatId).terminalSummaries : [],
        isMainHub: hubState.windowIndex === 0,
        sessionProgressTextLimit: options?.sessionProgressTextLimit ?? RUNTIME_HUB_SESSION_PROGRESS_TEXT_LIMIT
      });

      return {
        text,
        replyMarkup: buildRuntimeHubReplyMarkup({
          token: hubState.token,
          callbackVersion: visibleState.callbackVersion,
          language: this.deps.getUiLanguage(),
          sessions,
          focusedSessionId: visibleState.focusedSessionId,
          planEntries: focused.planEntries,
          planExpanded: visibleState.planExpanded,
          agentEntries: focused.agentEntries,
          agentsExpanded: visibleState.agentsExpanded
        }),
        visibleState: this.cloneRuntimeHubVisibleState(visibleState)
      };
    };

    let rendered = render(desiredVisibleState);
    if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
      return rendered;
    }

    const compactedVisibleState = desiredVisibleState.planExpanded || desiredVisibleState.agentsExpanded
      ? {
        ...desiredVisibleState,
        planExpanded: false,
        agentsExpanded: false,
        callbackVersion: desiredVisibleState.callbackVersion + 1
      }
      : desiredVisibleState;

    if (compactedVisibleState !== desiredVisibleState) {
      rendered = render(compactedVisibleState, {
        sessionProgressTextLimit: RUNTIME_HUB_COMPACT_SESSION_PROGRESS_TEXT_LIMIT
      });
      if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
        return rendered;
      }
    }

    rendered = render(compactedVisibleState, {
      compactFocused: true,
      sessionProgressTextLimit: RUNTIME_HUB_COMPACT_SESSION_PROGRESS_TEXT_LIMIT
    });
    if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
      return rendered;
    }

    return render(compactedVisibleState, {
      compactFocused: true,
      sessionProgressTextLimit: 0
    });
  }

  private buildRecoveryHubRenderPayload(chatId: string, hubState: RuntimeHubState): {
    text: string;
    replyMarkup: TelegramInlineKeyboardMarkup;
    visibleState: RuntimeHubVisibleState;
  } {
    const visibleState = this.getDesiredRuntimeHubVisibleState(hubState);
    const store = this.deps.getStore();
    const sessions = visibleState.sessionIds
      .map((sessionId) => store?.getSessionById(sessionId) ?? null)
      .filter((session): session is SessionRow => Boolean(session))
      .map((session) => ({
        sessionId: session.sessionId,
        sessionName: session.displayName,
        projectName: session.projectAlias?.trim() || session.projectName,
        state: session.failureReason === "bridge_restart" ? "Recovered" : session.status,
        progressText: session.failureReason === "bridge_restart"
          ? (this.deps.getUiLanguage() === "en"
            ? "Last turn stopped because the bridge restarted"
            : "上次运行因桥重启而停止")
          : null,
        isFocused: session.sessionId === visibleState.focusedSessionId,
        isActiveInputTarget: session.sessionId === (store?.getActiveSession(chatId)?.sessionId ?? null)
      }));
    const activeInputSession = this.buildSeparateHubActiveInputSession(chatId, new Set(visibleState.sessionIds));

    const text = buildRuntimeHubMessage({
      language: this.deps.getUiLanguage(),
      windowIndex: 0,
      totalWindows: 1,
      totalSessions: sessions.length,
      sessions,
      activeInputSession,
      sessionCollectionKind: "generic",
      terminalSummaries: [],
      isMainHub: true
    });

    return {
      text,
      replyMarkup: buildRuntimeHubReplyMarkup({
        token: hubState.token,
        callbackVersion: visibleState.callbackVersion,
        language: this.deps.getUiLanguage(),
        sessions,
        focusedSessionId: visibleState.focusedSessionId,
        planEntries: [],
        planExpanded: false,
        agentEntries: [],
        agentsExpanded: false
      }),
      visibleState
    };
  }

  private buildSeparateHubActiveInputSession(
    chatId: string,
    renderedSessionIds: ReadonlySet<string>
  ): RuntimeHubSessionView | null {
    const store = this.deps.getStore();
    const activeSession = store?.getActiveSession(chatId) ?? null;
    if (!activeSession || renderedSessionIds.has(activeSession.sessionId)) {
      return null;
    }

    const context = this.deps.getRuntimeCardContext(activeSession.sessionId);
    return {
      sessionId: activeSession.sessionId,
      sessionName: context.sessionName ?? activeSession.displayName,
      projectName: context.projectName ?? (activeSession.projectAlias?.trim() || activeSession.projectName),
      state: this.formatStandaloneHubSessionState(activeSession),
      progressText: null,
      isFocused: false,
      isActiveInputTarget: true
    };
  }

  private formatStandaloneHubSessionState(session: SessionRow): string {
    const language = this.deps.getUiLanguage();
    switch (session.status) {
      case "idle":
        return language === "en" ? "Idle" : "空闲";
      case "running":
        return language === "en" ? "Running" : "执行中";
      case "interrupted":
        return language === "en" ? "Interrupted" : "已中断";
      case "failed":
        return language === "en" ? "Failed" : "失败";
      default:
        return session.status;
    }
  }

  private async deleteHubState(hubState: RuntimeHubState): Promise<void> {
    hubState.destroyed = true;
    this.clearHubTimer(hubState);
    const messageId = hubState.messageId;
    const generation = hubState.committedGeneration;
    hubState.messageId = 0;
    hubState.requestedGeneration = 0;
    hubState.committedGeneration = 0;
    hubState.pendingGeneration = null;
    hubState.lastRenderedText = "";
    hubState.lastRenderedReplyMarkupKey = null;
    hubState.lastRenderedAtMs = null;
    hubState.rateLimitUntilAtMs = null;
    hubState.pendingText = null;
    hubState.pendingReplyMarkup = null;
    hubState.pendingReason = null;
    hubState.pendingVisibleState = null;
    hubState.replacementMessageId = null;
    if (messageId > 0) {
      await this.deleteHubMessage(hubState.chatId, messageId, generation);
    }
  }

  async refreshLiveRuntimeHubs(
    chatId: string,
    reason: string,
    preferredSessionId?: string | null,
    excludedSessionId?: string | null,
    options?: {
      forcePreferredFocus?: boolean;
    }
  ): Promise<void> {
    await this.runHubChatOperation(chatId, async () => {
      await this.refreshLiveRuntimeHubsNow(chatId, reason, preferredSessionId, excludedSessionId, options);
    });
  }

  private async refreshLiveRuntimeHubsNow(
    chatId: string,
    reason: string,
    preferredSessionId?: string | null,
    excludedSessionId?: string | null,
    options?: {
      forcePreferredFocus?: boolean;
    }
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
      const hubState = chatState.liveHubs.get(windowIndex)
        ?? this.createRuntimeHubState(chatId, "live", windowIndex, {
          messageId: this.claimRetainedHubMessageId(chatId)
        });
      this.updateHubFocus(hubState, sessionIds, preferredSessionId ?? null, activeSessionId, {
        forcePreferred: options?.forcePreferredFocus ?? false
      });
      chatState.liveHubs.set(windowIndex, hubState);
      const singleSessionTurn = this.getSingleSessionHubActiveTurn(hubState);
      this.hydrateSingleSessionHubStateFromTurn(hubState, singleSessionTurn);
      const rendered = this.buildLiveHubRenderPayload(chatId, hubState, totalWindows, turns);
      if (singleSessionTurn) {
        await this.logRuntimeCardEvent(singleSessionTurn, singleSessionTurn.statusCard, "state_transition", {
          reason,
          renderedText: rendered.text,
          replyMarkup: rendered.replyMarkup
        });
      }
      await this.requestHubRender(hubState, rendered.text, rendered.replyMarkup, {
        force: reason !== "runtime_progress",
        reason,
        visibleState: rendered.visibleState
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

  async sendRecoveryHub(chatId: string, sessionIds: string[]): Promise<boolean> {
    return await this.runHubChatOperation(chatId, async () => {
      return await this.sendRecoveryHubNow(chatId, sessionIds);
    });
  }

  private async sendRecoveryHubNow(chatId: string, sessionIds: string[]): Promise<boolean> {
    if (sessionIds.length === 0) {
      return false;
    }

    const chatState = this.getOrCreateHubChatState(chatId);
    for (const liveHub of chatState.liveHubs.values()) {
      await this.deleteHubState(liveHub);
    }
    chatState.liveHubs.clear();

    const store = this.deps.getStore();
    const activeSessionId = store?.getActiveSession(chatId)?.sessionId ?? null;
    const hubState = chatState.recoveryHub ?? this.createRuntimeHubState(chatId, "recovery", 0, {
      messageId: this.claimRetainedHubMessageId(chatId)
    });
    this.updateHubFocus(hubState, sessionIds, activeSessionId, activeSessionId);
    chatState.recoveryHub = hubState;
    const rendered = this.buildRecoveryHubRenderPayload(chatId, hubState);
    await this.requestHubRender(hubState, rendered.text, rendered.replyMarkup, {
      force: true,
      reason: "bridge_restart_recovery",
      visibleState: rendered.visibleState
    });
    return hubState.messageId > 0;
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
    return hubState.visibleState.focusedSessionId === sessionId ? hubState : null;
  }

  async handleHubSelectCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    version: number,
    slot: number
  ): Promise<void> {
    await this.runHubChatOperation(chatId, async () => {
      await this.handleHubSelectCallbackNow(callbackQueryId, chatId, messageId, token, version, slot);
    });
  }

  private async handleHubSelectCallbackNow(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    token: string,
    version: number,
    slot: number
  ): Promise<void> {
    const hubState = this.getLiveHubState(chatId, messageId);
    if (!hubState || hubState.token !== token || hubState.visibleState.callbackVersion !== version) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const sessionId = hubState.visibleState.sessionIds[slot];
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
      await this.refreshLiveRuntimeHubsNow(hubState.chatId, "hub_session_selected", sessionId);
      return;
    }

    const rendered = this.buildRecoveryHubRenderPayload(hubState.chatId, hubState);
    await this.requestHubRender(hubState, rendered.text, rendered.replyMarkup, {
      force: true,
      reason: "recovery_hub_session_selected",
      visibleState: rendered.visibleState
    });
  }

  private scheduleHubRetry(hubState: RuntimeHubState, delayMs: number): void {
    if (hubState.destroyed) {
      return;
    }

    this.clearHubTimer(hubState);
    hubState.timer = setTimeout(() => {
      hubState.timer = null;
      void this.runHubChatOperation(hubState.chatId, async () => {
        await this.flushHubRender(hubState);
      });
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
      visibleState?: RuntimeHubVisibleState;
    }
  ): Promise<void> {
    if (hubState.destroyed) {
      return;
    }

    const generation = hubState.requestedGeneration + 1;
    hubState.requestedGeneration = generation;
    const pendingVisibleState = this.cloneRuntimeHubVisibleState(
      options.visibleState ?? this.getDesiredRuntimeHubVisibleState(hubState)
    );
    const replyMarkupKey = serializeReplyMarkup(replyMarkup);
    const pendingChanged = hubState.pendingText !== text
      || serializeReplyMarkup(hubState.pendingReplyMarkup) !== replyMarkupKey
      || !this.runtimeHubVisibleStateEquals(hubState.pendingVisibleState, pendingVisibleState);
    hubState.pendingText = text;
    hubState.pendingReplyMarkup = replyMarkup;
    hubState.pendingReason = options.reason;
    hubState.pendingVisibleState = pendingVisibleState;
    hubState.pendingGeneration = generation;
    this.syncSingleSessionHubState(hubState);

    const singleSessionTurn = this.getSingleSessionHubActiveTurn(hubState);
    if (singleSessionTurn) {
      await this.logRuntimeCardEvent(singleSessionTurn, singleSessionTurn.statusCard, "render_requested", {
        reason: options.reason,
        renderedText: text,
        replyMarkup,
        generation
      });
    }

    if (!pendingChanged && text === hubState.lastRenderedText && hubState.lastRenderedReplyMarkupKey === replyMarkupKey) {
      hubState.pendingText = null;
      hubState.pendingReplyMarkup = null;
      hubState.pendingReason = null;
      hubState.pendingVisibleState = null;
      hubState.pendingGeneration = null;
      hubState.replacementMessageId = null;
      hubState.committedGeneration = generation;
      this.commitRuntimeHubVisibleState(hubState, pendingVisibleState);
      this.syncSingleSessionHubState(hubState);
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
    if (hubState.destroyed) {
      return;
    }

    const generation = hubState.pendingGeneration;
    const text = hubState.pendingText;
    const replyMarkup = hubState.pendingReplyMarkup ?? undefined;
    const pendingVisibleState = hubState.pendingVisibleState;
    if (generation === null || !text || !replyMarkup || !pendingVisibleState) {
      return;
    }

    const replyMarkupKey = serializeReplyMarkup(replyMarkup);
    if (text === hubState.lastRenderedText && hubState.lastRenderedReplyMarkupKey === replyMarkupKey) {
      hubState.pendingText = null;
      hubState.pendingReplyMarkup = null;
      hubState.pendingReason = null;
      hubState.pendingVisibleState = null;
      hubState.pendingGeneration = null;
      hubState.replacementMessageId = null;
      hubState.committedGeneration = generation;
      this.commitRuntimeHubVisibleState(hubState, pendingVisibleState);
      this.syncSingleSessionHubState(hubState);
      return;
    }

    const reason = hubState.pendingReason;
    hubState.pendingText = null;
    hubState.pendingReplyMarkup = null;
    hubState.pendingReason = null;
    hubState.pendingVisibleState = null;
    hubState.pendingGeneration = null;

    if (hubState.messageId === 0 || hubState.replacementMessageId !== null) {
      const replacementMessageId = hubState.replacementMessageId;
      const sent = await this.deps.safeSendHtmlMessageResult(hubState.chatId, text, replyMarkup);
      if (hubState.destroyed) {
        if (sent) {
          await this.deleteHubMessage(hubState.chatId, sent.message_id, generation);
        }
        return;
      }

      if (generation !== hubState.requestedGeneration) {
        if (sent) {
          await this.deleteHubMessage(hubState.chatId, sent.message_id, generation);
        }
        return;
      }

      if (!sent) {
        hubState.pendingText = text;
        hubState.pendingReplyMarkup = replyMarkup;
        hubState.pendingReason = reason;
        hubState.pendingVisibleState = pendingVisibleState;
        hubState.pendingGeneration = generation;
        this.syncSingleSessionHubState(hubState);
        this.scheduleHubRetry(hubState, FAILED_EDIT_RETRY_MS);
        return;
      }

      hubState.messageId = sent.message_id;
      hubState.lastRenderedText = text;
      hubState.lastRenderedReplyMarkupKey = replyMarkupKey;
      hubState.lastRenderedAtMs = Date.now();
      hubState.rateLimitUntilAtMs = null;
      hubState.replacementMessageId = null;
      hubState.committedGeneration = generation;
      this.commitRuntimeHubVisibleState(hubState, pendingVisibleState);
      this.syncSingleSessionHubState(hubState);
      this.notifyRecoveryHubVisible(hubState);
      if (replacementMessageId && replacementMessageId !== sent.message_id) {
        await this.deleteHubMessage(hubState.chatId, replacementMessageId, generation);
      }
      return;
    }

    const previousMessageId = hubState.messageId;
    const result = await this.deps.safeEditHtmlMessageText(hubState.chatId, hubState.messageId, text, replyMarkup);
    if (hubState.destroyed) {
      await this.deleteHubMessage(hubState.chatId, previousMessageId, generation);
      return;
    }

    if (generation !== hubState.requestedGeneration) {
      return;
    }

    if (isTelegramEditCommitted(result)) {
      hubState.lastRenderedText = text;
      hubState.lastRenderedReplyMarkupKey = replyMarkupKey;
      hubState.lastRenderedAtMs = Date.now();
      hubState.rateLimitUntilAtMs = null;
      hubState.committedGeneration = generation;
      this.commitRuntimeHubVisibleState(hubState, pendingVisibleState);
      this.syncSingleSessionHubState(hubState);
      this.notifyRecoveryHubVisible(hubState);
      return;
    }

    hubState.pendingText = text;
    hubState.pendingReplyMarkup = replyMarkup;
    hubState.pendingReason = reason;
    hubState.pendingVisibleState = pendingVisibleState;
    hubState.pendingGeneration = generation;
    if (result.outcome === "rate_limited") {
      hubState.rateLimitUntilAtMs = Date.now() + result.retryAfterMs;
      this.syncSingleSessionHubState(hubState);
      this.scheduleHubRetry(hubState, result.retryAfterMs);
      return;
    }

    hubState.replacementMessageId = previousMessageId;
    this.syncSingleSessionHubState(hubState);
    await this.flushHubRender(hubState);
  }

  private clearHubTimer(hubState: RuntimeHubState): void {
    if (!hubState.timer) {
      return;
    }
    clearTimeout(hubState.timer);
    hubState.timer = null;
  }

  private syncSingleSessionHubState(hubState: RuntimeHubState): void {
    if (hubState.destroyed || hubState.kind !== "live" || hubState.sessionIds.length !== 1 || hubState.messageId === 0) {
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

  async completeTerminalRuntimeHandoff(chatId: string, sessionId: string): Promise<void> {
    await this.runHubChatOperation(chatId, async () => {
      await this.refreshLiveRuntimeHubsNow(chatId, "terminal_handoff_completed", null, sessionId);
    });
  }

  async handleStatusCardSectionToggle(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    expanded: boolean,
    section: "plan" | "agents"
  ): Promise<void> {
    await this.runHubChatOperation(chatId, async () => {
      await this.handleStatusCardSectionToggleNow(callbackQueryId, chatId, messageId, sessionId, expanded, section);
    });
  }

  private async handleStatusCardSectionToggleNow(
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
    const visibleExpanded = section === "plan"
      ? hubState.visibleState.planExpanded
      : hubState.visibleState.agentsExpanded;
    if (visibleExpanded === expanded) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个操作已处理。");
      return;
    }

    hubState[expandedField] = expanded;
    hubState.callbackVersion += 1;
    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.refreshLiveRuntimeHubsNow(hubState.chatId, `${section}_${expanded ? "expanded" : "collapsed"}`, sessionId);
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
      await this.refreshLiveRuntimeHubs(activeTurn.chatId, options.reason, activeTurn.sessionId, undefined, {
        forcePreferredFocus: previousStatus === null
      });
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

      const keepLastCompletedHubVisible = classified?.kind === "turn_completed"
        && classified.status === "completed"
        && this.deps.listActiveTurns().filter((candidate) => candidate.chatId === activeTurn.chatId).length === 1;
      if (keepLastCompletedHubVisible) {
        await this.refreshLiveRuntimeHubs(activeTurn.chatId, "turn_terminal_pending_delivery", activeTurn.sessionId, undefined, {
          forcePreferredFocus: true
        });
      } else {
        await this.refreshLiveRuntimeHubs(activeTurn.chatId, "turn_terminal", null, activeTurn.sessionId);
      }
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

      if (isTelegramEditCommitted(editResult)) {
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
      for (const retained of chatState.retainedMessages) {
        this.clearRetainedHubTimer(retained);
      }
    }
  }

  async reanchorRuntimeAfterBridgeReply(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    chatId: string,
    reason: string,
    preferredSessionId?: string | null
  ): Promise<void> {
    await this.runHubChatOperation(chatId, async () => {
      await this.reanchorRuntimeAfterBridgeReplyNow(activeTurn, chatId, reason, preferredSessionId);
    });
  }

  private async reanchorRuntimeAfterBridgeReplyNow(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    chatId: string,
    reason: string,
    preferredSessionId?: string | null
  ): Promise<void> {
    const chatState = this.runtimeHubStates.get(chatId);
    if (!chatState) {
      return;
    }

    const store = this.deps.getStore();
    const preferredSession = preferredSessionId
      ? store?.getSessionById(preferredSessionId) ?? null
      : null;
    const resolvedPreferredSessionId = preferredSession?.telegramChatId === chatId
      ? preferredSession.sessionId
      : null;

    const targetSessionId = activeTurn?.chatId === chatId
      ? activeTurn.sessionId
      : resolvedPreferredSessionId ?? (store?.getActiveSession(chatId)?.sessionId ?? null);

    const targetSession = targetSessionId ? store?.getSessionById(targetSessionId) ?? null : null;
    // Keep actionable interaction cards at the bottom of the chat; reanchoring the
    // hub ahead of them would push the pending reply controls away from the operator.
    if (
      (
        (activeTurn?.tracker.getStatus().turnStatus === "blocked"
          && targetSession
          && this.deps.buildPendingInteractionSummaries(targetSession).length > 0)
        || this.chatHasActionablePendingInteractions(chatId, targetSessionId)
      )
    ) {
      return;
    }

    if (chatState.liveHubs.size > 0) {
      await this.refreshLiveRuntimeHubsNow(chatId, reason, targetSessionId, undefined, {
        forcePreferredFocus: true
      });

      const targetHub = [...chatState.liveHubs.values()].find((hubState) =>
        targetSessionId ? hubState.sessionIds.includes(targetSessionId) : false
      ) ?? chatState.liveHubs.get(0) ?? [...chatState.liveHubs.values()][0];

      if (!targetHub) {
        return;
      }

      await this.reanchorRuntimeHubToLatestMessage(targetHub, reason);
      return;
    }

    const recoveryHub = chatState.recoveryHub;
    if (!recoveryHub) {
      return;
    }

    const visibleSessionIds = recoveryHub.sessionIds.filter((sessionId) => store?.getSessionById(sessionId));
    this.updateHubFocus(
      recoveryHub,
      visibleSessionIds,
      targetSessionId,
      store?.getActiveSession(chatId)?.sessionId ?? null,
      { forcePreferred: true }
    );
    await this.reanchorRuntimeHubToLatestMessage(recoveryHub, reason);
  }

  private async reanchorRuntimeHubToLatestMessage(hubState: RuntimeHubState, _reason: string): Promise<void> {
    if (hubState.destroyed) {
      return;
    }

    this.clearHubTimer(hubState);
    const generation = hubState.requestedGeneration + 1;
    hubState.requestedGeneration = generation;
    const previousMessageId = hubState.messageId;
    const rendered = hubState.kind === "live"
      ? this.buildLiveHubRenderPayload(
        hubState.chatId,
        hubState,
        this.getOrCreateHubChatState(hubState.chatId).liveHubs.size,
        this.getOrderedActiveTurns(hubState.chatId)
      )
      : this.buildRecoveryHubRenderPayload(hubState.chatId, hubState);
    const sent = await this.deps.safeSendHtmlMessageResult(hubState.chatId, rendered.text, rendered.replyMarkup);
    if (!sent) {
      return;
    }

    if (hubState.destroyed || generation !== hubState.requestedGeneration) {
      await this.deleteHubMessage(hubState.chatId, sent.message_id, generation);
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
    hubState.pendingVisibleState = null;
    hubState.pendingGeneration = null;
    hubState.replacementMessageId = null;
    hubState.committedGeneration = generation;
    this.commitRuntimeHubVisibleState(hubState, rendered.visibleState);
    this.syncSingleSessionHubState(hubState);
    this.notifyRecoveryHubVisible(hubState);
    if (previousMessageId > 0 && previousMessageId !== sent.message_id) {
      await this.deleteHubMessage(hubState.chatId, previousMessageId, generation);
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
    if (isTelegramEditCommitted(editResult)) {
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
    if (isTelegramEditCommitted(result)) {
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

  private async replaceBridgeOwnedHtmlMessage(
    chatId: string,
    messageId: number,
    html: string
  ): Promise<boolean> {
    if (messageId > 0) {
      const result = await this.deps.safeEditHtmlMessageText(chatId, messageId, html);
      if (isTelegramEditCommitted(result)) {
        return true;
      }
    }

    const sent = await this.deps.safeSendHtmlMessageResult(chatId, html);
    if (!sent) {
      return false;
    }

    if (messageId > 0 && sent.message_id !== messageId) {
      await this.deps.safeDeleteMessage(chatId, messageId);
    }

    return true;
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
    if (isTelegramEditCommitted(result)) {
      this.deps.getStore()?.setFinalAnswerMessageId(answerId, messageId);
      this.deps.getStore()?.setFinalAnswerDeliveryState(answerId, "visible");
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    if (result.outcome === "rate_limited") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Telegram 正在限流，请稍后再试。");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法更新这条消息，请稍后再试。");
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
