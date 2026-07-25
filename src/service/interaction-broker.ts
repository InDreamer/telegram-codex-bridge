import type { Logger } from "../logger.js";
import type { ActivityStatus, InspectSnapshot } from "../activity/types.js";
import type { JsonRpcRequestId, JsonRpcServerRequest } from "../codex/app-server.js";
import type { InteractionCardView } from "../core/interaction-model/interaction.js";
import type { PlatformSurfaceOperationResult } from "../core/interaction-model/surface.js";
import { createInteractionCardView } from "../core/workflow/interaction-workflow.js";
import {
  buildApprovalActions,
  getCurrentQuestion,
  hasDraftAnswer,
  parseQuestionnaireDraft,
  summarizeAnsweredInteractionForSurface,
  type QuestionnaireDraft
} from "../core/workflow/interaction-support.js";
import type { BridgeStateStore } from "../state/store.js";
import type { EgressMessageSendResult } from "../packs/contract.js";
import type { TelegramInlineKeyboardMarkup, TelegramMessage } from "../telegram/api.js";
import {
  buildInteractionApprovalCard,
  buildInteractionExpiredCard,
  buildInteractionQuestionCard,
  buildInteractionResolvedCard,
  type ParsedCallbackData
} from "../telegram/ui.js";
import type { PendingInteractionRow, PendingInteractionSummary, PendingInteractionState, SessionRow } from "../types.js";
import { SKIP_QUESTION_OPTION_VALUE, type NormalizedInteraction, type NormalizedQuestion, type NormalizedQuestionnaireInteraction } from "../interactions/normalize.js";
import { parseBooleanLike } from "../util/boolean.js";
import { asRecord, getStringArray } from "../util/untyped.js";
import { executeTelegramHtmlSurfaceOperation } from "../telegram/surface-adapter.js";
import { isTelegramEditCommitted, type EgressEditResult } from "./runtime-surface-state.js";
import { nowIso } from "../util/time.js";

export interface PendingInteractionTextMode {
  sessionId: string;
  interactionId: string;
  questionId: string;
}

export type PendingInteractionTerminalState = Extract<
  PendingInteractionRow["state"],
  "answered" | "canceled" | "expired" | "failed"
>;

export type InteractionResolutionSource =
  | "server_response_success"
  | "server_response_error"
  | "app_server_exit"
  | "interaction_delivery_failed"
  | "turn_expired"
  | "session_clear"
  | "bridge_restart_recovery";

export interface InteractionBrokerActiveTurn {
  chatId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  tracker: {
    getInspectSnapshot(): InspectSnapshot;
    getStatus(): ActivityStatus;
  };
  statusCard: {
    needsReanchorOnActive: boolean;
  };
}

export type BlockedTurnSteerAvailability =
  | { kind: "available"; activeTurn: InteractionBrokerActiveTurn }
  | { kind: "interaction_pending" }
  | { kind: "busy" };

interface InteractionBrokerAppServer {
  respondToServerRequest(id: JsonRpcRequestId, payload: unknown): Promise<void>;
  respondToServerRequestError(id: JsonRpcRequestId, code: number, message: string): Promise<void>;
}

const INTERACTION_HUB_HINT = "如需查看或刷新 Hub，可发送 /hub。";

interface InteractionBrokerDeps {
  getStore: () => BridgeStateStore | null;
  getAppServer: () => InteractionBrokerAppServer | null;
  logger: Logger;
  preferBridgeCommandButtons: boolean;
  safeSendMessage(chatId: string, text: string): Promise<boolean>;
  safeSendHtmlMessageResult(
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<EgressMessageSendResult | null>;
  safeEditHtmlMessageText(
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<EgressEditResult>;
  safeAnswerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  appendInteractionCreatedJournal(row: PendingInteractionRow): Promise<void>;
  appendInteractionResolvedJournal(
    row: PendingInteractionRow,
    resolution: {
      finalState: PendingInteractionTerminalState;
      responseJson?: string | null;
      errorReason?: string | null;
      resolutionSource: InteractionResolutionSource;
    }
  ): Promise<void>;
}

export class InteractionBroker {
  private readonly pendingInteractionTextModes = new Map<string, PendingInteractionTextMode>();

  constructor(private readonly deps: InteractionBrokerDeps) {}

  getPendingTextMode(_chatId: string, sessionId: string | null): PendingInteractionTextMode | null {
    if (!sessionId) {
      return null;
    }

    return this.pendingInteractionTextModes.get(sessionId) ?? null;
  }

  buildPendingInteractionSummaries(activeSession: SessionRow): PendingInteractionSummary[] {
    const store = this.deps.getStore();
    if (!store) {
      return [];
    }

    return store
      .listPendingInteractionsByChat(activeSession.chatId, ["pending", "awaiting_text"])
      .filter((interaction) => interaction.sessionId === activeSession.sessionId)
      .map((interaction) => ({
        interactionId: interaction.interactionId,
        requestMethod: interaction.requestMethod,
        interactionKind: interaction.interactionKind,
        state: interaction.state,
        awaitingText: interaction.state === "awaiting_text"
      }));
  }

  buildAnsweredInteractionSummaries(activeSession: SessionRow): string[] {
    const store = this.deps.getStore();
    if (!store) {
      return [];
    }

    return store
      .listPendingInteractionsByChat(activeSession.chatId, ["answered"])
      .filter((interaction) => interaction.sessionId === activeSession.sessionId)
      .slice(0, 5)
      .map((row) => {
        const interaction = parseStoredInteraction(row.promptJson);
        return interaction ? summarizeAnsweredInteractionForSurface(row.responseJson, interaction) : null;
      })
      .filter((value): value is string => Boolean(value));
  }

  getBlockedTurnSteerAvailability(
    chatId: string,
    session: SessionRow,
    activeTurn: InteractionBrokerActiveTurn | null
  ): BlockedTurnSteerAvailability {
    if (session.status !== "running") {
      return { kind: "busy" };
    }

    if (!activeTurn || activeTurn.sessionId !== session.sessionId) {
      return { kind: "busy" };
    }

    if (activeTurn.tracker.getStatus().turnStatus !== "blocked") {
      return { kind: "busy" };
    }

    if (this.listActionablePendingInteractionsForSession(chatId, session.sessionId).length > 0) {
      return { kind: "interaction_pending" };
    }

    return { kind: "available", activeTurn };
  }

  async sendPendingInteractionBlockNotice(chatId: string): Promise<void> {
    await this.deps.safeSendMessage(chatId, "当前正在等待你处理交互卡片，请先在卡片中回答或取消。");
  }

  async cancelPendingTextInteraction(chatId: string, interactionId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const row = store.getPendingInteraction(interactionId, chatId);
    if (!row) {
      this.clearPendingInteractionTextMode(interactionId);
      await this.deps.safeSendMessage(chatId, "This 交互已过期。");
      return;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction) {
      this.clearPendingInteractionTextMode(interactionId);
      await this.deps.safeSendMessage(chatId, "This 交互已过期。");
      return;
    }

    await this.cancelInteraction(chatId, row, interaction, "user_canceled_text_mode");
  }

  async handlePendingInteractionTextAnswer(
    chatId: string,
    mode: PendingInteractionTextMode,
    text: string
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const row = store.getPendingInteraction(mode.interactionId, chatId);
    if (!row) {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.deps.safeSendMessage(chatId, "This 交互已过期。");
      return;
    }

    if (row.sessionId !== mode.sessionId) {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.deps.safeSendMessage(chatId, "This 交互已过期。");
      return;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction || interaction.kind !== "questionnaire") {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.deps.safeSendMessage(chatId, "This 交互已过期。");
      return;
    }

    if (!isPendingInteractionActionable(row)) {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.renderStoredPendingInteraction(chatId, row, interaction);
      await this.deps.safeSendMessage(chatId, isPendingInteractionHandled(row) ? "Already handled." : "This 交互已过期。");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    if (!currentQuestion || currentQuestion.id !== mode.questionId) {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.deps.safeSendMessage(chatId, "This 交互已过期。");
      return;
    }

    const parsedAnswer = parseQuestionAnswerInput(currentQuestion, text, "text");
    if (!parsedAnswer.ok) {
      await this.deps.safeSendMessage(chatId, parsedAnswer.message);
      return;
    }

    draft.answers[currentQuestion.id] = parsedAnswer.value;
    draft.awaitingQuestionId = null;
    this.clearPendingInteractionTextMode(mode.interactionId);

    const nextQuestion = getCurrentQuestion(interaction, draft);
    if (nextQuestion) {
      store.markPendingInteractionPending(row.interactionId, JSON.stringify(draft));
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: "pending",
        responseJson: JSON.stringify(draft)
      }, interaction);
      return;
    }

    const payload = buildQuestionnaireSubmissionPayload(interaction, draft);
    const success = await this.submitPendingInteractionResponse(chatId, row, interaction, payload);
    if (!success) {
      await this.deps.safeSendMessage(chatId, "暂时无法处理This 交互，请稍后再试。");
    }
  }

  async handleInteractionDecisionCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    parsed: Extract<ParsedCallbackData, { kind: "interaction_decision" }>
  ): Promise<void> {
    const loaded = await this.loadPendingInteractionForCallback(chatId, messageId, parsed.interactionId, callbackQueryId);
    if (!loaded) {
      return;
    }

    const { row, interaction } = loaded;
    if (await this.guardStaleInteraction(chatId, callbackQueryId, row, interaction)) {
      return;
    }

    const decisionKey = resolveInteractionDecisionKey(interaction, parsed);
    if (!decisionKey) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    const resolved = buildInteractionDecisionResolution(interaction, decisionKey);
    if (!resolved) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This 操作当前不支持。");
      return;
    }

    const success = await this.submitPendingInteractionResponse(chatId, row, interaction, resolved.payload);
    if (!success) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法处理This 交互，请稍后再试。");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
  }

  async handleInteractionQuestionCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    parsed: Extract<ParsedCallbackData, { kind: "interaction_question" }>
  ): Promise<void> {
    const store = this.deps.getStore();
    const loaded = await this.loadPendingInteractionForCallback(chatId, messageId, parsed.interactionId, callbackQueryId);
    if (!loaded || !store) {
      return;
    }

    const { row, interaction } = loaded;
    if (await this.guardStaleInteraction(chatId, callbackQueryId, row, interaction)) {
      return;
    }

    if (interaction.kind !== "questionnaire") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    const questionId = resolveInteractionQuestionId(interaction, parsed);
    if (!questionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    const selectedOption = currentQuestion?.options?.[parsed.optionIndex];
    if (!currentQuestion || currentQuestion.id !== questionId || !selectedOption) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    const parsedAnswer = parseQuestionAnswerInput(currentQuestion, selectedOption.value, "option");
    if (!parsedAnswer.ok) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, parsedAnswer.message);
      return;
    }

    draft.answers[currentQuestion.id] = parsedAnswer.value;
    draft.awaitingQuestionId = null;

    const nextQuestion = getCurrentQuestion(interaction, draft);
    if (nextQuestion) {
      store.markPendingInteractionPending(row.interactionId, JSON.stringify(draft));
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: "pending",
        responseJson: JSON.stringify(draft)
      }, interaction);
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    const payload = buildQuestionnaireSubmissionPayload(interaction, draft);
    const success = await this.submitPendingInteractionResponse(chatId, row, interaction, payload);
    if (!success) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法处理This 交互，请稍后再试。");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
  }

  async handleInteractionTextModeCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    parsed: Extract<ParsedCallbackData, { kind: "interaction_text" }>
  ): Promise<void> {
    const store = this.deps.getStore();
    const loaded = await this.loadPendingInteractionForCallback(chatId, messageId, parsed.interactionId, callbackQueryId);
    if (!loaded || !store) {
      return;
    }

    const { row, interaction } = loaded;
    if (await this.guardStaleInteraction(chatId, callbackQueryId, row, interaction)) {
      return;
    }

    if (interaction.kind !== "questionnaire") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    const questionId = resolveInteractionQuestionId(interaction, parsed);
    if (!questionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    if (!currentQuestion || currentQuestion.id !== questionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    if (!questionAllowsTextAnswer(currentQuestion)) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "This 问题只能用按钮回答。");
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== row.sessionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "请先切换到This 会话，再发送文字回答。");
      return;
    }

    draft.awaitingQuestionId = currentQuestion.id;
    store.markPendingInteractionAwaitingText(row.interactionId, JSON.stringify(draft));
    this.pendingInteractionTextModes.set(row.sessionId, {
      sessionId: row.sessionId,
      interactionId: row.interactionId,
      questionId: currentQuestion.id
    });
    await this.renderStoredPendingInteraction(chatId, {
      ...row,
      state: "awaiting_text",
      responseJson: JSON.stringify(draft)
    }, interaction);
    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
  }

  async handleInteractionCancelCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    interactionId: string
  ): Promise<void> {
    const loaded = await this.loadPendingInteractionForCallback(chatId, messageId, interactionId, callbackQueryId);
    if (!loaded) {
      return;
    }

    const { row, interaction } = loaded;
    if (await this.guardStaleInteraction(chatId, callbackQueryId, row, interaction)) {
      return;
    }

    const success = await this.cancelInteraction(chatId, row, interaction, "user_canceled_interaction");
    await this.deps.safeAnswerCallbackQuery(callbackQueryId, success ? undefined : "暂时无法处理This 交互，请稍后再试。");
  }

  async handleInteractionAnswerToggleCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    interactionId: string,
    expanded: boolean
  ): Promise<void> {
    const loaded = await this.loadPendingInteractionForCallback(chatId, messageId, interactionId, callbackQueryId);
    if (!loaded) {
      return;
    }

    const { row, interaction } = loaded;
    if (row.state !== "answered") {
      await this.renderStoredPendingInteraction(chatId, row, interaction);
      await this.deps.safeAnswerCallbackQuery(
        callbackQueryId,
        isPendingInteractionHandled(row) ? "Already handled." : "Button expired, try again."
      );
      return;
    }

    const rendered = buildPendingInteractionSurface(row, interaction, {
      answeredExpanded: expanded,
      preferBridgeCommandButtons: this.deps.preferBridgeCommandButtons
    });
    const result = await this.deps.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
    if (isTelegramEditCommitted(result)) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    if (result.outcome === "rate_limited") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Rate limited, try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Can't update now, try again.");
  }

  async handleNormalizedServerRequest(
    request: JsonRpcServerRequest,
    normalized: NormalizedInteraction,
    activeTurn: InteractionBrokerActiveTurn | null
  ): Promise<void> {
    const store = this.deps.getStore();
    const appServer = this.deps.getAppServer();
    if (!store || !appServer) {
      return;
    }

    if (!activeTurn) {
      await this.deps.logger.warn("server request received without active turn", {
        method: request.method,
        id: request.id
      });
      await appServer.respondToServerRequestError(request.id, -32000, "No active turn available for interaction");
      return;
    }

    const effectiveTurnId = normalized.turnId || activeTurn.turnId;
    const requestOnRootTurn = normalized.threadId === activeTurn.threadId;
    const requestOnKnownSubagent = !requestOnRootTurn
      && activeTurn.tracker.getInspectSnapshot().agentSnapshot.some((agent) => agent.threadId === normalized.threadId);

    if ((requestOnRootTurn && effectiveTurnId !== activeTurn.turnId) || (!requestOnRootTurn && !requestOnKnownSubagent)) {
      await this.deps.logger.warn("server request does not match active turn", {
        method: request.method,
        id: request.id,
        requestThreadId: normalized.threadId,
        requestTurnId: effectiveTurnId,
        activeThreadId: activeTurn.threadId,
        activeTurnId: activeTurn.turnId,
        knownSubagentThreadIds: requestOnRootTurn
          ? []
          : activeTurn.tracker.getInspectSnapshot().agentSnapshot.map((agent) => agent.threadId)
      });
      await appServer.respondToServerRequestError(request.id, -32001, "Interaction does not match the active turn");
      return;
    }

    const pending = store.createPendingInteraction({
      chatId: activeTurn.chatId,
      sessionId: activeTurn.sessionId,
      threadId: normalized.threadId,
      turnId: effectiveTurnId,
      requestId: request.id,
      requestMethod: request.method,
      interactionKind: normalized.kind,
      promptJson: JSON.stringify({
        ...normalized,
        turnId: effectiveTurnId
      })
    });
    await this.deps.appendInteractionCreatedJournal(pending);

    const sent = await this.sendPendingInteractionCard(activeTurn.chatId, pending, normalized);
    if (sent.outcome !== "sent") {
      store.markPendingInteractionFailed(pending.interactionId, "interaction_delivery_failed");
      await this.deps.appendInteractionResolvedJournal(pending, {
        finalState: "failed",
        errorReason: "interaction_delivery_failed",
        resolutionSource: "interaction_delivery_failed"
      });
      await appServer.respondToServerRequestError(request.id, -32603, "Failed to deliver the interaction surface");
      return;
    }

    store.setPendingInteractionMessageId(pending.interactionId, sent.deliveryRef.messageId);
    activeTurn.statusCard.needsReanchorOnActive = true;
  }

  async handleServerRequestResolvedNotification(
    threadId: string | null,
    requestId: JsonRpcRequestId | null
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store || !threadId || requestId === null) {
      return;
    }

    const pendingRows = store.listPendingInteractionsByRequest(threadId, requestId);
    for (const row of pendingRows) {
      const interaction = parseStoredInteraction(row.promptJson);
      const responseJson = row.responseJson ?? JSON.stringify({ resolvedBy: "serverRequest/resolved" });
      store.markPendingInteractionAnswered(row.interactionId, responseJson);
      this.clearPendingInteractionTextMode(row.interactionId);
      await this.deps.appendInteractionResolvedJournal(row, {
        finalState: "answered",
        responseJson,
        resolutionSource: "server_response_success"
      });

      if (interaction) {
        await this.renderStoredPendingInteraction(
          row.chatId,
          { ...row, state: "answered", responseJson, resolvedAt: nowIso() },
          interaction
        );
      }
    }
  }

  async resolveActionablePendingInteractionsForSession(
    chatId: string,
    sessionId: string,
    options: {
      state: Extract<PendingInteractionState, "failed" | "expired">;
      reason: string;
      resolutionSource: InteractionResolutionSource;
    }
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const pending = this.listActionablePendingInteractionsForSession(chatId, sessionId);
    if (pending.length === 0) {
      return;
    }

    for (const interactionRow of pending) {
      const updatedRow = await this.updatePendingInteractionTerminalState(
        interactionRow,
        options.state,
        options.reason
      );
      this.clearPendingInteractionTextMode(interactionRow.interactionId);
      await this.deps.appendInteractionResolvedJournal(interactionRow, {
        finalState: options.state,
        errorReason: options.reason,
        resolutionSource: options.resolutionSource
      });
      const interaction = parseStoredInteraction((updatedRow ?? interactionRow).promptJson);
      if (!interaction) {
        continue;
      }

      await this.renderStoredPendingInteraction(chatId, updatedRow ?? {
        ...interactionRow,
        state: options.state,
        errorReason: options.reason
      }, interaction);
    }
  }

  private async updatePendingInteractionTerminalState(
    row: PendingInteractionRow,
    state: Extract<PendingInteractionState, "failed" | "expired">,
    reason: string
  ): Promise<PendingInteractionRow | null> {
    const store = this.deps.getStore();
    if (!store) {
      return null;
    }

    if (state === "failed") {
      store.markPendingInteractionFailed(row.interactionId, reason);
    } else {
      store.markPendingInteractionExpired(row.interactionId, reason);
    }

    return store.getPendingInteraction(row.interactionId, row.chatId);
  }

  private listActionablePendingInteractionsForSession(chatId: string, sessionId: string): PendingInteractionRow[] {
    const store = this.deps.getStore();
    if (!store) {
      return [];
    }

    return store
      .listPendingInteractionsByChat(chatId, ["pending", "awaiting_text"])
      .filter((interaction) => interaction.sessionId === sessionId && isPendingInteractionActionable(interaction));
  }

  private clearPendingInteractionTextMode(interactionId: string): void {
    for (const [sessionId, pending] of this.pendingInteractionTextModes.entries()) {
      if (pending.interactionId === interactionId) {
        this.pendingInteractionTextModes.delete(sessionId);
      }
    }
  }

  private async loadPendingInteractionForCallback(
    chatId: string,
    messageId: number,
    interactionId: string,
    callbackQueryId: string
  ): Promise<{ row: PendingInteractionRow; interaction: NormalizedInteraction } | null> {
    const store = this.deps.getStore();
    if (!store) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return null;
    }

    const row = store.getPendingInteraction(interactionId, chatId);
    if (!row) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return null;
    }

    if (row.messageId !== null && row.messageId !== messageId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return null;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return null;
    }

    return { row, interaction };
  }

  private async guardStaleInteraction(
    chatId: string,
    callbackQueryId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction
  ): Promise<boolean> {
    if (isPendingInteractionActionable(row)) {
      return false;
    }
    await this.renderStoredPendingInteraction(chatId, row, interaction);
    await this.deps.safeAnswerCallbackQuery(
      callbackQueryId,
      isPendingInteractionHandled(row) ? "Already handled." : "Button expired, try again."
    );
    return true;
  }

  private async renderStoredPendingInteraction(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction
  ): Promise<void> {
    if (row.messageId === null) {
      return;
    }

    const rendered = buildPendingInteractionSurface(row, interaction, {
      preferBridgeCommandButtons: this.deps.preferBridgeCommandButtons
    });
    const result = await executeTelegramHtmlSurfaceOperation({
      intent: "pending_interaction",
      chatId,
      html: rendered.text,
      replyMarkup: rendered.replyMarkup,
      existingMessageId: row.messageId,
      preferEdit: true,
      sendHtmlMessage: this.deps.safeSendHtmlMessageResult,
      editHtmlMessage: this.deps.safeEditHtmlMessageText
    });
    if (result.outcome === "sent" && result.deliveryRef.messageId !== null) {
      this.deps.getStore()?.setPendingInteractionMessageId(row.interactionId, result.deliveryRef.messageId);
    }
  }

  private async sendPendingInteractionCard(
    chatId: string,
    pending: PendingInteractionRow,
    interaction: NormalizedInteraction
  ): Promise<PlatformSurfaceOperationResult> {
    const rendered = buildPendingInteractionSurface(pending, interaction, {
      preferBridgeCommandButtons: this.deps.preferBridgeCommandButtons
    });
    return await executeTelegramHtmlSurfaceOperation({
      intent: "pending_interaction",
      chatId,
      html: rendered.text,
      replyMarkup: rendered.replyMarkup,
      sendHtmlMessage: this.deps.safeSendHtmlMessageResult
    });
  }

  private async cancelInteraction(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction,
    errorReason: string
  ): Promise<boolean> {
    if (interaction.kind === "approval") {
      const resolved = buildInteractionDecisionResolution(interaction, "cancel");
      return resolved
        ? await this.submitPendingInteractionResponse(chatId, row, interaction, resolved.payload, {
          state: "canceled",
          errorReason
        })
        : await this.failPendingInteraction(chatId, row, interaction, errorReason, {
          state: "canceled"
        });
    }

    if (interaction.kind === "elicitation" || (interaction.kind === "questionnaire" && interaction.submission === "mcp_elicitation_form")) {
      return await this.submitPendingInteractionResponse(chatId, row, interaction, { action: "cancel" }, {
        state: "canceled",
        errorReason
      });
    }

    return await this.failPendingInteraction(chatId, row, interaction, errorReason, {
      state: "canceled"
    });
  }

  private async submitPendingInteractionResponse(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction,
    payload: unknown,
    options?: {
      state?: Extract<PendingInteractionState, "answered" | "canceled">;
      errorReason?: string | null;
    }
  ): Promise<boolean> {
    const store = this.deps.getStore();
    const appServer = this.deps.getAppServer();
    if (!store || !appServer) {
      return false;
    }

    const terminalState = options?.state ?? "answered";
    const payloadJson = JSON.stringify(payload);
    try {
      await appServer.respondToServerRequest(row.requestId, payload);
      if (terminalState === "canceled") {
        store.markPendingInteractionCanceled(row.interactionId, payloadJson, options?.errorReason ?? null);
      } else {
        store.markPendingInteractionAnswered(row.interactionId, payloadJson);
      }
      this.clearPendingInteractionTextMode(row.interactionId);
      await this.deps.appendInteractionResolvedJournal(row, {
        finalState: terminalState,
        responseJson: payloadJson,
        errorReason: options?.errorReason ?? null,
        resolutionSource: "server_response_success"
      });
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: terminalState,
        responseJson: payloadJson,
        errorReason: options?.errorReason ?? null
      }, interaction);
      return true;
    } catch (error) {
      await this.deps.logger.warn("interaction response dispatch failed", {
        interactionId: row.interactionId,
        requestMethod: row.requestMethod,
        error: `${error}`
      });
      store.markPendingInteractionFailed(row.interactionId, "response_dispatch_failed");
      this.clearPendingInteractionTextMode(row.interactionId);
      await this.deps.appendInteractionResolvedJournal(row, {
        finalState: "failed",
        errorReason: "response_dispatch_failed",
        resolutionSource: "server_response_error"
      });
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: "failed",
        errorReason: "response_dispatch_failed"
      }, interaction);
      return false;
    }
  }

  private async failPendingInteraction(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction,
    reason: string,
    options?: {
      state?: Extract<PendingInteractionState, "failed" | "canceled">;
    }
  ): Promise<boolean> {
    const store = this.deps.getStore();
    const appServer = this.deps.getAppServer();
    if (!store || !appServer) {
      return false;
    }

    const terminalState = options?.state ?? "failed";
    try {
      await appServer.respondToServerRequestError(
        row.requestId,
        4001,
        reason
      );
      if (terminalState === "canceled") {
        store.markPendingInteractionCanceled(row.interactionId, null, reason);
      } else {
        store.markPendingInteractionFailed(row.interactionId, reason);
      }
      this.clearPendingInteractionTextMode(row.interactionId);
      await this.deps.appendInteractionResolvedJournal(row, {
        finalState: terminalState,
        errorReason: reason,
        resolutionSource: "server_response_error"
      });
      await this.renderStoredPendingInteraction(chatId, {
        ...row,
        state: terminalState,
        errorReason: reason
      }, interaction);
      return true;
    } catch (error) {
      await this.deps.logger.warn("interaction failure dispatch failed", {
        interactionId: row.interactionId,
        requestMethod: row.requestMethod,
        error: `${error}`
      });
      return false;
    }
  }
}

function buildPendingInteractionSurface(
  row: PendingInteractionRow,
  interaction: NormalizedInteraction,
  options?: {
    answeredExpanded?: boolean;
    preferBridgeCommandButtons?: boolean;
  }
): {
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
} {
  return renderInteractionCardView(createInteractionCardView(row, interaction, {
    ...(options?.answeredExpanded !== undefined ? { answeredExpanded: options.answeredExpanded } : {}),
    hubHint: INTERACTION_HUB_HINT,
    ...(options?.preferBridgeCommandButtons ? { bridgeActions: [{ command: "hub" as const }] } : {})
  }));
}

function renderInteractionCardView(view: InteractionCardView): {
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
} {
  switch (view.kind) {
    case "approval":
      return buildInteractionApprovalCard(view);
    case "question":
      return buildInteractionQuestionCard(view);
    case "resolved":
      return buildInteractionResolvedCard(view);
    case "expired":
      return buildInteractionExpiredCard(view);
  }
}

function isPendingInteractionActionable(row: PendingInteractionRow): boolean {
  return row.state === "pending" || row.state === "awaiting_text";
}

function isPendingInteractionHandled(row: PendingInteractionRow): boolean {
  return row.state === "answered" || row.state === "canceled";
}

function parseStoredInteraction(promptJson: string): NormalizedInteraction | null {
  try {
    return JSON.parse(promptJson) as NormalizedInteraction;
  } catch {
    return null;
  }
}

function questionAllowsTextAnswer(question: NormalizedQuestion): boolean {
  return question.isOther || !question.options || question.options.length === 0;
}

function buildQuestionnaireSubmissionPayload(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): unknown {
  if (interaction.submission === "mcp_elicitation_form") {
    return {
      action: "accept",
      content: buildMcpElicitationFormContent(interaction, draft)
    };
  }

  return {
    answers: buildToolQuestionnaireAnswers(interaction, draft)
  };
}

function buildToolQuestionnaireAnswers(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): Record<string, { answers: string[] }> {
  const answers: Record<string, { answers: string[] }> = {};
  for (const question of interaction.questions) {
    if (!hasDraftAnswer(draft, question.id)) {
      continue;
    }

    const value = toToolQuestionnaireAnswerArray(draft.answers[question.id]);
    if (!value) {
      continue;
    }

    answers[question.id] = { answers: value };
  }

  return answers;
}

function buildMcpElicitationFormContent(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const question of interaction.questions) {
    if (!hasDraftAnswer(draft, question.id)) {
      continue;
    }

    const value = toQuestionAnswerValue(question, draft.answers[question.id]);
    if (value === null || value === undefined) {
      continue;
    }

    content[question.id] = value;
  }

  return content;
}

type ParsedQuestionAnswer = { ok: true; value: unknown } | { ok: false; message: string };

function parseQuestionAnswerInput(
  question: NormalizedQuestion,
  rawInput: string,
  source: "option" | "text"
): ParsedQuestionAnswer {
  if (rawInput === SKIP_QUESTION_OPTION_VALUE) {
    if (question.required) {
      return { ok: false, message: "This 问题不能跳过。" };
    }
    return { ok: true, value: null };
  }

  switch (question.answerFormat) {
    case "number": {
      const trimmed = rawInput.trim();
      const value = Number(trimmed);
      if (!trimmed || !Number.isFinite(value)) {
        return { ok: false, message: "请输入有效数字。" };
      }
      return { ok: true, value };
    }
    case "integer": {
      const trimmed = rawInput.trim();
      if (!/^[-+]?\d+$/u.test(trimmed)) {
        return { ok: false, message: "请输入整数。" };
      }
      return { ok: true, value: Number(trimmed) };
    }
    case "boolean": {
      const parsed = parseBooleanLike(rawInput);
      if (parsed !== undefined) {
        return { ok: true, value: parsed };
      }
      const normalized = rawInput.trim().toLowerCase();
      if (normalized === "y" || normalized === "Yes") {
        return { ok: true, value: true };
      }
      if (normalized === "n" || normalized === "No") {
        return { ok: true, value: false };
      }
      return { ok: false, message: "请输入 true/false 或 是/否。" };
    }
    case "string_array": {
      const values = rawInput.split(/[,\uFF0C]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (values.length === 0) {
        return {
          ok: false,
          message: question.required ? "请至少输入一个值。" : "请先输入至少一个值，或点击跳过。"
        };
      }
      const invalid = question.allowedValues
        ? values.filter((entry) => !question.allowedValues?.includes(entry))
        : [];
      if (invalid.length > 0) {
        return { ok: false, message: buildAllowedValuesMessage(question.allowedValues) };
      }
      return { ok: true, value: values };
    }
    case "string":
    default: {
      if (source === "text" && rawInput.trim().length === 0) {
        return { ok: false, message: "回答不能为空。" };
      }
      if (question.allowedValues && !(source === "text" && question.isOther) && !question.allowedValues.includes(rawInput)) {
        return { ok: false, message: buildAllowedValuesMessage(question.allowedValues) };
      }
      return { ok: true, value: rawInput };
    }
  }
}

function buildAllowedValuesMessage(values: string[] | null): string {
  return values && values.length > 0 ? `可用值：${values.join(", ")}。` : "输入值不合法。";
}

function toToolQuestionnaireAnswerArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }

  const legacy = extractLegacyAnswerArray(value);
  return legacy && legacy.length > 0 ? legacy : null;
}

function toQuestionAnswerValue(question: NormalizedQuestion, value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  switch (question.answerFormat) {
    case "number":
    case "integer":
      if (typeof value === "number") {
        return value;
      }
      break;
    case "boolean":
      if (typeof value === "boolean") {
        return value;
      }
      break;
    case "string_array":
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        return value;
      }
      break;
    case "string":
    default:
      if (typeof value === "string") {
        return value;
      }
      break;
  }

  const legacyAnswers = extractLegacyAnswerArray(value);
  if (legacyAnswers) {
    if (question.answerFormat === "string_array") {
      return legacyAnswers;
    }

    const parsed = parseQuestionAnswerInput(question, legacyAnswers[0] ?? "", "text");
    return parsed.ok ? parsed.value : null;
  }

  if (typeof value === "string") {
    const parsed = parseQuestionAnswerInput(question, value, "text");
    return parsed.ok ? parsed.value : null;
  }

  return null;
}

function extractLegacyAnswerArray(value: unknown): string[] | null {
  const record = asRecord(value);
  if (!Array.isArray(record?.answers)) {
    return null;
  }

  return getStringArray(record, "answers");
}

function buildInteractionDecisionResolution(
  interaction: NormalizedInteraction,
  decisionKey: string
): { payload: unknown } | null {
  switch (interaction.kind) {
    case "approval": {
      const option = interaction.decisionOptions.find((candidate) => candidate.key === decisionKey);
      return option ? { payload: option.payload } : null;
    }
    case "permissions":
      if (decisionKey === "accept") {
        return { payload: { permissions: interaction.requestedPermissions, scope: "turn" } };
      }
      if (decisionKey === "acceptForSession") {
        return { payload: { permissions: interaction.requestedPermissions, scope: "session" } };
      }
      if (decisionKey === "decline") {
        return { payload: { permissions: {}, scope: "turn" } };
      }
      return null;
    case "elicitation":
      if (decisionKey === "accept" || decisionKey === "decline") {
        return { payload: { action: decisionKey } };
      }
      return null;
    case "questionnaire":
      return null;
  }
}

function resolveInteractionDecisionKey(
  interaction: NormalizedInteraction,
  parsed: Extract<ParsedCallbackData, { kind: "interaction_decision" }>
): string | null {
  if (parsed.decisionKey) {
    return parsed.decisionKey;
  }

  if (parsed.decisionIndex === null) {
    return null;
  }

  return getVisibleInteractionDecisionKeys(interaction)[parsed.decisionIndex] ?? null;
}

function getVisibleInteractionDecisionKeys(interaction: NormalizedInteraction): string[] {
  switch (interaction.kind) {
    case "approval":
      return buildApprovalActions(interaction).map((action) => action.decisionKey);
    case "permissions":
      return ["accept", "acceptForSession", "decline"];
    case "elicitation":
      return ["accept", "decline"];
    case "questionnaire":
      return [];
  }
}

function resolveInteractionQuestionId(
  interaction: NormalizedInteraction,
  parsed: Extract<ParsedCallbackData, { kind: "interaction_question" | "interaction_text" }>
): string | null {
  if (parsed.questionId) {
    return parsed.questionId;
  }

  if (interaction.kind !== "questionnaire" || parsed.questionIndex === null) {
    return null;
  }

  return interaction.questions[parsed.questionIndex]?.id ?? null;
}
