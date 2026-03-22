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
import { normalizeAndTruncate, truncateText, summarizeTextPreview } from "../util/text.js";
import { summarizeActivityStatus, summarizeActivityStatusList } from "../activity/serialize.js";
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
const MAX_LIVE_RUNTIME_HUBS = 3;
const RUNTIME_HUB_SLOT_COUNT = 5;
const RUNTIME_HUB_TEXT_SOFT_LIMIT = 3200;
const RUNTIME_HUB_SESSION_PROGRESS_TEXT_LIMIT = 120;
const RUNTIME_HUB_COMPACT_SESSION_PROGRESS_TEXT_LIMIT = 80;
const RECOVERY_HUB_COMPACT_SESSION_NAME_LIMIT = 32;
const RECOVERY_HUB_TIGHT_SESSION_NAME_LIMIT = 24;
const HUB_AUTO_REFRESH_START_DELAY_MS = 1500;
const HUB_AUTO_REFRESH_RECOVERY_DELAY_MS = 1000;
const HUB_COMMAND_REMINDER_TEXT = "需要查看运行卡片时，可发送 /hub。";

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

type RuntimeHubTerminalState = "completed" | "failed" | "interrupted";

interface RuntimeHubSlotState {
  sessionId: string | null;
  terminalState: RuntimeHubTerminalState | null;
}

interface RuntimeHubVisibleState {
  callbackVersion: number;
  focusedSessionId: string | null;
  sessionIds: string[];
  slotSessionIds: Array<string | null>;
  planExpanded: boolean;
  agentsExpanded: boolean;
}

interface RuntimeHubState {
  token: string;
  chatId: string;
  kind: "live" | "recovery";
  destroyed: boolean;
  windowIndex: number;
  slots: RuntimeHubSlotState[];
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
  currentHubIndex: number | null;
  retainedMessages: RetainedHubMessage[];
  operationQueue: Promise<void>;
}

interface TurnHubAutoRefreshState {
  timer: ReturnType<typeof setTimeout> | null;
  pendingTrigger: "start" | "recovery" | null;
  startScheduled: boolean;
  recoveryScheduled: boolean;
  suppressNextStart: boolean;
  suppressNextRecovery: boolean;
  reminderShown: boolean;
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
  private readonly turnHubAutoRefreshStates = new Map<string, TurnHubAutoRefreshState>();
  private readonly learnedHubCommandChats = new Set<string>();

  constructor(private readonly deps: RuntimeSurfaceControllerDeps) {}

  hasRuntimeHub(chatId: string): boolean {
    const state = this.runtimeHubStates.get(chatId);
    return Boolean(state && (state.liveHubs.size > 0 || state.recoveryHub));
  }

  private getOrCreateHubChatState(chatId: string): RuntimeHubChatState {
    let state = this.runtimeHubStates.get(chatId);
    if (!state) {
      state = {
        liveHubs: new Map(),
        recoveryHub: null,
        currentHubIndex: null,
        retainedMessages: [],
        operationQueue: Promise.resolve()
      };
      this.runtimeHubStates.set(chatId, state);
    }

    return state;
  }

  private getOrCreateTurnHubAutoRefreshState(turnId: string): TurnHubAutoRefreshState {
    let state = this.turnHubAutoRefreshStates.get(turnId);
    if (!state) {
      state = {
        timer: null,
        pendingTrigger: null,
        startScheduled: false,
        recoveryScheduled: false,
        suppressNextStart: false,
        suppressNextRecovery: false,
        reminderShown: false
      };
      this.turnHubAutoRefreshStates.set(turnId, state);
    }

    return state;
  }

  private clearTurnHubAutoRefreshState(turnId: string): void {
    const state = this.turnHubAutoRefreshStates.get(turnId);
    if (!state) {
      return;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.turnHubAutoRefreshStates.delete(turnId);
  }

  private suppressTurnHubAutoRefresh(turnId: string, trigger: "start" | "recovery"): void {
    const state = this.getOrCreateTurnHubAutoRefreshState(turnId);
    if (state.timer && state.pendingTrigger === trigger) {
      clearTimeout(state.timer);
      state.timer = null;
      state.pendingTrigger = null;
    }

    if (trigger === "start") {
      state.suppressNextStart = true;
      return;
    }

    state.suppressNextRecovery = true;
  }

  private consumeHubCommandReminder(chatId: string, turnId: string): string | null {
    if (this.learnedHubCommandChats.has(chatId)) {
      return null;
    }

    const state = this.getOrCreateTurnHubAutoRefreshState(turnId);
    if (state.reminderShown) {
      return null;
    }

    state.reminderShown = true;
    return HUB_COMMAND_REMINDER_TEXT;
  }

  consumeHubCommandReminderForTurn(chatId: string, turnId: string | null | undefined): string | null {
    if (!turnId) {
      return null;
    }

    return this.consumeHubCommandReminder(chatId, turnId);
  }

  private markHubCommandLearned(chatId: string): void {
    this.learnedHubCommandChats.add(chatId);
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
    const slots = Array.from({ length: RUNTIME_HUB_SLOT_COUNT }, (): RuntimeHubSlotState => ({
      sessionId: null,
      terminalState: null
    }));
    const visibleState: RuntimeHubVisibleState = {
      callbackVersion: 0,
      focusedSessionId: null,
      sessionIds: [],
      slotSessionIds: slots.map((slot) => slot.sessionId),
      planExpanded: false,
      agentsExpanded: false
    };

    return {
      token: randomUUID().replace(/-/gu, "").slice(0, 8),
      chatId,
      kind,
      destroyed: false,
      windowIndex,
      slots,
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
      slotSessionIds: [...state.slotSessionIds],
      planExpanded: state.planExpanded,
      agentsExpanded: state.agentsExpanded
    };
  }

  private getDesiredRuntimeHubVisibleState(hubState: RuntimeHubState): RuntimeHubVisibleState {
    return {
      callbackVersion: hubState.callbackVersion,
      focusedSessionId: hubState.focusedSessionId,
      sessionIds: hubState.kind === "recovery"
        ? [...hubState.sessionIds]
        : this.getHubOccupiedSessionIds(hubState),
      slotSessionIds: hubState.slots.map((slot) => slot.sessionId),
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
      && left.sessionIds.join("\u0000") === right.sessionIds.join("\u0000")
      && left.slotSessionIds.join("\u0000") === right.slotSessionIds.join("\u0000");
  }

  private isTerminalTurnStatus(status: ActivityStatus["turnStatus"]): boolean {
    return status === "completed" || status === "failed" || status === "interrupted";
  }

  private getHubOccupiedSessionIds(hubState: RuntimeHubState): string[] {
    return hubState.slots
      .map((slot) => slot.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId));
  }

  private getHubOccupiedSlotCount(hubState: RuntimeHubState): number {
    return this.getHubOccupiedSessionIds(hubState).length;
  }

  private getHubEmptySlotIndex(hubState: RuntimeHubState): number {
    return hubState.slots.findIndex((slot) => !slot.sessionId);
  }

  private getLatestLiveHub(chatState: RuntimeHubChatState): RuntimeHubState | null {
    return this.getOrderedLiveHubs(chatState).at(-1) ?? null;
  }

  private getDisplayHubIndex(chatState: RuntimeHubChatState, hubState: RuntimeHubState): number {
    const ordered = this.getOrderedLiveHubs(chatState);
    const index = ordered.findIndex((candidate) => candidate.windowIndex === hubState.windowIndex);
    return index >= 0 ? index : hubState.windowIndex;
  }

  private getOrderedLiveHubs(chatState: RuntimeHubChatState): RuntimeHubState[] {
    return [...chatState.liveHubs.values()].sort((left, right) => left.windowIndex - right.windowIndex);
  }

  private findLiveHubSlot(
    chatState: RuntimeHubChatState,
    sessionId: string
  ): { hubState: RuntimeHubState; slotIndex: number } | null {
    for (const hubState of this.getOrderedLiveHubs(chatState)) {
      const slotIndex = hubState.slots.findIndex((slot) => slot.sessionId === sessionId);
      if (slotIndex >= 0) {
        return { hubState, slotIndex };
      }
    }

    return null;
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

  private getActiveTurnsForChat(chatId: string, excludedSessionId?: string | null): RuntimeSurfaceActiveTurn[] {
    return this.deps.listActiveTurns().filter((activeTurn) =>
      activeTurn.chatId === chatId && activeTurn.sessionId !== excludedSessionId
    );
  }

  private getRunningTurnsForChat(chatId: string, excludedSessionId?: string | null): RuntimeSurfaceActiveTurn[] {
    return this.getActiveTurnsForChat(chatId, excludedSessionId).filter((activeTurn) =>
      !this.isTerminalTurnStatus(activeTurn.tracker.getStatus().turnStatus)
    );
  }

  private getNextLiveHubIndex(chatState: RuntimeHubChatState): number {
    return (this.getOrderedLiveHubs(chatState).at(-1)?.windowIndex ?? -1) + 1;
  }

  private resolveCurrentLiveHubContext(chatState: RuntimeHubChatState): RuntimeHubState | null {
    if (chatState.currentHubIndex !== null) {
      const currentHub = chatState.liveHubs.get(chatState.currentHubIndex) ?? null;
      if (currentHub) {
        return currentHub;
      }
    }

    return this.getLatestLiveHub(chatState);
  }

  private repairCurrentLiveHubIndex(chatState: RuntimeHubChatState, chatId: string): void {
    const activeSessionId = this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null;
    const activeSessionHub = activeSessionId ? this.findLiveHubSlot(chatState, activeSessionId) : null;
    if (activeSessionHub) {
      chatState.currentHubIndex = activeSessionHub.hubState.windowIndex;
      return;
    }

    if (chatState.currentHubIndex !== null && chatState.liveHubs.has(chatState.currentHubIndex)) {
      return;
    }

    chatState.currentHubIndex = this.getLatestLiveHub(chatState)?.windowIndex ?? null;
  }

  private isLiveHubCompleted(hubState: RuntimeHubState, runningSessionIds: ReadonlySet<string>): boolean {
    return this.getHubOccupiedSlotCount(hubState) > 0
      && !hubState.slots.some((slot) => slot.sessionId && runningSessionIds.has(slot.sessionId));
  }

  private async evictOldestNonRunningHubIfNeeded(
    chatId: string,
    runningSessionIds: ReadonlySet<string>
  ): Promise<void> {
    await this.pruneOldestNonRunningHubs(chatId, runningSessionIds, MAX_LIVE_RUNTIME_HUBS - 1);
  }

  private async pruneOverflowNonRunningHubs(
    chatId: string,
    runningSessionIds: ReadonlySet<string>
  ): Promise<void> {
    await this.pruneOldestNonRunningHubs(chatId, runningSessionIds, MAX_LIVE_RUNTIME_HUBS);
  }

  private async pruneOldestNonRunningHubs(
    chatId: string,
    runningSessionIds: ReadonlySet<string>,
    maxLiveHubs: number
  ): Promise<void> {
    const chatState = this.getOrCreateHubChatState(chatId);
    while (chatState.liveHubs.size > maxLiveHubs) {
      const candidate = this.getOrderedLiveHubs(chatState).find((hubState) =>
        !hubState.slots.some((slot) => slot.sessionId && runningSessionIds.has(slot.sessionId))
      );
      if (!candidate) {
        break;
      }

      await this.deleteHubState(candidate);
      chatState.liveHubs.delete(candidate.windowIndex);
      if (chatState.currentHubIndex === candidate.windowIndex) {
        chatState.currentHubIndex = null;
      }
    }

    this.repairCurrentLiveHubIndex(chatState, chatId);
  }

  private async removeSessionFromLiveAndRecoveryHubs(
    chatId: string,
    sessionId: string,
    _reason: string
  ): Promise<{ liveRemoved: boolean; recoveryRemoved: boolean }> {
    const chatState = this.runtimeHubStates.get(chatId);
    if (!chatState) {
      return { liveRemoved: false, recoveryRemoved: false };
    }

    let liveRemoved = false;
    let recoveryRemoved = false;
    const liveBinding = this.findLiveHubSlot(chatState, sessionId);
    if (liveBinding) {
      liveBinding.hubState.slots[liveBinding.slotIndex] = {
        sessionId: null,
        terminalState: null
      };
      liveBinding.hubState.callbackVersion += 1;
      liveRemoved = true;
      if (this.getHubOccupiedSlotCount(liveBinding.hubState) === 0) {
        await this.deleteHubState(liveBinding.hubState);
        chatState.liveHubs.delete(liveBinding.hubState.windowIndex);
        if (chatState.currentHubIndex === liveBinding.hubState.windowIndex) {
          chatState.currentHubIndex = null;
        }
      }
    }

    const recoveryHub = chatState.recoveryHub;
    if (recoveryHub && recoveryHub.sessionIds.includes(sessionId)) {
      recoveryHub.sessionIds = recoveryHub.sessionIds.filter((candidate) => candidate !== sessionId);
      recoveryHub.callbackVersion += 1;
      recoveryRemoved = true;
      if (recoveryHub.sessionIds.length === 0) {
        await this.deleteHubState(recoveryHub);
        chatState.recoveryHub = null;
      }
    }

    this.repairCurrentLiveHubIndex(chatState, chatId);
    return { liveRemoved, recoveryRemoved };
  }

  private async ensureLiveHubSlotAssignments(chatId: string, runningTurns: RuntimeSurfaceActiveTurn[]): Promise<void> {
    const chatState = this.getOrCreateHubChatState(chatId);
    this.repairCurrentLiveHubIndex(chatState, chatId);

    const runningSessionIds = new Set(runningTurns.map((turn) => turn.sessionId));
    for (const activeTurn of runningTurns) {
      const existing = this.findLiveHubSlot(chatState, activeTurn.sessionId);
      if (existing) {
        existing.hubState.slots[existing.slotIndex]!.terminalState = null;
        continue;
      }

      let hubState = this.getLatestLiveHub(chatState);
      if (!hubState || this.getHubEmptySlotIndex(hubState) < 0) {
        await this.evictOldestNonRunningHubIfNeeded(chatId, runningSessionIds);
        hubState = this.getLatestLiveHub(chatState);
      }
      if (!hubState || this.getHubEmptySlotIndex(hubState) < 0) {
        hubState = this.createRuntimeHubState(chatId, "live", this.getNextLiveHubIndex(chatState), {
          messageId: this.claimRetainedHubMessageId(chatId)
        });
        chatState.liveHubs.set(hubState.windowIndex, hubState);
      }

      const emptySlotIndex = this.getHubEmptySlotIndex(hubState);
      if (emptySlotIndex < 0) {
        continue;
      }

      hubState.slots[emptySlotIndex] = {
        sessionId: activeTurn.sessionId,
        terminalState: null
      };
      hubState.callbackVersion += 1;
      chatState.currentHubIndex = hubState.windowIndex;
    }
  }

  private updateHubFocus(
    hubState: RuntimeHubState,
    preferredSessionId: string | null,
    activeSessionId: string | null,
    options?: {
      forcePreferred?: boolean;
    }
  ): boolean {
    const sessionIds = hubState.kind === "recovery"
      ? [...hubState.sessionIds]
      : this.getHubOccupiedSessionIds(hubState);
    let nextFocus = hubState.focusedSessionId;
    // Foreground actions may force the requested session into view, but ordinary
    // background progress should not steal focus from the session the operator is already watching.
    if (options?.forcePreferred && preferredSessionId && sessionIds.includes(preferredSessionId)) {
      nextFocus = preferredSessionId;
    } else if (activeSessionId && sessionIds.includes(activeSessionId)) {
      nextFocus = activeSessionId;
    } else if (!nextFocus || !sessionIds.includes(nextFocus)) {
      nextFocus = preferredSessionId && sessionIds.includes(preferredSessionId)
        ? preferredSessionId
        : (sessionIds[0] ?? null);
    }

    const changed = nextFocus !== hubState.focusedSessionId;
    hubState.focusedSessionId = nextFocus;
    if (changed) {
      hubState.callbackVersion += 1;
    }
    return changed;
  }

  private getSingleSessionHubActiveTurn(hubState: RuntimeHubState): RuntimeSurfaceActiveTurn | null {
    const sessionIds = this.getHubOccupiedSessionIds(hubState);
    if (hubState.kind !== "live" || sessionIds.length !== 1) {
      return null;
    }

    const sessionId = sessionIds[0];
    if (!sessionId) {
      return null;
    }

    return this.deps.listActiveTurns().find((candidate) => candidate.chatId === hubState.chatId && candidate.sessionId === sessionId) ?? null;
  }

  private hydrateSingleSessionHubStateFromTurn(
    hubState: RuntimeHubState,
    activeTurn: RuntimeSurfaceActiveTurn | null
  ): void {
    if (hubState.kind !== "live" || hubState.messageId !== 0 || this.getHubOccupiedSlotCount(hubState) !== 1 || !activeTurn) {
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
      sessionIds: this.getHubOccupiedSessionIds(hubState),
      slotSessionIds: hubState.slots.map((slot) => slot.sessionId),
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
    if (!activeTurn || this.isTerminalTurnStatus(activeTurn.tracker.getStatus().turnStatus)) {
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

  private formatLiveHubTerminalState(state: RuntimeHubTerminalState): string {
    const language = this.deps.getUiLanguage();
    switch (state) {
      case "completed":
        return language === "en" ? "Completed" : "已完成";
      case "failed":
        return language === "en" ? "Failed" : "失败";
      case "interrupted":
        return language === "en" ? "Interrupted" : "已中断";
    }
  }

  private buildLiveHubSessionView(
    slot: RuntimeHubSlotState,
    slotIndex: number,
    turnMap: ReadonlyMap<string, RuntimeSurfaceActiveTurn>,
    focusedSessionId: string | null
  ): RuntimeHubSessionView | null {
    const sessionId = slot.sessionId;
    if (!sessionId) {
      return null;
    }

    const context = this.deps.getRuntimeCardContext(sessionId);
    const activeTurn = turnMap.get(sessionId) ?? null;
    const inspect = activeTurn?.tracker.getInspectSnapshot() ?? null;
    const state = slot.terminalState
      ? this.formatLiveHubTerminalState(slot.terminalState)
      : inspect
        ? formatVisibleRuntimeState(inspect)
        : (this.deps.getStore()?.getSessionById(sessionId)?.status ?? "idle");

    return {
      sessionId,
      sessionName: context.sessionName ?? "session",
      projectName: context.projectName ?? null,
      state,
      progressText: slot.terminalState || !inspect
        ? null
        : selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null),
      slot: slotIndex + 1,
      isFocused: sessionId === focusedSessionId,
      isActiveInputTarget: false
    };
  }

  private buildLiveHubRenderPayload(
    chatId: string,
    hubState: RuntimeHubState,
    totalWindows: number,
    turns: RuntimeSurfaceActiveTurn[],
    reminderText?: string | null
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
      }
    ): {
      text: string;
      replyMarkup: TelegramInlineKeyboardMarkup;
      visibleState: RuntimeHubVisibleState;
    } => {
      const turnMap = new Map(turns.map((activeTurn) => [activeTurn.sessionId, activeTurn] as const));
      const runningSessionIds = new Set(
        turns
          .filter((activeTurn) => !this.isTerminalTurnStatus(activeTurn.tracker.getStatus().turnStatus))
          .map((activeTurn) => activeTurn.sessionId)
      );
      const activeSessionId = this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null;
      const currentViewedSlotIndex = activeSessionId
        ? hubState.slots.findIndex((slot) => slot.sessionId === activeSessionId)
        : -1;
      const currentViewedSession = currentViewedSlotIndex >= 0
        ? this.buildLiveHubSessionView(
          hubState.slots[currentViewedSlotIndex]!,
          currentViewedSlotIndex,
          turnMap,
          visibleState.focusedSessionId
        )
        : null;
      const otherRunningSessions = hubState.slots
        .map((slot, slotIndex) => {
          if (!slot.sessionId || slot.terminalState || !runningSessionIds.has(slot.sessionId)) {
            return null;
          }
          if (slot.sessionId === currentViewedSession?.sessionId) {
            return null;
          }
          return this.buildLiveHubSessionView(slot, slotIndex, turnMap, visibleState.focusedSessionId);
        })
        .filter((session): session is RuntimeHubSessionView => Boolean(session));
      const recentEndedSessions = hubState.slots
        .map((slot, slotIndex) => {
          if (!slot.sessionId) {
            return null;
          }

          const persistedStatus = this.deps.getStore()?.getSessionById(slot.sessionId)?.status ?? null;
          const endedWithoutTerminalSlotState = !runningSessionIds.has(slot.sessionId)
            && (persistedStatus === "failed" || persistedStatus === "interrupted");

          if (!slot.terminalState && !endedWithoutTerminalSlotState) {
            return null;
          }
          if (slot.sessionId === currentViewedSession?.sessionId) {
            return null;
          }
          return this.buildLiveHubSessionView(slot, slotIndex, turnMap, visibleState.focusedSessionId);
        })
        .filter((session): session is RuntimeHubSessionView => Boolean(session));

      const focusedTurn = visibleState.focusedSessionId ? (turnMap.get(visibleState.focusedSessionId) ?? null) : null;
      const focused = this.buildFocusedRuntimeHubSection(focusedTurn, {
        compact: options?.compactFocused ?? false
      });
      const text = buildRuntimeHubMessage({
        language: this.deps.getUiLanguage(),
        windowIndex: this.getDisplayHubIndex(this.getOrCreateHubChatState(chatId), hubState),
        totalWindows,
        currentViewedSession,
        otherSessions: otherRunningSessions,
        recentEndedSessions,
        planEntries: focused.planEntries,
        planExpanded: !options?.compactFocused && visibleState.planExpanded,
        agentEntries: focused.agentEntries,
        agentsExpanded: !options?.compactFocused && visibleState.agentsExpanded,
        completed: this.isLiveHubCompleted(hubState, runningSessionIds),
        sessionProgressTextLimit: options?.sessionProgressTextLimit ?? RUNTIME_HUB_SESSION_PROGRESS_TEXT_LIMIT,
        ...(reminderText !== undefined ? { reminderText } : {})
      });

      return {
        text,
        replyMarkup: buildRuntimeHubReplyMarkup({
          token: hubState.token,
          callbackVersion: visibleState.callbackVersion,
          language: this.deps.getUiLanguage(),
          slotSessionIds: visibleState.slotSessionIds,
          focusedSessionId: currentViewedSession?.sessionId ?? null,
          planEntries: focused.planEntries,
          planExpanded: !options?.compactFocused && visibleState.planExpanded,
          agentEntries: focused.agentEntries,
          agentsExpanded: !options?.compactFocused && visibleState.agentsExpanded
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

  private buildRecoveryHubRenderPayload(chatId: string, hubState: RuntimeHubState, reminderText?: string | null): {
    text: string;
    replyMarkup: TelegramInlineKeyboardMarkup;
    visibleState: RuntimeHubVisibleState;
  } {
    const visibleState = this.getDesiredRuntimeHubVisibleState(hubState);
    const store = this.deps.getStore();
    const allSessions = visibleState.sessionIds
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
    const render = (options?: {
      sessionProgressTextLimit?: number;
      compactSessions?: boolean;
      sessionNameLimit?: number;
      projectNameLimit?: number;
      visibleSessionLimit?: number;
    }): {
      text: string;
      replyMarkup: TelegramInlineKeyboardMarkup;
      visibleState: RuntimeHubVisibleState;
    } => {
      const sessions = allSessions.map((session) => ({
        ...session,
        sessionName: this.truncateRecoveryHubField(session.sessionName, options?.sessionNameLimit) ?? session.sessionName,
        projectName: this.truncateRecoveryHubField(session.projectName, options?.projectNameLimit),
        progressText: options?.sessionProgressTextLimit === 0 ? null : session.progressText
      }));
      const activeInputSession = this.buildSeparateHubActiveInputSession(chatId, new Set(visibleState.sessionIds), {
        ...(options?.sessionNameLimit !== undefined ? { sessionNameLimit: options.sessionNameLimit } : {}),
        ...(options?.projectNameLimit !== undefined ? { projectNameLimit: options.projectNameLimit } : {})
      });
      const text = buildRuntimeHubMessage({
        language: this.deps.getUiLanguage(),
        windowIndex: 0,
        totalWindows: 1,
        totalSessions: allSessions.length,
        sessions,
        activeInputSession,
        sessionCollectionKind: "generic",
        terminalSummaries: [],
        isMainHub: true,
        sessionProgressTextLimit: options?.sessionProgressTextLimit ?? RUNTIME_HUB_SESSION_PROGRESS_TEXT_LIMIT,
        genericSessionLayout: options?.compactSessions ? "compact" : "detailed",
        ...(options?.visibleSessionLimit !== undefined ? { genericVisibleSessionLimit: options.visibleSessionLimit } : {}),
        ...(reminderText !== undefined ? { reminderText } : {})
      });

      return {
        text,
        replyMarkup: buildRuntimeHubReplyMarkup({
          token: hubState.token,
          callbackVersion: visibleState.callbackVersion,
          language: this.deps.getUiLanguage(),
          sessions: allSessions,
          focusedSessionId: visibleState.focusedSessionId,
          planEntries: [],
          planExpanded: false,
          agentEntries: [],
          agentsExpanded: false
        }),
        visibleState
      };
    };

    let rendered = render();
    if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
      return rendered;
    }

    rendered = render({
      sessionProgressTextLimit: 0
    });
    if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
      return rendered;
    }

    rendered = render({
      sessionProgressTextLimit: 0,
      compactSessions: true
    });
    if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
      return rendered;
    }

    rendered = render({
      sessionProgressTextLimit: 0,
      compactSessions: true,
      sessionNameLimit: RECOVERY_HUB_COMPACT_SESSION_NAME_LIMIT,
      projectNameLimit: RECOVERY_HUB_COMPACT_SESSION_NAME_LIMIT
    });
    if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
      return rendered;
    }

    rendered = render({
      sessionProgressTextLimit: 0,
      compactSessions: true,
      sessionNameLimit: RECOVERY_HUB_TIGHT_SESSION_NAME_LIMIT,
      projectNameLimit: RECOVERY_HUB_TIGHT_SESSION_NAME_LIMIT
    });
    if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
      return rendered;
    }

    for (let visibleSessionLimit = Math.max(1, allSessions.length - 1); visibleSessionLimit >= 1; visibleSessionLimit -= 1) {
      rendered = render({
        sessionProgressTextLimit: 0,
        compactSessions: true,
        sessionNameLimit: RECOVERY_HUB_TIGHT_SESSION_NAME_LIMIT,
        projectNameLimit: RECOVERY_HUB_TIGHT_SESSION_NAME_LIMIT,
        visibleSessionLimit
      });
      if (rendered.text.length <= RUNTIME_HUB_TEXT_SOFT_LIMIT) {
        return rendered;
      }
    }

    return rendered;
  }

  private buildSeparateHubActiveInputSession(
    chatId: string,
    renderedSessionIds: ReadonlySet<string>,
    options?: {
      sessionNameLimit?: number;
      projectNameLimit?: number;
    }
  ): RuntimeHubSessionView | null {
    const store = this.deps.getStore();
    const activeSession = store?.getActiveSession(chatId) ?? null;
    if (!activeSession || renderedSessionIds.has(activeSession.sessionId)) {
      return null;
    }

    const context = this.deps.getRuntimeCardContext(activeSession.sessionId);
    return {
      sessionId: activeSession.sessionId,
      sessionName: this.truncateRecoveryHubField(
        context.sessionName ?? activeSession.displayName,
        options?.sessionNameLimit
      ) ?? activeSession.displayName,
      projectName: this.truncateRecoveryHubField(
        context.projectName ?? (activeSession.projectAlias?.trim() || activeSession.projectName),
        options?.projectNameLimit
      ),
      state: this.formatStandaloneHubSessionState(activeSession),
      progressText: null,
      isFocused: false,
      isActiveInputTarget: true
    };
  }

  private truncateRecoveryHubField(value: string | null | undefined, limit?: number): string | null {
    if (!value) {
      return null;
    }
    if (!limit || limit <= 0 || value.length <= limit) {
      return value;
    }
    return truncateText(value, limit);
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
    const turns = this.getActiveTurnsForChat(chatId, excludedSessionId);
    const runningTurns = turns.filter((activeTurn) => !this.isTerminalTurnStatus(activeTurn.tracker.getStatus().turnStatus));
    const runningSessionIds = new Set(runningTurns.map((activeTurn) => activeTurn.sessionId));
    await this.ensureLiveHubSlotAssignments(chatId, runningTurns);
    await this.pruneOverflowNonRunningHubs(chatId, runningSessionIds);

    for (const [windowIndex, hubState] of [...chatState.liveHubs.entries()]) {
      if (this.getHubOccupiedSlotCount(hubState) > 0) {
        continue;
      }
      await this.deleteHubState(hubState);
      chatState.liveHubs.delete(windowIndex);
      if (chatState.currentHubIndex === windowIndex) {
        chatState.currentHubIndex = null;
      }
    }

    if (chatState.liveHubs.size === 0) {
      return;
    }

    if (chatState.recoveryHub) {
      await this.deleteHubState(chatState.recoveryHub);
      chatState.recoveryHub = null;
    }

    const activeSessionId = this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null;
    this.repairCurrentLiveHubIndex(chatState, chatId);

    const orderedHubs = this.getOrderedLiveHubs(chatState);
    const totalWindows = orderedHubs.length;
    for (const hubState of orderedHubs) {
      this.updateHubFocus(hubState, preferredSessionId ?? null, activeSessionId, {
        forcePreferred: options?.forcePreferredFocus ?? false
      });
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
    hubState.sessionIds = [...sessionIds];
    this.updateHubFocus(hubState, activeSessionId, activeSessionId, { forcePreferred: true });
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

    const sessionId = hubState.kind === "live"
      ? hubState.visibleState.slotSessionIds[slot - 1] ?? null
      : hubState.visibleState.sessionIds[slot] ?? null;
    const store = this.deps.getStore();
    if (!store) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }
    if (hubState.kind === "live" && !sessionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    const session = sessionId ? store.getSessionById(sessionId) : null;
    if (!session || session.archived || session.telegramChatId !== hubState.chatId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    store.setActiveSession(hubState.chatId, session.sessionId);
    hubState.focusedSessionId = session.sessionId;
    if (hubState.kind === "live") {
      this.getOrCreateHubChatState(hubState.chatId).currentHubIndex = hubState.windowIndex;
    }
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

  private scheduleTurnHubAutoRefresh(
    activeTurn: RuntimeSurfaceActiveTurn,
    trigger: "start" | "recovery"
  ): void {
    const state = this.getOrCreateTurnHubAutoRefreshState(activeTurn.turnId);
    if (trigger === "start" ? state.suppressNextStart : state.suppressNextRecovery) {
      if (trigger === "start") {
        state.suppressNextStart = false;
        state.startScheduled = true;
      } else {
        state.suppressNextRecovery = false;
        state.recoveryScheduled = true;
      }
      return;
    }

    if ((trigger === "start" && state.startScheduled) || (trigger === "recovery" && state.recoveryScheduled)) {
      return;
    }

    if (trigger === "start") {
      state.startScheduled = true;
    } else {
      state.recoveryScheduled = true;
    }

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.pendingTrigger = trigger;

    const delayMs = trigger === "start" ? HUB_AUTO_REFRESH_START_DELAY_MS : HUB_AUTO_REFRESH_RECOVERY_DELAY_MS;
    state.timer = setTimeout(() => {
      state.timer = null;
      state.pendingTrigger = null;
      void this.runHubChatOperation(activeTurn.chatId, async () => {
        const currentTurn = this.deps.listActiveTurns().find((candidate) =>
          candidate.chatId === activeTurn.chatId
          && candidate.sessionId === activeTurn.sessionId
          && candidate.turnId === activeTurn.turnId
        );
        if (!currentTurn) {
          return;
        }

        const currentStatus = currentTurn.tracker.getStatus();
        if (currentStatus.turnStatus !== "running") {
          return;
        }

        if (this.chatHasActionablePendingInteractions(currentTurn.chatId)) {
          return;
        }

        await this.refreshLiveRuntimeHubsNow(
          currentTurn.chatId,
          trigger === "start" ? "turn_running_auto_refresh" : "turn_recovered_auto_refresh",
          currentTurn.sessionId,
          undefined,
          { forcePreferredFocus: true }
        );

        const chatState = this.runtimeHubStates.get(currentTurn.chatId);
        const targetHub = chatState
          ? (
            this.findLiveHubSlot(chatState, currentTurn.sessionId)?.hubState
            ?? this.resolveCurrentLiveHubContext(chatState)
          )
          : null;
        if (!targetHub) {
          return;
        }

        const reminderText = this.consumeHubCommandReminder(currentTurn.chatId, currentTurn.turnId);
        await this.reanchorRuntimeHubToLatestMessage(
          targetHub,
          trigger === "start" ? "turn_running_auto_refresh" : "turn_recovered_auto_refresh",
          reminderText
        );
        currentTurn.statusCard.needsReanchorOnActive = false;
      });
    }, delayMs);
    state.timer.unref?.();
  }

  private syncSingleSessionHubState(hubState: RuntimeHubState): void {
    const sessionIds = this.getHubOccupiedSessionIds(hubState);
    if (hubState.destroyed || hubState.kind !== "live" || sessionIds.length !== 1 || hubState.messageId === 0) {
      return;
    }

    const sessionId = sessionIds[0];
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

  async completeTerminalRuntimeHandoff(chatId: string, _sessionId: string): Promise<void> {
    await this.runHubChatOperation(chatId, async () => {
      await this.refreshLiveRuntimeHubsNow(chatId, "terminal_handoff_completed");
    });
  }

  async handleSessionArchived(chatId: string, sessionId: string, reason = "session_archived"): Promise<void> {
    await this.runHubChatOperation(chatId, async () => {
      const chatState = this.runtimeHubStates.get(chatId);
      if (!chatState) {
        return;
      }

      const removed = await this.removeSessionFromLiveAndRecoveryHubs(chatId, sessionId, reason);
      if (!removed.liveRemoved && !removed.recoveryRemoved) {
        return;
      }

      if (chatState.liveHubs.size > 0) {
        await this.refreshLiveRuntimeHubsNow(chatId, reason);
        return;
      }

      const recoveryHub = chatState.recoveryHub;
      if (!recoveryHub) {
        return;
      }

      const activeSessionId = this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null;
      this.updateHubFocus(recoveryHub, activeSessionId, activeSessionId, { forcePreferred: true });
      const rendered = this.buildRecoveryHubRenderPayload(chatId, recoveryHub);
      await this.requestHubRender(recoveryHub, rendered.text, rendered.replyMarkup, {
        force: true,
        reason,
        visibleState: rendered.visibleState
      });
    });
  }

  async handleSessionUnarchived(chatId: string, _sessionId: string, reason = "session_unarchived"): Promise<void> {
    await this.runHubChatOperation(chatId, async () => {
      const chatState = this.runtimeHubStates.get(chatId);
      if (!chatState || chatState.liveHubs.size > 0) {
        return;
      }

      const recoveryHub = chatState.recoveryHub;
      if (!recoveryHub) {
        return;
      }

      const activeSessionId = this.deps.getStore()?.getActiveSession(chatId)?.sessionId ?? null;
      this.updateHubFocus(recoveryHub, activeSessionId, activeSessionId, { forcePreferred: true });
      const rendered = this.buildRecoveryHubRenderPayload(chatId, recoveryHub);
      await this.requestHubRender(recoveryHub, rendered.text, rendered.replyMarkup, {
        force: true,
        reason,
        visibleState: rendered.visibleState
      });
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
    const shouldScheduleStartAutoRefresh = previousStatus === null && nextStatus.turnStatus === "running";
    const shouldScheduleRecoveryAutoRefresh = previousStatus?.turnStatus === "blocked"
      && nextStatus.turnStatus === "running";

    if (statusChanged) {
      await this.refreshLiveRuntimeHubs(activeTurn.chatId, options.reason, activeTurn.sessionId, undefined, {
        forcePreferredFocus: previousStatus === null
      });
    }

    if (nextStatus.turnStatus === "blocked" || this.isTerminalTurnStatus(nextStatus.turnStatus)) {
      const autoRefreshState = this.turnHubAutoRefreshStates.get(activeTurn.turnId);
      if (autoRefreshState?.timer) {
        clearTimeout(autoRefreshState.timer);
        autoRefreshState.timer = null;
        autoRefreshState.pendingTrigger = null;
      }
    }

    if (shouldScheduleStartAutoRefresh) {
      this.scheduleTurnHubAutoRefresh(activeTurn, "start");
    }

    if (shouldScheduleRecoveryAutoRefresh) {
      this.scheduleTurnHubAutoRefresh(activeTurn, "recovery");
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
      this.clearTurnHubAutoRefreshState(activeTurn.turnId);
      const chatState = this.getOrCreateHubChatState(activeTurn.chatId);
      const slotBinding = this.findLiveHubSlot(chatState, activeTurn.sessionId);
      if (slotBinding) {
        slotBinding.hubState.slots[slotBinding.slotIndex]!.terminalState = nextStatus.turnStatus;
        chatState.currentHubIndex = slotBinding.hubState.windowIndex;
      }

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
    this.clearTurnHubAutoRefreshState(activeTurn.turnId);
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
    for (const turnId of this.turnHubAutoRefreshStates.keys()) {
      this.clearTurnHubAutoRefreshState(turnId);
    }
  }

  async handleHub(chatId: string): Promise<{ kind: "refreshed" | "no_running" | "interaction_pending" }> {
    return await this.runHubChatOperation(chatId, async () => {
      if (this.chatHasActionablePendingInteractions(chatId)) {
        return { kind: "interaction_pending" };
      }

      const store = this.deps.getStore();
      const preferredSessionId = store?.getActiveSession(chatId)?.sessionId ?? null;
      const runningTurns = this.getRunningTurnsForChat(chatId);
      if (runningTurns.length === 0) {
        return { kind: "no_running" };
      }

      await this.refreshLiveRuntimeHubsNow(chatId, "manual_hub_command", preferredSessionId, undefined, {
        forcePreferredFocus: true
      });

      const chatState = this.runtimeHubStates.get(chatId);
      const targetHub = chatState
        ? (
          (preferredSessionId ? this.findLiveHubSlot(chatState, preferredSessionId)?.hubState : null)
          ?? this.resolveCurrentLiveHubContext(chatState)
        )
        : null;
      if (targetHub) {
        const refreshed = await this.reanchorRuntimeHubToLatestMessage(targetHub, "manual_hub_command");
        if (refreshed) {
          this.markHubCommandLearned(chatId);
        }
      }

      return { kind: "refreshed" };
    });
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
    const autoRefreshTrigger = reason === "accepted_user_work" || reason === "accepted_structured_work"
      ? "start"
      : reason === "accepted_turn_continue"
        ? "recovery"
        : null;

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

      const targetHub = (targetSessionId
        ? this.findLiveHubSlot(chatState, targetSessionId)?.hubState
        : null) ?? this.resolveCurrentLiveHubContext(chatState);

      if (!targetHub) {
        return;
      }

      const reanchored = await this.reanchorRuntimeHubToLatestMessage(targetHub, reason);
      if (reanchored && activeTurn && autoRefreshTrigger) {
        this.suppressTurnHubAutoRefresh(activeTurn.turnId, autoRefreshTrigger);
      }
      return;
    }

    const recoveryHub = chatState.recoveryHub;
    if (!recoveryHub) {
      return;
    }

    recoveryHub.sessionIds = recoveryHub.sessionIds.filter((sessionId) => store?.getSessionById(sessionId));
    this.updateHubFocus(
      recoveryHub,
      targetSessionId,
      store?.getActiveSession(chatId)?.sessionId ?? null,
      { forcePreferred: true }
    );
    const reanchored = await this.reanchorRuntimeHubToLatestMessage(recoveryHub, reason);
    if (reanchored && activeTurn && autoRefreshTrigger) {
      this.suppressTurnHubAutoRefresh(activeTurn.turnId, autoRefreshTrigger);
    }
  }

  private async reanchorRuntimeHubToLatestMessage(
    hubState: RuntimeHubState,
    _reason: string,
    reminderText?: string | null
  ): Promise<boolean> {
    if (hubState.destroyed) {
      return false;
    }

    this.clearHubTimer(hubState);
    const generation = hubState.requestedGeneration + 1;
    hubState.requestedGeneration = generation;
    const previousMessageId = hubState.messageId;
    const rendered = hubState.kind === "live"
      ? this.buildLiveHubRenderPayload(
        hubState.chatId,
        hubState,
        this.getOrderedLiveHubs(this.getOrCreateHubChatState(hubState.chatId)).length,
        this.getActiveTurnsForChat(hubState.chatId),
        reminderText
      )
      : this.buildRecoveryHubRenderPayload(hubState.chatId, hubState, reminderText);
    const sent = await this.deps.safeSendHtmlMessageResult(hubState.chatId, rendered.text, rendered.replyMarkup);
    if (!sent) {
      return false;
    }

    if (hubState.destroyed || generation !== hubState.requestedGeneration) {
      await this.deleteHubMessage(hubState.chatId, sent.message_id, generation);
      return false;
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
    return true;
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
