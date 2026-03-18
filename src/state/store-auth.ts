import type { DatabaseSync } from "node:sqlite";

import type { AuthorizedUserRow, ChatBindingRow, PendingAuthorizationRow } from "../types.js";
import { nowIso } from "../util/time.js";
import {
  type AuthorizedUserRecord,
  type ChatBindingRecord,
  type PendingAuthorizationRecord,
  mapAuthorizedUser,
  mapChatBinding,
  mapPendingAuthorization
} from "./store-records.js";

export interface StoreAuth {
  getAuthorizedUser(): AuthorizedUserRow | null;
  getChatBinding(telegramChatId: string): ChatBindingRow | null;
  listChatBindings(): ChatBindingRow[];
  listChatBindingsByTelegramUserId(telegramUserId: string): ChatBindingRow[];
  listPendingAuthorizations(options?: { includeExpired?: boolean }): PendingAuthorizationRow[];
  upsertPendingAuthorization(candidate: {
    telegramUserId: string;
    telegramChatId: string;
    telegramUsername: string | null;
    displayName: string | null;
  }): void;
  saveAuthorizedUser(options: {
    telegramUserId: string;
    telegramUsername: string | null;
    displayName: string | null;
    firstSeenAt: string;
    updatedAt: string;
  }): void;
  replaceChatBinding(options: {
    telegramChatId: string;
    telegramUserId: string;
    activeSessionId: string | null;
    createdAt: string;
    updatedAt: string;
  }): void;
  setChatBindingActiveSession(
    telegramChatId: string,
    activeSessionId: string | null,
    updatedAt?: string
  ): void;
  deleteChatBindingsByTelegramUserId(telegramUserId: string): void;
  clearAuthorizedUsers(): void;
  clearChatBindings(): void;
  clearPendingAuthorizations(): void;
}

export function createStoreAuth(db: DatabaseSync): StoreAuth {
  return {
    getAuthorizedUser() {
      const row = db
        .prepare("SELECT * FROM authorized_user ORDER BY updated_at DESC LIMIT 1")
        .get() as AuthorizedUserRecord | undefined;

      return row ? mapAuthorizedUser(row) : null;
    },

    getChatBinding(telegramChatId) {
      const row = db
        .prepare("SELECT * FROM chat_binding WHERE telegram_chat_id = ?")
        .get(telegramChatId) as ChatBindingRecord | undefined;

      return row ? mapChatBinding(row) : null;
    },

    listChatBindings() {
      const rows = db
        .prepare("SELECT * FROM chat_binding ORDER BY updated_at DESC, created_at DESC")
        .all() as unknown as ChatBindingRecord[];

      return rows.map(mapChatBinding);
    },

    listChatBindingsByTelegramUserId(telegramUserId) {
      const rows = db
        .prepare(
          `
            SELECT *
            FROM chat_binding
            WHERE telegram_user_id = ?
            ORDER BY updated_at DESC, created_at DESC
          `
        )
        .all(telegramUserId) as unknown as ChatBindingRecord[];

      return rows.map(mapChatBinding);
    },

    listPendingAuthorizations(options) {
      const includeExpired = options?.includeExpired ?? false;
      const rows = db
        .prepare(
          "SELECT * FROM pending_authorization ORDER BY last_seen_at DESC, first_seen_at DESC"
        )
        .all() as unknown as PendingAuthorizationRecord[];

      return rows
        .map(mapPendingAuthorization)
        .filter((row) => includeExpired || !row.expired);
    },

    upsertPendingAuthorization(candidate) {
      const timestamp = nowIso();
      db
        .prepare(
          `
            INSERT INTO pending_authorization (
              telegram_user_id,
              telegram_chat_id,
              telegram_username,
              display_name,
              first_seen_at,
              last_seen_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(telegram_user_id) DO UPDATE SET
              telegram_chat_id = excluded.telegram_chat_id,
              telegram_username = excluded.telegram_username,
              display_name = excluded.display_name,
              last_seen_at = excluded.last_seen_at
          `
        )
        .run(
          candidate.telegramUserId,
          candidate.telegramChatId,
          candidate.telegramUsername,
          candidate.displayName,
          timestamp,
          timestamp
        );
    },

    saveAuthorizedUser(options) {
      db
        .prepare(
          `
            INSERT OR REPLACE INTO authorized_user (
              telegram_user_id,
              telegram_username,
              display_name,
              first_seen_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(
          options.telegramUserId,
          options.telegramUsername,
          options.displayName,
          options.firstSeenAt,
          options.updatedAt
        );
    },

    replaceChatBinding(options) {
      db
        .prepare(
          `
            INSERT OR REPLACE INTO chat_binding (
              telegram_chat_id,
              telegram_user_id,
              active_session_id,
              created_at,
              updated_at
            )
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(
          options.telegramChatId,
          options.telegramUserId,
          options.activeSessionId,
          options.createdAt,
          options.updatedAt
        );
    },

    setChatBindingActiveSession(telegramChatId, activeSessionId, updatedAt = nowIso()) {
      db
        .prepare(
          `
            UPDATE chat_binding
            SET active_session_id = ?, updated_at = ?
            WHERE telegram_chat_id = ?
          `
        )
        .run(activeSessionId, updatedAt, telegramChatId);
    },

    deleteChatBindingsByTelegramUserId(telegramUserId) {
      db
        .prepare(
          `
            DELETE FROM chat_binding
            WHERE telegram_user_id = ?
          `
        )
        .run(telegramUserId);
    },

    clearAuthorizedUsers() {
      db.prepare("DELETE FROM authorized_user").run();
    },

    clearChatBindings() {
      db.prepare("DELETE FROM chat_binding").run();
    },

    clearPendingAuthorizations() {
      db.prepare("DELETE FROM pending_authorization").run();
    }
  };
}
