# Auth And Project Flow

Current intended behavior for:
- Telegram authorization and first-bind flow
- project discovery and project picker behavior
- session list, switching, archive, rename, pin, and browse behavior
- general command-response rules for these bridge-owned flows

When implementation detail matters, verify against:
- `src/service/session-project-coordinator.ts`
- `src/service/project-browser-coordinator.ts`
- `src/telegram/commands.ts`

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

Scan root source:
- read `PROJECT_SCAN_ROOTS` from `bridge.env`
- when configured, scan only those roots in the configured order
- when empty or unset, scan the user's `HOME` as one bounded root
- install and repair flows should persist preferred roots; runtime fallback does not rewrite config

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

Ordering signals:
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
- `/new` only selects a project and creates a new session
- group visible candidates into `已收藏`, `最近使用`, and `本地发现`
- show at most 5 visible projects total
- when no pinned projects consume that shared budget, prefer up to 3 `最近使用` entries and 2 `本地发现` entries
- each visible project shows display name plus path hint
- paths under `HOME` render as `~/...`; other paths render as absolute paths
- the same project path appears at most once; if it matches multiple sources, show it in the highest-priority group and expose the others as tags
- project buttons use compact numeric labels in the same order as the visible grouped list
- always show `扫描本地项目` and `手动输入路径`

Degradation:
- partial scan results are acceptable
- scan timeout does not fail `/new`
- if every configured scan root is unavailable, show a degraded notice and fall back to historical results when available
- if no candidates remain, show fallback actions and `未找到可用项目，请扫描本地项目或手动输入路径。`

## Telegram Command Contract

General rule:
- Telegram is not a debug console
- every command returns a compact user-facing response
- structured Telegram command replies render field labels in bold via Telegram HTML
- plain one-line prompts and session lists may stay plain text when they do not expose label-value fields

### `/help`, `/start`, and `/commands`

Shows:
- the current localized help text derived from the Telegram command registry

Rules:
- `/start` and `/commands` are aliases of `/help`
- the Telegram command menu and the help text stay aligned because both are generated from the same command registry
- no active session is required

### `/cancel`

Behavior:
- cancels the current manual-path flow, rename input flow, queued structured-input prompt, or pending free-text interaction answer

Responses:
- manual project-path mode returns to the current project picker
- session rename cancel: `已取消会话重命名。`
- project alias cancel: `已取消项目别名修改。`
- queued structured-input cancel: `已取消待发送的结构化输入。`
- nothing to cancel: `当前没有可取消的输入。`

Rules:
- `/cancel` does not interrupt an active turn; use `/interrupt` for that
- interaction cards that are waiting for button-based approval stay on the card flow; `/cancel` only applies when the bridge is explicitly waiting for free text

### `/language`

Behavior:
- shows an inline picker for `中文` and `English`
- persists the selected bridge UI language in SQLite
- resyncs the Telegram command menu to the selected language
- reanchors any active runtime status card after the language change so bridge-owned UI surfaces stay consistent

Responses:
- callback save acknowledgement: `已保存。` or `Saved.`

Rules:
- no active session is required
- this changes bridge-owned UI copy only; it does not reconfigure Codex itself
- after selection or explicit close, the picker should end as a non-interactive summary instead of staying open

### `/new`

Shows the project picker:
- title `选择要新建会话的项目`
- grouped project list
- compact numeric project buttons in the same order as the visible grouped list
- fallback buttons

Rules:
- selecting a project always creates a new session
- `/new` never resumes or switches to an old session
- `/new` may be used even when another session is already running; the newly created session becomes the active foreground session
- a newly created idle session does not appear in the runtime hub until it starts its first real running turn
- `/new` always recreates the picker as a fresh bridge-owned message at the bottom of chat
- the bridge keeps at most one valid project picker per chat; any older picker becomes stale

### `/browse`

Behavior:
- opens a bridge-owned read-only browser for the current active session's project root
- directory navigation stays inside the active project's root path
- text files open in a paged inline preview on the same browser message
- image files send a separate Telegram image preview and keep the browser message in place
- binary or unsupported files send a compact metadata message instead of raw content

Responses:
- no active session: `当前没有活动会话，请先发送 /new 或 /use 进入项目。`
- current project unavailable: `当前项目目录不可用，请重新选择项目后再试。`
- expired browser button: `这个按钮已过期，请重新发送 /browse。`

Rules:
- `/browse` is read-only in v1
- `/browse` does not expose arbitrary server paths; it is limited to the current active project's root tree
- `/browse` can be used while a turn is running because it does not mutate the project or start a Codex turn

### `扫描本地项目`

Behavior:
- retire the previous valid picker or no-results surface and send a fresh bridge-owned surface
- show `正在扫描本地项目，请稍候…`
- after scanning, keep a single refreshed picker or no-results surface visible; do not leave older picker cards behind

If no new results are found:
- show `没有发现新的本地项目。`
- include `手动输入路径` and `返回项目列表`

### `手动输入路径`

Behavior:
- consume the current valid picker surface and continue the manual-path flow from the newest bridge-owned prompt
- enter `awaiting_manual_project_path` mode
- prompt with an example path and `/cancel`

Validation flow:
1. user sends a plain-text path
2. bridge validates that the path exists, is readable, and is a directory
3. if valid, bridge sends a confirmation card as the newest chat surface and retires the older manual-path prompt
4. if confirmed, bridge creates the session and consumes the confirmation card into a compact success summary

Return flow:
- when the user returns to the project picker from manual-path mode, the bridge recreates the picker as a fresh bridge-owned message
- only the newest picker remains valid for button callbacks

Invalid path feedback:
- `这个目录不可用，请重新发送目录路径。`
- `也可以发送 /cancel 返回项目列表。`

`/cancel` also exits rename input mode when the bridge is waiting for a new session name or project alias.

### `/sessions`

Shows:
- default title `最近会话`
- default view hides archived sessions
- up to 10 sessions, newest first
- session index, active marker when applicable, display name, project display name, user-visible state, optional last-result summary, and relative last-used time

### `/sessions archived`

Shows:
- title `已归档会话`
- up to 10 archived sessions, newest first by last-used time
- session index, display name, project display name, user-visible state, optional last-result summary, and relative last-used time

### `/use <n>`

Responses:
- success: `已切换到项目：{project_name}`
- failure: `找不到这个会话。`

Rules:
- switching the active session does not stop other running sessions
- background running sessions keep their own runtime card and final-answer delivery
- subsequent free-text user input targets the newly active session

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

### `/rename` and `/rename <name>`

Responses:
- `/rename <name>` success: `当前会话已重命名为：{name}`
- bare `/rename` shows a picker for `重命名会话` and `设置项目别名`
- if the current project already has an alias, the picker also shows `清除项目别名`
- project alias success: `当前项目别名已更新为：{name}`
- project alias clear success: `已清除项目别名：{project_name}`
- session rename prompt: `请输入新的会话名称。`
- project alias prompt: `请输入新的项目别名。`

### `/pin`

Responses:
- success: `已收藏项目：{project_name}`
- already pinned: `这个项目已经收藏。`
