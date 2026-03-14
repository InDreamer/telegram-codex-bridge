# Telegram Chat And Project Flow

## Authorized User Model

v1 supports exactly one authorized Telegram user.

The bridge must reject every Telegram update from any other user before session lookup or Codex interaction.

Unauthorized response:
- `这个 Telegram 账号无权访问此服务器上的 Codex。`

System behavior:
- do not create a session
- do not forward the message to Codex
- log the rejection with Telegram user id and chat id
- rate-limit repeated unauthorized responses

## First Bind Flow

Selected v1 flow:
- Telegram first contact
- local administrator confirmation

Sequence:
1. installer finishes and bridge starts in `awaiting_authorization`
2. the first Telegram private message becomes a pending authorization candidate
3. the bridge replies with `这台服务器还没有绑定 Telegram 账号，请等待管理员在本机确认。`
4. the administrator runs `ctb authorize pending`
5. the administrator confirms the intended candidate with `ctb authorize pending --latest`, `--select <index>`, or `--user-id <id>`
6. the bridge persists `authorized_user` and `chat_binding`
7. normal operation begins

Pending-candidate rules:
- TTL is 24 hours
- repeated messages refresh `last_seen_at` without creating duplicates
- expired candidates are hidden by default
- expired candidates cannot be confirmed without fresh contact

Rebinding flow:
- run `ctb authorize clear`
- remove `authorized_user`, `chat_binding`, and pending candidates
- keep historical sessions, but make them unreachable until a new user binds

## Project Discovery Rules

Default scan roots, in order:
1. `~/Repo`
2. `~/workspace`
3. `~/code`

A directory is a candidate project if it contains at least one of:
- `.git/`
- `package.json`
- `pyproject.toml`
- `Cargo.toml`
- `go.mod`
- `.jj/`

Exclude:
- hidden directories unless explicitly pinned
- common dependency and build directories such as `node_modules`, `.venv`, `venv`, `dist`, `build`, `target`, `.next`, and `.turbo`

Scan limits:
- max depth: 3
- max candidates: 200
- max scan time: 3 seconds per `/new`

Recommendation scoring:
- `+100` pinned project
- `+80` last successful project
- `+60` most recently used project
- `+40` existing session history
- `+20` discovered by scan and still exists
- `-50` path missing or inaccessible

Tie-breakers:
1. latest `last_used_at`
2. pinned first
3. lexical project name

`/new` output rules:
- show one primary recommendation if score is at least 60
- show up to 5 other frequent projects
- always show `扫描更多仓库` and `手动输入路径`

Degradation:
- partial scan results are acceptable
- scan timeout does not fail `/new`
- if no candidates remain, show fallback actions and `未找到推荐项目，请扫描更多仓库或手动输入路径。`

## Telegram Command Contract

General rule:
- Telegram is not a debug console
- every command returns a compact user-facing response
- structured Telegram command replies render field labels in bold via Telegram HTML
- plain one-line prompts and session lists may stay plain text when they do not expose label-value fields

### `/new`

Shows the project picker:
- title `选择这次要操作的项目`
- optional primary recommendation
- frequent project buttons
- fallback buttons

Primary button examples:
- `继续上次项目：{project_name}`
- `进入项目：{project_name}`

### `扫描更多仓库`

Behavior:
- send a new message instead of editing the original picker
- show `正在扫描更多项目，请稍候…`
- after scanning, send a refreshed picker as another new message

If no new results are found:
- show `没有发现更多可用项目，请手动输入路径。`
- include `手动输入路径` and `返回项目列表`

### `手动输入路径`

Behavior:
- send a new prompt message
- enter `awaiting_manual_project_path` mode
- prompt with an example path and `/cancel`

Validation flow:
1. user sends a plain-text path
2. bridge validates existence
3. bridge validates project-candidate rules
4. if valid, bridge asks for confirmation and shows name plus path
5. if confirmed, bridge creates the session

Invalid path feedback:
- `这个路径不可用，请重新发送项目路径。`
- `也可以发送 /cancel 返回项目列表。`

`/cancel` also exits rename input mode when the bridge is waiting for a new session name.

### `/sessions`

Shows:
- default title `最近会话`
- default view hides archived sessions
- up to 10 sessions, newest first
- session index, active marker when applicable, display name, project name, user-visible state, optional last-result summary, and relative last-used time

### `/sessions archived`

Shows:
- title `已归档会话`
- up to 10 archived sessions, newest first by last-used time
- session index, display name, project name, user-visible state, optional last-result summary, and relative last-used time

### `/use <n>`

Responses:
- success: `已切换到项目：{project_name}`
- failure: `找不到这个会话。`

If the current active session is running:
- reject the switch
- return `当前项目仍在执行，请先等待完成或停止当前操作。`

### `/archive`

Responses:
- success: `已归档当前会话：{project_name}`
- no active session: `当前没有活动会话。`
- active session running: `当前项目仍在执行，请先等待完成或停止当前操作。`
- archive unavailable: `当前无法归档这个会话，请稍后重试。`

Archive rules:
- archive only applies to the current active session
- archived sessions are hidden from default `/sessions`
- after archiving the active session, the bridge switches to the most recent remaining visible session when one exists
- low-level Codex protocol events such as `thread/archived` are internal bridge signals, not Telegram commands

### `/unarchive <n>`

Responses:
- success: `已恢复会话：{project_name}`
- failure: `找不到这个会话。`
- unarchive unavailable: `当前无法恢复这个会话，请稍后重试。`

Rules:
- `<n>` is indexed against `/sessions archived`, not the default `/sessions` view
- if no active visible session remains, the restored session becomes active automatically

### `/rename <name>`

Responses:
- success: `当前会话已重命名为：{name}`
- missing or empty name: prompt with `请输入新的会话名称。` and allow `/cancel`

### `/pin`

Responses:
- success: `已收藏项目：{project_name}`
- already pinned: `这个项目已经收藏。`

### `/where`

Shows:
- current session name
- current project name
- current project path
- session status
- bridge `session_id`
- Codex `thread_id` when available, otherwise an explicit not-created-yet note
- latest `turn_id` when available

### `/inspect`

Shows a structured activity snapshot for the active session.

Responses:
- with activity data:
  - Telegram HTML in compact Chinese, optimized for normal chat reading instead of debug-dump fidelity
  - deduplicated session and project identity
  - current turn status, blocker, active step, and elapsed step time when available
  - one concise latest conclusion when available
  - recent action timeline when live activity data exists
  - recent command details, including command text and latest result summary when available
  - recent file-change summaries
  - recent MCP and web-search summaries grouped into one user-facing section
  - current plan snapshot
  - completed commentary entries when available
  - when no live snapshot exists but the session has a completed turn, best-effort detail recovered from thread history
- with no activity data: `当前没有可用的活动详情。`

Rules:
- do not mirror raw delta, raw reasoning, or raw protocol frames
- do not show debug file paths in the normal Telegram inspect response
- omit empty sections instead of printing placeholder noise such as `None`

### `/interrupt`

Responses:
- success: `已请求停止当前操作。`
- no running turn: `当前没有正在执行的操作。`
- interrupt unavailable: `当前无法中断正在运行的操作。`

### `/status`

Shows:
- bridge readiness state
- Telegram connectivity
- Codex availability
- active session summary

## Callback Contract

Versioned callback formats:
- `v1:pick:{project_key}`
- `v1:scan:more`
- `v1:path:manual`
- `v1:path:back`
- `v1:path:confirm:{project_key}`
- `v1:plan:expand:{session_id}`
- `v1:plan:collapse:{session_id}`
- `v1:final:open:{answer_id}`
- `v1:final:close:{answer_id}`
- `v1:final:page:{answer_id}:{page}`

Rules:
- `project_key` is a stable short hash of the project path, never the raw path
- duplicate clicks must be idempotent and return `这个操作已处理。`
- stale callbacks must return `这个按钮已过期，请重新操作。`
- session switching and pinning are text commands (`/use <n>` and `/pin`), not callback actions

## Message And Turn Rules

Final-answer handling:
- send the final assistant answer as a separate Telegram message after the turn finishes
- render the final assistant answer with Telegram formatting rather than exposing raw Markdown markers
- if the answer is long enough to harm chat readability, send a collapsed preview with an inline `展开全文` button
- keep long final answers on a single bridge-owned message by editing that message for `展开全文`, `收起`, and page navigation
- persist collapsed previews plus rendered pages locally so final-answer buttons still work after bridge restart
- if an expanded final answer still exceeds Telegram single-message size, page through the rendered HTML instead of sending a cascade of long continuation messages
- keep the older `(2/3)` continuation fallback only when the collapsible path cannot be established safely
- never truncate silently
- if no final assistant answer is available after a successful turn, send `本次操作已完成，但没有可返回的最终答复。`

Edit versus new message:
- edit existing messages for bridge-owned runtime cards and bridge-owned long final-answer views
- send new messages for initial final answers, status views, refreshed pickers, manual-path flows, and rename prompts
- send a new message when a new runtime card first appears, including status and error cards

While a turn is running:
- keep one bridge-owned status card in the chat
- current runtime-card titles are `Runtime Status` and `Error`
- when plan state becomes available, expose it through a collapsed button on the status card
- the collapsed button shows the current plan step summary and expands inline on demand
- project `commandExecution` items into the status card instead of sending separate command cards
- keep the `State` line aligned with reduced Codex runtime state such as running, blocked, and terminal outcomes
- status card command activity should appear only through the `Progress` section when a visible progress unit exists
- render the `Progress` body on its own line using Telegram HTML from a safe inline Markdown subset
- keep `Progress` for commentary and other user-readable stage updates rather than using it as the only running-state signal
- keep full per-command detail in `/inspect`, ordered by execution sequence and including command text, state, and latest output summary when available
- create separate error cards for runtime failures
- update the status card only when the visible turn state changes or when a complete progress unit is available
- keep raw `item/agentMessage/delta` traffic out of the default chat flow
- only surface completed `agentMessage` items when `phase = commentary`
- never expose raw reasoning deltas in the default chat flow
- if Telegram refuses an edit or rate-limits it, retry the same card later instead of sending replacement-message spam
- let `/inspect` return a snapshot on demand instead of pushing extra detail automatically

While a turn is running:
- do not queue a second turn
- reply with `当前项目仍在执行，请等待完成或发送 /interrupt。`
