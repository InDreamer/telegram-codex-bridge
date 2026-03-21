# Runtime And Delivery Flow

Current intended behavior for:
- `/hub`, `/where`, `/inspect`, `/interrupt`, `/status`, and `/runtime`
- runtime-hub and runtime-card behavior while turns are running
- final-answer delivery and bridge-owned message edit/replacement rules
- blocked-turn continuation and rich-input continuation rules

When implementation detail matters, verify against:
- `src/service/runtime-surface-controller.ts`
- `src/service/turn-coordinator.ts`
- `src/service/interaction-broker.ts`
- `src/telegram/ui-runtime.ts`
- `src/telegram/ui-final-answer.ts`

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

### `/hub`

Shows:
- the latest live runtime hub for the current chat

Responses:
- with one or more running sessions: resend the runtime hub to the bottom of the chat
- with no running sessions: `当前没有运行中的会话。`
- with actionable pending interaction cards still visible: `当前有待处理的交互，请先完成当前操作。`

Rules:
- `/hub` does not include extra detail rows beyond the runtime hub itself
- `/hub` never buries pending interaction controls under a refreshed hub
- a successful `/hub` use marks the command as learned for that chat so reminder copy stops repeating

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
- auto-refresh the hub only after a new turn stays running for a short delay, or after a blocked turn resumes running and stays running for a short delay
- do not auto-refresh the hub after final answers, plan results, `/status`, `/inspect`, `/where`, `/help`, language changes, interrupt replies, failure notices, or session-management confirmations
- when actionable interaction cards are pending, keep them visually primary and block both automatic hub refresh and `/hub` pull-up
- use the one-line reminder `需要查看运行卡片时，可发送 /hub。` only on the delayed first auto-refresh for a turn and on plain-text busy-turn rejection before the user has learned `/hub`

While a turn is running:
- do not queue a second turn
- reply with `当前项目仍在执行，请等待完成或发送 /interrupt。`
- before the user has learned `/hub`, plain-text busy-turn rejection may append `需要查看运行卡片时，可发送 /hub。`

Blocked-turn continuation and rich input rules:
- if the active turn is blocked and the session has no unresolved interaction cards, plain text becomes `turn/steer`
- if any interaction card for the active session is still `pending` or `awaiting_text`, the user must answer or cancel that interaction before unrelated text or rich input can continue the turn
- the same blocked-turn continuation path also accepts queued `skill`, `localImage`, `mention`, and Telegram photo inputs, but only after unresolved interaction cards are cleared
- Telegram photo messages are downloaded bridge-side and submitted as `localImage` input
- a photo caption is used as the prompt immediately; without a caption, the bridge queues the image and waits for the next text message
- Telegram remains an adapted UX, not a raw terminal surface
