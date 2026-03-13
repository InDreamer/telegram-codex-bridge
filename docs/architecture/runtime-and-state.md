# Runtime And State Architecture

## Service Shape

Run a standalone `codex-telegram-bridge` service on the VPS.

It owns:
- one long-lived local `codex app-server` child process over `stdio`
- one local persistent SQLite database
- the Telegram polling and command loop

This keeps Telegram-specific logic outside Codex core and avoids an extra network-facing transport for v1.

## Codex App-Server Integration Contract

Primary transport:
- local `stdio` connection to a long-lived `codex app-server` child process

Fallback:
- restart and reconnect to a fresh local child process, still over `stdio`

Not selected for v1:
- websocket transport

Minimum capabilities expected from app-server:
1. `initialize` / `initialized` handshake
2. create a new thread
3. resume an existing thread
4. start a turn in a selected project path
5. stream or consume turn events until completion
6. interrupt a running turn
7. provide a basic readiness signal
8. survive bridge-side reconnect logic after child restart

Integration assumptions:
- one app-server child per bridge process
- one JSON-RPC request id namespace per bridge process
- thread id is the durable foreign key from bridge session to Codex conversation
- Telegram may receive bridge-owned runtime cards before turn completion, but the final answer is still sent only after completion
- v1 does not depend on approval-request surfaces

## Runtime Surface Reduction And Final-Answer Rule

The bridge must not mirror the raw runtime notification stream into Telegram.

It should:
- listen to the mixed runtime notification stream
- reduce that stream into compact user-facing runtime surfaces
- keep one status card for the running turn
- create an optional plan card when plan state becomes available
- project command activity into the status card rather than creating per-command messages
- show the latest concrete execution command by default, with inline expand/collapse for the full command list when needed
- create separate error cards when runtime failures surface
- render runtime cards as plain-text Telegram messages rather than HTML log blocks
- keep reasoning deltas and raw token fragments out of the normal Telegram chat flow
- surface commentary only after it forms a complete progress unit
- retain richer structured detail for `/inspect` and the on-disk debug journal
- capture the final assistant message emitted before `turn/completed`
- send the final assistant message as a separate Telegram message after turn completion
- observe internal `thread/archived` / `thread/unarchived` notifications for reconciliation and drift diagnosis without exposing them as user commands

If the turn completes successfully but no final assistant message is available, send:
- `本次操作已完成，但没有可返回的最终答复。`

## SQLite State Model

Selected store:
- SQLite

Reason:
- durable enough for restart recovery
- safer than ad hoc JSON files under concurrent writes
- easy to inspect manually
- sufficient for v1 scale

Default database path:
- `~/.local/state/codex-telegram-bridge/bridge.db`

Persisted entities:

### `authorized_user`

Single allowed Telegram identity.

Important fields:
- `telegram_user_id`
- `telegram_username`
- `display_name`
- `first_seen_at`
- `updated_at`

### `pending_authorization`

Pending candidates awaiting local confirmation.

Important fields:
- `telegram_user_id`
- `telegram_chat_id`
- `telegram_username`
- `display_name`
- `first_seen_at`
- `last_seen_at`

### `chat_binding`

The Telegram chat controlled by the authorized user.

Important fields:
- `telegram_chat_id`
- `telegram_user_id`
- `active_session_id`
- `created_at`
- `updated_at`

### `session`

One bridge session maps to one Codex thread plus one selected project.

Important fields:
- `session_id`
- `telegram_chat_id`
- `thread_id`
- `display_name`
- `project_name`
- `project_path`
- `status`
- `failure_reason`
- `archived`
- `archived_at`
- `created_at`
- `last_used_at`
- `last_turn_id`
- `last_turn_status`

Allowed `status` values:
- `idle`
- `running`
- `interrupted`
- `failed`

Archive note:
- archive state is tracked separately from runtime `status`
- archived sessions are hidden from the default session list and active-session lookup

Allowed v1 `failure_reason` values:
- `bridge_restart`
- `app_server_lost`
- `turn_failed`
- `unknown`

### `recent_project`

Project recommendation memory.

Important fields:
- `project_path`
- `project_name`
- `last_used_at`
- `pinned`
- `last_session_id`
- `last_success_at`
- `source`

Allowed `source` values:
- `mru`
- `pin`
- `scan`
- `last_success`

### `project_scan_cache`

Cached discovered project candidates.

Important fields:
- `project_path`
- `project_name`
- `scan_root`
- `confidence`
- `detected_markers`
- `last_scanned_at`
- `exists_now`

### `bootstrap_state`

Latest readiness snapshot.

Important fields:
- `key`
- `readiness_state`
- `details_json`
- `checked_at`
- `app_server_pid`

## Recovery Model

On bridge startup:
1. open SQLite
2. load the latest bootstrap snapshot
3. load authorization state and chat binding
4. load sessions
5. mark any `running` session as `failed` with `failure_reason = bridge_restart`
6. probe app-server readiness
7. restore the active session pointer

If SQLite open or integrity check fails:
1. rename the broken DB to `bridge.db.corrupt.<timestamp>`
2. create a fresh database
3. set readiness to `bridge_unhealthy`
4. log the event
5. force the user to re-establish authorization locally

## Session Concurrency

v1 concurrency rules:
1. one Telegram chat may have multiple sessions
2. exactly one session is active for that chat
3. each session allows at most one active turn
4. only the active session receives normal text input

Behavioral guardrails:
- do not queue a second turn while one is still running
- reject `/use` while the active session is running
- scope `/interrupt` to the current active session only

## Failure Handling

### `codex_not_authenticated`

User sees:
- `服务器上的 Codex 还没有准备好，请先在本机完成登录或初始化。`

System behavior:
- set readiness to `codex_not_authenticated`
- refuse new turns
- keep Telegram `/status` available
- keep local `ctb doctor` available

### `app_server_unavailable`

User sees:
- `Codex 服务暂时不可用，请稍后重试。`

System behavior:
- attempt one child restart
- degrade readiness if restart fails
- preserve sessions

### `project path invalid`

User sees:
- `这个项目路径不可用，请重新选择项目。`

System behavior:
- block session creation
- do not persist the invalid path as active
- mark stale cached candidates if needed

### `scan timeout`

System behavior:
- stop scanning at 3 seconds
- preserve partial candidates
- do not fail `/new`

### `callback delivery failure`

User impact:
- callback acknowledgements may fail without a guaranteed user-visible retry message
- if Telegram refuses a runtime-card edit or rate-limits it, the visible update may land later on the same message

System behavior:
- process the downstream callback action independently of the acknowledgement result
- log callback acknowledgement failures locally
- retry the same runtime-card message after cooldown or backoff
- do not create replacement-message spam for edit failures or rate limits
- do not assume delivery succeeded unless Telegram confirms it

### `bridge restart during running turn`

User sees:
- `桥接服务已重启，正在运行的操作状态未知，请查看会话状态后重新发起。`

System behavior:
- mark all running sessions as failed
- store `failure_reason = bridge_restart`
- do not infer a final answer from a half-observed turn

### `state store corruption`

User sees:
- `桥接状态已损坏并已重置，请重新选择会话或项目。`

System behavior:
- rotate the corrupt DB
- create a fresh one
- preserve logs
- expose details in `ctb doctor`
