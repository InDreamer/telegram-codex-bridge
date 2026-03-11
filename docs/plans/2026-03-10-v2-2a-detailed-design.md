# Telegram Codex Bridge V2 Phase 2A Detailed Design

Status: Proposed design for implementation handoff
Date: 2026-03-10
Scope: V2 Phase 2A only
Priority: Structured activity visibility > session management enhancement > platform/stability completion

Related documents:
- Current-state product/runtime docs:
  - `docs/product/v1-scope.md`
  - `docs/product/chat-and-project-flow.md`
  - `docs/architecture/runtime-and-state.md`
  - `docs/operations/install-and-admin.md`
  - `docs/research/app-server-phase-0-verification.md`
- Future-scope product/evaluation docs:
  - `docs/future/v2-prd.md`
  - `docs/future/v2-engineering-evaluation-template.md`
  - `docs/future/v2-engineering-evaluation.md`

---

## 1. Purpose

This document turns the V2 engineering evaluation into a build-ready Phase 2A design.

Phase 2A is intentionally narrow:
- preserve the frozen v1 trust boundary
- do not expand into archive/delete or `launchd` implementation yet
- deliver the first real V2 win: structured activity visibility built on native app-server events

The output of 2A should be sufficient for engineering to implement:
- native event collection
- three-layer visibility mapping
- normalized status model
- Telegram default-message high-value event surface
- `/inspect` expanded view
- local-only debug retention path

---

## 2. Canonical Document Placement

### 2.1 Placement rule for this round

Use the following path convention going forward:

| Doc type | Canonical location | Reason |
|---|---|---|
| Frozen/current behavior | `docs/product/`, `docs/architecture/`, `docs/operations/`, `docs/research/` | Code-derived or verified current-state docs |
| Future product intent and engineering evaluation | `docs/future/` | Future-scope source material and cross-phase evaluation |
| Phase-by-phase design and implementation handoff | `docs/plans/` | Execution-oriented design and checkpoint docs |
| Historical leftovers | `docs/archive/` | Prevents inactive drafts from being mistaken for live behavior |

### 2.2 Practical rule for references in this design

To avoid more path drift in the current round:
- treat `docs/future/v2-prd.md` as the only product source for V2 intent
- treat `docs/future/v2-engineering-evaluation.md` as the current evaluated engineering output
- place this 2A design under `docs/plans/`

### 2.3 Maintenance rule after this cleanup

After this cleanup:
- keep `AGENTS.md` listing:
  - V2 PRD
  - V2 engineering evaluation
  - current 2A design
- keep future-scope docs under `docs/future/` and execution handoff docs under `docs/plans/`

All new docs should keep using the canonical layered paths instead of inventing unofficial root-level variants.

---

## 3. 2A Goals And Non-Goals

### 3.1 Goals

Phase 2A should ship:
- native event ingestion for the stable app-server surface needed by V2 visibility
- a three-layer visibility policy:
  - Default
  - Inspect
  - Debug
- a normalized status model derived from native events
- a default Telegram one-message high-value event surface for long-running turns
- an explicit `/inspect` view for expanded, user-readable detail
- local debug capture for raw/native data without turning Telegram into a log console

### 3.2 Non-goals

Phase 2A does not include:
- session archive/unarchive implementation
- session delete
- `launchd` support
- expanded readiness/preflight implementation
- approval-flow UX
- rich debug streaming in Telegram
- cross-host continuity

### 3.3 Success criteria

2A is successful when:
- a long-running turn shows useful progress in normal Telegram usage
- the bridge surfaces actions/results rather than low-value status churn
- `/inspect` returns more detail without raw protocol noise
- raw event data remains available locally for debugging
- existing v1 final-answer behavior still works

### 3.4 Design correction after protocol verification and smoke feedback

This section overrides earlier 2A wording where they conflict.

After validating the real Codex app-server protocol surface and running Telegram smoke tests, 2A is refined as follows:

1. **Layer A is no longer status-card-first.**
   - It becomes a low-frequency, high-value event surface.
   - Prefer `action + result` over `state + heartbeat`.

2. **Default Telegram output should not chase every active-item/status change.**
   - Avoid exposing `starting`, `running`, `other`, or duration-only drift as primary user-facing content.

3. **Native signals should be split by trust level.**
   - Direct-use: command/tool activity that can be mapped accurately from native structured events.
   - Best-effort: commentary-like execution narration when the runtime emits it consistently enough.
   - Never user-facing: raw reasoning streams.

4. **`/inspect` should carry more of the useful execution detail.**
   - Recent commands
   - command/result summaries
   - file changes
   - MCP progress/tool summaries
   - web search summaries
   - plan snapshot
   - optional best-effort commentary snippets

5. **Reasoning remains outside product surfaces.**
   - No raw reasoning text
   - No reasoning summary delta streaming
   - At most a coarse category-level signal in the future, if needed

---

## 4. Approaches Considered

### Option A: Notification-first activity pipeline

Shape:
- consume native notifications as they arrive
- preserve them in bounded raw buffers
- derive a normalized status object
- render Layer A and Layer B from the normalized model

Pros:
- matches the PRD and evaluation
- gives live long-task visibility
- keeps source fidelity for later iteration
- avoids polling

Cons:
- needs a new event-mapping layer
- needs throttling and Telegram edit handling

Recommendation:
- use this for 2A

### Option B: Poll-and-reconstruct from `thread/read` / `thread/resume`

Shape:
- keep current final-answer path
- periodically re-read thread state and infer activity from completed items

Pros:
- simpler event ingestion

Cons:
- stale for long-running turns
- weak support for current active item
- poor fit for low-latency visibility

Recommendation:
- reject for 2A

### Option C: Telegram narration layer without native fidelity

Shape:
- keep transport mostly unchanged
- generate human-readable progress text from coarse signals only

Pros:
- low implementation cost

Cons:
- violates the V2 product decision to use native structured activity
- creates fragile fake state

Recommendation:
- reject for 2A

### Selected approach

2A should use Option A:
- native notifications
- bounded raw retention
- normalized status model
- layered rendering

---

## 5. Selected 2A Architecture

### 5.1 High-level flow

```text
app-server notifications
  -> method parser + capability guard
  -> raw event journal (bounded memory + local debug export)
  -> activity tracker / normalized status reducer
  -> Layer A status-card renderer
  -> Layer B inspect renderer
```

### 5.2 Design principles

- Preserve raw data first; decide visibility later.
- Keep Layer A compact and edit-in-place.
- Keep Layer B on-demand only.
- Keep Layer C local/operator-oriented.
- Keep 2A mostly in-memory; avoid SQLite schema churn unless it becomes necessary.

### 5.3 State boundary

For 2A:
- durable session/thread data stays in SQLite as-is
- per-turn activity state stays in memory
- raw debug export is written to runtime files, not SQLite

Reason:
- 2A is about visibility, not archival analytics
- this keeps scope smaller and avoids coupling 2A to 2B session schema changes

---

## 6. Native Event To Visibility Mapping

### 6.1 Raw event classes to collect

Collect and classify at minimum:
- `turn/started`
- `turn/completed`
- `thread/status/changed`
- `item/started`
- `item/completed`
- `item/mcpToolCall/progress`
- `turn/plan/updated`
- `item/plan/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `item/agentMessage/delta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`
- `error`
- legacy compatibility:
  - `codex/event/task_complete`
  - `codex/event/turn_aborted`

### 6.2 Three-layer mapping table

| Native signal | Default | Inspect | Debug | Derived use | Notes |
|---|---|---|---|---|---|
| `turn/started` | Limited | Yes | Yes | start anchor only | Use only when it adds value |
| `turn/completed` | Yes | Yes | Yes | completion anchor | Immediate Layer A update |
| `thread/status/changed` | Derived only | Derived summary | Raw kept | blocked vs active vs idle signal | Show only reduced blocked/failure meaning |
| `item/started` for `commandExecution` | Yes as `Ran cmd` candidate | Yes | Yes | command/action event | Prefer command + result, not generic active-item text |
| `item/started` for `fileChange` | Maybe as `Changed` candidate | Yes | Yes | change event | Default only when meaningful |
| `item/started` for `mcpToolCall` | Maybe | Yes | Yes | tool-call event | Prefer progress/result over raw type label |
| `item/started` for `webSearch` | Maybe | Yes | Yes | search event | Default only when search itself is meaningful |
| `item/started` for `plan` | No | Yes | Yes | inspect plan context | Keep out of Layer A by default |
| `item/started` for `agentMessage` | No direct text | Yes | Yes | possible commentary/finalization context | Not a Layer A contract |
| `item/started` for `reasoning` | No | No | Yes | internal work classification | Never user-facing in 2A |
| `item/completed` for all stable types | Yes if resultful | Yes | Yes | finalize action/result summary | Preferred source for `Found` / `Changed` / command result |
| `item/mcpToolCall/progress` | Yes, throttled | Yes | Yes | useful progress text | High-value native message field |
| `turn/plan/updated` | No | Yes | Yes | best-effort plan snapshot | Inspect-only |
| `item/plan/delta` | No | Optional best-effort | Yes | plan preview text | Experimental; never required |
| `item/commandExecution/outputDelta` | No direct raw text | Yes as summarized result source | Yes | derive command-result summary | Do not raw-stream in Layer A |
| `item/fileChange/outputDelta` | No | Yes as summarized result source | Yes | derive change summary | No raw diff in Layer A |
| `item/agentMessage/delta` | No | Optional best-effort commentary snippet | Yes | inspect execution narration hint | Never raw-stream in default chat |
| `item/reasoning/summaryTextDelta` | No | No | Yes | internal/debug only | Keep debug-only |
| `item/reasoning/summaryPartAdded` | No | No | Yes | reasoning segmentation | Debug-only |
| `item/reasoning/textDelta` | No | No | Yes | raw reasoning stream | Debug-only |
| `error` | Yes as blocked/failed | Yes | Yes | failure reason enrichment | Keep user copy compact |
| `codex/event/task_complete` | No direct Layer A | No | Yes | final-answer fast path compatibility | Keep for backward compatibility only |
| `codex/event/turn_aborted` | Derived only | Yes | Yes | interruption compatibility | Keep while legacy path exists |

### 6.3 Active item type mapping

Map native item types to product labels:

| Native item type | Product `active_item_type` |
|---|---|
| `plan` | `planning` |
| `commandExecution` | `commandExecution` |
| `fileChange` | `fileChange` |
| `mcpToolCall` | `mcpToolCall` |
| `webSearch` | `webSearch` |
| `agentMessage` | `agentMessage` |
| `reasoning` | `reasoning` |
| any other known item | `other` |
| unavailable | `null` |

### 6.4 Borderline signals

These stay conservative in 2A:
- reasoning summaries remain Debug-only
- plan deltas remain Inspect/Debug only
- raw agent-message deltas are never shown verbatim in normal chat

---

## 7. Normalized Status Model

### 7.1 Top-level model

```yaml
turn_status: idle | blocked | interrupted | completed | failed | unknown
active_item_type: commandExecution | fileChange | mcpToolCall | webSearch | plan | agentMessage | reasoning | other | null
last_activity_at: ISO8601 | null
last_high_value_event_type: ran_cmd | found | changed | blocked | done | null
last_high_value_title: string | null
last_high_value_detail: string | null
latest_progress: string | null
thread_blocked_reason: waitingOnApproval | waitingOnUserInput | null
final_message_available: boolean
inspect_available: boolean
debug_available: boolean
error_state: bridge_restart | app_server_lost | turn_failed | codex_not_authenticated | app_server_unavailable | unknown | null
```

### 7.2 Field definitions

| Field | Meaning | Primary source | Fallback |
|---|---|---|---|
| `turn_status` | Product-level execution state | `turn/started`, `turn/completed`, `thread/status/changed`, local failures | `unknown` if no active signal exists |
| `active_item_type` | Current kind of work for internal reduction | `item/started` minus completed item | `null` |
| `last_activity_at` | Time of last accepted relevant event | bridge receive time | last known value or `null` |
| `last_high_value_event_type` | The last default-layer-worthy event category | derived from classified native events | `null` |
| `last_high_value_title` | Short user-facing action/result title | derived summary | `null` |
| `last_high_value_detail` | Short user-facing result detail | derived summary | `null` |
| `latest_progress` | Low-noise text for current work | `item/mcpToolCall/progress.message` or other best-effort useful native text | `null` |
| `thread_blocked_reason` | If the thread is blocked | `thread/status/changed.activeFlags` | `null` |
| `final_message_available` | Whether a final answer is already available | `codex/event/task_complete` or final history lookup result | `false` |
| `inspect_available` | Whether Layer B can return meaningful data | derived from recent item/timeline buffers | `false` |
| `debug_available` | Whether local raw debug exists | derived from active raw journal path | `true` for active tracked turns |
| `error_state` | Coarse failure code | local bridge failure and readiness states | `unknown` or `null` |

### 7.3 Fallback rules

If a required native signal is absent:
- keep `turn_status` truthful even if `active_item_type` is `null`
- do not invent a semantic state name
- prefer no default-layer update over low-value heartbeat/status churn

If only legacy signals arrive:
- retain current v1 final-answer path
- keep `turn_status`
- disable rich item-derived Layer A details
- mark `inspect_available = false` unless enough item history exists

If an unknown item type appears:
- keep the raw payload
- map `active_item_type = other` internally
- do not surface `other` directly in Layer A

If the bridge restarts mid-turn:
- keep existing runtime notice behavior
- start new turns with fresh activity state
- do not attempt to reconstruct in-flight item detail from nothing

### 7.4 Inspect snapshot model

For `/inspect`, derive:

```yaml
inspect_snapshot:
  turn_status:
  active_item_type:
  last_activity_at:
  latest_progress:
  recent_transitions:
  recent_command_summaries:
  recent_file_change_summaries:
  recent_mcp_summaries:
  recent_web_searches:
  plan_snapshot:
  commentary_snippets:
  notes:
```

### 7.5 Raw retention model

Keep two bounded stores per active turn:

1. In-memory high-signal activity journal
- purpose: Layer A and Layer B rendering
- suggested retention:
  - last 100 normalized activity records

2. Local raw debug journal
- purpose: Layer C/operator debugging
- suggested retention:
  - newline-delimited JSON
  - per-turn file in runtime directory
  - size cap with truncation/rotation, for example 512 KB to 1 MB per turn

---

## 8. Telegram Surface Design

### 8.1 Default chat behavior

Default Telegram behavior should remain simple:
- one bridge-owned default message per running turn
- edits to that message while the turn is active, but only when real information value changes
- final answer remains a new message
- explicit failure/interruption remains a new message

Suggested Layer A shape:

```text
Ran cmd: pnpm test
结果：26/26 tests passed
发送 /inspect 查看更多细节
```

Alternative examples:

```text
Found: located bridge service and verified ready state
发送 /inspect 查看更多细节
```

```text
Blocked: Codex app-server unavailable
发送 /inspect 查看更多细节
```

### 8.2 Default card rendering rules

Show:
- one high-value action/result event at a time
- blocked/failure/completion when relevant
- latest useful progress if it carries real information value
- inspect hint

Do not show:
- `starting` / `running` / `other` as primary content
- duration-only drift
- raw stdout/stderr
- raw diff text
- reasoning text
- protocol fields

### 8.3 Inspect behavior

Use `/inspect` as the first-cut trigger.

Reason:
- command-first is simpler than inventing new callback flows immediately
- it avoids coupling 2A to button state management
- it keeps 2A focused on visibility, not control-surface expansion

Suggested inspect response:

```text
当前任务详情
最近有用进展：Ran cmd: pnpm test -> 26/26 tests passed
最近进度：Searching docs

最近命令
- pnpm test -> 26/26 tests passed
- rg "app-server" src -> matched 12 files

最近文件变更
- src/service.ts（默认层节流修复）
- src/telegram/ui.ts（默认层文案收敛）

最近 MCP
- Searching docs

计划概览
- 收集协议证据（completed）
- 归一化状态模型设计（inProgress）
- Telegram 展示策略（pending）

可选 commentary（best-effort）
- 正在核对 app-server 事件与 Telegram 默认层边界
```

### 8.4 Debug access

Debug data should stay out of normal Telegram flow.

2A minimum debug path:
- write raw event journal to runtime files under the state directory
- keep existing bootstrap/app-server logs
- document the file path for local inspection

Suggested runtime path:
- `~/.local/state/codex-telegram-bridge/runtime/debug/<threadId>/<turnId>.jsonl`

Optional later CLI surface:
- a future operator command such as `ctb doctor --debug-export`

2A does not require the CLI export command to exist yet, but the runtime debug file format should be chosen so that a later CLI/export layer can reuse it.

---

## 9. Update And Throttling Strategy

### 9.1 Rendering policy

Apply updates immediately for:
- a new high-value action/result event
- turn completion
- blocked/unblocked thread status change
- first non-empty progress message that materially improves user understanding

Apply throttled updates for:
- repeated progress refreshes
- commentary-like text changes
- repeated deltas that do not change the rendered action/result summary
- any duration-only or heartbeat-only change

### 9.2 Suggested throttle values

Default message:
- immediate on new high-value event
- otherwise at most once every 5 seconds when a genuinely useful update exists

Inspect:
- no push updates
- snapshot only when the user asks

Debug:
- append every collected raw event to local journal

### 9.3 Coalescing rules

Coalesce duplicate or low-value updates:
- identical `latest_progress` strings should not trigger another Telegram edit
- `last_activity_at` alone should not cause a new edit more often than the throttle window
- multiple raw deltas inside the same item should compress into one rendered summary state

### 9.4 Edit failure policy

If Telegram message edit fails:
- avoid retry loops
- if failure is a Telegram rate limit, enter cooldown instead of sending a replacement flood
- if replacement is unavoidable, preserve the one-active-card invariant

---

## 10. Module Landing Zones In Current Codebase

### 10.1 Recommended new modules

| Path | Responsibility |
|---|---|
| `src/activity/types.ts` | normalized status types, inspect snapshot types, activity labels |
| `src/activity/tracker.ts` | reduce native notifications into normalized state and bounded journals |
| `src/activity/debug-journal.ts` | append raw notifications to local JSONL files with rotation/size bounds |
| `src/codex/notification-classifier.ts` | parse and classify app-server notifications into stable internal events |

### 10.2 Recommended existing module changes

| Path | Change |
|---|---|
| `src/codex/app-server.ts` | keep transport ownership; expose notification stream cleanly; avoid putting product mapping here |
| `src/service.ts` | wire tracker lifecycle, default-message lifecycle, `/inspect`, and turn-scoped activity state |
| `src/telegram/api.ts` | add `editMessageText`; make `sendMessage` return enough data to store the default-message id |
| `src/telegram/ui.ts` | add renderers for Layer A high-value default message and Layer B inspect response |
| `src/telegram/commands.ts` | add `/inspect` help text and command registration |
| `src/types.ts` | add shared types only if they are used outside the new `activity/` module |
| `src/paths.ts` | add a canonical debug-runtime directory path |
| `src/service.test.ts` | cover default-message lifecycle and inspect behavior |

### 10.3 Responsibilities to avoid

Avoid:
- making `src/service.ts` the permanent home of event-reduction logic
- storing raw 2A activity events in SQLite
- mixing Telegram presentation strings into `src/codex/app-server.ts`

### 10.4 Suggested service wiring

Recommended flow inside `BridgeService`:

1. Turn starts:
- initialize an `ActivityTracker` for the active turn
- create the initial default message only if there is useful content to show

2. Notification arrives:
- append raw notification to debug journal
- classify it
- reduce it into tracker state
- maybe update the default message based on high-value-event policy and throttling

3. `/inspect` arrives:
- render snapshot from tracker state

4. Turn completes:
- finalize tracker
- send final answer or failure message
- stop editing the default message

---

## 11. Data And File Shapes

### 11.1 Raw debug journal record

Suggested JSONL shape:

```json
{
  "receivedAt": "2026-03-10T10:00:00.000Z",
  "threadId": "thr_123",
  "turnId": "turn_456",
  "method": "item/mcpToolCall/progress",
  "params": {
    "itemId": "item_789",
    "message": "Searching docs"
  }
}
```

### 11.2 High-signal normalized activity record

Suggested in-memory shape:

```json
{
  "at": "2026-03-10T10:00:02.000Z",
  "kind": "progress",
  "turnStatus": "running",
  "activeItemType": "mcpToolCall",
  "summary": "Searching docs"
}
```

### 11.3 Status-card session state

Suggested bridge-local state:

```yaml
status_card:
  chat_id:
  message_id:
  last_render_hash:
  last_sent_at:
```

This should stay in memory for 2A.

---

## 12. Risks And Open Items

### 12.1 Design risks

| Risk | Why it matters | 2A mitigation |
|---|---|---|
| Telegram API currently lacks message editing support | Default Layer A UX depends on edit-in-place | Add `editMessageText` before 2A visibility UI lands |
| Native event bursts can spam edits | Bad UX and rate-limit risk | Structural-change immediacy plus 5-second throttle |
| Legacy and v2 event surfaces may both appear | Could duplicate signals | Keep one classifier and de-dup by turn/item ids |
| Plan delta is experimental | Unsafe as a required status source | Use `turn/plan/updated` best-effort; never require plan delta |
| Reasoning data is tempting to overexpose | Violates product direction | Keep reasoning debug-only in first cut |

### 12.2 Open items that do not block 2A design

- Whether `/inspect` later gains an inline button
- Exact Chinese copy polish for active-item labels
- Whether debug export gets a dedicated CLI surface in 2A or 2C

### 12.3 Items that would block build-readiness

2A would stop being ready to build only if one of these proves false:
- the local Codex version lacks `item/started` / `item/completed`
- Telegram edit support cannot be added reliably
- the bridge cannot correlate item progress to the active turn/thread

Current evidence says none of those are blocked.

---

## 13. Ready-To-Build Judgement

### Judgement

2A is `ready to build` with one explicit implementation assumption:
- keep the current evaluation document at its actual path for now and reference it explicitly until a docs-only cleanup moves it

### Why it is ready

- the event surface needed for 2A is already confirmed by:
  - local Phase 0 verification
  - local generated v2 schema
  - official app-server docs
- current v1 code already has:
  - app-server ownership
  - session/thread lifecycle
  - final-answer handling
  - Telegram command loop
  - runtime paths and logs
- 2A can avoid:
  - SQLite schema change
  - session archive work
  - platform manager work

### First implementation checkpoint expected from this design

- new `activity/` module skeleton
- typed notification classifier
- normalized status reducer tests
- Telegram status-card API support
- `/inspect` command wiring
