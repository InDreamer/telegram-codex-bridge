import type { Logger } from "../logger.js";
import { TurnDebugJournal, type DebugJournalWriter } from "../activity/debug-journal.js";
import { ActivityTracker, type SubagentIdentityEvent } from "../activity/tracker.js";
import type { ActivityStatus } from "../activity/types.js";
import { getDebugRuntimeDir, type BridgePaths } from "../paths.js";
import type { JsonRpcRequestId, JsonRpcServerRequest, UserInput, CodexAppServerClient } from "../codex/app-server.js";
import { classifyNotification } from "../codex/notification-classifier.js";
import { normalizeServerRequest } from "../interactions/normalize.js";
import {
  buildCollapsibleFinalAnswerView,
  buildFinalAnswerReplyMarkup,
  buildPlanResultActionRows,
  buildPlanResultReplyMarkup
} from "../telegram/ui-final-answer.js";
import type {
  BlockedTurnSteerAvailability,
  InteractionBrokerActiveTurn,
  PendingInteractionTerminalState,
  InteractionResolutionSource
} from "./interaction-broker.js";
import type { BridgeStateStore } from "../state/store.js";
import type { SessionRow, ReasoningEffort } from "../types.js";
import {
  createStatusCardMessageState,
  type ErrorCardState,
  type StatusCardState
} from "./runtime-surface-state.js";
import { extractTurnArtifactsFromHistory } from "./turn-artifacts.js";
import { asRecord, getString } from "../util/untyped.js";
import { normalizeAndTruncate } from "../util/text.js";

const MAX_RECENT_ACTIVITY_ENTRIES = 20;

interface ActiveTurnState extends InteractionBrokerActiveTurn {
  startedInPlanMode: boolean;
  finalMessage: string | null;
  effectiveModel: string | null;
  effectiveReasoningEffort: ReasoningEffort | null;
  effectiveReasoningEffortPinned: boolean;
  tracker: ActivityTracker;
  debugJournal: DebugJournalWriter;
  statusCard: StatusCardState;
  latestStatusProgressText: string | null;
  latestPlanFingerprint: string;
  latestAgentFingerprint: string;
  subagentIdentityBackfillStates: Map<string, "pending" | "resolved" | "exhausted">;
  errorCards: ErrorCardState[];
  nextErrorCardId: number;
  surfaceQueue: Promise<void>;
}

interface RecentActivityEntry {
  tracker: ActivityTracker;
  debugFilePath: string | null;
  statusCard: StatusCardState | null;
}

interface EffectiveTurnConfig {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  reasoningEffortPinned: boolean;
}

interface EnsuredThreadState {
  threadId: string;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

type ThreadArchiveNotification = Extract<
  ReturnType<typeof classifyNotification>,
  { kind: "thread_archived" | "thread_unarchived" }
>;

type GlobalRuntimeNotice = Extract<
  ReturnType<typeof classifyNotification>,
  { kind: "config_warning" | "deprecation_notice" | "model_rerouted" | "skills_changed" | "thread_compacted" }
>;

interface TurnCoordinatorDeps {
  paths: Pick<BridgePaths, "runtimeDir">;
  logger: Logger;
  getStore: () => BridgeStateStore | null;
  getAppServer: () => CodexAppServerClient | null;
  ensureAppServerAvailable: () => Promise<void>;
  fetchAllModels: () => Promise<NonNullable<Awaited<ReturnType<CodexAppServerClient["listModels"]>>["data"]>>;
  interactionBroker: {
    getBlockedTurnSteerAvailability: (
      chatId: string,
      session: SessionRow,
      activeTurn: InteractionBrokerActiveTurn | null
    ) => BlockedTurnSteerAvailability;
    handleNormalizedServerRequest: (
      request: JsonRpcServerRequest,
      normalized: NonNullable<ReturnType<typeof normalizeServerRequest>>,
      activeTurn: InteractionBrokerActiveTurn | null
    ) => Promise<void>;
    handleServerRequestResolvedNotification: (
      threadId: string | null,
      requestId: JsonRpcRequestId | null
    ) => Promise<void>;
    resolveActionablePendingInteractionsForSession: (
      chatId: string,
      sessionId: string,
      options: {
        state: Extract<PendingInteractionTerminalState, "failed" | "expired">;
        reason: string;
        resolutionSource: InteractionResolutionSource;
      }
    ) => Promise<void>;
  };
  syncRuntimeCards: (
    activeTurn: ActiveTurnState,
    classified: ReturnType<typeof classifyNotification> | null,
    previousStatus: ActivityStatus | null,
    nextStatus: ActivityStatus,
    options: {
      force?: boolean;
      reason: string;
    }
  ) => Promise<void>;
  runRuntimeCardOperation: (activeTurn: ActiveTurnState, operation: () => Promise<void>) => Promise<void>;
  reanchorStatusCardToLatestMessage: (activeTurn: ActiveTurnState, reason: string) => Promise<void>;
  disposeRuntimeCards: (activeTurn: ActiveTurnState) => void;
  safeSendMessage: (chatId: string, text: string) => Promise<boolean>;
  safeSendHtmlMessageResult: (
    chatId: string,
    html: string,
    replyMarkup?: {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }
  ) => Promise<{ message_id: number } | null>;
  handleGlobalRuntimeNotice: (notification: GlobalRuntimeNotice) => Promise<void>;
  handleThreadArchiveNotification: (classified: ThreadArchiveNotification) => Promise<void>;
}

export class TurnCoordinator {
  private readonly recentActivityBySessionId = new Map<string, RecentActivityEntry>();
  private readonly activeTurnsBySessionId = new Map<string, ActiveTurnState>();
  private readonly activeTurnSessionIdsByThreadId = new Map<string, string>();

  constructor(private readonly deps: TurnCoordinatorDeps) {}

  getActiveTurnBySessionId(sessionId: string): ActiveTurnState | null {
    return this.activeTurnsBySessionId.get(sessionId) ?? null;
  }

  getActiveTurnByThreadId(threadId: string): ActiveTurnState | null {
    const directSessionId = this.activeTurnSessionIdsByThreadId.get(threadId);
    if (directSessionId) {
      return this.getActiveTurnBySessionId(directSessionId);
    }

    for (const activeTurn of this.activeTurnsBySessionId.values()) {
      if (activeTurn.tracker.getInspectSnapshot().agentSnapshot.some((agent) => agent.threadId === threadId)) {
        return activeTurn;
      }
    }

    return null;
  }

  getActiveTurn(): ActiveTurnState | null {
    return this.activeTurnsBySessionId.values().next().value ?? null;
  }

  listActiveTurns(): ActiveTurnState[] {
    return [...this.activeTurnsBySessionId.values()];
  }

  getActiveInspectActivity(sessionId: string): { tracker: ActivityTracker; statusCard: StatusCardState } | null {
    const activeTurn = this.getActiveTurnBySessionId(sessionId);
    if (!activeTurn) {
      return null;
    }

    return {
      tracker: activeTurn.tracker,
      statusCard: activeTurn.statusCard
    };
  }

  getRecentActivity(sessionId: string): RecentActivityEntry | null {
    return this.recentActivityBySessionId.get(sessionId) ?? null;
  }

  setRecentActivity(sessionId: string, entry: RecentActivityEntry): void {
    this.recentActivityBySessionId.delete(sessionId);
    this.recentActivityBySessionId.set(sessionId, entry);

    while (this.recentActivityBySessionId.size > MAX_RECENT_ACTIVITY_ENTRIES) {
      const oldestSessionId = this.recentActivityBySessionId.keys().next().value;
      if (!oldestSessionId) {
        return;
      }

      this.recentActivityBySessionId.delete(oldestSessionId);
    }
  }

  clearRecentActivity(sessionId: string): void {
    this.recentActivityBySessionId.delete(sessionId);
  }

  getBlockedTurnSteerAvailability(chatId: string, session: SessionRow): BlockedTurnSteerAvailability {
    return this.deps.interactionBroker.getBlockedTurnSteerAvailability(
      chatId,
      session,
      this.getActiveTurnBySessionId(session.sessionId)
    );
  }

  async handleInterrupt(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      await this.deps.safeSendMessage(chatId, "当前没有正在执行的操作。");
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.status !== "running") {
      await this.deps.safeSendMessage(chatId, "当前没有正在执行的操作。");
      return;
    }

    const activeTurn = this.getActiveTurnBySessionId(activeSession.sessionId);
    if (!activeTurn) {
      await this.deps.safeSendMessage(chatId, "当前没有正在执行的操作。");
      return;
    }

    try {
      await this.deps.ensureAppServerAvailable();
      await this.deps.getAppServer()?.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      await this.deps.safeSendMessage(chatId, "已请求停止当前操作。");
    } catch {
      await this.deps.safeSendMessage(chatId, "当前无法中断正在运行的操作。");
    }
  }

  async interruptSession(chatId: string, sessionId: string): Promise<{ ok: boolean; message: string }> {
    const activeTurn = this.getActiveTurnBySessionId(sessionId);
    if (!activeTurn || activeTurn.chatId !== chatId) {
      return {
        ok: false,
        message: "这个按钮已过期，请重新操作。"
      };
    }

    try {
      await this.deps.ensureAppServerAvailable();
      await this.deps.getAppServer()?.interruptTurn(activeTurn.threadId, activeTurn.turnId);
      return {
        ok: true,
        message: "已请求停止这个会话的当前操作。"
      };
    } catch {
      return {
        ok: false,
        message: "当前无法中断这个会话的操作。"
      };
    }
  }

  async startTextTurn(
    chatId: string,
    session: SessionRow,
    text: string,
    options?: {
      sourceKind: "voice";
      transcript: string;
    }
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    try {
      await this.deps.ensureAppServerAvailable();
      const threadState = await this.ensureSessionThreadState(session);
      const threadId = threadState.threadId;
      const appServer = this.deps.getAppServer();
      const request = await this.buildTurnStartRequest(session, {
        threadId,
        cwd: session.projectPath,
        text
      });
      const turn = await appServer?.startTurn(request);

      if (!turn) {
        throw new Error("turn start returned no result");
      }
      if (session.needsDefaultCollaborationModeReset) {
        store.clearSessionDefaultCollaborationModeReset(session.sessionId);
      }
      if (options?.sourceKind === "voice") {
        store.saveTurnInputSource({
          threadId,
          turnId: turn.turn.id,
          sourceKind: "voice",
          transcript: options.transcript
        });
      }
      const effectiveConfig = this.resolveEffectiveTurnConfig(session, request, threadState);
      await this.beginActiveTurn(chatId, session, threadId, turn.turn.id, turn.turn.status, effectiveConfig);
    } catch (error) {
      await this.deps.logger.error("turn start failed", {
        sessionId: session.sessionId,
        error: `${error}`
      });
      store.updateSessionStatus(session.sessionId, "failed", {
        failureReason: "turn_failed",
        lastTurnId: session.lastTurnId,
        lastTurnStatus: "failed"
      });
      await this.deps.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
    }
  }

  async startStructuredTurn(chatId: string, session: SessionRow, input: UserInput[]): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    try {
      await this.deps.ensureAppServerAvailable();
      const threadState = await this.ensureSessionThreadState(session);
      const threadId = threadState.threadId;
      const appServer = this.deps.getAppServer();
      const request = await this.buildTurnStartRequest(session, {
        threadId,
        cwd: session.projectPath,
        input
      });
      const turn = await appServer?.startTurn(request);
      if (!turn) {
        throw new Error("turn start returned no result");
      }
      if (session.needsDefaultCollaborationModeReset) {
        store.clearSessionDefaultCollaborationModeReset(session.sessionId);
      }

      const effectiveConfig = this.resolveEffectiveTurnConfig(session, request, threadState);
      await this.beginActiveTurn(chatId, session, threadId, turn.turn.id, turn.turn.status, effectiveConfig);
    } catch (error) {
      await this.deps.logger.error("structured turn start failed", {
        sessionId: session.sessionId,
        error: `${error}`
      });
      store.updateSessionStatus(session.sessionId, "failed", {
        failureReason: "turn_failed",
        lastTurnId: session.lastTurnId,
        lastTurnStatus: "failed"
      });
      await this.deps.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
    }
  }

  async beginActiveTurn(
    chatId: string,
    session: SessionRow,
    threadId: string,
    turnId: string,
    turnStatus: string,
    effectiveConfig?: EffectiveTurnConfig
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const resolvedEffectiveConfig = effectiveConfig ?? {
      model: session.selectedModel ?? null,
      reasoningEffort: session.selectedReasoningEffort ?? null,
      reasoningEffortPinned: session.selectedReasoningEffort !== null
    };

    const activeTurn: ActiveTurnState = {
      sessionId: session.sessionId,
      chatId,
      threadId,
      turnId,
      startedInPlanMode: session.planMode,
      finalMessage: null,
      effectiveModel: resolvedEffectiveConfig.model,
      effectiveReasoningEffort: resolvedEffectiveConfig.reasoningEffort,
      effectiveReasoningEffortPinned: resolvedEffectiveConfig.reasoningEffortPinned,
      tracker: new ActivityTracker({
        threadId,
        turnId
      }),
      debugJournal: new TurnDebugJournal({
        debugRootDir: getDebugRuntimeDir(this.deps.paths.runtimeDir),
        threadId,
        turnId
      }),
      statusCard: createStatusCardMessageState(),
      latestStatusProgressText: null,
      latestPlanFingerprint: "",
      latestAgentFingerprint: "",
      subagentIdentityBackfillStates: new Map(),
      errorCards: [],
      nextErrorCardId: 1,
      surfaceQueue: Promise.resolve()
    };
    this.registerActiveTurn(activeTurn);

    this.setRecentActivity(session.sessionId, {
      tracker: activeTurn.tracker,
      debugFilePath: activeTurn.debugJournal.filePath,
      statusCard: activeTurn.statusCard
    });
    store.updateSessionStatus(session.sessionId, "running", {
      lastTurnId: turnId,
      lastTurnStatus: turnStatus
    });
    await this.deps.syncRuntimeCards(activeTurn, null, null, activeTurn.tracker.getStatus(), {
      force: true,
      reason: "turn_initialized"
    });
  }

  async ensureSessionThread(session: SessionRow): Promise<string> {
    const ensured = await this.ensureSessionThreadState(session);
    return ensured.threadId;
  }

  private async ensureSessionThreadState(session: SessionRow): Promise<EnsuredThreadState> {
    const store = this.deps.getStore();
    const appServer = this.deps.getAppServer();
    if (!store) {
      throw new Error("state store unavailable");
    }

    if (!appServer) {
      throw new Error("app-server unavailable");
    }

    if (!session.threadId) {
      const started = await appServer.startThread({
        cwd: session.projectPath,
        ...(session.selectedModel ? { model: session.selectedModel } : {})
      });
      store.updateSessionThreadId(session.sessionId, started.thread.id);
      return {
        threadId: started.thread.id,
        model: started.model ?? null,
        reasoningEffort: started.reasoningEffort ?? null
      };
    }

    try {
      const resumed = await appServer.resumeThread(session.threadId);
      return {
        threadId: session.threadId,
        model: resumed.model ?? null,
        reasoningEffort: resumed.reasoningEffort ?? resumed.thread.reasoningEffort ?? null
      };
    } catch (error) {
      if (!isMissingRemoteThreadError(error)) {
        throw error;
      }

      await this.deps.logger.warn("session thread missing remotely; recreating", {
        sessionId: session.sessionId,
        threadId: session.threadId
      });
      const started = await appServer.startThread({
        cwd: session.projectPath,
        ...(session.selectedModel ? { model: session.selectedModel } : {})
      });
      store.updateSessionThreadId(session.sessionId, started.thread.id);
      return {
        threadId: started.thread.id,
        model: started.model ?? null,
        reasoningEffort: started.reasoningEffort ?? null
      };
    }
  }

  async handleAppServerServerRequest(request: JsonRpcServerRequest): Promise<void> {
    const store = this.deps.getStore();
    const appServer = this.deps.getAppServer();
    if (!store || !appServer) {
      return;
    }

    const knownUnsupported = getKnownUnsupportedServerRequest(request);
    if (knownUnsupported) {
      const activeTurn = this.findActiveTurnForRequestParams(request.params);
      await this.deps.logger.warn("known unsupported app-server server request", {
        method: request.method,
        id: request.id,
        detail: knownUnsupported.logDetail
      });
      if (activeTurn) {
        await this.appendDebugJournal(activeTurn, "bridge/serverRequest/rejected", {
          requestId: serializeJsonRpcRequestId(request.id),
          requestMethod: request.method,
          params: request.params,
          reason: knownUnsupported.errorMessage
        });
        const delivered = await this.deps.safeSendMessage(activeTurn.chatId, knownUnsupported.userMessage);
        if (delivered) {
          await this.deps.runRuntimeCardOperation(activeTurn, async () => {
            await this.deps.reanchorStatusCardToLatestMessage(activeTurn, "known_unsupported_server_request");
          });
        }
      }
      await appServer.respondToServerRequestError(request.id, -32601, knownUnsupported.errorMessage);
      return;
    }

    const normalized = normalizeServerRequest(request.method, request.params);
    if (!normalized) {
      await this.deps.logger.warn("unsupported app-server server request", {
        method: request.method,
        id: request.id
      });
      await appServer.respondToServerRequestError(request.id, -32601, `Unsupported server request: ${request.method}`);
      return;
    }

    await this.deps.interactionBroker.handleNormalizedServerRequest(
      request,
      normalized,
      this.findActiveTurnForInteraction(normalized.threadId, normalized.turnId ?? null)
    );
  }

  async handleAppServerNotification(method: string, params: unknown): Promise<void> {
    const classified = classifyNotification(method, params);

    if (classified.kind === "server_request_resolved") {
      await this.deps.interactionBroker.handleServerRequestResolvedNotification(classified.threadId, classified.requestId);
    }

    if (classified.kind === "thread_archived" || classified.kind === "thread_unarchived") {
      const activeTurn = classified.threadId
        ? this.getActiveTurnByThreadId(classified.threadId) ?? this.getActiveTurn()
        : this.getActiveTurn();
      if (activeTurn) {
        await this.appendDebugJournal(activeTurn, method, params, {
          threadId: classified.threadId ?? null,
          turnId: null
        });
      }
      await this.deps.handleThreadArchiveNotification(classified);
      return;
    }

    const activeTurn = this.findActiveTurnForNotification(classified);
    if (!activeTurn) {
      if (isGlobalRuntimeNotice(classified)) {
        await this.deps.handleGlobalRuntimeNotice(classified);
      }
      return;
    }

    await this.appendDebugJournal(activeTurn, method, params, {
      threadId: classified.threadId ?? activeTurn.threadId,
      turnId: classified.turnId ?? activeTurn.turnId
    });
    const before = activeTurn.tracker.getStatus();

    if (
      classified.kind === "final_message_available" &&
      classified.message &&
      (!classified.threadId || classified.threadId === activeTurn.threadId)
    ) {
      activeTurn.finalMessage = classified.message;
    }

    if (classified.kind === "model_rerouted" && classified.toModel) {
      activeTurn.effectiveModel = classified.toModel;
    }

    activeTurn.tracker.apply(classified);
    await this.logSubagentIdentityEvents(activeTurn, activeTurn.tracker.drainSubagentIdentityEvents());
    for (const agent of activeTurn.tracker.getInspectSnapshot().agentSnapshot) {
      this.activeTurnSessionIdsByThreadId.set(agent.threadId, activeTurn.sessionId);
    }
    const after = activeTurn.tracker.getStatus();
    const forceSurfaceSync = classified.kind === "turn_completed";
    await this.deps.logger.info("turn event processed", {
      sessionId: activeTurn.sessionId,
      chatId: activeTurn.chatId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      method,
      classifiedKind: classified.kind,
      forceSurfaceSync,
      before: summarizeActivityStatus(before),
      after: summarizeActivityStatus(after)
    });
    await this.deps.syncRuntimeCards(activeTurn, classified, before, after, {
      force: forceSurfaceSync,
      reason: classified.kind
    });

    if (classified.kind !== "turn_completed" || (classified.turnId && classified.turnId !== activeTurn.turnId)) {
      return;
    }

    await this.deps.interactionBroker.resolveActionablePendingInteractionsForSession(activeTurn.chatId, activeTurn.sessionId, {
      state: "expired",
      reason: `turn_${classified.status}`,
      resolutionSource: "turn_expired"
    });

    this.unregisterActiveTurn(activeTurn);

    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    if (classified.status === "completed") {
      let finalMessage = activeTurn.finalMessage;
      let proposedPlan: string | null = null;
      const appServer = this.deps.getAppServer();
      if (appServer) {
        const turnArtifacts = await extractTurnArtifactsFromHistory(
          appServer,
          activeTurn.threadId,
          activeTurn.turnId
        );
        if (!finalMessage) {
          finalMessage = turnArtifacts.finalMessage;
        }
        proposedPlan = turnArtifacts.proposedPlan;
      }
      store.markSessionSuccessful(activeTurn.sessionId);
      this.deps.disposeRuntimeCards(activeTurn);
      if (activeTurn.startedInPlanMode && proposedPlan) {
        await this.sendPlanResult(activeTurn, proposedPlan);
        return;
      }
      await this.sendFinalAnswer(activeTurn, finalMessage);
      return;
    }

    if (classified.status === "interrupted") {
      store.updateSessionStatus(activeTurn.sessionId, "interrupted", {
        lastTurnId: activeTurn.turnId,
        lastTurnStatus: "interrupted"
      });
      this.deps.disposeRuntimeCards(activeTurn);
      return;
    }

    store.updateSessionStatus(activeTurn.sessionId, "failed", {
      failureReason: "turn_failed",
      lastTurnId: activeTurn.turnId,
      lastTurnStatus: classified.status
    });
    this.deps.disposeRuntimeCards(activeTurn);
    await this.deps.safeSendMessage(activeTurn.chatId, "这次操作未成功完成，请重试。");
  }

  async handleActiveTurnAppServerExit(): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    for (const runningTurn of this.listActiveTurns()) {
      await this.deps.interactionBroker.resolveActionablePendingInteractionsForSession(
        runningTurn.chatId,
        runningTurn.sessionId,
        {
          state: "failed",
          reason: "app_server_lost",
          resolutionSource: "app_server_exit"
        }
      );
      this.unregisterActiveTurn(runningTurn);
      this.deps.disposeRuntimeCards(runningTurn);
      store.updateSessionStatus(runningTurn.sessionId, "failed", {
        failureReason: "app_server_lost",
        lastTurnId: runningTurn.turnId,
        lastTurnStatus: "failed"
      });
      await this.deps.safeSendMessage(runningTurn.chatId, "Codex 服务暂时不可用，请稍后重试。");
    }
  }

  private async buildTurnStartRequest(
    session: SessionRow,
    request: {
      threadId: string;
      cwd: string;
      text?: string;
      input?: UserInput[];
    }
  ): Promise<Parameters<CodexAppServerClient["startTurn"]>[0]> {
    const baseRequest: Parameters<CodexAppServerClient["startTurn"]>[0] = {
      threadId: request.threadId,
      cwd: request.cwd,
      ...(request.text !== undefined ? { text: request.text } : {}),
      ...(request.input !== undefined ? { input: request.input } : {})
    };

    if (session.planMode || session.needsDefaultCollaborationModeReset) {
      return {
        ...baseRequest,
        collaborationMode: {
          mode: session.planMode ? "plan" : "default",
          settings: {
            model: await this.resolveCollaborationModeModel(session),
            developerInstructions: null,
            reasoningEffort: session.selectedReasoningEffort ?? null
          }
        }
      };
    }

    return {
      ...baseRequest,
      ...(session.selectedModel ? { model: session.selectedModel } : {}),
      ...(session.selectedReasoningEffort ? { effort: session.selectedReasoningEffort } : {})
    };
  }

  private async resolveCollaborationModeModel(session: SessionRow): Promise<string> {
    if (session.selectedModel) {
      return session.selectedModel;
    }

    const models = await this.deps.fetchAllModels();
    const model = models.find((entry) => entry.isDefault) ?? models[0];
    if (!model) {
      throw new Error("model list returned no models");
    }

    return model.id;
  }

  private resolveEffectiveTurnConfig(
    session: SessionRow,
    request: Parameters<CodexAppServerClient["startTurn"]>[0],
    threadState: EnsuredThreadState
  ): EffectiveTurnConfig {
    const requestedModel = request.collaborationMode?.settings.model ?? request.model ?? null;
    const explicitReasoningEffort = request.collaborationMode?.settings.reasoningEffort
      ?? request.effort
      ?? null;

    return {
      model: requestedModel ?? threadState.model ?? session.selectedModel ?? null,
      reasoningEffort: explicitReasoningEffort ?? threadState.reasoningEffort ?? session.selectedReasoningEffort ?? null,
      reasoningEffortPinned: explicitReasoningEffort !== null
    };
  }

  private async sendFinalAnswer(activeTurn: ActiveTurnState, finalMessage: string | null): Promise<void> {
    const text = finalMessage || "本次操作已完成，但没有可返回的最终答复。";
    const rendered = buildCollapsibleFinalAnswerView(text, this.getFinalAnswerRenderContext(activeTurn.sessionId));
    await this.deps.logger.info("sending final answer", {
      chatId: activeTurn.chatId,
      chunkCount: rendered.pages.length,
      collapsible: rendered.truncated,
      hasFinalMessage: finalMessage !== null,
      preview: summarizeTextPreview(text)
    });

    const store = this.deps.getStore();
    if (rendered.truncated && store) {
      let answerId: string | null = null;

      try {
        const saved = store.saveFinalAnswerView({
          telegramChatId: activeTurn.chatId,
          sessionId: activeTurn.sessionId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          previewHtml: rendered.previewHtml,
          pages: rendered.pages
        });
        answerId = saved.answerId;

        const sent = await this.deps.safeSendHtmlMessageResult(
          activeTurn.chatId,
          saved.previewHtml,
          buildFinalAnswerReplyMarkup({
            answerId: saved.answerId,
            totalPages: saved.pages.length,
            expanded: false
          })
        );

        if (sent) {
          store.setFinalAnswerMessageId(saved.answerId, sent.message_id);
          return;
        }
      } catch (error) {
        await this.deps.logger.warn("persisted final answer delivery failed; falling back to chunked send", {
          chatId: activeTurn.chatId,
          sessionId: activeTurn.sessionId,
          error: `${error}`
        });
      }

      if (answerId) {
        store.deleteFinalAnswerView(answerId);
      }
    }

    if (!rendered.truncated && rendered.pages.length === 1) {
      await this.deps.safeSendHtmlMessageResult(activeTurn.chatId, rendered.pages[0] ?? "");
      return;
    }

    for (const page of rendered.pages) {
      await this.deps.safeSendHtmlMessageResult(activeTurn.chatId, page);
    }
  }

  private async sendPlanResult(activeTurn: ActiveTurnState, planMarkdown: string): Promise<void> {
    const rendered = buildCollapsibleFinalAnswerView(planMarkdown, this.getFinalAnswerRenderContext(activeTurn.sessionId));
    const store = this.deps.getStore();

    if (store) {
      const saved = store.saveFinalAnswerView({
        telegramChatId: activeTurn.chatId,
        sessionId: activeTurn.sessionId,
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
        previewHtml: rendered.previewHtml,
        pages: rendered.pages
      });

      const markup = rendered.truncated
        ? buildPlanResultReplyMarkup({
          answerId: saved.answerId,
          totalPages: saved.pages.length,
          expanded: false,
          primaryActionConsumed: false
        })
        : {
          inline_keyboard: buildPlanResultActionRows(saved.answerId)
        };

      const sent = await this.deps.safeSendHtmlMessageResult(
        activeTurn.chatId,
        rendered.truncated ? saved.previewHtml : (rendered.pages[0] ?? ""),
        markup
      );
      if (sent) {
        store.setFinalAnswerMessageId(saved.answerId, sent.message_id);
        return;
      }

      store.deleteFinalAnswerView(saved.answerId);
    }

    await this.deps.safeSendHtmlMessageResult(activeTurn.chatId, rendered.pages[0] ?? "");
  }

  private getFinalAnswerRenderContext(sessionId: string): {
    sessionName?: string | null;
    projectName?: string | null;
  } {
    const session = this.deps.getStore()?.getSessionById(sessionId) ?? null;
    if (!session) {
      return {};
    }

    return {
      sessionName: session.displayName,
      projectName: session.projectAlias?.trim() || session.projectName
    };
  }

  private registerActiveTurn(activeTurn: ActiveTurnState): void {
    const previous = this.activeTurnsBySessionId.get(activeTurn.sessionId);
    if (previous) {
      this.unregisterActiveTurn(previous);
    }

    this.activeTurnsBySessionId.set(activeTurn.sessionId, activeTurn);
    this.activeTurnSessionIdsByThreadId.set(activeTurn.threadId, activeTurn.sessionId);
  }

  private unregisterActiveTurn(activeTurn: ActiveTurnState): void {
    const current = this.activeTurnsBySessionId.get(activeTurn.sessionId);
    if (current?.turnId === activeTurn.turnId) {
      this.activeTurnsBySessionId.delete(activeTurn.sessionId);
    }

    for (const [threadId, sessionId] of this.activeTurnSessionIdsByThreadId.entries()) {
      if (sessionId === activeTurn.sessionId) {
        this.activeTurnSessionIdsByThreadId.delete(threadId);
      }
    }
  }

  private findActiveTurnForInteraction(
    threadId: string | null,
    turnId: string | null
  ): ActiveTurnState | null {
    if (threadId) {
      const byThread = this.getActiveTurnByThreadId(threadId);
      if (byThread) {
        return byThread;
      }
    }

    if (turnId) {
      for (const activeTurn of this.activeTurnsBySessionId.values()) {
        if (activeTurn.turnId === turnId) {
          return activeTurn;
        }
      }
    }

    if (this.activeTurnsBySessionId.size === 1) {
      return this.getActiveTurn();
    }

    return null;
  }

  private findActiveTurnForNotification(
    classified: ReturnType<typeof classifyNotification>
  ): ActiveTurnState | null {
    return this.findActiveTurnForInteraction(classified.threadId, classified.turnId);
  }

  private findActiveTurnForRequestParams(params: unknown): ActiveTurnState | null {
    const record = asRecord(params);
    return this.findActiveTurnForInteraction(getString(record, "threadId"), getString(record, "turnId"))
      ?? this.getActiveTurn();
  }

  private async appendDebugJournal(
    activeTurn: ActiveTurnState,
    method: string,
    params: unknown,
    overrides?: {
      threadId?: string | null;
      turnId?: string | null;
    }
  ): Promise<void> {
    try {
      await activeTurn.debugJournal.append({
        receivedAt: new Date().toISOString(),
        threadId: overrides?.threadId ?? activeTurn.threadId,
        turnId: overrides?.turnId ?? activeTurn.turnId,
        method,
        params
      });
    } catch (error) {
      await this.deps.logger.warn("debug journal append failed", {
        sessionId: activeTurn.sessionId,
        turnId: activeTurn.turnId,
        error: `${error}`
      });
    }
  }

  private async logSubagentIdentityEvents(
    activeTurn: ActiveTurnState,
    events: SubagentIdentityEvent[]
  ): Promise<void> {
    for (const event of events) {
      await this.deps.logger.info(
        event.kind === "cached" ? "subagent identity cached" : "subagent identity applied",
        {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: event.threadId,
          label: event.label,
          labelSource: event.labelSource,
          origin: event.origin
        }
      );
    }
  }
}

function isMissingRemoteThreadError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /no rollout found for thread id/i.test(error.message);
}

function isGlobalRuntimeNotice(
  notification: ReturnType<typeof classifyNotification>
): notification is GlobalRuntimeNotice {
  return notification.kind === "config_warning"
    || notification.kind === "deprecation_notice"
    || notification.kind === "model_rerouted"
    || notification.kind === "skills_changed"
    || notification.kind === "thread_compacted";
}

function getKnownUnsupportedServerRequest(request: JsonRpcServerRequest): {
  errorMessage: string;
  userMessage: string;
  logDetail: string;
} | null {
  if (request.method === "item/tool/call") {
    const tool = getString(asRecord(request.params), "tool") ?? "unknown";
    return {
      errorMessage: "Dynamic tool calls are not supported by the Telegram bridge",
      userMessage: `Codex 发起了动态工具调用（${tool}），但 Telegram bridge 当前没有稳定的客户端工具映射，已拒绝这次调用。`,
      logDetail: `tool=${tool}`
    };
  }

  if (request.method === "account/chatgptAuthTokens/refresh") {
    const reason = getString(asRecord(request.params), "reason") ?? "unknown";
    return {
      errorMessage: "ChatGPT auth token refresh is not supported by the Telegram bridge",
      userMessage: `Codex 请求 ChatGPT 登录令牌刷新（原因：${reason}），但 bridge 不持有可刷新的 ChatGPT access token / account id，已拒绝这次请求。`,
      logDetail: `reason=${reason}`
    };
  }

  return null;
}

function serializeJsonRpcRequestId(id: JsonRpcRequestId): string {
  return typeof id === "number" ? `${id}` : `s:${id}`;
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
