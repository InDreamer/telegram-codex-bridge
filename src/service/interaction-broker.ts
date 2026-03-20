import type { Logger } from "../logger.js";
import type { ActivityStatus, InspectSnapshot } from "../activity/types.js";
import type { JsonRpcRequestId, JsonRpcServerRequest } from "../codex/app-server.js";
import type { BridgeStateStore } from "../state/store.js";
import type { TelegramInlineKeyboardMarkup, TelegramMessage } from "../telegram/api.js";
import {
  buildInteractionApprovalCard,
  buildInteractionExpiredCard,
  buildInteractionQuestionCard,
  buildInteractionResolvedCard,
  type ParsedCallbackData
} from "../telegram/ui.js";
import type { PendingInteractionRow, PendingInteractionSummary, PendingInteractionState, SessionRow } from "../types.js";
import { SKIP_QUESTION_OPTION_VALUE, type NormalizedApprovalInteraction, type NormalizedInteraction, type NormalizedQuestion, type NormalizedQuestionnaireInteraction } from "../interactions/normalize.js";
import { parseBooleanLike } from "../util/boolean.js";
import { asRecord, getString, getStringArray } from "../util/untyped.js";
import { isTelegramEditCommitted, type TelegramEditResult } from "./runtime-surface-state.js";

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
  | "telegram_delivery_failed"
  | "turn_expired"
  | "bridge_restart_recovery";

interface QuestionnaireDraft {
  answers: Record<string, unknown>;
  awaitingQuestionId?: string | null;
}

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

interface InteractionBrokerDeps {
  getStore: () => BridgeStateStore | null;
  getAppServer: () => InteractionBrokerAppServer | null;
  logger: Logger;
  safeSendMessage(chatId: string, text: string): Promise<boolean>;
  safeSendHtmlMessageResult(
    chatId: string,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<TelegramMessage | null>;
  safeEditHtmlMessageText(
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ): Promise<TelegramEditResult>;
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
      .listPendingInteractionsByChat(activeSession.telegramChatId, ["pending", "awaiting_text"])
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
      .listPendingInteractionsByChat(activeSession.telegramChatId, ["answered"])
      .filter((interaction) => interaction.sessionId === activeSession.sessionId)
      .slice(0, 5)
      .map((row) => {
        const interaction = parseStoredInteraction(row.promptJson);
        return interaction ? summarizeAnsweredInteractionForInspect(row, interaction) : null;
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
      await this.deps.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction) {
      this.clearPendingInteractionTextMode(interactionId);
      await this.deps.safeSendMessage(chatId, "这个交互已过期。");
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
      await this.deps.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    if (row.sessionId !== mode.sessionId) {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.deps.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction || interaction.kind !== "questionnaire") {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.deps.safeSendMessage(chatId, "这个交互已过期。");
      return;
    }

    if (!isPendingInteractionActionable(row)) {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.renderStoredPendingInteraction(chatId, row, interaction);
      await this.deps.safeSendMessage(chatId, isPendingInteractionHandled(row) ? "这个操作已处理。" : "这个交互已过期。");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    if (!currentQuestion || currentQuestion.id !== mode.questionId) {
      this.clearPendingInteractionTextMode(mode.interactionId);
      await this.deps.safeSendMessage(chatId, "这个交互已过期。");
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
      await this.deps.safeSendMessage(chatId, "暂时无法处理这个交互，请稍后再试。");
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
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const resolved = buildInteractionDecisionResolution(interaction, decisionKey);
    if (!resolved) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个操作当前不支持。");
      return;
    }

    const success = await this.submitPendingInteractionResponse(chatId, row, interaction, resolved.payload);
    if (!success) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法处理这个交互，请稍后再试。");
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
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const questionId = resolveInteractionQuestionId(interaction, parsed);
    if (!questionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    const selectedOption = currentQuestion?.options?.[parsed.optionIndex];
    if (!currentQuestion || currentQuestion.id !== questionId || !selectedOption) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
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
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法处理这个交互，请稍后再试。");
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
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const questionId = resolveInteractionQuestionId(interaction, parsed);
    if (!questionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    const draft = parseQuestionnaireDraft(row.responseJson);
    const currentQuestion = getCurrentQuestion(interaction, draft);
    if (!currentQuestion || currentQuestion.id !== questionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return;
    }

    if (!questionAllowsTextAnswer(currentQuestion)) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个问题只能用按钮回答。");
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== row.sessionId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "请先切换到这个会话，再发送文字回答。");
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
    await this.deps.safeAnswerCallbackQuery(callbackQueryId, success ? undefined : "暂时无法处理这个交互，请稍后再试。");
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
        isPendingInteractionHandled(row) ? "这个操作已处理。" : "这个按钮已过期，请重新操作。"
      );
      return;
    }

    const rendered = buildPendingInteractionSurface(row, interaction, { answeredExpanded: expanded });
    const result = await this.deps.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
    if (isTelegramEditCommitted(result)) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId);
      return;
    }

    if (result.outcome === "rate_limited") {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Telegram 正在限流，请稍后再试。");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId, "暂时无法更新这条消息，请稍后再试。");
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
      telegramChatId: activeTurn.chatId,
      sessionId: activeTurn.sessionId,
      threadId: normalized.threadId,
      turnId: effectiveTurnId,
      requestId: serializeJsonRpcRequestId(request.id),
      requestMethod: request.method,
      interactionKind: normalized.kind,
      promptJson: JSON.stringify({
        ...normalized,
        turnId: effectiveTurnId
      })
    });
    await this.deps.appendInteractionCreatedJournal(pending);

    const sent = await this.sendPendingInteractionCard(activeTurn.chatId, pending, normalized);
    if (!sent) {
      store.markPendingInteractionFailed(pending.interactionId, "telegram_delivery_failed");
      await this.deps.appendInteractionResolvedJournal(pending, {
        finalState: "failed",
        errorReason: "telegram_delivery_failed",
        resolutionSource: "telegram_delivery_failed"
      });
      await appServer.respondToServerRequestError(request.id, -32603, "Failed to deliver Telegram interaction card");
      return;
    }

    store.setPendingInteractionMessageId(pending.interactionId, sent.message_id);
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

    const serializedRequestId = serializeJsonRpcRequestId(requestId);
    const pendingRows = store.listPendingInteractionsByRequest(threadId, serializedRequestId);
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
          row.telegramChatId,
          { ...row, state: "answered", responseJson, resolvedAt: new Date().toISOString() },
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

    return store.getPendingInteraction(row.interactionId, row.telegramChatId);
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
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return null;
    }

    const row = store.getPendingInteraction(interactionId, chatId);
    if (!row) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return null;
    }

    if (row.telegramMessageId !== null && row.telegramMessageId !== messageId) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
      return null;
    }

    const interaction = parseStoredInteraction(row.promptJson);
    if (!interaction) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "这个按钮已过期，请重新操作。");
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
      isPendingInteractionHandled(row) ? "这个操作已处理。" : "这个按钮已过期，请重新操作。"
    );
    return true;
  }

  private async renderStoredPendingInteraction(
    chatId: string,
    row: PendingInteractionRow,
    interaction: NormalizedInteraction
  ): Promise<void> {
    if (row.telegramMessageId === null) {
      return;
    }

    const rendered = buildPendingInteractionSurface(row, interaction);
    await this.deps.safeEditHtmlMessageText(chatId, row.telegramMessageId, rendered.text, rendered.replyMarkup);
  }

  private async sendPendingInteractionCard(
    chatId: string,
    pending: PendingInteractionRow,
    interaction: NormalizedInteraction
  ): Promise<TelegramMessage | null> {
    const rendered = buildPendingInteractionSurface(pending, interaction);
    return await this.deps.safeSendHtmlMessageResult(chatId, rendered.text, rendered.replyMarkup);
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
      await appServer.respondToServerRequest(deserializeJsonRpcRequestId(row.requestId), payload);
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
        deserializeJsonRpcRequestId(row.requestId),
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
  }
): {
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
} {
  if (row.state === "answered") {
    const details = buildAnsweredInteractionDetails(row, interaction);
    return buildInteractionResolvedCard({
      title: interaction.title,
      state: "answered",
      summary: summarizeAnsweredInteraction(row, interaction),
      details,
      expandable: details.length > 0,
      expanded: options?.answeredExpanded ?? false,
      interactionId: row.interactionId
    });
  }

  if (row.state === "canceled") {
    return buildInteractionResolvedCard({
      title: interaction.title,
      state: "canceled",
      summary: "已取消"
    });
  }

  if (row.state === "failed") {
    return buildInteractionResolvedCard({
      title: interaction.title,
      state: "failed",
      summary: formatPendingInteractionTerminalReason(row.errorReason)
    });
  }

  if (row.state === "expired") {
    return buildInteractionExpiredCard({
      title: interaction.title,
      reason: formatPendingInteractionTerminalReason(row.errorReason)
    });
  }

  switch (interaction.kind) {
    case "approval":
      return buildInteractionApprovalCard({
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: interaction.subtitle,
        body: interaction.body,
        detail: interaction.detail,
        actions: buildApprovalActions(interaction)
      });
    case "permissions":
      return buildInteractionApprovalCard({
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: interaction.subtitle,
        body: summarizePermissions(interaction.requestedPermissions),
        detail: interaction.detail,
        actions: [
          { text: "批准本次权限", decisionKey: "accept" },
          { text: "本会话内总是批准", decisionKey: "acceptForSession" },
          { text: "拒绝", decisionKey: "decline" }
        ]
      });
    case "elicitation":
      return buildInteractionApprovalCard({
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: `MCP: ${interaction.serverName}`,
        body: interaction.message,
        detail: interaction.detail,
        actions: [
          { text: "接受", decisionKey: "accept" },
          { text: "拒绝", decisionKey: "decline" }
        ]
      });
    case "questionnaire": {
      const draft = parseQuestionnaireDraft(row.responseJson);
      const currentQuestion = getCurrentQuestion(interaction, draft);
      if (!currentQuestion) {
        return buildInteractionResolvedCard({
          title: interaction.title,
          state: "answered",
          summary: summarizeAnsweredInteraction(row, interaction)
        });
      }

      return buildInteractionQuestionCard({
        interactionId: row.interactionId,
        title: interaction.title,
        questionId: currentQuestion.id,
        header: currentQuestion.header,
        question: currentQuestion.question,
        questionIndex: findQuestionIndex(interaction, currentQuestion.id) + 1,
        totalQuestions: interaction.questions.length,
        options: currentQuestion.options,
        isOther: currentQuestion.isOther,
        isSecret: currentQuestion.isSecret,
        awaitingText: row.state === "awaiting_text"
      });
    }
  }
}

function buildAnsweredInteractionDetails(
  row: PendingInteractionRow,
  interaction: NormalizedInteraction
): string[] {
  if (interaction.kind !== "questionnaire") {
    return [];
  }

  const details: string[] = [];
  const payload = parseJsonRecord(row.responseJson);
  const answers = parseJsonRecord(payload?.answers);
  if (!answers) {
    return [];
  }

  for (const [index, question] of interaction.questions.entries()) {
    const answerRecord = parseJsonRecord(answers[question.id]);
    const answerList = extractAnsweredInteractionValues(answerRecord);
    if (!answerList) {
      continue;
    }

    details.push(`${index + 1}. ${question.header}`);
    details.push(`问题：${question.question}`);
    details.push(`回答：${question.isSecret ? "已提交敏感回答，不显示内容" : answerList.join("，")}`);
  }

  return details;
}

function extractAnsweredInteractionValues(record: Record<string, unknown> | null): string[] | null {
  if (!record) {
    return null;
  }

  const answers = getStringArray(record, "answers");
  return answers.length > 0 ? answers : null;
}

function summarizeAnsweredInteractionForInspect(
  row: PendingInteractionRow,
  interaction: NormalizedInteraction
): string | null {
  if (interaction.kind !== "questionnaire") {
    return summarizeAnsweredInteraction(row, interaction);
  }

  const payload = parseJsonRecord(row.responseJson);
  const answers = parseJsonRecord(payload?.answers);
  if (!answers) {
    return summarizeAnsweredInteraction(row, interaction);
  }

  const segments = interaction.questions
    .map((question) => {
      const answerRecord = parseJsonRecord(answers[question.id]);
      const answerList = extractAnsweredInteractionValues(answerRecord);
      if (!answerList) {
        return null;
      }
      const answerText = question.isSecret ? "已提交敏感回答，不显示内容" : answerList.join("，");
      return `${question.header}: ${answerText}`;
    })
    .filter((value): value is string => Boolean(value));

  if (segments.length === 0) {
    return summarizeAnsweredInteraction(row, interaction);
  }

  return `${interaction.title} / ${segments.join(" / ")}`;
}

function buildApprovalActions(interaction: NormalizedApprovalInteraction): Array<{ text: string; decisionKey: string }> {
  return interaction.decisionOptions
    .filter((option) => option.kind !== "cancel")
    .map((option) => ({
      decisionKey: option.key,
      text: option.label
    }));
}

function summarizeAnsweredInteraction(row: PendingInteractionRow, interaction: NormalizedInteraction): string | null {
  const payload = parseJsonRecord(row.responseJson);
  switch (interaction.kind) {
    case "approval": {
      const decisionRecord = asRecord(payload?.decision);
      if (decisionRecord?.acceptWithExecpolicyAmendment) {
        return "已批准，并更新命令规则";
      }
      if (decisionRecord?.applyNetworkPolicyAmendment) {
        const networkDecision = asRecord(decisionRecord.applyNetworkPolicyAmendment);
        const amendment = asRecord(networkDecision?.network_policy_amendment);
        const host = typeof amendment?.host === "string" ? amendment.host : null;
        return host ? `已批准，并保存网络规则（${host}）` : "已批准，并保存网络规则";
      }

      const decision = typeof payload?.decision === "string" ? payload.decision : null;
      if (decision === "accept" || decision === "approved") {
        return "已批准";
      }
      if (decision === "acceptForSession" || decision === "approved_for_session") {
        return "已批准，并写入本会话缓存";
      }
      if (decision === "decline" || decision === "denied") {
        return "已拒绝";
      }
      if (decision === "cancel" || decision === "abort") {
        return "已取消";
      }
      return "已处理";
    }

    case "permissions": {
      const scope = typeof payload?.scope === "string" ? payload.scope : "turn";
      const granted = summarizeGrantedPermissions(payload?.permissions ?? null);
      return granted ? `已授权（${scope}）: ${granted}` : `已拒绝（${scope}）`;
    }

    case "questionnaire": {
      const action = typeof payload?.action === "string" ? payload.action : null;
      if (action === "cancel") {
        return "已取消";
      }
      if (action === "decline") {
        return "已拒绝";
      }
      if (action === "accept") {
        const content = parseJsonRecord(payload?.content);
        const count = content ? Object.keys(content).length : 0;
        return count > 0 ? `已提交 ${count} 个字段` : "已提交表单";
      }

      const answers = parseJsonRecord(payload?.answers);
      const count = answers ? Object.keys(answers).length : 0;
      return count > 0 ? `已提交 ${count} 个回答` : "已提交回答";
    }

    case "elicitation": {
      const action = typeof payload?.action === "string" ? payload.action : null;
      return action === "accept" ? "已接受" : action === "decline" ? "已拒绝" : action === "cancel" ? "已取消" : "已处理";
    }
  }
}

function summarizePermissions(value: unknown): string | null {
  const parts = collectPermissionSummaryParts(value);
  return parts.length > 0 ? parts.join("；") : "无额外权限";
}

function summarizeGrantedPermissions(value: unknown): string | null {
  const parts = collectPermissionSummaryParts(value);
  return parts.length > 0 ? parts.join("；") : null;
}

function collectPermissionSummaryParts(value: unknown): string[] {
  const record = parseJsonRecord(value);
  if (!record) {
    return [];
  }

  const parts: string[] = [];
  const fileSystem = parseJsonRecord(record.fileSystem);
  if (fileSystem) {
    const read = Array.isArray(fileSystem.read) ? fileSystem.read.length : 0;
    const write = Array.isArray(fileSystem.write) ? fileSystem.write.length : 0;
    if (read > 0 || write > 0) {
      parts.push(`文件系统 读${read}/写${write}`);
    }
  }

  const network = parseJsonRecord(record.network);
  if (network?.enabled === true) {
    parts.push("网络");
  }

  const macos = parseJsonRecord(record.macos);
  if (macos) {
    parts.push("macOS 权限");
  }

  return parts;
}

function formatPendingInteractionTerminalReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "app_server_lost":
      return "Codex 服务已断开，这个交互无法继续。";
    case "bridge_restart":
      return "桥接服务已重启，这个交互无法继续。";
    case "response_dispatch_failed":
      return "Codex 服务没有收到这次交互结果。";
    case "turn_completed":
    case "turn_failed":
    case "turn_interrupted":
      return "当前操作已结束，交互已失效。";
    case "telegram_delivery_failed":
      return "Telegram 未能发送这张交互卡片。";
    default:
      return reason ? "这个交互无法继续。" : null;
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

function parseQuestionnaireDraft(responseJson: string | null): QuestionnaireDraft {
  if (!responseJson) {
    return { answers: {} };
  }

  try {
    const parsed = asRecord(JSON.parse(responseJson));
    return {
      answers: asRecord(parsed?.answers) ?? {},
      awaitingQuestionId: getString(parsed, "awaitingQuestionId")
    };
  } catch {
    return { answers: {} };
  }
}

function getCurrentQuestion(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): NormalizedQuestion | null {
  if (draft.awaitingQuestionId) {
    return interaction.questions.find((question) => question.id === draft.awaitingQuestionId) ?? null;
  }

  return interaction.questions.find((question) => !hasDraftAnswer(draft, question.id)) ?? null;
}

function findQuestionIndex(interaction: NormalizedQuestionnaireInteraction, questionId: string): number {
  return Math.max(0, interaction.questions.findIndex((question) => question.id === questionId));
}

function hasDraftAnswer(draft: QuestionnaireDraft, questionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(draft.answers, questionId);
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
      return { ok: false, message: "这个问题不能跳过。" };
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
      if (normalized === "y" || normalized === "是") {
        return { ok: true, value: true };
      }
      if (normalized === "n" || normalized === "否") {
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
  return values && values.length > 0 ? `可用值：${values.join("、")}。` : "输入值不合法。";
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

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseJsonRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }

  return asRecord(value);
}

function serializeJsonRpcRequestId(id: JsonRpcRequestId): string {
  return JSON.stringify(id);
}

function deserializeJsonRpcRequestId(text: string): JsonRpcRequestId {
  try {
    const parsed = JSON.parse(text) as JsonRpcRequestId;
    if (typeof parsed === "number" || typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // fall through
  }

  return text;
}
