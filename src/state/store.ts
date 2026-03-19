import { mkdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { nowIso } from "../util/time.js";
import type {
  AuthorizedUserRow,
  ChatBindingRow,
  FailureReason,
  FinalAnswerViewRow,
  PendingInteractionKind,
  PendingInteractionRow,
  PendingInteractionState,
  PendingAuthorizationRow,
  ProjectScanCacheRow,
  ReadinessSnapshot,
  RecentProjectRow,
  ReasoningEffort,
  RuntimeCardPreferencesRow,
  RuntimeStatusField,
  RuntimeNotice,
  SessionProjectStatsRow,
  SessionRow,
  SessionStatus,
  UiLanguage,
  TurnInputSourceKind,
  TurnInputSourceRow
} from "../types.js";
import {
  appliedTableExists,
  buildStateStoreFailure,
  clearStateStoreFailure,
  getStateStoreFailureStage,
  logStateStoreOpenFailure,
  openInitializedDatabase,
  persistStateStoreFailure,
  withStateStoreFailureStage
} from "./store-open.js";
import {
  createStorePendingInteractions,
  type StorePendingInteractions
} from "./store-pending-interactions.js";
import {
  createStoreAuth,
  type StoreAuth
} from "./store-auth.js";
import {
  choosePreferredActiveSessionId
} from "./store-records.js";
import {
  createStoreRuntimeArtifacts,
  type StoreRuntimeArtifacts
} from "./store-runtime-artifacts.js";
import {
  createStoreSessions,
  type StoreSessions
} from "./store-sessions.js";

export type StateStoreOpenStage =
  | "open_db"
  | "initialize_schema"
  | "verify_integrity"
  | "normalize_active_sessions";

export type StateStoreFailureClassification =
  | "transient_open_failure"
  | "integrity_failure"
  | "schema_failure";

export interface StateStoreFailureRecord {
  detectedAt: string;
  dbPath: string;
  stage: StateStoreOpenStage;
  classification: StateStoreFailureClassification;
  error: string;
  recommendedAction: string;
}

export class StateStoreOpenError extends Error {
  readonly failure: StateStoreFailureRecord;

  constructor(failure: StateStoreFailureRecord) {
    super(`state store open failed (${failure.classification} at ${failure.stage}): ${failure.error}`);
    this.name = "StateStoreOpenError";
    this.failure = failure;
  }
}

export { readStateStoreFailure } from "./store-open.js";

export class BridgeStateStore {
  private readonly auth: StoreAuth;
  private readonly runtimeArtifacts: StoreRuntimeArtifacts;
  private readonly pendingInteractions: StorePendingInteractions;
  private readonly sessions: StoreSessions;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly logger: Logger,
    readonly recoveredFromCorruption: boolean
  ) {
    this.auth = createStoreAuth(db);
    this.runtimeArtifacts = createStoreRuntimeArtifacts(db);
    this.pendingInteractions = createStorePendingInteractions(db);
    this.sessions = createStoreSessions(db, {
      auth: this.auth
    });
  }

  static async open(paths: BridgePaths, logger: Logger): Promise<BridgeStateStore> {
    try {
      const store = this.openInitializedStore(paths.dbPath, logger, false);
      await clearStateStoreFailure(paths);
      return store;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        try {
          // First-run installs may be missing the state directory even though creating a new DB is safe.
          await mkdir(dirname(paths.dbPath), { recursive: true });
          const store = this.openInitializedStore(paths.dbPath, logger, false);
          await clearStateStoreFailure(paths);
          return store;
        } catch (retryError) {
          const failure = buildStateStoreFailure(
            paths.dbPath,
            getStateStoreFailureStage(retryError),
            retryError
          );
          await persistStateStoreFailure(paths, failure, logger);
          await logStateStoreOpenFailure(logger, failure);
          throw new StateStoreOpenError(failure);
        }
      }

      // Any non-ENOENT failure must preserve the existing database and stop the service cold.
      const failure = buildStateStoreFailure(paths.dbPath, getStateStoreFailureStage(error), error);
      await persistStateStoreFailure(paths, failure, logger);
      await logStateStoreOpenFailure(logger, failure);
      throw new StateStoreOpenError(failure);
    }
  }

  private static openInitializedStore(
    dbPath: string,
    logger: Logger,
    recoveredFromCorruption: boolean
  ): BridgeStateStore {
    const db = openInitializedDatabase(dbPath);

    try {
      const store = new BridgeStateStore(db, logger, recoveredFromCorruption);
      withStateStoreFailureStage("normalize_active_sessions", () => store.normalizeAllActiveSessions());
      return store;
    } catch (error) {
      try {
        db.close();
      } catch {
        // Ignore close failures while surfacing the original open error.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private normalizeAllActiveSessions(): void {
    const bindings = this.auth.listChatBindings();
    for (const binding of bindings) {
      this.sessions.normalizeActiveSession(binding.telegramChatId);
    }
  }

  getAuthorizedUser(): AuthorizedUserRow | null {
    return this.auth.getAuthorizedUser();
  }

  getChatBinding(telegramChatId: string): ChatBindingRow | null {
    return this.auth.getChatBinding(telegramChatId);
  }

  listChatBindings(): ChatBindingRow[] {
    return this.auth.listChatBindings();
  }

  listPendingAuthorizations(options?: { includeExpired?: boolean }): PendingAuthorizationRow[] {
    return this.auth.listPendingAuthorizations(options);
  }

  upsertPendingAuthorization(candidate: {
    telegramUserId: string;
    telegramChatId: string;
    telegramUsername: string | null;
    displayName: string | null;
  }): void {
    this.auth.upsertPendingAuthorization(candidate);
  }

  confirmPendingAuthorization(candidate: PendingAuthorizationRow): void {
    if (candidate.expired) {
      throw new Error("pending authorization candidate expired; ask the user to message the bot again");
    }

    const timestamp = nowIso();
    const previousSnapshot = this.getReadinessSnapshot();
    this.db.exec("BEGIN");

    try {
      const existingBindings = this.auth.listChatBindingsByTelegramUserId(candidate.telegramUserId);
      const previousChatIds = existingBindings.map((binding) => binding.telegramChatId);
      const migratedActiveSessionId = choosePreferredActiveSessionId(existingBindings);

      this.auth.saveAuthorizedUser({
        telegramUserId: candidate.telegramUserId,
        telegramUsername: candidate.telegramUsername,
        displayName: candidate.displayName,
        firstSeenAt: candidate.firstSeenAt,
        updatedAt: timestamp
      });

      if (previousChatIds.length > 0) {
        this.sessions.rebindSessionsChatIds(candidate.telegramChatId, previousChatIds);
        this.runtimeArtifacts.rebindRuntimeNoticesChatIds(candidate.telegramChatId, previousChatIds);
        this.runtimeArtifacts.rebindFinalAnswerViewsChatIds(candidate.telegramChatId, previousChatIds);

        if (appliedTableExists(this.db, "pending_interaction")) {
          this.pendingInteractions.rebindPendingInteractionsChatIds(candidate.telegramChatId, previousChatIds);
        }

        this.auth.deleteChatBindingsByTelegramUserId(candidate.telegramUserId);
      }

      this.auth.replaceChatBinding({
        telegramChatId: candidate.telegramChatId,
        telegramUserId: candidate.telegramUserId,
        activeSessionId: migratedActiveSessionId,
        createdAt: timestamp,
        updatedAt: timestamp
      });

      this.sessions.normalizeActiveSession(candidate.telegramChatId);

      this.auth.clearPendingAuthorizations();

      if (previousSnapshot) {
        const nextState =
          previousSnapshot.details.codexAuthenticated &&
          previousSnapshot.details.telegramTokenValid &&
          previousSnapshot.details.appServerAvailable
            ? "ready"
            : previousSnapshot.state === "awaiting_authorization"
              ? "ready"
              : previousSnapshot.state;

        this.writeReadinessSnapshot({
          ...previousSnapshot,
          state: nextState,
          checkedAt: timestamp,
          details: {
            ...previousSnapshot.details,
            authorizedUserBound: true
          }
        });
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearAuthorization(): void {
    const previousSnapshot = this.getReadinessSnapshot();
    this.db.exec("BEGIN");

    try {
      this.auth.clearAuthorizedUsers();
      this.auth.clearChatBindings();
      this.auth.clearPendingAuthorizations();
      this.runtimeArtifacts.clearAllFinalAnswerViews();
      if (appliedTableExists(this.db, "pending_interaction")) {
        this.pendingInteractions.clearAllPendingInteractions();
      }

      if (previousSnapshot) {
        this.writeReadinessSnapshot({
          ...previousSnapshot,
          state: "awaiting_authorization",
          checkedAt: nowIso(),
          details: {
            ...previousSnapshot.details,
            authorizedUserBound: false
          }
        });
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markRunningSessionsFailed(reason: FailureReason): number {
    return this.sessions.markRunningSessionsFailed(reason);
  }

  markRunningSessionsFailedWithNotices(reason: FailureReason): RuntimeNotice[] {
    const runningSessions = this.sessions.listRunningSessions();

    if (runningSessions.length === 0) {
      return [];
    }

    const timestamp = nowIso();
    this.db.exec("BEGIN");

    try {
      this.sessions.markRunningSessionsFailedAt(reason, timestamp);

      const notices = runningSessions.map((session) => {
        const notice: RuntimeNotice = {
          key: `restart:${session.sessionId}:${timestamp}`,
          telegramChatId: session.telegramChatId,
          type: "bridge_restart_recovery",
          message: "桥接服务已重启，正在运行的操作状态未知，请查看会话状态后重新发起。",
          createdAt: timestamp
        };

        return notice;
      });
      this.runtimeArtifacts.upsertRuntimeNotices(notices);

      if (appliedTableExists(this.db, "pending_interaction")) {
        this.pendingInteractions.failPendingInteractionsForSessionIds(
          runningSessions.map((session) => session.sessionId),
          timestamp,
          "bridge_restart"
        );
      }

      this.db.exec("COMMIT");
      return notices;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSessions(telegramChatId: string, limitOrOptions?: number | { archived?: boolean; limit?: number }): SessionRow[] {
    return this.sessions.listSessions(telegramChatId, limitOrOptions);
  }

  getSessionById(sessionId: string): SessionRow | null {
    return this.sessions.getSessionById(sessionId);
  }

  getSessionByThreadId(threadId: string): SessionRow | null {
    return this.sessions.getSessionByThreadId(threadId);
  }

  listSessionsWithThreads(): SessionRow[] {
    return this.sessions.listSessionsWithThreads();
  }

  getActiveSession(telegramChatId: string): SessionRow | null {
    return this.sessions.getActiveSession(telegramChatId);
  }

  createSession(options: {
    telegramChatId: string;
    projectName: string;
    projectPath: string;
    displayName?: string;
    selectedModel?: string | null;
    selectedReasoningEffort?: ReasoningEffort | null;
    planMode?: boolean;
    needsDefaultCollaborationModeReset?: boolean;
    threadId?: string | null;
    lastTurnId?: string | null;
    lastTurnStatus?: string | null;
  }): SessionRow {
    return this.sessions.createSession(options);
  }

  setActiveSession(telegramChatId: string, sessionId: string): void {
    this.sessions.setActiveSession(telegramChatId, sessionId);
  }

  archiveSession(sessionId: string): SessionRow | null {
    return this.sessions.archiveSession(sessionId);
  }

  unarchiveSession(sessionId: string): SessionRow | null {
    return this.sessions.unarchiveSession(sessionId);
  }

  renameSession(sessionId: string, displayName: string): void {
    this.sessions.renameSession(sessionId, displayName);
  }

  pinProject(options: {
    projectPath: string;
    projectName: string;
    sessionId: string | null;
  }): void {
    this.sessions.pinProject(options);
  }

  isProjectPinned(projectPath: string): boolean {
    return this.sessions.isProjectPinned(projectPath);
  }

  getRecentProjectByPath(projectPath: string): RecentProjectRow | null {
    return this.sessions.getRecentProjectByPath(projectPath);
  }

  listRecentProjects(): RecentProjectRow[] {
    return this.sessions.listRecentProjects();
  }

  setProjectAlias(options: {
    projectPath: string;
    projectName: string;
    projectAlias: string;
    sessionId: string | null;
  }): void {
    this.sessions.setProjectAlias(options);
  }

  clearProjectAlias(projectPath: string): void {
    this.sessions.clearProjectAlias(projectPath);
  }

  listPinnedProjectPaths(): string[] {
    return this.sessions.listPinnedProjectPaths();
  }

  listProjectScanCache(): ProjectScanCacheRow[] {
    return this.sessions.listProjectScanCache();
  }

  listSessionProjectStats(): SessionProjectStatsRow[] {
    return this.sessions.listSessionProjectStats();
  }

  upsertProjectScanCandidates(
    candidates: Array<{
      projectPath: string;
      projectName: string;
      scanRoot: string;
      confidence: number;
      detectedMarkers: string[];
      existsNow: boolean;
    }>
  ): void {
    this.sessions.upsertProjectScanCandidates(candidates);
  }

  markProjectScanCandidateMissing(projectPath: string): void {
    this.sessions.markProjectScanCandidateMissing(projectPath);
  }

  updateSessionThreadId(sessionId: string, threadId: string): void {
    this.sessions.updateSessionThreadId(sessionId, threadId);
  }

  setSessionSelectedModel(sessionId: string, selectedModel: string | null): void {
    this.sessions.setSessionSelectedModel(sessionId, selectedModel);
  }

  setSessionSelectedReasoningEffort(sessionId: string, selectedReasoningEffort: ReasoningEffort | null): void {
    this.sessions.setSessionSelectedReasoningEffort(sessionId, selectedReasoningEffort);
  }

  setSessionPlanMode(sessionId: string, planMode: boolean): void {
    this.sessions.setSessionPlanMode(sessionId, planMode);
  }

  clearSessionDefaultCollaborationModeReset(sessionId: string): void {
    this.sessions.clearSessionDefaultCollaborationModeReset(sessionId);
  }

  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    options?: {
      failureReason?: FailureReason | null;
      lastTurnId?: string | null;
      lastTurnStatus?: string | null;
    }
  ): void {
    this.sessions.updateSessionStatus(sessionId, status, options);
  }

  markSessionSuccessful(sessionId: string): void {
    this.sessions.markSessionSuccessful(sessionId);
  }

  listRuntimeNotices(telegramChatId: string): RuntimeNotice[] {
    return this.runtimeArtifacts.listRuntimeNotices(telegramChatId);
  }

  countRuntimeNotices(): number {
    return this.runtimeArtifacts.countRuntimeNotices();
  }

  clearRuntimeNotice(key: string): void {
    this.runtimeArtifacts.clearRuntimeNotice(key);
  }

  createRuntimeNotice(options: {
    key?: string;
    telegramChatId: string;
    type: RuntimeNotice["type"];
    message: string;
  }): RuntimeNotice {
    return this.runtimeArtifacts.createRuntimeNotice(options);
  }

  listNoticeChatIds(): string[] {
    return this.runtimeArtifacts.listNoticeChatIds();
  }

  getRuntimeCardPreferences(): RuntimeCardPreferencesRow {
    return this.runtimeArtifacts.getRuntimeCardPreferences();
  }

  setRuntimeCardPreferences(fields: RuntimeStatusField[]): RuntimeCardPreferencesRow {
    return this.runtimeArtifacts.setRuntimeCardPreferences(fields);
  }

  getUiLanguage(): UiLanguage {
    return this.runtimeArtifacts.getUiLanguage();
  }

  setUiLanguage(language: UiLanguage): UiLanguage {
    return this.runtimeArtifacts.setUiLanguage(language);
  }

  saveFinalAnswerView(options: {
    answerId?: string;
    telegramChatId: string;
    telegramMessageId?: number | null;
    sessionId: string;
    threadId: string;
    turnId: string;
    previewHtml: string;
    pages: string[];
    primaryActionConsumed?: boolean;
  }): FinalAnswerViewRow {
    return this.runtimeArtifacts.saveFinalAnswerView(options);
  }

  getFinalAnswerView(answerId: string, telegramChatId: string): FinalAnswerViewRow | null {
    return this.runtimeArtifacts.getFinalAnswerView(answerId, telegramChatId);
  }

  listFinalAnswerViews(telegramChatId: string): FinalAnswerViewRow[] {
    return this.runtimeArtifacts.listFinalAnswerViews(telegramChatId);
  }

  setFinalAnswerMessageId(answerId: string, telegramMessageId: number): void {
    this.runtimeArtifacts.setFinalAnswerMessageId(answerId, telegramMessageId);
  }

  setFinalAnswerPrimaryActionConsumed(answerId: string, consumed: boolean): void {
    this.runtimeArtifacts.setFinalAnswerPrimaryActionConsumed(answerId, consumed);
  }

  deleteFinalAnswerView(answerId: string): void {
    this.runtimeArtifacts.deleteFinalAnswerView(answerId);
  }

  saveTurnInputSource(options: {
    threadId: string;
    turnId: string;
    sourceKind: TurnInputSourceKind;
    transcript: string;
  }): TurnInputSourceRow {
    return this.runtimeArtifacts.saveTurnInputSource(options);
  }

  getTurnInputSource(threadId: string, turnId: string): TurnInputSourceRow | null {
    return this.runtimeArtifacts.getTurnInputSource(threadId, turnId);
  }

  createPendingInteraction(options: {
    interactionId?: string;
    telegramChatId: string;
    sessionId: string;
    threadId: string;
    turnId: string;
    requestId: string;
    requestMethod: string;
    interactionKind: PendingInteractionKind;
    state?: PendingInteractionState;
    promptJson: string;
    responseJson?: string | null;
    telegramMessageId?: number | null;
    errorReason?: string | null;
  }): PendingInteractionRow {
    return this.pendingInteractions.createPendingInteraction(options);
  }

  getPendingInteraction(interactionId: string, telegramChatId?: string): PendingInteractionRow | null {
    return this.pendingInteractions.getPendingInteraction(interactionId, telegramChatId);
  }

  listPendingInteractionsByRequest(threadId: string, requestId: string): PendingInteractionRow[] {
    return this.pendingInteractions.listPendingInteractionsByRequest(threadId, requestId);
  }

  listPendingInteractionsByChat(
    telegramChatId: string,
    states?: PendingInteractionState[]
  ): PendingInteractionRow[] {
    return this.pendingInteractions.listPendingInteractionsByChat(telegramChatId, states);
  }

  listPendingInteractionsByTurn(threadId: string, turnId: string): PendingInteractionRow[] {
    return this.pendingInteractions.listPendingInteractionsByTurn(threadId, turnId);
  }

  listUnresolvedPendingInteractions(): PendingInteractionRow[] {
    return this.pendingInteractions.listUnresolvedPendingInteractions();
  }

  listPendingInteractionsForRunningSessions(): PendingInteractionRow[] {
    return this.pendingInteractions.listPendingInteractionsForRunningSessions();
  }

  setPendingInteractionMessageId(interactionId: string, messageId: number): void {
    this.pendingInteractions.setPendingInteractionMessageId(interactionId, messageId);
  }

  savePendingInteractionDraftResponse(
    interactionId: string,
    state: PendingInteractionState,
    responseJson: string | null
  ): void {
    this.pendingInteractions.savePendingInteractionDraftResponse(interactionId, state, responseJson);
  }

  markPendingInteractionAwaitingText(interactionId: string, responseJson?: string | null): void {
    this.pendingInteractions.markPendingInteractionAwaitingText(interactionId, responseJson);
  }

  markPendingInteractionPending(interactionId: string, responseJson?: string | null): void {
    this.pendingInteractions.markPendingInteractionPending(interactionId, responseJson);
  }

  markPendingInteractionAnswered(interactionId: string, responseJson: string): void {
    this.pendingInteractions.markPendingInteractionAnswered(interactionId, responseJson);
  }

  markPendingInteractionCanceled(
    interactionId: string,
    responseJson?: string | null,
    reason?: string | null
  ): void {
    this.pendingInteractions.markPendingInteractionCanceled(interactionId, responseJson, reason);
  }

  markPendingInteractionFailed(interactionId: string, reason: string): void {
    this.pendingInteractions.markPendingInteractionFailed(interactionId, reason);
  }

  markPendingInteractionExpired(interactionId: string, reason: string): void {
    this.pendingInteractions.markPendingInteractionExpired(interactionId, reason);
  }

  expirePendingInteractionsForTurn(threadId: string, turnId: string, reason: string): number {
    return this.pendingInteractions.expirePendingInteractionsForTurn(threadId, turnId, reason);
  }

  writeReadinessSnapshot(snapshot: ReadinessSnapshot): void {
    this.runtimeArtifacts.writeReadinessSnapshot(snapshot);
  }

  getReadinessSnapshot(): ReadinessSnapshot | null {
    return this.runtimeArtifacts.getReadinessSnapshot();
  }
}
