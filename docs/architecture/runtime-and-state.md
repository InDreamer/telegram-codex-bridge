# Runtime And State Architecture

## Service Shape

Run a standalone `codex-telegram-bridge` service on the VPS.

It owns:
- one long-lived local `codex app-server` child process over `stdio`
- one local persistent SQLite database
- the Telegram polling and command loop
- an optional voice-input pipeline that serializes Telegram voice-message transcription before handing the resulting text back into normal turn or blocked-turn continuation flow

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
- the bridge uses a persisted interaction broker for current server-request surfaces such as approvals, structured user input, elicitation, and blocked-turn continuation
- the bridge now also uses stable long-tail client requests where Telegram has a clear adapted UX, including plugin/app discovery, MCP admin discovery plus reload/login-link, account diagnostics, and background-terminal cleanup
- when voice input is enabled, the bridge may create short-lived helper threads for realtime transcription fallback, then archive those helper threads after extracting the transcript

## Runtime Surface Reduction And Final-Answer Rule

The bridge must not mirror the raw runtime notification stream into Telegram.

It should:
- listen to the mixed runtime notification stream
- reduce that stream into compact user-facing runtime surfaces
- keep one status card for the running turn
- keep only `Session`, `State`, and `Progress` as fixed runtime-card rows
- render any operator-selected optional runtime fields as one row per field instead of a single pipe-delimited summary line
- expose current plan state through a collapsed button on the status card rather than a separate plan card
- project command activity into the status card rather than creating per-command messages
- surface command activity on the status card only through the `Progress` section when a visible progress unit exists
- keep the status-card `State` label aligned with reduced app-server runtime state such as active, blocked, and terminal turn outcomes
- render status-card labels and progress content with Telegram-safe HTML rather than raw Markdown markers
- create separate error cards when runtime failures surface
- keep reasoning deltas and raw token fragments out of the normal Telegram chat flow
- treat completed `agentMessage` items with `phase = commentary` as the authoritative commentary source
- keep commentary-driven `Progress` separate from the reduced runtime `State` so phase narration does not replace the running or blocked indicator
- use the same commentary-first rule for expanded subagent rows, but let blocker text override stale commentary while the subagent is waiting on approval or user input
- resolve expanded subagent labels from protocol thread identity when available, preferring `agentNickname`, then thread title, then a local fallback label, and bound the rendered label length before building the Telegram card
- keep raw `item/agentMessage/delta` traffic out of the normal Telegram chat flow
- retain richer structured command detail for `/inspect` and the on-disk debug journal
- write bridge-owned interaction audit records into the same per-turn debug journal when pending interactions are created or reach a terminal state
- explicitly reject known-but-unsupported specialized server requests such as `item/tool/call` and `account/chatgptAuthTokens/refresh`, emit a compact Telegram notice when a turn is active, and record the rejection in the debug journal instead of pretending those surfaces are supported
- reduce stable runtime-parity signals such as token usage, diff summaries, hook summaries, terminal-interaction summaries, and selected runtime notices into `/inspect` or bridge-owned notices instead of dumping raw protocol frames
- use `serverRequest/resolved` to close matching pending interaction cards when the server resolves them independently
- when the active root turn reaches a terminal state, expire every unresolved interaction for that Telegram session, including subagent-thread requests
- if the app-server child exits mid-turn, fail every unresolved interaction for that Telegram session and clear any pending free-text interaction mode before reconnecting
- capture the final assistant message emitted before `turn/completed`
- send the final assistant message as a separate Telegram message after turn completion
- render the final assistant message with Telegram HTML derived from a safe Markdown subset rather than sending raw Markdown literals
- prefer a persisted collapsed preview plus inline expand/collapse/page controls for oversized final answers so one bridge-owned final-answer message remains readable in chat
- persist collapsed previews and rendered pages in SQLite so final-answer buttons survive bridge restart without relying on Telegram as a state store
- keep chunked `(2/N)` continuation sends only as a delivery fallback when the collapsible path cannot be established safely
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
- `selected_model`
- `selected_reasoning_effort`
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

### `runtime_notice`

Bridge-owned deferred notices when Telegram delivery fails or when restart recovery needs a user-visible follow-up.

Important fields:
- `key`
- `telegram_chat_id`
- `type`
- `message`
- `created_at`

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

Readiness details also capture:
- Node version and engine-floor support
- Codex version and minimum supported version
- service-manager health
- state/config/install root writability
- capability-check results for the required V2 app-server request and notification surface
- whether the runtime exposes the subagent identity notifications needed for protocol-backed agent naming

### `final_answer_view`

Persisted long final-answer views for restart-safe Telegram callbacks.

Important fields:
- `answer_id`
- `telegram_chat_id`
- `telegram_message_id`
- `session_id`
- `thread_id`
- `turn_id`
- `preview_html`
- `pages_json`
- `created_at`

Retention note:
- keep only the most recent 50 persisted final-answer views per Telegram chat
- do not persist the user's current expanded/collapsed state or page cursor

### `pending_interaction`

Persisted bridge-owned interaction state for app-server server requests.

Important fields:
- `interaction_id`
- `telegram_chat_id`
- `session_id`
- `thread_id`
- `turn_id`
- `request_id`
- `request_method`
- `interaction_kind`
- `state`
- `prompt_json`
- `response_json`
- `telegram_message_id`
- `created_at`
- `updated_at`
- `resolved_at`
- `error_reason`

Allowed `state` values:
- `pending`
- `awaiting_text`
- `answered`
- `canceled`
- `expired`
- `failed`

Behavior notes:
- `request_id` is stored as serialized JSON-RPC id text so numeric and string ids round-trip exactly
- `/inspect` only shows unresolved pending interactions, which means `pending` and `awaiting_text`
- `canceled` is reserved for explicit user cancellation, not timeout or bridge failure cleanup
- terminal turn cleanup is session-scoped, not root-thread-scoped, so subagent interactions do not survive after the parent turn ends

## Recovery Model

On bridge startup:
1. open SQLite
2. load the latest bootstrap snapshot
3. load authorization state and chat binding
4. load sessions
5. mark any `running` session as `failed` with `failure_reason = bridge_restart`
6. mark unresolved pending interactions from those running sessions as `failed`
7. append interaction-resolution audit records for that recovery cleanup
8. probe app-server readiness
9. restore the active session pointer

Readiness / preflight rules:
- unsupported Node runtime is a hard failure
- unsupported Codex version or missing required app-server surface is a hard failure
- missing writable state or config roots is a hard failure
- missing local service-manager support is a warning only
- the bridge must not enter the Telegram polling loop unless readiness is `ready` or `awaiting_authorization`

If SQLite open or integrity check fails:
1. fail closed without replacing the database
2. write a classified failure marker under state root
3. log the failure with stage and classification
4. stop bridge startup before the Telegram polling loop
5. require manual inspection instead of destructive auto-recovery

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

## Doctor-Only Archive Drift Diagnostics

`ctb doctor` may run an explicit archive drift scan when readiness is otherwise healthy.

Rules:
- local `session.archived` remains the Telegram UX source of truth
- the scan compares local sessions with `threadId` against remote `thread/list` membership for both archived and visible threads
- drift results are operator diagnostics only
- the scan does not mutate local state
- the scan does not auto-repair remote state

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
