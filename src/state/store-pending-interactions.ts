import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type {
  PendingInteractionKind,
  PendingInteractionRow,
  PendingInteractionState
} from "../types.js";
import { nowIso } from "../util/time.js";
import { buildInClausePlaceholders } from "./store-shared.js";

interface PendingInteractionRecord {
  interaction_id: string;
  telegram_chat_id: string;
  session_id: string;
  thread_id: string;
  turn_id: string;
  request_id: string;
  request_method: string;
  interaction_kind: PendingInteractionKind;
  state: PendingInteractionState;
  prompt_json: string;
  response_json: string | null;
  telegram_message_id: number | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  error_reason: string | null;
}

function mapPendingInteraction(record: PendingInteractionRecord): PendingInteractionRow {
  return {
    interactionId: record.interaction_id,
    telegramChatId: record.telegram_chat_id,
    sessionId: record.session_id,
    threadId: record.thread_id,
    turnId: record.turn_id,
    requestId: record.request_id,
    requestMethod: record.request_method,
    interactionKind: record.interaction_kind,
    state: record.state,
    promptJson: record.prompt_json,
    responseJson: record.response_json,
    telegramMessageId: record.telegram_message_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    resolvedAt: record.resolved_at,
    errorReason: record.error_reason
  };
}

export interface StorePendingInteractions {
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
  }): PendingInteractionRow;
  getPendingInteraction(interactionId: string, telegramChatId?: string): PendingInteractionRow | null;
  listPendingInteractionsByRequest(threadId: string, requestId: string): PendingInteractionRow[];
  listPendingInteractionsByChat(
    telegramChatId: string,
    states?: PendingInteractionState[]
  ): PendingInteractionRow[];
  listPendingInteractionsByTurn(threadId: string, turnId: string): PendingInteractionRow[];
  listUnresolvedPendingInteractions(): PendingInteractionRow[];
  listPendingInteractionsForRunningSessions(): PendingInteractionRow[];
  rebindPendingInteractionsChatIds(telegramChatId: string, previousChatIds: string[]): void;
  clearAllPendingInteractions(): void;
  failPendingInteractionsForSessionIds(sessionIds: string[], timestamp: string, reason: string): void;
  setPendingInteractionMessageId(interactionId: string, messageId: number): void;
  savePendingInteractionDraftResponse(
    interactionId: string,
    state: PendingInteractionState,
    responseJson: string | null
  ): void;
  markPendingInteractionAwaitingText(interactionId: string, responseJson?: string | null): void;
  markPendingInteractionPending(interactionId: string, responseJson?: string | null): void;
  markPendingInteractionAnswered(interactionId: string, responseJson: string): void;
  markPendingInteractionCanceled(
    interactionId: string,
    responseJson?: string | null,
    reason?: string | null
  ): void;
  markPendingInteractionFailed(interactionId: string, reason: string): void;
  markPendingInteractionExpired(interactionId: string, reason: string): void;
  expirePendingInteractionsForTurn(threadId: string, turnId: string, reason: string): number;
}

export function createStorePendingInteractions(db: DatabaseSync): StorePendingInteractions {
  return {
    createPendingInteraction(options) {
      const interactionId = options.interactionId ?? randomUUID();
      const timestamp = nowIso();
      db
        .prepare(
          `
            INSERT INTO pending_interaction (
              interaction_id,
              telegram_chat_id,
              session_id,
              thread_id,
              turn_id,
              request_id,
              request_method,
              interaction_kind,
              state,
              prompt_json,
              response_json,
              telegram_message_id,
              created_at,
              updated_at,
              resolved_at,
              error_reason
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
          `
        )
        .run(
          interactionId,
          options.telegramChatId,
          options.sessionId,
          options.threadId,
          options.turnId,
          options.requestId,
          options.requestMethod,
          options.interactionKind,
          options.state ?? "pending",
          options.promptJson,
          options.responseJson ?? null,
          options.telegramMessageId ?? null,
          timestamp,
          timestamp,
          options.errorReason ?? null
        );

      return {
        interactionId,
        telegramChatId: options.telegramChatId,
        sessionId: options.sessionId,
        threadId: options.threadId,
        turnId: options.turnId,
        requestId: options.requestId,
        requestMethod: options.requestMethod,
        interactionKind: options.interactionKind,
        state: options.state ?? "pending",
        promptJson: options.promptJson,
        responseJson: options.responseJson ?? null,
        telegramMessageId: options.telegramMessageId ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
        resolvedAt: null,
        errorReason: options.errorReason ?? null
      } as PendingInteractionRow;
    },

    getPendingInteraction(interactionId, telegramChatId) {
      const row = telegramChatId
        ? db
          .prepare(
            `
              SELECT *
              FROM pending_interaction
              WHERE interaction_id = ? AND telegram_chat_id = ?
            `
          )
          .get(interactionId, telegramChatId)
        : db
          .prepare(
            `
              SELECT *
              FROM pending_interaction
              WHERE interaction_id = ?
            `
          )
          .get(interactionId);

      return row ? mapPendingInteraction(row as unknown as PendingInteractionRecord) : null;
    },

    listPendingInteractionsByRequest(threadId, requestId) {
      const rows = db
        .prepare(
          `
            SELECT *
            FROM pending_interaction
            WHERE thread_id = ?
              AND request_id = ?
              AND state IN ('pending', 'awaiting_text')
            ORDER BY created_at DESC, interaction_id DESC
          `
        )
        .all(threadId, requestId) as unknown as PendingInteractionRecord[];

      return rows.map(mapPendingInteraction);
    },

    listPendingInteractionsByChat(telegramChatId, states) {
      const rows = states && states.length > 0
        ? db
          .prepare(
            `
              SELECT *
              FROM pending_interaction
              WHERE telegram_chat_id = ?
                AND state IN (${states.map(() => "?").join(", ")})
              ORDER BY created_at DESC, interaction_id DESC
            `
          )
          .all(telegramChatId, ...states)
        : db
          .prepare(
            `
              SELECT *
              FROM pending_interaction
              WHERE telegram_chat_id = ?
              ORDER BY created_at DESC, interaction_id DESC
            `
          )
          .all(telegramChatId);

      return (rows as unknown as PendingInteractionRecord[]).map(mapPendingInteraction);
    },

    listPendingInteractionsByTurn(threadId, turnId) {
      const rows = db
        .prepare(
          `
            SELECT *
            FROM pending_interaction
            WHERE thread_id = ? AND turn_id = ?
            ORDER BY created_at DESC, interaction_id DESC
          `
        )
        .all(threadId, turnId) as unknown as PendingInteractionRecord[];

      return rows.map(mapPendingInteraction);
    },

    listUnresolvedPendingInteractions() {
      const rows = db
        .prepare(
          `
            SELECT *
            FROM pending_interaction
            WHERE state IN ('pending', 'awaiting_text')
            ORDER BY created_at ASC, interaction_id ASC
          `
        )
        .all() as unknown as PendingInteractionRecord[];

      return rows.map(mapPendingInteraction);
    },

    listPendingInteractionsForRunningSessions() {
      const rows = db
        .prepare(
          `
            SELECT pi.*
            FROM pending_interaction pi
            INNER JOIN session s
              ON s.session_id = pi.session_id
            WHERE s.status = 'running'
              AND pi.state IN ('pending', 'awaiting_text')
            ORDER BY pi.created_at ASC, pi.interaction_id ASC
          `
        )
        .all() as unknown as PendingInteractionRecord[];

      return rows.map(mapPendingInteraction);
    },

    rebindPendingInteractionsChatIds(telegramChatId, previousChatIds) {
      if (previousChatIds.length === 0) {
        return;
      }

      const placeholders = buildInClausePlaceholders(previousChatIds.length);
      db
        .prepare(
          `
            UPDATE pending_interaction
            SET telegram_chat_id = ?
            WHERE telegram_chat_id IN (${placeholders})
          `
        )
        .run(telegramChatId, ...previousChatIds);
    },

    clearAllPendingInteractions() {
      db.prepare("DELETE FROM pending_interaction").run();
    },

    failPendingInteractionsForSessionIds(sessionIds, timestamp, reason) {
      if (sessionIds.length === 0) {
        return;
      }

      const placeholders = buildInClausePlaceholders(sessionIds.length);
      db
        .prepare(
          `
            UPDATE pending_interaction
            SET
              state = 'failed',
              updated_at = ?,
              resolved_at = COALESCE(resolved_at, ?),
              error_reason = COALESCE(error_reason, ?)
            WHERE state IN ('pending', 'awaiting_text')
              AND session_id IN (${placeholders})
          `
        )
        .run(timestamp, timestamp, reason, ...sessionIds);
    },

    setPendingInteractionMessageId(interactionId, messageId) {
      db
        .prepare(
          `
            UPDATE pending_interaction
            SET telegram_message_id = ?, updated_at = ?
            WHERE interaction_id = ?
          `
        )
        .run(messageId, nowIso(), interactionId);
    },

    savePendingInteractionDraftResponse(interactionId, state, responseJson) {
      if (state !== "pending" && state !== "awaiting_text") {
        throw new Error("draft interaction state must be pending or awaiting_text");
      }

      db
        .prepare(
          `
            UPDATE pending_interaction
            SET
              state = ?,
              response_json = ?,
              updated_at = ?,
              resolved_at = NULL,
              error_reason = NULL
            WHERE interaction_id = ?
          `
        )
        .run(state, responseJson, nowIso(), interactionId);
    },

    markPendingInteractionAwaitingText(interactionId, responseJson) {
      this.savePendingInteractionDraftResponse(interactionId, "awaiting_text", responseJson ?? null);
    },

    markPendingInteractionPending(interactionId, responseJson) {
      this.savePendingInteractionDraftResponse(interactionId, "pending", responseJson ?? null);
    },

    markPendingInteractionAnswered(interactionId, responseJson) {
      const timestamp = nowIso();
      db
        .prepare(
          `
            UPDATE pending_interaction
            SET
              state = 'answered',
              response_json = ?,
              updated_at = ?,
              resolved_at = ?,
              error_reason = NULL
            WHERE interaction_id = ?
          `
        )
        .run(responseJson, timestamp, timestamp, interactionId);
    },

    markPendingInteractionCanceled(interactionId, responseJson, reason) {
      const timestamp = nowIso();
      db
        .prepare(
          `
            UPDATE pending_interaction
            SET
              state = 'canceled',
              response_json = ?,
              updated_at = ?,
              resolved_at = ?,
              error_reason = ?
            WHERE interaction_id = ?
          `
        )
        .run(responseJson ?? null, timestamp, timestamp, reason ?? null, interactionId);
    },

    markPendingInteractionFailed(interactionId, reason) {
      const timestamp = nowIso();
      db
        .prepare(
          `
            UPDATE pending_interaction
            SET
              state = 'failed',
              updated_at = ?,
              resolved_at = ?,
              error_reason = ?
            WHERE interaction_id = ?
          `
        )
        .run(timestamp, timestamp, reason, interactionId);
    },

    markPendingInteractionExpired(interactionId, reason) {
      const timestamp = nowIso();
      db
        .prepare(
          `
            UPDATE pending_interaction
            SET
              state = 'expired',
              updated_at = ?,
              resolved_at = COALESCE(resolved_at, ?),
              error_reason = COALESCE(error_reason, ?)
            WHERE interaction_id = ?
          `
        )
        .run(timestamp, timestamp, reason, interactionId);
    },

    expirePendingInteractionsForTurn(threadId, turnId, reason) {
      const timestamp = nowIso();
      const info = db
        .prepare(
          `
            UPDATE pending_interaction
            SET
              state = 'expired',
              updated_at = ?,
              resolved_at = COALESCE(resolved_at, ?),
              error_reason = COALESCE(error_reason, ?)
            WHERE thread_id = ?
              AND turn_id = ?
              AND state IN ('pending', 'awaiting_text')
          `
        )
        .run(timestamp, timestamp, reason, threadId, turnId);

      return Number(info.changes ?? 0);
    }
  };
}
