# Telegram Codex Bridge v1 Engineering Plan Draft

## Goal

Build a VPS-hosted Telegram bridge that wakes and controls the Codex installation that already exists on the server.

Telegram is the control surface.
Codex remains the execution engine.
The bridge is not a second Codex environment, not a new provider configuration layer, and not a second permission system.

## v1 Product Boundary

### In scope

- single authorized Telegram user
- Telegram private chat only
- one bridge service per server
- reuse the server's existing Codex environment
- project-aware session startup
- final-answer-only Telegram output
- multiple sessions with switching
- one active session per chat
- one-line install plus local self-check
- operator-managed full access / no-Telegram-approval runtime model

### Out of scope

- group chats
- multi-user access
- Telegram-side execution policy beyond access identity
- rich streaming of tool calls, patches, or reasoning
- Telegram-driven provider/model setup
- Codex approval relay
- Telegram approval UI / approval callback flow
- a first-class Telegram transport inside Codex core

## v1 Runtime Assumption

v1 assumes the server operator intentionally runs Codex in a **full access / no-Telegram-approval** mode.

That means:
- Telegram does not provide a second approval barrier
- bridge does not wait for user confirmation before allowing Codex to proceed
- execution risk is intentionally accepted by the server operator as part of the deployment model

This is a deliberate product-scope decision, not a missing feature.

Future versions may add approval relay and Telegram-side confirmation, but v1 does not depend on that path.

## v1 Architecture

### Recommended shape

Run a standalone `codex-telegram-bridge` service on the VPS. It owns one long-lived local `codex app-server` child process and communicates with it over local `stdio`.

Components:

1. `codex-telegram-bridge`
   - receives Telegram updates
   - owns bridge state and session state
   - starts and supervises one local `codex app-server` child process
   - translates Telegram commands into app-server requests
   - relays final answers back to Telegram

2. local `codex app-server` child process
   - owned by the bridge process
   - owns threads, turns, interrupt, and execution lifecycle

3. local persistent state store
   - remembers authorization, sessions, project recommendations, and health snapshots

This avoids invasive Codex core changes and keeps Telegram-specific logic outside the Codex codebase.

---

## Authorization Model

### Single authorized Telegram user

v1 supports exactly one authorized Telegram user.

The bridge must reject every Telegram update from any other user before session lookup or Codex interaction.

### First bind flow

**Selected v1 flow:** Telegram first contact + local administrator confirmation.

Reason:
- easiest setup path for a real user
- no need to manually type a Telegram user id during install
- avoids accidental silent binding
- still keeps authorization under local server administrator control

### First bind sequence

1. installer finishes and bridge starts in `awaiting_authorization` mode
2. no `authorized_user` row exists yet
3. first Telegram private message received from any user is treated as an authorization candidate
4. bridge stores candidate info in a temporary pending-authorization record
5. bridge replies to that Telegram user:
   - `这台服务器还没有绑定 Telegram 账号，请等待管理员在本机确认。`
6. local administrator runs:
   - `ctb authorize pending`
7. local CLI shows:
   - Telegram user id
   - username
   - display name
   - first seen time
8. local administrator confirms that pending user
9. bridge writes `authorized_user` and `chat_binding`
10. bridge leaves `awaiting_authorization` mode and starts normal operation

### Multiple pending authorization candidates

If more than one Telegram user contacts the bot before authorization is confirmed:

- `ctb authorize pending` defaults to listing **all pending candidates**, newest first
- each candidate row must include:
  - index
  - Telegram user id
  - username
  - display name
  - first seen time
  - last seen time
- administrator selects a specific candidate with:
  - `ctb authorize pending --select <index>`
  - or `ctb authorize pending --user-id <telegram_user_id>`

For convenience, v1 also supports:
- `ctb authorize pending --latest`

This confirms the most recently seen pending candidate.

### Candidate expiry and deduplication

Pending authorization candidate rules:

- pending candidate TTL: **24 hours**
- same Telegram user contacting again before expiry updates `last_seen_at`, but does not create a duplicate row
- expired pending candidates are not auto-confirmed
- `ctb authorize pending` must hide expired candidates by default and support optional listing of expired ones only for diagnostics
- if administrator tries to confirm an expired candidate, command fails and instructs the user to message the bot again

### Rebind / change account flow

If the administrator wants to replace the authorized Telegram account:

1. run local command:
   - `ctb authorize clear`
2. bridge removes `authorized_user`, `chat_binding`, and all pending authorization candidates
3. existing sessions remain in state store but are no longer reachable from Telegram until a new user is bound
4. bridge returns to `awaiting_authorization` mode
5. new Telegram account sends a private message
6. local administrator confirms with:
   - `ctb authorize pending`

### Rebind after state reset or DB corruption

If state reset or DB recreation occurs:

1. no `authorized_user` row exists
2. bridge enters `awaiting_authorization`
3. any incoming Telegram user becomes a pending authorization candidate
4. administrator must confirm locally again
5. no previous authorization is trusted after DB reset

### Unauthorized user rejection behavior

User-facing response:
- `这个 Telegram 账号无权访问此服务器上的 Codex。`

System behavior:
- do not create session
- do not forward message to Codex
- log rejection with Telegram user id and chat id
- rate-limit repeated unauthorized responses to avoid spam

---

## Phase 0: app-server Protocol Verification

Before implementation starts, perform a mandatory protocol verification phase against a real local `codex app-server` instance.

This phase exists to replace abstract assumptions with observed protocol facts.

### Required verification checklist

The team must verify, with real traffic capture, the exact request and event names for:

1. initialize / initialized
2. create thread
3. resume thread
4. start turn
5. final answer extraction path
6. interrupt
7. failure / connection-close behavior

Approval request / response is explicitly **out of scope for v1** and is not a Phase 0 blocker.

### Startup-layer verification

Phase 0 must also verify the real app-server startup contract on the target VPS:

1. **local start command**
   - exact binary name
   - exact subcommand
   - exact invocation form used by the bridge

2. **required parameters / flags**
   - whether app-server needs any explicit `--listen` or mode flags for stdio usage
   - whether any client identity fields are mandatory during initialize
   - whether any environment variables are required for startup

3. **startup timeout**
   - define the maximum time the bridge will wait for app-server to become ready
   - v1 target: **5 seconds** from child spawn to successful initialize/initialized completion

4. **stdout / stderr behavior**
   - verify stdout is reserved for protocol frames only
   - verify diagnostic logs, if any, go to stderr
   - verify no startup banner or noise corrupts JSON-RPC framing on stdout

5. **ready detection rule**
   - app-server is considered truly ready only when:
     - child process is alive
     - stdio pipes are open
     - initialize request succeeds
     - initialized notification is accepted
     - at least one minimal follow-up request succeeds or the protocol spec confirms initialize completion is sufficient

### Required outputs of Phase 0

Before Phase 1 starts, append a protocol appendix to this document containing:

- exact JSON-RPC method names
- exact event/notification names
- minimal request payload examples
- minimal response payload examples
- exact field names needed for:
  - thread id
  - turn id
  - final assistant message
  - interrupt target
- exact local app-server start command used by the bridge
- exact startup timeout and ready-detection rule
- any observed protocol mismatches from this plan

### Phase 0 acceptance rule

Phase 1 may start after the v1 in-scope protocol surface above is verified and documented in the appendix.

If real app-server behavior differs from this plan, the real protocol wins and this document must be updated before coding.

---

## 1) Bridge 与 codex app-server 的技术契约

### v1 主选 transport

**Primary:** local `stdio` connection to a long-lived `codex app-server` child process owned by the bridge.

Reason:
- same-host deployment
- avoids depending on websocket stability
- simplest trust boundary for a VPS-local bridge
- easiest to restart and reconnect deterministically
- no second service lifecycle to manage for app-server

**Fallback:** restart and reconnect to a fresh local `codex app-server` child process, still over local `stdio`.

**Not selected for v1:** websocket transport.

Reason:
- app-server README marks websocket as experimental/unsupported
- adds a network-facing failure mode without v1 benefit

### v1 app-server capability contract

The bridge assumes the following minimum app-server capabilities exist and are stable enough to integrate against:

1. **initialize / initialized handshake**
   - bridge can open a connection, send initialize, then send initialized
   - failure means app-server is not ready

2. **create thread/session**
   - bridge can create a new thread for a new Telegram session
   - result returns a stable thread identifier

3. **resume thread**
   - bridge can continue an existing thread by thread id
   - used after `/use`, restart recovery, and continued chat messages

4. **start turn**
   - bridge can submit user text to a specific thread
   - bridge can pass the selected project path as the execution directory for that turn

5. **stream or consume turn events until completion**
   - bridge can observe the turn lifecycle
   - bridge can detect final completion
   - bridge can extract the final assistant message from the turn

6. **interrupt**
   - bridge can interrupt a running turn for a specific thread/session

7. **health/readiness**
   - bridge can verify app-server startup and basic responsiveness with a minimal handshake plus follow-up probe

8. **reconnect/recover**
   - if the child app-server process dies, bridge can start a new child and reconnect
   - existing bridge session metadata remains local and survives reconnect

### v1 interface assumptions

The bridge will implement against the following engineering assumptions:

- one long-lived local app-server child process per bridge process
- one JSON-RPC request id namespace per bridge process
- one app-server connection per bridge service instance
- thread id is the durable foreign key from bridge session to Codex conversation
- turn completion is the only point at which the bridge sends the final assistant reply to Telegram
- v1 does not depend on any approval request surface

### Final-answer extraction rule

The bridge must not forward intermediate tool events.

The bridge will:
- listen to turn/item events
- ignore reasoning, tool progress, and intermediate logs
- capture the final assistant message emitted before `turn/completed`
- send only that final assistant message to Telegram

If no final assistant message is emitted but the turn completes successfully, the bridge sends:
- `本次操作已完成，但没有可返回的最终答复。`

### v1 degradation rules

If app-server capability is unstable, v1 degrades as follows:

- **stream unstable but turn completes and thread can be resumed:**
  - do not stream live output
  - fetch or reconstruct only the final answer at completion if available

- **interrupt unavailable:**
  - bridge keeps `/interrupt` command visible only when health state says interrupt is supported
  - otherwise user sees: `当前无法中断正在运行的操作。`

- **app-server child process exits unexpectedly:**
  - mark bridge health degraded
  - restart child app-server once automatically
  - reattach bridge connection
  - keep local sessions
  - user sees on next action: `Codex 服务已恢复连接，请继续。`

---

## 2) 本地状态存储方案与数据模型

### v1 storage choice

**Selected:** SQLite.

Reason:
- durable enough for restart recovery
- safer than ad hoc JSON files under concurrent updates
- simple local deployment story on VPS
- easy to inspect manually for debugging
- sufficient for v1 scale

**Not selected for v1:** JSON file primary store.

Reason:
- higher corruption risk on crash/partial write
- weaker tooling for diagnostics

### Database location

Default path:
- `~/.local/state/codex-telegram-bridge/bridge.db`

### Persisted entities

#### 1. `authorized_user`

Stores the single allowed Telegram identity.

Fields:
- `telegram_user_id` TEXT PRIMARY KEY
- `telegram_username` TEXT NULL
- `display_name` TEXT NULL
- `first_seen_at` TEXT
- `updated_at` TEXT

#### 2. `pending_authorization`

Stores first-contact candidates awaiting local admin confirmation.

Fields:
- `telegram_user_id` TEXT PRIMARY KEY
- `telegram_chat_id` TEXT
- `telegram_username` TEXT NULL
- `display_name` TEXT NULL
- `first_seen_at` TEXT
- `last_seen_at` TEXT

#### 3. `chat_binding`

Stores the Telegram chat controlled by the authorized user.

Fields:
- `telegram_chat_id` TEXT PRIMARY KEY
- `telegram_user_id` TEXT
- `active_session_id` TEXT NULL
- `created_at` TEXT
- `updated_at` TEXT

#### 4. `session`

One bridge session maps to one Codex thread plus one selected project.

Fields:
- `session_id` TEXT PRIMARY KEY
- `telegram_chat_id` TEXT
- `thread_id` TEXT NULL
- `display_name` TEXT
- `project_name` TEXT
- `project_path` TEXT
- `status` TEXT
- `failure_reason` TEXT NULL
- `created_at` TEXT
- `last_used_at` TEXT
- `last_turn_id` TEXT NULL
- `last_turn_status` TEXT NULL

Allowed `status` values:
- `idle`
- `running`
- `interrupted`
- `failed`

`failure_reason` allowed values for v1:
- `bridge_restart`
- `app_server_lost`
- `turn_failed`
- `unknown`

#### 5. `recent_project`

Stores project usage for recommendations.

Fields:
- `project_path` TEXT PRIMARY KEY
- `project_name` TEXT
- `last_used_at` TEXT
- `pinned` INTEGER
- `last_session_id` TEXT NULL
- `last_success_at` TEXT NULL
- `source` TEXT

Allowed `source` values:
- `mru`
- `pin`
- `scan`
- `last_success`

#### 6. `project_scan_cache`

Caches discovered project candidates.

Fields:
- `project_path` TEXT PRIMARY KEY
- `project_name` TEXT
- `scan_root` TEXT
- `confidence` INTEGER
- `detected_markers` TEXT
- `last_scanned_at` TEXT
- `exists_now` INTEGER

#### 7. `bootstrap_state`

Stores the last bridge readiness snapshot.

Fields:
- `key` TEXT PRIMARY KEY
- `readiness_state` TEXT
- `details_json` TEXT
- `checked_at` TEXT
- `app_server_pid` TEXT NULL

### Restart recovery logic

On bridge startup:

1. open SQLite
2. load latest `bootstrap_state`
3. load authorized Telegram user and chat binding
4. load pending authorization candidates
5. load sessions
6. mark any `session.status = running` as:
   - `status = failed`
   - `failure_reason = bridge_restart`
7. probe app-server readiness
8. restore `active_session_id` for each chat binding

### State corruption fallback

If SQLite open fails or integrity check fails:

1. rename broken DB to `bridge.db.corrupt.<timestamp>`
2. create a fresh database
3. set readiness to `bridge_unhealthy`
4. log the corruption event
5. user sees: `桥接状态已重置，请重新选择会话或项目。`

No silent recovery.

---

## 3) 项目发现与推荐机制的可执行规则

### Scan roots

v1 scans these roots in order:

1. `~/Repo`
2. `~/workspace`
3. `~/code`

### Usable project detection rules

A directory is considered a candidate project if at least one of the following is true:

- contains `.git/`
- contains `package.json`
- contains `pyproject.toml`
- contains `Cargo.toml`
- contains `go.mod`
- contains `.jj/`

A directory is excluded if:
- it is hidden and not explicitly pinned
- it matches common dependency/build dirs:
  - `node_modules`
  - `.venv`
  - `venv`
  - `dist`
  - `build`
  - `target`
  - `.next`
  - `.turbo`

### Scan depth and limits

v1 scan limits:

- max depth: **3** levels below each root
- max candidates collected: **200** total
- max scan time: **3 seconds** total per `/new` request
- max displayed recommendations: **1 primary + 5 frequent + 2 fallback actions**

### Recommendation scoring

Candidate score is computed using these fixed signals:

- `+100` pinned project
- `+80` last successful project
- `+60` most recently used project
- `+40` has existing session history
- `+20` discovered from scan and still exists
- `-50` path missing or inaccessible

Tie-breakers in order:
1. latest `last_used_at`
2. pinned first
3. lexical project name

### Selection output rules

On `/new`, bridge renders:

- **primary recommendation:** top-ranked candidate if score >= 60
- **other frequent projects:** next up to 5 candidates
- **fallback actions:** always show
  - `扫描更多仓库`
  - `手动输入路径`

### Large-directory degradation

If the scan hits time or count limits:
- keep already collected candidates
- stop scanning
- annotate internal scan result as partial
- user still sees recommendations and fallback actions
- do not fail `/new`

### Scan failure degradation

If all scan roots fail:
- use only MRU and pinned projects
- if none exist, show only fallback actions
- user sees: `未找到推荐项目，请扫描更多仓库或手动输入路径。`

---

## 4) Telegram 交互协议

### Common response rule

Telegram is not a debug console. Every command returns a compact user-facing response.

### `/new`

Return structure:
- title: `选择这次要操作的项目`
- optional primary recommendation button
- frequent project buttons
- fallback buttons

Primary button copy examples:
- `继续上次项目：{project_name}`
- `进入项目：{project_name}`

### `扫描更多仓库`

Interaction model:
- clicking `扫描更多仓库` sends a **new message** from the bridge
- bridge does not edit the original project picker into a loading spinner for v1
- new message content:
  - `正在扫描更多项目，请稍候…`
- after scan completes, bridge sends another **new message** with a refreshed project picker

If scan produces no new results:
- send new message:
  - `没有发现更多可用项目，请手动输入路径。`
- include action buttons:
  - `手动输入路径`
  - `返回项目列表`

### `手动输入路径`

Interaction model:
- clicking `手动输入路径` sends a **new message** from the bridge
- bridge sets chat mode to `awaiting_manual_project_path` for the current active picker flow
- prompt text:
  - `请发送项目路径，例如：/home/ubuntu/Repo/openclaw`
  - `发送 /cancel 返回项目列表。`

Manual path handling steps:
1. user sends plain text path
2. bridge validates path exists
3. bridge validates path matches usable-project rules
4. if valid, bridge sends confirmation message:
   - `在这个项目中开始会话？`
   - show project name
   - show project path
   - buttons:
     - `确认进入项目`
     - `返回项目列表`
5. if confirmed, create session and continue normal flow

### Invalid manual path feedback

If the user sends an invalid path while in `awaiting_manual_project_path` mode:
- bridge sends a **new message**
- message text:
  - `这个路径不可用，请重新发送项目路径。`
  - `也可以发送 /cancel 返回项目列表。`
- keep chat mode in `awaiting_manual_project_path`

### Returning to project picker

`返回项目列表` behavior:
- bridge clears `awaiting_manual_project_path` mode
- bridge sends a **new message** with the latest project picker
- bridge does not edit older picker messages in v1

### `/sessions`

Return structure:
- title: `最近会话`
- up to 10 sessions, newest first
- each row includes:
  - session index
  - display name
  - project name
  - relative last used time
  - status marker if running

### `/use <n>`

Return structure:
- success: `已切换到项目：{project_name}`
- failure: `找不到这个会话。`

### `/rename <name>`

Return structure:
- success: `当前会话已重命名为：{name}`
- invalid empty name: `请输入新的会话名称。`

### `/pin`

Return structure:
- success: `已收藏项目：{project_name}`
- if already pinned: `这个项目已经收藏。`

### `/where`

Return structure:
- title: `当前会话`
- fields:
  - current session name
  - current project name
  - current project path
  - session status

The path is shown here because this is an explicit inspection command, not a primary onboarding screen.

### `/interrupt`

Return structure:
- success: `已请求停止当前操作。`
- no running turn: `当前没有正在执行的操作。`
- app-server interrupt unavailable: `当前无法中断正在运行的操作。`

### `/status`

Return structure:
- title: `服务状态`
- fields:
  - bridge readiness state
  - Telegram connectivity
  - Codex availability
  - active session summary

### Callback data encoding

All inline-button callback data uses a versioned compact format:

- `v1:pick:{project_key}`
- `v1:use:{session_id}`
- `v1:pin:{session_id}`
- `v1:scan:more`
- `v1:path:manual`
- `v1:path:back`
- `v1:path:confirm:{project_key}`

`project_key` is a short stable hash of the project path, not the raw path.

### Duplicate click handling

If a callback is received for an already-resolved action:
- acknowledge callback
- do not repeat side effects
- user sees: `这个操作已处理。`

### Expired/stale button handling

If callback references stale or missing state:
- acknowledge callback
- user sees: `这个按钮已过期，请重新操作。`

### Final-answer chunking

If final answer exceeds safe Telegram size:
- split into chunks of **3000 UTF-8 characters max**
- preserve order
- prefix subsequent chunks with `(2/3)`, `(3/3)` style markers
- never truncate silently

### Edit vs new message policy

Use **edit existing message** when:
- updating an in-progress status card created by the bridge

Use **new message** when:
- sending final assistant answer
- returning `/sessions`, `/where`, `/status`
- starting `扫描更多仓库`
- entering `手动输入路径`
- returning refreshed project picker
- callback source message is stale or missing

### User sends messages while a turn is running

If active session is running and user sends a normal text message:
- do not enqueue a new turn
- reply: `当前项目仍在执行，请等待完成或发送 /interrupt。`

---

## 5) Session 并发模型

### v1 concurrency policy

1. a Telegram chat may have multiple sessions
2. exactly one session is the **active session** for that chat
3. each session allows **at most one active turn**
4. only the active session receives normal text input

### Running turn rule

If active session already has a running turn and user sends another normal message:
- do not queue a second turn
- reply: `当前项目仍在执行，请等待完成或发送 /interrupt。`

Reason:
- safest v1 behavior
- avoids ambiguous interleaving in Telegram
- avoids complex per-session queues

### `/use` while current session is running

If current active session is `running`:
- `/use` is rejected
- user sees: `当前项目仍在执行，请先等待完成或停止当前操作。`

Reason:
- switching active context mid-turn causes avoidable confusion in Telegram

### `/interrupt` scope

v1 `/interrupt` applies only to the **current active session**.

No session-id parameter in v1.

Reason:
- simplest and least error-prone Telegram UX

### Multiple sessions in one chat

Allowed.

Only one active session at a time.

User can switch only when the current active session is idle, interrupted, or failed.

---

## 6) Installer / Service 运维细节

### Install location

Default bridge install root:
- `~/.local/share/codex-telegram-bridge`

### State directory

Default:
- `~/.local/state/codex-telegram-bridge`

Contains:
- `bridge.db`
- `runtime/`
- `cache/`

### Log directory

Default:
- `~/.local/state/codex-telegram-bridge/logs`

Files:
- `bridge.log`
- `bootstrap.log`
- `app-server.log`

### systemd service name

Use:
- `codex-telegram-bridge.service`

### Process ownership model

**Selected v1 model:**
- `systemd --user` manages only `codex-telegram-bridge.service`
- the bridge process itself starts, monitors, restarts, and reconnects its local `codex app-server` child process

Reason:
- one supervisor only at the outermost layer
- simpler restart semantics
- local bridge can reconnect without cross-service coordination
- readiness, restart, and failure attribution stay in one place

`systemd --user` does **not** manage `codex app-server` as a separate unit in v1.

### Local management commands

Installer must place a local management script at:
- `~/.local/share/codex-telegram-bridge/bin/ctb`

Supported subcommands:
- `ctb install`
- `ctb status`
- `ctb restart`
- `ctb stop`
- `ctb start`
- `ctb update`
- `ctb uninstall`
- `ctb doctor`
- `ctb authorize pending`
- `ctb authorize clear`

### Service ownership model behavior

- bridge start:
  - start local app-server child
  - run initialize handshake
  - run non-destructive readiness probe
  - mark readiness
- app-server child exit:
  - bridge logs exit
  - bridge performs one automatic child restart attempt
  - bridge reconnects on success
  - bridge marks readiness degraded on failure
- bridge exit:
  - systemd restarts bridge
  - bridge recreates app-server child on next boot

### Administrator diagnostics

Administrator can inspect:
- `ctb status`
- `ctb doctor`
- `journalctl --user -u codex-telegram-bridge.service -n 200`
- `sqlite3 ~/.local/state/codex-telegram-bridge/bridge.db`

### Update behavior

`ctb update` must:
1. fetch/install new bridge release
2. preserve DB and logs
3. restart the service
4. run readiness checks
5. print post-update status summary

### Uninstall behavior

`ctb uninstall` must:
1. stop and disable service
2. remove installed bridge files
3. keep state directory by default
4. support `--purge-state` for full removal

---

## 7) Failure handling 的系统动作

### `codex_not_authenticated`

User sees:
- `服务器上的 Codex 还没有准备好，请先在本机完成登录或初始化。`

System does:
- readiness state set to `codex_not_authenticated`
- bridge refuses new turns
- `/status` and `/doctor` remain available
- logs remediation hint locally

### `app_server_unavailable`

User sees:
- `Codex 服务暂时不可用，请稍后重试。`

System does:
- attempt one local app-server child restart
- if restart fails, set readiness to `app_server_unavailable`
- reject new turns
- keep sessions persisted

### `telegram_token_invalid`

User sees:
- no Telegram interaction is possible because bot cannot connect

System does:
- installer fails fast
- readiness state set to `telegram_token_invalid`
- service does not enter normal run loop
- local diagnostics instruct admin to replace the bot token

### `project path invalid`

User sees:
- `这个项目路径不可用，请重新选择项目。`

System does:
- session creation is blocked
- invalid path is not written as active session
- if it came from cached recommendation, mark candidate stale in cache

### `scan timeout`

User sees:
- normal project picker based on partial results, or fallback-only picker if no results finished

System does:
- stop scan at 3 seconds
- preserve partial candidates
- mark scan result partial in cache
- do not fail `/new`

### `callback delivery failure`

User sees:
- `这次操作未成功送达，请重试。`

System does:
- do not assume action succeeded
- leave underlying state unchanged unless downstream confirmation exists
- log callback failure with callback type and target entity id

### `bridge restart during running turn`

User sees:
- `桥接服务已重启，正在运行的操作状态未知，请查看会话状态后重新发起。`

System does:
- all `running` sessions become `failed`
- set `failure_reason = bridge_restart`
- no attempt to infer final answer from a half-observed turn in v1
- require explicit user retry

### `state store corruption`

User sees:
- `桥接状态已损坏并已重置，请重新选择会话或项目。`

System does:
- rotate corrupt DB file
- create fresh DB
- readiness set to `bridge_unhealthy`
- preserve logs
- expose failure details in `ctb doctor`
- require authorization to be re-established locally

---

## 8) Phase 1 验收标准（Definition of Done）

### Installation success

Done when:
- one-line install completes without manual code edits
- bridge files are installed in target directory
- service file is written
- `ctb status` reports installed state

### Telegram bot available

Done when:
- bot token passes validation
- bridge receives Telegram updates from the authorized user
- unauthorized user is rejected

### Readiness/self-check available

Done when:
- `ctb doctor` returns explicit readiness state
- `/status` returns current bridge/Codex readiness summary
- installer fails with actionable remediation when Codex is not ready

### `/new` project picker available

Done when:
- `/new` never silently enters a project
- `/new` always shows either recommendation list or fallback actions
- top recommendation is explicit and visible

### Real Codex request starts after project selection

Done when:
- user chooses a project
- bridge creates a session and thread
- next normal message starts a real Codex turn against that selected project

### Final answer returns to Telegram

Done when:
- bridge waits for turn completion
- only final assistant message is sent back
- intermediate tool/reasoning events are not shown
- long final reply is chunked safely

### `/sessions`, `/use`, `/interrupt` work

Done when:
- `/sessions` lists recent sessions
- `/use` switches active session when current one is idle
- `/use` is blocked if current session is running
- `/interrupt` interrupts the active running session when supported

### Restart recovery works

Done when:
- sessions remain persisted after bridge restart
- active session pointer is restored
- running turns are marked failed with a concrete `failure_reason`
- user is told to retry, not left in silent ambiguity

### Unauthorized user blocked

Done when:
- any Telegram user other than the configured authorized user is rejected
- rejected users do not create sessions or Codex turns
- rejection is logged locally

---

## 9) 推荐开发顺序 / backlog

### Phase 0

1. **app-server protocol verification**
   - capture real initialize / initialized
   - capture real create thread
   - capture real resume thread
   - capture real start turn
   - capture real final-answer path
   - capture real interrupt
   - capture real local startup command and startup behavior
   - append exact protocol appendix to this document

### Phase 1

2. **installer scaffold**
   - install root
   - state/log dirs
   - systemd unit
   - `ctb` management script

3. **authorization bootstrap**
   - awaiting-authorization mode
   - pending authorization table
   - local `ctb authorize pending`
   - local `ctb authorize clear`

4. **readiness probe**
   - codex installed check
   - Codex authenticated check
   - app-server child startup probe
   - Telegram token validation

5. **SQLite state store**
   - schema
   - migrations
   - corruption detection
   - startup integrity check

6. **app-server adapter**
   - stdio child process manager
   - initialize handshake
   - request/response plumbing
   - child restart/reconnect handling

7. **Telegram bot skeleton**
   - authorized user gate
   - update handling
   - command routing
   - callback routing

8. **project discovery engine**
   - scan roots
   - candidate detection rules
   - scan bounds and timeout
   - cache writes

9. **project picker flow**
   - `/new`
   - recommendation scoring
   - `扫描更多仓库`
   - `手动输入路径`
   - button encoding/decoding
   - manual path input validation

10. **session management**
    - create session
    - switch active session
    - rename/pin/where
    - idle/running/interrupted/failed transitions

11. **turn execution and final-answer extraction**
    - start turn
    - track active turn per session
    - collect final assistant reply only
    - chunk long answers

12. **interrupt and concurrency guardrails**
    - one active turn per session
    - block message send while running
    - `/interrupt` current active session only

13. **restart recovery**
    - restore sessions
    - fail interrupted running turns with `failure_reason`
    - restore active session pointer

14. **logging and diagnostics**
    - structured logs
    - `ctb doctor`
    - `/status`
    - admin remediation outputs

15. **acceptance test matrix**
    - install
    - auth gate
    - `/new`
    - real turn
    - final answer
    - restart recovery
    - unauthorized access rejection

### Future / Out of scope

- approval relay
- Telegram approval cards
- approve/reject callback handling
- approval timeout handling
- pending approval persistence

---

## Risk Boundary

v1 depends on the server operator intentionally accepting the runtime boundary of:
- full access execution on the server side
- no Telegram-side approval barrier
- no second human confirmation inside Telegram before Codex proceeds

This is a deliberate scope reduction to make v1 smaller and shippable.

It means:
- Telegram is a direct control plane into a high-trust Codex runtime
- access control at the Telegram identity boundary matters more, not less
- v1 should be deployed only by operators who explicitly accept that trust model

---

## User-Facing Copy Rules

Prefer:
- `选择这次要操作的项目`
- `继续上次项目：{project_name}`
- `其他常用项目`
- `扫描更多仓库`
- `手动输入路径`
- `当前项目：{project_name}`

Avoid in the main user flow:
- `workdir`
- `cwd`
- `API key`
- `provider`
- `transport`
- `sandbox mode`

These terms may appear in local administrator diagnostics only.

---

## Final v1 Rule

**The bridge may recommend a project, but it must never silently choose the project. The user must always be able to see which project the next Codex session will operate on before the first real task is sent.**

---

## Appendix A: Phase 0 Verified app-server Protocol Notes

This appendix records the real Phase 0 verification results gathered from the local `codex app-server` binary available on this machine on 2026-03-09.

### Phase 0 environment

Verified binary:
- `codex` at `/home/ubuntu/.local/bin/codex`
- version: `codex-cli 0.112.0`

### A.1 Real local startup contract

**Verified local start command**

```bash
codex app-server --listen stdio://
```

**Verified required flag for bridge v1**
- `--listen stdio://`

`stdio://` is the default according to `--help`, but v1 should still pass it explicitly to avoid ambiguity.

**Verified startup timeout**
- local initialize response arrived well under 5 seconds in every successful run
- v1 startup timeout remains **5 seconds**

**Verified stdout / stderr behavior**
- stdout carried JSON-RPC frames only in the verified startup and handshake runs
- stderr remained empty in the verified local runs
- no startup banner or human-readable prelude was emitted on stdout before the initialize response

**Verified ready rule for bridge v1**

Bridge should consider app-server truly ready only when all of the following are true:
1. child process is alive
2. stdio pipes are open
3. `initialize` request returns success
4. bridge sends `initialized` notification
5. one non-destructive follow-up request succeeds

**Verified non-destructive follow-up request**
- `thread/list`

### A.2 Handshake verification

**Verified behavior before initialization**

Request sent:
```json
{ "id": 1, "method": "thread/start", "params": { "cwd": "/home/ubuntu/Repo" } }
```

Verified response:
```json
{ "error": { "code": -32600, "message": "Not initialized" }, "id": 1 }
```

**Verified initialize request**

Request sent:
```json
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "phase0_probe",
      "version": "0.1.0"
    }
  }
}
```

Verified response shape:
```json
{
  "id": 1,
  "result": {
    "userAgent": "phase0_probe/0.112.0 (Ubuntu 24.4.0; x86_64) ..."
  }
}
```

**Verified initialized notification**

Request sent:
```json
{ "method": "initialized", "params": {} }
```

No acknowledgement frame was observed, which matches notification semantics.

**Verified repeated initialize behavior**

Request sent:
```json
{
  "id": 3,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "phase0_init_probe",
      "version": "0.1.0"
    }
  }
}
```

Verified response:
```json
{ "error": { "code": -32600, "message": "Already initialized" }, "id": 3 }
```

### A.3 Verified thread lifecycle methods

**Verified `thread/start`**

Request sent:
```json
{
  "id": 2,
  "method": "thread/start",
  "params": {
    "cwd": "/home/ubuntu/Repo",
    "approvalPolicy": "never"
  }
}
```

Verified response shape:
```json
{
  "id": 2,
  "result": {
    "thread": {
      "id": "019cd26e-...",
      "preview": "",
      "ephemeral": false,
      "modelProvider": "packycode",
      "createdAt": 1773056963,
      "updatedAt": 1773056963,
      "status": { "type": "idle" },
      "path": "/home/ubuntu/.codex/sessions/...jsonl",
      "cwd": "/home/ubuntu/Repo",
      "cliVersion": "0.112.0",
      "source": "vscode",
      "name": null,
      "turns": []
    },
    "model": "gpt-5.4",
    "modelProvider": "packycode",
    "serviceTier": null,
    "cwd": "/home/ubuntu/Repo",
    "approvalPolicy": "never",
    "sandbox": { "type": "dangerFullAccess" },
    "reasoningEffort": "high"
  }
}
```

**Verified notification emitted after `thread/start`**
```json
{ "method": "thread/started", "params": { "thread": { "id": "019cd26e-...", ... } } }
```

**Verified `thread/resume`**

Request sent:
```json
{
  "id": 7,
  "method": "thread/resume",
  "params": {
    "threadId": "019cd26e-b837-7532-b767-cba59c4a39b3"
  }
}
```

Verified response shape includes the resumed thread and historical turns.

### A.4 Verified turn lifecycle methods

**Verified `turn/start`**

Request sent:
```json
{
  "id": 3,
  "method": "turn/start",
  "params": {
    "threadId": "019cd26e-b837-7532-b767-cba59c4a39b3",
    "input": [
      { "type": "text", "text": "Reply with exactly: PHASE0_OK" }
    ],
    "cwd": "/home/ubuntu/Repo",
    "approvalPolicy": "never"
  }
}
```

Verified immediate response:
```json
{
  "id": 3,
  "result": {
    "turn": {
      "id": "019cd26e-b845-7fd2-ad3f-f5539f138f41",
      "items": [],
      "status": "inProgress",
      "error": null
    }
  }
}
```

**Verified `turn/started` notification** and **`turn/completed` notification** were both observed.

### A.5 Verified final-answer extraction paths

**Verified path 1: `codex/event/task_complete.msg.last_agent_message`**

Observed runtime event contained:
- `method = codex/event/task_complete`
- `params.msg.last_agent_message = "PHASE0_OK"`

**Verified path 2: `thread/resume` historical turn items**

Observed resumed turn item contained:
- `items[].type = "agentMessage"`
- `items[].text = "PHASE0_OK"`
- `items[].phase = "final_answer"`

**Observed extra stdout event namespaces**

In addition to `thread/*`, `turn/*`, and `item/*`, stdout also emitted:
- `codex/event/*`
- `thread/status/changed`
- `account/rateLimits/updated`

Bridge v1 must therefore treat stdout as a mixed notification stream.

### A.6 Approval request / response

**Runtime verification status:** **NOT VERIFIED**

Reason:
- approval path was probed in this environment, but an exact runtime `requestApproval` frame was not captured reliably
- approval is now out of scope for v1 and does not block Phase 1

### A.7 Verified interrupt behavior

**Verified `turn/interrupt` request**

Request sent:
```json
{
  "id": 6,
  "method": "turn/interrupt",
  "params": {
    "threadId": "019cd26e-b837-7532-b767-cba59c4a39b3",
    "turnId": "019cd26e-cd7c-7be1-a0fc-7026e988fee0"
  }
}
```

Verified immediate response:
```json
{ "id": 6, "result": {} }
```

Verified follow-up events included:
- `codex/event/turn_aborted`
- `turn/completed` with `turn.status = "interrupted"`

### A.8 Verified connection-close behavior

When the local app-server child process was terminated by the parent process:
- process exited with code `0` in the verified run
- stdout reached EOF
- no protocol-level shutdown frame was observed
- stderr remained empty in the verified run

Bridge v1 should therefore treat child-process exit and stdout EOF as the authoritative connection-close signal.

### A.9 Key verified field names

Verified field names from real runs:
- thread id: `thread.id` and `params.threadId`
- turn id: `turn.id` and `params.turnId`
- final assistant message in resumed history: `items[].text` where `items[].type = "agentMessage"` and `phase = "final_answer"`
- fast final-message shortcut: `params.msg.last_agent_message` on `codex/event/task_complete`
- interrupt target fields: `threadId`, `turnId`

### A.10 Mismatches vs earlier assumptions

1. stdout event surface is broader than only `thread/*`, `turn/*`, and `item/*`
2. `thread/start` response is richer than the earlier minimal assumption
3. approval flow remains unverified at runtime, but is no longer part of v1 scope
4. ready detection should include a non-destructive follow-up request after initialize/initialized

### A.11 Phase 0 final conclusion

**Conclusion:** **可进入 Phase 1**

Reason:
- handshake, thread lifecycle, turn lifecycle, final-answer extraction, interrupt, and connection-close behavior are sufficiently verified for the narrowed v1 scope
- approval request / response remains unverified at runtime, but approval is now explicitly out of scope for v1 and does not block implementation
