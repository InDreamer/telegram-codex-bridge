import { randomUUID } from "node:crypto";

import type { ActivityStatus, CollabAgentStateSnapshot, InspectSnapshot } from "../activity/types.js";
import type { Logger } from "../logger.js";
import type { BridgeStateStore } from "../state/store.js";
import type { TelegramInlineKeyboardMarkup, TelegramMessage } from "../telegram/api.js";
import {
  buildFinalAnswerReplyMarkup,
  buildInspectText,
  buildInspectViewMessage,
  buildPlanResultReplyMarkup,
  buildRuntimePreferencesAppliedMessage,
  buildRuntimePreferencesMessage,
  buildRuntimeErrorCard,
  buildRuntimeStatusCard,
  buildRuntimeStatusReplyMarkup,
  type RuntimeCommandEntryView
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

interface RuntimeSurfaceControllerDeps {
  logger: Logger;
  getStore: () => BridgeStateStore | null;
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

  constructor(private readonly deps: RuntimeSurfaceControllerDeps) {}

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
      planEntries: inspect.planSnapshot,
      planExpanded: statusCard.planExpanded,
      agentEntries: inspect.agentSnapshot,
      agentsExpanded: statusCard.agentsExpanded
    });

    return replyMarkup ? { text, replyMarkup } : { text };
  }

  async refreshActiveRuntimeStatusCard(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    chatId: string,
    reason: string
  ): Promise<void> {
    if (!activeTurn || activeTurn.chatId !== chatId) {
      return;
    }

    const rendered = this.buildStatusCardRenderPayload(
      activeTurn.sessionId,
      activeTurn.tracker,
      activeTurn.statusCard
    );
    await this.requestRuntimeCardRender(activeTurn, activeTurn.statusCard, rendered.text, rendered.replyMarkup, {
      force: true,
      reason
    });
  }

  async handleStatusCardSectionToggle(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    callbackQueryId: string,
    messageId: number,
    sessionId: string,
    expanded: boolean,
    section: "plan" | "agents"
  ): Promise<void> {
    if (!activeTurn || activeTurn.sessionId !== sessionId || activeTurn.statusCard.messageId !== messageId) {
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
    if (activeTurn.statusCard[expandedField] === expanded) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个操作已处理。");
      return;
    }

    activeTurn.statusCard[expandedField] = expanded;
    await this.deps.safeAnswerCallbackQuery(callbackQueryId);

    const expandedLabel = `${section === "plan" ? "plan" : "agents"}_${expanded ? "expanded" : "collapsed"}`;
    const triggerMethod = `v1:${section === "plan" ? "plan" : "agent"}:${expanded ? "expand" : "collapse"}`;
    const rendered = this.buildStatusCardRenderPayload(activeTurn.sessionId, activeTurn.tracker, activeTurn.statusCard);
    await this.logRuntimeCardEvent(activeTurn, activeTurn.statusCard, "state_transition", {
      reason: expandedLabel,
      forced: true,
      triggerKind: "callback",
      triggerMethod,
      commandStateChanged: false,
      statusProgressTextChanged: false,
      previousStatus: summarizeActivityStatus(inspect),
      nextStatus: summarizeActivityStatus(inspect),
      selectedProgressText: selectStatusProgressText(inspect, inspect.completedCommentary.at(-1) ?? null),
      commands: summarizeRuntimeCommands(activeTurn.statusCard.commandOrder),
      card: summarizeRuntimeCardSurface(activeTurn.statusCard),
      renderedText: rendered.text,
      replyMarkup: rendered.replyMarkup ?? null
    });
    await this.requestRuntimeCardRender(activeTurn, activeTurn.statusCard, rendered.text, rendered.replyMarkup, {
      force: true,
      reason: expandedLabel
    });
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
      const rendered = this.buildStatusCardRenderPayload(activeTurn.sessionId, activeTurn.tracker, activeTurn.statusCard);
      await this.logRuntimeCardEvent(activeTurn, activeTurn.statusCard, "state_transition", {
        reason: options.reason,
        forced: options.force ?? false,
        triggerKind: classified?.kind ?? null,
        triggerMethod: classified?.method ?? null,
        commandStateChanged,
        statusProgressTextChanged,
        previousStatus: previousStatus ? summarizeActivityStatus(previousStatus) : null,
        nextStatus: summarizeActivityStatus(nextStatus),
        selectedProgressText: nextStatusProgressText,
        commands: summarizeRuntimeCommands(activeTurn.statusCard.commandOrder),
        card: summarizeRuntimeCardSurface(activeTurn.statusCard),
        renderedText: rendered.text,
        replyMarkup: rendered.replyMarkup ?? null
      });
      await this.requestRuntimeCardRender(
        activeTurn,
        activeTurn.statusCard,
        rendered.text,
        rendered.replyMarkup,
        options.force
          ? { force: true, reason: options.reason }
          : { reason: options.reason }
      );
    }

    if (shouldReanchorOnRecovery) {
      activeTurn.statusCard.needsReanchorOnActive = false;
      await this.runRuntimeCardOperation(activeTurn, async () => {
        await this.reanchorStatusCardToLatestMessage(activeTurn, "recovered_active");
      });
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

  async reanchorRuntimeAfterBridgeReply(
    activeTurn: RuntimeSurfaceActiveTurn | null,
    chatId: string,
    reason: string
  ): Promise<void> {
    if (!activeTurn || activeTurn.chatId !== chatId) {
      return;
    }

    if (activeTurn.tracker.getStatus().turnStatus !== "running") {
      return;
    }

    await this.runRuntimeCardOperation(activeTurn, async () => {
      await this.reanchorStatusCardToLatestMessage(activeTurn, reason);
    });
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
        view.previewHtml,
        buildPlanResultReplyMarkup({
          answerId,
          sessionId: view.sessionId,
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
      buildPlanResultReplyMarkup({
        answerId,
        sessionId: view.sessionId,
        totalPages: view.pages.length,
        expanded: true,
        currentPage: page
      })
    );
    await this.finishPersistedFinalAnswerRender(callbackQueryId, answerId, messageId, result);
  }

  async handleInspect(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
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
