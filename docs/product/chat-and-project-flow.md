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

### `/plan`

Behavior:
- toggles the active session between default mode and plan mode
- persists the selected mode on the bridge session
- does not change the current running turn in place; the new mode applies on the next `turn/start`

Responses:
- switched on while idle: `已为当前会话开启 Plan mode。下次任务开始时生效。`
- switched off while idle: `已为当前会话关闭 Plan mode。下次任务开始时生效。`
- switched on while running: `已为当前会话开启 Plan mode。当前任务不受影响，下次任务开始时生效。`
- switched off while running: `已为当前会话关闭 Plan mode。当前任务不受影响，下次任务开始时生效。`
- no active session: `当前没有活动会话。`

### `/model` and `/model <model_id>`

Shows:
- a two-step inline-button picker driven by the current app-server `model/list`
- step 1 shows only 4-6 visible model candidates at a time, marks `当前` and `默认`, and paginates when needed
- step 2 appears only when the chosen model exposes multiple `supportedReasoningEfforts`; otherwise the bridge skips directly to confirmation
- reasoning effort button copy translates protocol values into user-facing Chinese labels
- the active session's effective selection as `模型 + 思考强度`

Rules:
- selection is stored on the bridge session and applied on the next `thread/start` or `turn/start`
- the bridge stores model and reasoning effort separately; `默认` means "do not pin an override for this field"
- the bridge does not expose provider setup or arbitrary config editing through Telegram

### `/skills`

Shows:
- the current project's available skills from `skills/list`
- each skill's enabled state and concise description when present

### `/skill <name> :: <prompt>`

Behavior:
- sends the selected skill as structured input
- if the prompt is omitted, queue the skill and use the next normal text message as the task prompt
- `/cancel` clears the queued structured input

### `/plugins`

Shows:
- the current project's discovered plugin marketplaces plus plugin summaries from `plugin/list`
- installed and enabled state per plugin when available
- install and uninstall command hints

Rules:
- use the active session project path as the discovery cwd
- keep the Telegram output to a compact list instead of dumping raw marketplace JSON

### `/plugin install <marketplace>/<plugin>` and `/plugin uninstall <plugin_id>`

Behavior:
- resolves `<marketplace>/<plugin>` against the live `plugin/list` result for the active project
- calls `plugin/install` with the resolved marketplace path plus plugin name
- calls `plugin/uninstall` with the provided plugin id

Responses:
- install success: `已安装插件：{plugin_name}`
- uninstall success: `已卸载插件：{plugin_id}`
- install or uninstall failure: compact Telegram error text rather than raw protocol frames
- when install returns `appsNeedingAuth`, include a short follow-up list of affected app names and install URLs when present

### `/apps`

Shows:
- the current app list from `app/list`
- app accessibility and enabled state
- concise plugin linkage and install URL data when present

Rules:
- use the active thread id when available so app gating matches the current session config
- keep the Telegram surface read-only; app install flows remain link-first rather than form-heavy Telegram setup

### `/mcp`, `/mcp reload`, and `/mcp login <name>`

Shows:
- current MCP server status from `mcpServerStatus/list`
- auth status plus compact counts for tools, resources, and templates

Behavior:
- `/mcp reload` calls `config/mcpServer/reload`
- `/mcp login <name>` calls `mcpServer/oauth/login` and returns the generated authorization URL

Rules:
- Telegram shows the login link and asks the user to re-run `/mcp` after auth instead of trying to mirror the whole OAuth browser flow inline
- keep MCP status in compact chat form rather than exposing raw server metadata dumps

### `/account`

Shows:
- current account summary from `account/read`
- whether OpenAI auth is still required
- best-effort rate-limit summary from `account/rateLimits/read` when available

### `/review [detached] [branch <name>|commit <sha>|custom <instructions>]`

Behavior:
- starts `review/start` against the active session thread
- if Codex returns a new review thread, the bridge creates a dedicated review session and makes it active
- review sessions inherit the active session's selected model

### `/fork [name]`

Behavior:
- forks the active Codex thread into a new bridge session
- the new session becomes active immediately
- the selected model follows the forked session when present

### `/rollback` and `/rollback <n>`

Behavior:
- bare `/rollback` opens a target picker built from thread history and asks for confirmation before calling `thread/rollback`
- `/rollback <n>` remains as a direct compatibility path
- updates the active session's latest turn pointer to the returned thread state
- reminds the user that local file edits are not auto-reverted

### `/compact`

Behavior:
- requests `thread/compact/start`
- keeps the Telegram UX at the session level instead of exposing raw compact protocol detail

### `/thread name <name>`

Behavior:
- calls `thread/name/set`
- mirrors the new thread name into the bridge session display name

### `/thread meta branch=<branch> sha=<sha> origin=<url>`

Behavior:
- calls `thread/metadata/update`
- supports `-` as a clear value for any provided field

### `/thread clean-terminals`

Behavior:
- calls `thread/backgroundTerminals/clean`
- keeps the response compact at the thread level instead of exposing terminal-session internals

### `/local_image <path> :: <prompt>`

Behavior:
- resolves the image path relative to the active project path
- sends a real `localImage` input to Codex
- if the prompt is omitted, queue the image and use the next normal text message as the task prompt

### `/mention <path-or-name|path> :: <prompt>`

Behavior:
- sends a real `mention` input to Codex
- `name | path` sets the visible mention label explicitly
- if the prompt is omitted, queue the mention and use the next normal text message as the task prompt

### `/where`

Shows:
- current session name
- current project name
- current project path
- session status
- current `模型 + 思考强度`
- current `plan mode:on|off`
- bridge `session_id`
- Codex `thread_id` when available, otherwise an explicit not-created-yet note
- latest `turn_id` when available

### `/inspect`

Shows a structured activity snapshot for the active session.

Responses:
- with activity data:
  - Telegram HTML in compact Chinese, optimized for normal chat reading instead of debug-dump fidelity
  - a collapsible default view with explicit expand/collapse controls
  - paged detail when a full inspect view would be too large for one Telegram message
  - deduplicated session and project identity
  - current turn status, blocker, active step, and elapsed step time when available
  - one concise latest conclusion when available
  - recent action timeline when live activity data exists
  - recent command details, including command text and latest result summary when available
  - recent file-change summaries
  - recent MCP and web-search summaries grouped into one user-facing section
  - latest token-usage snapshot when available
  - latest diff summary when available
  - recent hook summaries when available
  - recent runtime notices such as config warnings, deprecation notices, model reroutes, skills refreshes, and thread compaction
  - terminal interaction summary when available
  - current plan snapshot
  - completed commentary entries when available
  - unresolved interaction summaries
  - when no live snapshot exists but the session has a completed turn, best-effort detail recovered from thread history
- with no activity data: `当前没有可用的活动详情。`
- if Telegram rejects an expanded inspect edit, the bridge sends a plain-text fallback message instead of leaving the callback silently broken

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
- when the active session currently has a live turn, append that session's runtime detail block under the bridge-health summary

### `/runtime`

Shows and edits the optional runtime-card field selection.

Rules:
- runtime status cards always keep fixed `Session`, `State`, and `Progress` rows
- `/runtime` controls only the additional optional rows under those fixed fields
- selected optional fields render one field per line instead of a single pipe-delimited summary line
- the picker separates `Codex CLI` fields from `Bridge Extensions`
- `Codex CLI` fields use Codex CLI semantics when rendered in Telegram
- bridge extensions remain available for bridge-specific operator needs
- only CLI fields that the bridge can currently render truthfully are exposed in the picker
- `Plan mode` is available as a bridge extension field
- legacy bridge fields such as `project_path`, `model_reasoning`, and `thread_id` may still remain available as bridge extensions for compatibility, but they are not the preferred v4 CLI-aligned choices
- `恢复默认` only resets the in-memory `/runtime` draft to `DEFAULT_RUNTIME_STATUS_FIELDS`; it does not persist or close the picker by itself
- `保存并应用` persists the current draft, updates any active runtime status card, and replaces the picker message with a compact non-interactive summary
- the saved summary lists the current effective field labels in display order; when no optional fields are selected it renders `无`

## Callback Contract

Versioned callback families currently emitted by the bridge:
- `v1` project picker and session-surface callbacks: `pick:{project_key}`, `scan:more`, `path:manual`, `path:back`, `path:confirm:{project_key}`, `rename:session:{session_id}`, `rename:project:{session_id}`, `rename:project:clear:{session_id}`, `plan:expand|collapse:{session_id}`, `agent:expand|collapse:{session_id}`, `final:open|close|page:{answer_id}[:{page}]`
- `v2` model picker callbacks: `model:default:{session_id}`, `model:page:{session_id}:{page36}`, `model:pick:{session_id}:{model_index36}`, `model:effort:{session_id}:{model_index36}:{effort|default}`
- `v3` interaction callbacks: compact `ix:d|q|t|c|a:...` forms using base64url interaction tokens plus base36 indexes; legacy `v3:ix:decision|question|text|cancel:...` callbacks are still accepted for compatibility
- `v4` runtime and long-tail UI callbacks: `plan:open|close|page:{answer_id}[:{page}]`, `rt:p|t|s|r:{token}[:{value}]`, `lg:s:{zh|en}`, `in:e|c|p:{session_id}[:{page36}]`, `rb:p|k|c|b:{session_id}:...`, `pr:i:{session_id}`
- `v5` targeted runtime and project-browser callbacks: `st:i|x:{session_id}`, `br:o|p|u|r|f|b|c:{token}[:{value36}]`

Rules:
- `project_key` is a stable short hash of the project path, never the raw path
- `interaction_token` is a bridge-owned compact token for the persisted interaction id, not a raw protocol id
- decision and question selectors are compact bridge-local indexes, not raw `decision_key` or `question_id` values
- runtime field selectors use short bridge-owned codes such as `mn`, `mw`, `pm`, and `fr`
- compact callback indexes use base36 encoding to stay within Telegram size limits
- bridge-emitted callback payloads must stay within Telegram's 64-byte `callback_data` limit; interaction callbacks are the tightest budget
- duplicate clicks must be idempotent and return `这个操作已处理。`
- stale callbacks must return `这个按钮已过期，请重新操作。`
- session switching and pinning are text commands (`/use <n>` and `/pin`), not callback actions
- interaction callbacks are bridge-owned UX for persisted pending interactions, not raw protocol passthrough
- rename, model, runtime, language, inspect, rollback, and plan-result callbacks are also bridge-owned UI contracts, not raw Codex callback passthrough

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
- edit or replace existing messages for bridge-owned runtime cards, bridge-owned long final-answer views, project pickers, manual-path flows, and rename prompts
- when a bridge-owned surface must fall back to sending a new message, retire the superseded message instead of leaving duplicate cards behind
- send new messages for initial final answers, status views, and when a new runtime card first appears

While a turn is running:
- keep one bridge-owned runtime surface in the chat for each visible runtime hub
- current runtime-card titles are `Runtime Status` and `Error`
- each live runtime hub is a stable five-slot container; sessions join a slot only when they first become truly running and keep that slot after they finish
- show at most one `当前查看中的会话` section on the hub that owns the active viewed session; hide that section entirely when the active session has not joined any hub yet
- show `其他运行中的会话` and `最近结束的会话` from that hub's own slots only
- keep completed hubs visible in chat and render their header as `Hub：x/y · 已完成`
- use a fixed one-row slot selector with `1..5` for occupied slots and `·` for empty positions; ended slots remain selectable
- keep richer runtime rows such as model, directory, token, and plan-mode fields out of the hub and available through `/status`
- when plan state becomes available, expose it through a collapsed button on the viewed runtime surface
- the collapsed Chinese plan label is fixed `计划清单`, `收起计划清单`, and plan/agent controls share one row when both are present
- project `commandExecution` items into the runtime surface instead of sending separate command cards
- keep the visible running-state label aligned with reduced Codex runtime state such as running, blocked, and terminal outcomes
- command activity should appear only through the visible progress text when a complete progress unit exists
- render progress text using Telegram HTML from a safe inline Markdown subset
- keep `Progress` for commentary and other user-readable stage updates rather than using it as the only running-state signal
- when subagents are expanded inline, show protocol-backed agent names whenever the runtime provides them instead of keeping the thread-id fallback label
- when subagents are expanded inline, prefer completed commentary over command or tool chatter for the visible per-agent progress text
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

Blocked-turn continuation and rich input rules:
- if the active turn is blocked and the session has no unresolved interaction cards, plain text becomes `turn/steer`
- if any interaction card for the active session is still `pending` or `awaiting_text`, the user must answer or cancel that interaction before unrelated text or rich input can continue the turn
- the same blocked-turn continuation path also accepts queued `skill`, `localImage`, `mention`, and Telegram photo inputs, but only after unresolved interaction cards are cleared
- Telegram photo messages are downloaded bridge-side and submitted as `localImage` input
- a photo caption is used as the prompt immediately; without a caption, the bridge queues the image and waits for the next text message
- Telegram remains an adapted UX, not a raw terminal surface
