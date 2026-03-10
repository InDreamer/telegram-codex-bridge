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

### `/sessions`

Shows:
- title `最近会话`
- up to 10 sessions, newest first
- session index, display name, project name, relative last-used time, and running marker

### `/use <n>`

Responses:
- success: `已切换到项目：{project_name}`
- failure: `找不到这个会话。`

If the current active session is running:
- reject the switch
- return `当前项目仍在执行，请先等待完成或停止当前操作。`

### `/rename <name>`

Responses:
- success: `当前会话已重命名为：{name}`
- invalid empty name: `请输入新的会话名称。`

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
- `v1:use:{session_id}`
- `v1:pin:{session_id}`
- `v1:scan:more`
- `v1:path:manual`
- `v1:path:back`
- `v1:path:confirm:{project_key}`

Rules:
- `project_key` is a stable short hash of the project path, never the raw path
- duplicate clicks must be idempotent and return `这个操作已处理。`
- stale callbacks must return `这个按钮已过期，请重新操作。`

## Message And Turn Rules

Final-answer handling:
- send only the final assistant answer to Telegram
- if the answer exceeds safe size, split into 3000 UTF-8 character chunks
- prefix later chunks with `(2/3)` style markers
- never truncate silently

Edit versus new message:
- edit existing messages only for bridge-owned in-progress status cards
- send new messages for final answers, status views, refreshed pickers, and manual-path flows

While a turn is running:
- do not queue a second turn
- reply with `当前项目仍在执行，请等待完成或发送 /interrupt。`
