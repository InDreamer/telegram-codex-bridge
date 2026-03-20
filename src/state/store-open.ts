import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { ALL_RUNTIME_STATUS_FIELDS, DEFAULT_RUNTIME_STATUS_FIELDS } from "../types.js";
import type { RuntimeStatusField } from "../types.js";
import { nowIso } from "../util/time.js";
import type {
  StateStoreFailureClassification,
  StateStoreFailureRecord,
  StateStoreOpenStage
} from "./store.js";

interface RuntimeCardPreferencesRecord {
  key: "global";
  fields_json: string;
  updated_at: string;
}

const LEGACY_RUNTIME_STATUS_FIELD_MIGRATIONS: ReadonlyMap<string, RuntimeStatusField> = new Map([
  ["project_path", "current-dir"],
  ["model_reasoning", "model-with-reasoning"],
  ["thread_id", "session-id"]
]);
const RUNTIME_STATUS_FIELD_V4_MIGRATION_CUTOFF = "2026-03-17T00:00:00.000Z";
const CURRENT_SCHEMA_VERSION = 15;

export function parseRuntimeStatusFields(fieldsJson: string): RuntimeStatusField[] {
  try {
    const parsed = JSON.parse(fieldsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_RUNTIME_STATUS_FIELDS];
    }

    const allowed = new Set<RuntimeStatusField>(ALL_RUNTIME_STATUS_FIELDS);
    const fields = parsed.filter((field): field is RuntimeStatusField =>
      typeof field === "string" && allowed.has(field as RuntimeStatusField)
    );
    if (parsed.length === 0) {
      return [];
    }

    return fields.length > 0 ? fields : [...DEFAULT_RUNTIME_STATUS_FIELDS];
  } catch {
    return [...DEFAULT_RUNTIME_STATUS_FIELDS];
  }
}

export function migrateRuntimeStatusFields(fieldsJson: string): RuntimeStatusField[] | null {
  try {
    const parsed = JSON.parse(fieldsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }

    const allowed = new Set<RuntimeStatusField>(ALL_RUNTIME_STATUS_FIELDS);
    const migrated = parsed.flatMap((field): RuntimeStatusField[] => {
      if (typeof field !== "string") {
        return [];
      }

      const mapped = LEGACY_RUNTIME_STATUS_FIELD_MIGRATIONS.get(field) ?? field;
      return allowed.has(mapped as RuntimeStatusField) ? [mapped as RuntimeStatusField] : [];
    });

    if (parsed.length === 0) {
      return [];
    }

    const uniqueFields = [...new Set(migrated)];
    return uniqueFields.length > 0 ? uniqueFields : [...DEFAULT_RUNTIME_STATUS_FIELDS];
  } catch {
    return null;
  }
}

export function shouldMigrateRuntimeStatusFields(updatedAt: string): boolean {
  return updatedAt < RUNTIME_STATUS_FIELD_V4_MIGRATION_CUTOFF;
}

function initialSchema(): string {
  return `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS authorized_user (
      telegram_user_id TEXT PRIMARY KEY,
      telegram_username TEXT NULL,
      display_name TEXT NULL,
      first_seen_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_authorization (
      telegram_user_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      telegram_username TEXT NULL,
      display_name TEXT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_binding (
      telegram_chat_id TEXT PRIMARY KEY,
      telegram_user_id TEXT NOT NULL,
      active_session_id TEXT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session (
      session_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      thread_id TEXT NULL,
      selected_model TEXT NULL,
      selected_reasoning_effort TEXT NULL,
      plan_mode INTEGER NOT NULL DEFAULT 0,
      pending_default_collaboration_mode_reset INTEGER NOT NULL DEFAULT 0,
      display_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL,
      failure_reason TEXT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      last_turn_id TEXT NULL,
      last_turn_status TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS recent_project (
      project_path TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      project_alias TEXT NULL,
      last_used_at TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      last_session_id TEXT NULL,
      last_success_at TEXT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_scan_cache (
      project_path TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      scan_root TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      detected_markers TEXT NOT NULL,
      last_scanned_at TEXT NOT NULL,
      exists_now INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bootstrap_state (
      key TEXT PRIMARY KEY,
      readiness_state TEXT NOT NULL,
      details_json TEXT NOT NULL,
      checked_at TEXT NOT NULL,
      app_server_pid TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_notice (
      key TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      parse_mode TEXT NULL,
      reply_markup_json TEXT NULL,
      session_id TEXT NULL,
      turn_id TEXT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS final_answer_view (
      answer_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      telegram_message_id INTEGER NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'final_answer',
      delivery_state TEXT NOT NULL DEFAULT 'pending',
      preview_html TEXT NOT NULL,
      pages_json TEXT NOT NULL,
      primary_action_consumed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runtime_card_preferences (
      key TEXT PRIMARY KEY,
      fields_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_settings (
      key TEXT PRIMARY KEY,
      ui_language TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_interaction (
      interaction_id TEXT PRIMARY KEY,
      telegram_chat_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_method TEXT NOT NULL,
      interaction_kind TEXT NOT NULL,
      state TEXT NOT NULL,
      prompt_json TEXT NOT NULL,
      response_json TEXT NULL,
      telegram_message_id INTEGER NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT NULL,
      error_reason TEXT NULL
    );

    CREATE TABLE IF NOT EXISTS turn_input_source (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      transcript TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pending_authorization_last_seen
      ON pending_authorization(last_seen_at DESC);

    CREATE INDEX IF NOT EXISTS idx_session_chat_id
      ON session(telegram_chat_id);

    CREATE INDEX IF NOT EXISTS idx_final_answer_view_chat_created_at
      ON final_answer_view(telegram_chat_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pending_interaction_chat_state
      ON pending_interaction(telegram_chat_id, state, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_pending_interaction_turn
      ON pending_interaction(thread_id, turn_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_turn_input_source_thread_created_at
      ON turn_input_source(thread_id, created_at DESC);
  `;
}

function listColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function hasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  return listColumns(db, tableName).includes(columnName);
}

function getAppliedMigrations(db: DatabaseSync): Set<number> {
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number | bigint }>;

  return new Set(rows.map((row) => Number(row.version)));
}

function recordMigration(db: DatabaseSync, version: number): void {
  db.prepare(
    `
      INSERT OR REPLACE INTO schema_migrations (version, applied_at)
      VALUES (?, ?)
    `
  ).run(version, nowIso());
}

function applyMigrations(db: DatabaseSync): void {
  db.exec(
    `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `
  );

  const applied = getAppliedMigrations(db);

  if (!applied.has(1)) {
    db.exec(initialSchema());
    recordMigration(db, 1);
  }

  if (!applied.has(2)) {
    if (!hasColumn(db, "session", "archived")) {
      db.exec("ALTER TABLE session ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }

    if (!hasColumn(db, "session", "archived_at")) {
      db.exec("ALTER TABLE session ADD COLUMN archived_at TEXT NULL");
    }

    recordMigration(db, 2);
  }

  if (!applied.has(3)) {
    db.exec(
      `
        CREATE TABLE IF NOT EXISTS final_answer_view (
          answer_id TEXT PRIMARY KEY,
          telegram_chat_id TEXT NOT NULL,
          telegram_message_id INTEGER NULL,
          session_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'final_answer',
          delivery_state TEXT NOT NULL DEFAULT 'pending',
          preview_html TEXT NOT NULL,
          pages_json TEXT NOT NULL,
          primary_action_consumed INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `
    );
    db.exec(
      `
        CREATE INDEX IF NOT EXISTS idx_final_answer_view_chat_created_at
          ON final_answer_view(telegram_chat_id, created_at DESC)
      `
    );

    recordMigration(db, 3);
  }

  if (!applied.has(4)) {
    db.exec(
      `
        CREATE TABLE IF NOT EXISTS pending_interaction (
          interaction_id TEXT PRIMARY KEY,
          telegram_chat_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          request_method TEXT NOT NULL,
          interaction_kind TEXT NOT NULL,
          state TEXT NOT NULL,
          prompt_json TEXT NOT NULL,
          response_json TEXT NULL,
          telegram_message_id INTEGER NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          resolved_at TEXT NULL,
          error_reason TEXT NULL
        )
      `
    );
    db.exec(
      `
        CREATE INDEX IF NOT EXISTS idx_pending_interaction_chat_state
          ON pending_interaction(telegram_chat_id, state, created_at DESC)
      `
    );
    db.exec(
      `
        CREATE INDEX IF NOT EXISTS idx_pending_interaction_turn
          ON pending_interaction(thread_id, turn_id, created_at DESC)
      `
    );

    recordMigration(db, 4);
  }

  if (!applied.has(5)) {
    if (!hasColumn(db, "session", "selected_model")) {
      db.exec("ALTER TABLE session ADD COLUMN selected_model TEXT NULL");
    }

    recordMigration(db, 5);
  }

  if (!applied.has(6)) {
    if (!hasColumn(db, "session", "selected_reasoning_effort")) {
      db.exec("ALTER TABLE session ADD COLUMN selected_reasoning_effort TEXT NULL");
    }

    recordMigration(db, 6);
  }

  if (!applied.has(7)) {
    if (!hasColumn(db, "recent_project", "project_alias")) {
      db.exec("ALTER TABLE recent_project ADD COLUMN project_alias TEXT NULL");
    }

    recordMigration(db, 7);
  }

  if (!applied.has(8)) {
    db.exec(
      `
        CREATE TABLE IF NOT EXISTS runtime_card_preferences (
          key TEXT PRIMARY KEY,
          fields_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `
    );

    db.exec(
      `
        CREATE TABLE IF NOT EXISTS turn_input_source (
          thread_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          transcript TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, turn_id)
        )
      `
    );

    db.exec(
      `
        CREATE INDEX IF NOT EXISTS idx_turn_input_source_thread_created_at
          ON turn_input_source(thread_id, created_at DESC)
      `
    );

    recordMigration(db, 8);
  }

  if (!applied.has(9)) {
    if (appliedTableExists(db, "runtime_card_preferences")) {
      const rows = db
        .prepare(
          `
            SELECT key, fields_json, updated_at
            FROM runtime_card_preferences
          `
        )
        .all() as unknown as RuntimeCardPreferencesRecord[];

      const updatePreference = db.prepare(
        `
          UPDATE runtime_card_preferences
          SET fields_json = ?
          WHERE key = ?
        `
      );

      for (const row of rows) {
        if (!shouldMigrateRuntimeStatusFields(row.updated_at)) {
          continue;
        }

        const migrated = migrateRuntimeStatusFields(row.fields_json);
        if (!migrated) {
          continue;
        }

        updatePreference.run(JSON.stringify(migrated), row.key);
      }
    }

    recordMigration(db, 9);
  }

  if (!applied.has(10)) {
    if (!hasColumn(db, "session", "plan_mode")) {
      db.exec("ALTER TABLE session ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0");
    }

    recordMigration(db, 10);
  }

  if (!applied.has(11)) {
    if (!hasColumn(db, "session", "pending_default_collaboration_mode_reset")) {
      db.exec(
        "ALTER TABLE session ADD COLUMN pending_default_collaboration_mode_reset INTEGER NOT NULL DEFAULT 0"
      );
    }

    recordMigration(db, 11);
  }

  if (!applied.has(12)) {
    db.exec(
      `
        CREATE TABLE IF NOT EXISTS bridge_settings (
          key TEXT PRIMARY KEY,
          ui_language TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `
    );

    recordMigration(db, 12);
  }

  if (!applied.has(13)) {
    if (!hasColumn(db, "final_answer_view", "primary_action_consumed")) {
      db.exec("ALTER TABLE final_answer_view ADD COLUMN primary_action_consumed INTEGER NOT NULL DEFAULT 0");
    }

    recordMigration(db, 13);
  }

  if (!applied.has(14)) {
    if (!hasColumn(db, "runtime_notice", "parse_mode")) {
      db.exec("ALTER TABLE runtime_notice ADD COLUMN parse_mode TEXT NULL");
    }
    if (!hasColumn(db, "runtime_notice", "reply_markup_json")) {
      db.exec("ALTER TABLE runtime_notice ADD COLUMN reply_markup_json TEXT NULL");
    }
    if (!hasColumn(db, "runtime_notice", "session_id")) {
      db.exec("ALTER TABLE runtime_notice ADD COLUMN session_id TEXT NULL");
    }
    if (!hasColumn(db, "runtime_notice", "turn_id")) {
      db.exec("ALTER TABLE runtime_notice ADD COLUMN turn_id TEXT NULL");
    }

    recordMigration(db, 14);
  }

  if (!applied.has(15)) {
    if (!hasColumn(db, "final_answer_view", "kind")) {
      db.exec("ALTER TABLE final_answer_view ADD COLUMN kind TEXT NOT NULL DEFAULT 'final_answer'");
    }
    if (!hasColumn(db, "final_answer_view", "delivery_state")) {
      db.exec("ALTER TABLE final_answer_view ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'");
    }

    db.exec(
      `
        UPDATE final_answer_view
        SET delivery_state = CASE
          WHEN telegram_message_id IS NOT NULL THEN 'visible'
          ELSE 'pending'
        END
        WHERE delivery_state NOT IN ('pending', 'visible', 'deferred_notice_visible')
           OR delivery_state IS NULL
      `
    );

    recordMigration(db, 15);
  }
}

export function openInitializedDatabase(dbPath: string): DatabaseSync {
  const db = withStateStoreFailureStage("open_db", () => new DatabaseSync(dbPath));
  withStateStoreFailureStage("initialize_schema", () => initializeDatabase(db));
  withStateStoreFailureStage("verify_integrity", () => verifyIntegrity(db));
  return db;
}

function initializeDatabase(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);

  const applied = getAppliedMigrations(db);
  if (!applied.has(CURRENT_SCHEMA_VERSION)) {
    throw new Error(`schema migrations incomplete; expected version ${CURRENT_SCHEMA_VERSION}`);
  }
}

export function appliedTableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare(
      `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
      `
    )
    .get(tableName) as { name: string } | undefined;

  return Boolean(row?.name);
}

function verifyIntegrity(db: DatabaseSync): void {
  const result = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  if (result.integrity_check !== "ok") {
    throw new Error(`sqlite integrity check failed: ${result.integrity_check}`);
  }
}

function isCorruptionLikeError(error: unknown): boolean {
  const message = `${error}`.toLowerCase();
  return message.includes("sqlite integrity check failed")
    || message.includes("database disk image is malformed")
    || message.includes("file is not a database");
}

function isSchemaLikeError(error: unknown): boolean {
  const message = `${error}`.toLowerCase();
  return message.includes("schema migrations incomplete")
    || message.includes("malformed database schema")
    || message.includes("no such table")
    || message.includes("no such column")
    || message.includes("table ") && message.includes("already exists");
}

function recommendedActionForClassification(classification: StateStoreFailureClassification): string {
  switch (classification) {
    case "integrity_failure":
      return "Do not replace the database. Copy bridge.db for offline inspection, run integrity_check manually, and restore from a known-good backup if needed.";
    case "schema_failure":
      return "Do not replace the database. Inspect migration/state-store logs, verify the running binary version, and fix the schema issue before restarting.";
    case "transient_open_failure":
    default:
      return "Retry service start after checking for transient filesystem or locking issues. Do not rotate or delete the database.";
  }
}

function classifyStateStoreFailure(error: unknown): StateStoreFailureClassification {
  if (isSchemaLikeError(error)) {
    return "schema_failure";
  }

  if (isCorruptionLikeError(error)) {
    return "integrity_failure";
  }

  return "transient_open_failure";
}

export function getStateStoreFailureStage(error: unknown): StateStoreOpenStage {
  const stage = (error as { stateStoreOpenStage?: StateStoreOpenStage }).stateStoreOpenStage;
  return stage ?? "open_db";
}

export function withStateStoreFailureStage<T>(stage: StateStoreOpenStage, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    (error as { stateStoreOpenStage?: StateStoreOpenStage }).stateStoreOpenStage = stage;
    throw error;
  }
}

export function buildStateStoreFailure(
  dbPath: string,
  stage: StateStoreOpenStage,
  error: unknown
): StateStoreFailureRecord {
  const classification = classifyStateStoreFailure(error);
  return {
    detectedAt: nowIso(),
    dbPath,
    stage,
    classification,
    error: `${error}`,
    recommendedAction: recommendedActionForClassification(classification)
  };
}

async function writeStateStoreFailure(paths: BridgePaths, failure: StateStoreFailureRecord): Promise<void> {
  await mkdir(dirname(paths.stateStoreFailurePath), { recursive: true });
  await writeFile(paths.stateStoreFailurePath, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
}

export async function persistStateStoreFailure(
  paths: BridgePaths,
  failure: StateStoreFailureRecord,
  logger: Logger
): Promise<void> {
  try {
    await writeStateStoreFailure(paths, failure);
  } catch (markerError) {
    await logger.warn("state store failure marker write failed", {
      dbPath: failure.dbPath,
      markerPath: paths.stateStoreFailurePath,
      error: `${markerError}`
    }).catch(() => {});
  }
}

export async function logStateStoreOpenFailure(
  logger: Logger,
  failure: StateStoreFailureRecord
): Promise<void> {
  await logger.error("state store open failed", { ...failure }).catch(() => {});
}

export async function clearStateStoreFailure(paths: BridgePaths): Promise<void> {
  try {
    await unlink(paths.stateStoreFailurePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function readStateStoreFailure(paths: BridgePaths): Promise<StateStoreFailureRecord | null> {
  try {
    const content = await readFile(paths.stateStoreFailurePath, "utf8");
    return JSON.parse(content) as StateStoreFailureRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}
