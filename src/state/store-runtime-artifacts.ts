import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_RUNTIME_STATUS_FIELDS } from "../types.js";
import type {
  FinalAnswerViewRow,
  ReadinessSnapshot,
  RuntimeCardPreferencesRow,
  RuntimeNotice,
  RuntimeStatusField,
  TurnInputSourceKind,
  TurnInputSourceRow,
  UiLanguage
} from "../types.js";
import { nowIso } from "../util/time.js";
import {
  migrateRuntimeStatusFields,
  parseRuntimeStatusFields,
  shouldMigrateRuntimeStatusFields
} from "./store-open.js";
import { buildInClausePlaceholders } from "./store-shared.js";

interface RuntimeNoticeRecord {
  key: string;
  telegram_chat_id: string;
  type: "bridge_restart_recovery" | "app_server_notice";
  message: string;
  created_at: string;
}

interface FinalAnswerViewRecord {
  answer_id: string;
  telegram_chat_id: string;
  telegram_message_id: number | null;
  session_id: string;
  thread_id: string;
  turn_id: string;
  preview_html: string;
  pages_json: string;
  primary_action_consumed: number;
  created_at: string;
}

interface RuntimeCardPreferencesRecord {
  key: "global";
  fields_json: string;
  updated_at: string;
}

interface UiLanguageRecord {
  key: "global";
  ui_language: UiLanguage;
  updated_at: string;
}

interface TurnInputSourceRecord {
  thread_id: string;
  turn_id: string;
  source_kind: TurnInputSourceKind;
  transcript: string;
  created_at: string;
}

interface ReadinessRecord {
  readiness_state: ReadinessSnapshot["state"];
  details_json: string;
  checked_at: string;
  app_server_pid: string | null;
}

function mapRuntimeNotice(record: RuntimeNoticeRecord): RuntimeNotice {
  return {
    key: record.key,
    telegramChatId: record.telegram_chat_id,
    type: record.type,
    message: record.message,
    createdAt: record.created_at
  };
}

function mapFinalAnswerView(record: FinalAnswerViewRecord): FinalAnswerViewRow {
  return {
    answerId: record.answer_id,
    telegramChatId: record.telegram_chat_id,
    telegramMessageId: record.telegram_message_id,
    sessionId: record.session_id,
    threadId: record.thread_id,
    turnId: record.turn_id,
    previewHtml: record.preview_html,
    pages: JSON.parse(record.pages_json) as string[],
    primaryActionConsumed: record.primary_action_consumed === 1,
    createdAt: record.created_at
  };
}

function mapRuntimeCardPreferences(record: RuntimeCardPreferencesRecord): RuntimeCardPreferencesRow {
  const fields = shouldMigrateRuntimeStatusFields(record.updated_at)
    ? migrateRuntimeStatusFields(record.fields_json) ?? parseRuntimeStatusFields(record.fields_json)
    : parseRuntimeStatusFields(record.fields_json);

  return {
    key: "global",
    fields,
    updatedAt: record.updated_at
  };
}

function mapUiLanguage(record: UiLanguageRecord): UiLanguage {
  return record.ui_language === "en" ? "en" : "zh";
}

function mapTurnInputSource(record: TurnInputSourceRecord): TurnInputSourceRow {
  return {
    threadId: record.thread_id,
    turnId: record.turn_id,
    sourceKind: record.source_kind,
    transcript: record.transcript,
    createdAt: record.created_at
  };
}

export interface StoreRuntimeArtifacts {
  listRuntimeNotices(telegramChatId: string): RuntimeNotice[];
  countRuntimeNotices(): number;
  clearRuntimeNotice(key: string): void;
  upsertRuntimeNotices(notices: RuntimeNotice[]): void;
  createRuntimeNotice(options: {
    key?: string;
    telegramChatId: string;
    type: RuntimeNotice["type"];
    message: string;
  }): RuntimeNotice;
  listNoticeChatIds(): string[];
  rebindRuntimeNoticesChatIds(telegramChatId: string, previousChatIds: string[]): void;
  getRuntimeCardPreferences(): RuntimeCardPreferencesRow;
  setRuntimeCardPreferences(fields: RuntimeStatusField[]): RuntimeCardPreferencesRow;
  getUiLanguage(): UiLanguage;
  setUiLanguage(language: UiLanguage): UiLanguage;
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
  }): FinalAnswerViewRow;
  getFinalAnswerView(answerId: string, telegramChatId: string): FinalAnswerViewRow | null;
  listFinalAnswerViews(telegramChatId: string): FinalAnswerViewRow[];
  rebindFinalAnswerViewsChatIds(telegramChatId: string, previousChatIds: string[]): void;
  setFinalAnswerMessageId(answerId: string, telegramMessageId: number): void;
  setFinalAnswerPrimaryActionConsumed(answerId: string, consumed: boolean): void;
  deleteFinalAnswerView(answerId: string): void;
  clearAllFinalAnswerViews(): void;
  saveTurnInputSource(options: {
    threadId: string;
    turnId: string;
    sourceKind: TurnInputSourceKind;
    transcript: string;
  }): TurnInputSourceRow;
  getTurnInputSource(threadId: string, turnId: string): TurnInputSourceRow | null;
  writeReadinessSnapshot(snapshot: ReadinessSnapshot): void;
  getReadinessSnapshot(): ReadinessSnapshot | null;
}

export function createStoreRuntimeArtifacts(db: DatabaseSync): StoreRuntimeArtifacts {
  const getFinalAnswerView = (answerId: string, telegramChatId: string): FinalAnswerViewRow | null => {
    const row = db
      .prepare(
        `
          SELECT *
          FROM final_answer_view
          WHERE answer_id = ? AND telegram_chat_id = ?
        `
      )
      .get(answerId, telegramChatId) as FinalAnswerViewRecord | undefined;

    return row ? mapFinalAnswerView(row) : null;
  };

  return {
    listRuntimeNotices(telegramChatId) {
      const rows = db
        .prepare(
          `
            SELECT *
            FROM runtime_notice
            WHERE telegram_chat_id = ?
            ORDER BY created_at ASC
          `
        )
        .all(telegramChatId) as unknown as RuntimeNoticeRecord[];

      return rows.map(mapRuntimeNotice);
    },

    countRuntimeNotices() {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM runtime_notice")
        .get() as { count: number | bigint } | undefined;

      return Number(row?.count ?? 0);
    },

    clearRuntimeNotice(key) {
      db.prepare("DELETE FROM runtime_notice WHERE key = ?").run(key);
    },

    upsertRuntimeNotices(notices) {
      const statement = db.prepare(
        `
          INSERT OR REPLACE INTO runtime_notice (
            key,
            telegram_chat_id,
            type,
            message,
            created_at
          )
          VALUES (?, ?, ?, ?, ?)
        `
      );

      for (const notice of notices) {
        statement.run(notice.key, notice.telegramChatId, notice.type, notice.message, notice.createdAt);
      }
    },

    createRuntimeNotice(options) {
      const notice: RuntimeNotice = {
        key: options.key ?? `notice:${randomUUID()}`,
        telegramChatId: options.telegramChatId,
        type: options.type,
        message: options.message,
        createdAt: nowIso()
      };

      db
        .prepare(
          `
            INSERT OR REPLACE INTO runtime_notice (
              key,
              telegram_chat_id,
              type,
              message,
              created_at
            )
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(notice.key, notice.telegramChatId, notice.type, notice.message, notice.createdAt);

      return notice;
    },

    listNoticeChatIds() {
      const rows = db
        .prepare("SELECT DISTINCT telegram_chat_id FROM runtime_notice ORDER BY telegram_chat_id ASC")
        .all() as Array<{ telegram_chat_id: string }>;

      return rows.map((row) => row.telegram_chat_id);
    },

    rebindRuntimeNoticesChatIds(telegramChatId, previousChatIds) {
      if (previousChatIds.length === 0) {
        return;
      }

      const placeholders = buildInClausePlaceholders(previousChatIds.length);
      db
        .prepare(
          `
            UPDATE runtime_notice
            SET telegram_chat_id = ?
            WHERE telegram_chat_id IN (${placeholders})
          `
        )
        .run(telegramChatId, ...previousChatIds);
    },

    getRuntimeCardPreferences() {
      const row = db
        .prepare(
          `
            SELECT *
            FROM runtime_card_preferences
            WHERE key = 'global'
          `
        )
        .get() as RuntimeCardPreferencesRecord | undefined;

      if (row) {
        return mapRuntimeCardPreferences(row);
      }

      return {
        key: "global",
        fields: [...DEFAULT_RUNTIME_STATUS_FIELDS],
        updatedAt: nowIso()
      };
    },

    setRuntimeCardPreferences(fields) {
      const updatedAt = nowIso();
      const uniqueFields = [...new Set(fields)];

      db
        .prepare(
          `
            INSERT OR REPLACE INTO runtime_card_preferences (
              key,
              fields_json,
              updated_at
            )
            VALUES ('global', ?, ?)
          `
        )
        .run(JSON.stringify(uniqueFields), updatedAt);

      return {
        key: "global",
        fields: uniqueFields,
        updatedAt
      };
    },

    getUiLanguage() {
      const row = db
        .prepare(
          `
            SELECT *
            FROM bridge_settings
            WHERE key = 'global'
          `
        )
        .get() as UiLanguageRecord | undefined;

      return row ? mapUiLanguage(row) : "zh";
    },

    setUiLanguage(language) {
      const updatedAt = nowIso();
      const next = language === "en" ? "en" : "zh";

      db
        .prepare(
          `
            INSERT OR REPLACE INTO bridge_settings (
              key,
              ui_language,
              updated_at
            )
            VALUES ('global', ?, ?)
          `
        )
        .run(next, updatedAt);

      return next;
    },

    saveFinalAnswerView(options) {
      const answerId = options.answerId ?? randomUUID();
      const createdAt = nowIso();

      db.exec("BEGIN");

      try {
        db
          .prepare(
            `
              INSERT OR REPLACE INTO final_answer_view (
                answer_id,
                telegram_chat_id,
                telegram_message_id,
                session_id,
                thread_id,
                turn_id,
                preview_html,
                pages_json,
                primary_action_consumed,
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .run(
            answerId,
            options.telegramChatId,
            options.telegramMessageId ?? null,
            options.sessionId,
            options.threadId,
            options.turnId,
            options.previewHtml,
            JSON.stringify(options.pages),
            options.primaryActionConsumed ? 1 : 0,
            createdAt
          );

        db
          .prepare(
            `
              DELETE FROM final_answer_view
              WHERE answer_id IN (
                SELECT answer_id
                FROM final_answer_view
                WHERE telegram_chat_id = ?
                ORDER BY created_at DESC, rowid DESC
                LIMIT -1 OFFSET 50
              )
            `
          )
          .run(options.telegramChatId);

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      const saved = getFinalAnswerView(answerId, options.telegramChatId);
      if (!saved) {
        throw new Error(`persisted final answer view missing after save: ${answerId}`);
      }

      return saved;
    },

    getFinalAnswerView,

    listFinalAnswerViews(telegramChatId) {
      const rows = db
        .prepare(
          `
            SELECT *
            FROM final_answer_view
            WHERE telegram_chat_id = ?
            ORDER BY created_at DESC, rowid DESC
          `
        )
        .all(telegramChatId) as unknown as FinalAnswerViewRecord[];

      return rows.map(mapFinalAnswerView);
    },

    rebindFinalAnswerViewsChatIds(telegramChatId, previousChatIds) {
      if (previousChatIds.length === 0) {
        return;
      }

      const placeholders = buildInClausePlaceholders(previousChatIds.length);
      db
        .prepare(
          `
            UPDATE final_answer_view
            SET telegram_chat_id = ?
            WHERE telegram_chat_id IN (${placeholders})
          `
        )
        .run(telegramChatId, ...previousChatIds);
    },

    setFinalAnswerMessageId(answerId, telegramMessageId) {
      db
        .prepare(
          `
            UPDATE final_answer_view
            SET telegram_message_id = ?
            WHERE answer_id = ?
          `
        )
        .run(telegramMessageId, answerId);
    },

    setFinalAnswerPrimaryActionConsumed(answerId, consumed) {
      db
        .prepare(
          `
            UPDATE final_answer_view
            SET primary_action_consumed = ?
            WHERE answer_id = ?
          `
        )
        .run(consumed ? 1 : 0, answerId);
    },

    deleteFinalAnswerView(answerId) {
      db.prepare("DELETE FROM final_answer_view WHERE answer_id = ?").run(answerId);
    },

    clearAllFinalAnswerViews() {
      db.prepare("DELETE FROM final_answer_view").run();
    },

    saveTurnInputSource(options) {
      const record: TurnInputSourceRow = {
        threadId: options.threadId,
        turnId: options.turnId,
        sourceKind: options.sourceKind,
        transcript: options.transcript,
        createdAt: nowIso()
      };

      db
        .prepare(
          `
            INSERT OR REPLACE INTO turn_input_source (
              thread_id,
              turn_id,
              source_kind,
              transcript,
              created_at
            )
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(record.threadId, record.turnId, record.sourceKind, record.transcript, record.createdAt);

      return record;
    },

    getTurnInputSource(threadId, turnId) {
      const row = db
        .prepare(
          `
            SELECT *
            FROM turn_input_source
            WHERE thread_id = ? AND turn_id = ?
          `
        )
        .get(threadId, turnId) as TurnInputSourceRecord | undefined;

      return row ? mapTurnInputSource(row) : null;
    },

    writeReadinessSnapshot(snapshot) {
      db
        .prepare(
          `
            INSERT OR REPLACE INTO bootstrap_state (
              key,
              readiness_state,
              details_json,
              checked_at,
              app_server_pid
            )
            VALUES (?, ?, ?, ?, ?)
          `
        )
        .run(
          "bootstrap",
          snapshot.state,
          JSON.stringify(snapshot.details),
          snapshot.checkedAt,
          snapshot.appServerPid ?? null
        );
    },

    getReadinessSnapshot() {
      const row = db
        .prepare(
          `
            SELECT readiness_state, details_json, checked_at, app_server_pid
            FROM bootstrap_state
            WHERE key = 'bootstrap'
          `
        )
        .get() as ReadinessRecord | undefined;

      if (!row) {
        return null;
      }

      return {
        state: row.readiness_state,
        checkedAt: row.checked_at,
        details: JSON.parse(row.details_json) as ReadinessSnapshot["details"],
        appServerPid: row.app_server_pid
      };
    }
  };
}
