# Telegram Codex Bridge V2 Engineering Evaluation

Status: Evaluated
For: V2 engineering evaluation response
Related PRD: `docs/future/v2-prd.md`
Related template: `docs/future/v2-engineering-evaluation-template.md`
Related v1 docs: `docs/product/v1-scope.md`, `docs/product/chat-and-project-flow.md`, `docs/architecture/runtime-and-state.md`, `docs/operations/install-and-admin.md`, `docs/research/app-server-phase-0-verification.md`

---

## 1. Evaluation Summary

### 1.0 Response metadata
- Evaluator: Codex
- Date: 2026-03-10
- Repo / branch / commit reviewed: `telegram-codex-bridge` / `master` / `9a6b618`
- Runtime version reviewed: `codex-cli 0.112.0`
- Local verification environment: `node v22.22.0` with project engine declaration `>=25.0.0`
- Confidence level: `High`
- Current status: `Validated`

### 1.1 Overall feasibility
- Feasibility: `Feasible with constraints`
- Overall recommendation: build V2 as a phased extension on the current v1 base, not as a rewrite
- Recommended V2 scope: ship structured activity visibility first, then archive-first session management, then platform/stability completion including macOS `launchd`
- Recommended deferrals to V3:
  - hard delete / destructive session removal
  - any cross-host continuity or migration implication
  - raw debug streaming inside normal Telegram chat flow

### 1.2 One-paragraph conclusion
- V2 is feasible on the current codebase because the bridge already has the right v1 spine: a long-lived local app-server client, persistent SQLite state, readiness probing, restart degradation, session persistence, and same-host rebind migration at the chat-binding layer. The main V2 gap is not transport or persistence; it is that the current bridge still behaves like a final-answer-only adapter and consumes only a tiny slice of the native event surface. The generated `codex app-server` v2 schema and official app-server docs show that the required activity/event surface already exists for a real three-layer visibility model, while local code and tests show that session continuity and corruption fallback already have a usable foundation. The recommended cut line is therefore: ship structured activity flow plus normalized status model as the must-have core, keep session management archive-first and delete-cautious, and treat macOS `launchd` as required V2 completion rather than optional polish.

### 1.3 Progress tracking snapshot

| Track | Priority | Status | Confidence | Owner | Main blocker | Next step |
|---|---|---|---|---|---|---|
| Structured activity visibility | P0 | Ready to build | High | Bridge engineering | No event collector, retention, or status mapper yet | Build event inventory adapter and normalized status model |
| Session management enhancement | P1 | Feasible | High | Bridge engineering | No archive model, no richer session state rendering | Add archive-first local/remote session model and clearer list rendering |
| Platform/stability completion | P2 | Feasible | Medium | Bridge engineering | Linux-only service management and shallow preflight | Add service-manager abstraction with `launchd`, expand readiness/preflight |

---

## 2. Validation Inputs

Engineering reviewed the requested sources plus current implementation evidence.

- [x] Main v1 docs reviewed
- [x] Current PRD reviewed
- [x] Current implementation/code reviewed
- [x] Current Codex app-server protocol/schema reviewed
- [x] Official docs reviewed
- [x] Web research completed if needed

### Notes
- Code/branch/repo reviewed: `telegram-codex-bridge@master (9a6b618)`
- Runtime / Codex version reviewed: `codex-cli 0.112.0`
- Local Node version used for validation: `v22.22.0`
- Protocol/schema source reviewed:
  - `docs/research/app-server-phase-0-verification.md`
  - local `codex app-server --help`
  - local `codex app-server generate-json-schema --experimental --out /tmp/codex-app-schema/json`
  - local `codex app-server generate-ts --experimental --out /tmp/codex-app-ts`
- External docs / links reviewed:
  - https://developers.openai.com/codex/app-server
  - https://developers.openai.com/codex/cli
  - official pages fetched successfully on 2026-03-10 via `markdown.new` mirror because the direct browser capture was incomplete
- Path note:
  - the user message referenced `docs/telegram-codex-bridge-v2-prd.md` and `docs/telegram-codex-bridge-v2-engineering-eval-template.md`
  - in the current repo information architecture, the live future-scope sources are `docs/future/v2-prd.md`, `docs/future/v2-engineering-evaluation-template.md`, and this document at `docs/future/v2-engineering-evaluation.md`

### Evidence register

| Evidence type | Link / path / command | Key finding |
|---|---|---|
| v1 planning baseline | `docs/archive/legacy-v1-engineering-plan-draft.md` | The earlier monolithic draft was retired; the split v1 docs preserve the same frozen trust boundary |
| PRD | `docs/future/v2-prd.md` | Priority order is fixed: activity visibility > session management > platform/stability |
| current code | `src/service.ts`, `src/state/store.ts`, `src/install.ts`, `src/readiness.ts`, `src/telegram/ui.ts` | Current implementation is solid v1 infrastructure but still final-answer-centric |
| tests | `npm test` on 2026-03-10 | 12/12 tests passed; current baseline is stable for evaluation |
| protocol/schema | `docs/research/app-server-phase-0-verification.md`; `/tmp/codex-app-schema/json/codex_app_server_protocol.v2.schemas.json`; `/tmp/codex-app-ts/v2/` | Local runtime confirms legacy event mix and generated v2 schema exposes the richer event surface needed for V2 |
| official docs | https://developers.openai.com/codex/app-server ; https://developers.openai.com/codex/cli | Official docs confirm JSON-RPC transport, initialize flow, item/turn/thread primitives, and generator tooling availability |
| web research | official OpenAI docs fetched on 2026-03-10 via `markdown.new` mirror | No blocker found that invalidates the local/runtime evidence |
| local toolchain | `package.json`; `npm install`; `npm run check` | Current code validates locally, but the project still lacks an explicit Node-version preflight despite declaring `>=25.0.0` |

---

## 3. Event Surface Assessment

### 3.1 Confirmed native event surface
List the Codex-native events/signals confirmed to exist and be usable.

| Event / Signal | Confirmed? | Stability | Notes |
|---|---|---|---|
| turn lifecycle | Yes | High | Verified locally in Phase 0 and current bridge already consumes `turn/completed` |
| thread status | Yes | High | `thread/status/changed` is documented and present in generated v2 schema |
| item started/completed | Yes | High | Generated v2 schema exposes `item/started` and `item/completed` |
| MCP progress | Yes | High | Generated v2 schema exposes `item/mcpToolCall/progress` with `message` |
| plan updates | Yes | Medium | `turn/plan/updated` and `item/plan/delta` exist, but plan delta is explicitly marked experimental |
| command output delta | Yes | High | Generated v2 schema exposes `item/commandExecution/outputDelta` |
| reasoning stream | Yes | Medium | Generated v2 schema exposes reasoning text/summary deltas; useful for debug, risky for product UX |
| raw protocol frames | Yes | High | Bridge owns stdio transport, so raw JSON-RPC frames are available for debug capture even though current code does not persist them |

### 3.2 Event gaps / uncertainty
- The current bridge only consumes `codex/event/task_complete` and `turn/completed`; the richer v2 item surface is confirmed by schema/docs but not yet integrated locally.
- `PlanDeltaNotification` is explicitly marked experimental in the generated schema, so it should not become a hard dependency for Layer A.
- The official app-server docs describe the JSON-RPC contract and client generation path, but the generated local schema is the stronger source for exact v2 event names on `codex-cli 0.112.0`.

### 3.3 Protocol mismatches vs product expectation
- Product expects structured activity visibility; current bridge still ignores almost all native activity signals.
- Product wants three visibility layers; current bridge has only two practical layers today: hidden internals and final answer.
- Product prefers archive-first session handling; current runtime exposes `thread/archive` and `thread/unarchive`, but the local session model has no archive concept yet.

---

## 4. Visibility Layer Mapping Proposal

Map events/features into the three-layer visibility model.

### 4.1 Layer A — Default User Layer

| Event / Derived Signal | Show? | Why | Rendering notes |
|---|---|---|---|
| `turn/started`, `turn/completed`, interrupted/failure completion | Yes | This is the minimal trustworthy turn lifecycle | Drive one bridge-owned in-progress status card plus final answer/new failure message |
| Active item type derived from `item/started` / `item/completed` | Yes | This is the core V2 user win | Map only stable types: `plan`, `commandExecution`, `fileChange`, `mcpToolCall`, `webSearch`, `agentMessage`, `reasoning`, `other` |
| `thread/status/changed` reduced to high-level blocked/idle/active | Yes | Useful when visible state really changes | Do not expose raw thread-status payload directly |
| Last activity timestamp | Yes | Reassures the user the task is alive | Derived locally from latest accepted event |
| Current activity duration | Yes | Useful on long tasks if the active item remains stable | Derived locally; omit if item identity changes too frequently |
| Latest low-noise MCP progress message | Yes | Stable, native, and user-readable | Show only the latest message and throttle aggressively |
| Raw agent-message deltas | No | Too noisy for default chat | Keep for inspect/debug only |
| Command/file output deltas | No | Violates final-answer-first chat simplicity | Debug only |

### 4.2 Layer B — User Inspect Layer

| Event / Derived Signal | Show? | Why | Rendering notes |
|---|---|---|---|
| Recent activity timeline | Yes | Best answer to “what is it doing” | Show recent transitions with relative times |
| Command summary | Yes | Useful without dumping raw stdout | Summarize command action/name/path when available |
| File-change summary | Yes | Product-useful, less noisy than diff streaming | Summarize touched paths/counts, not raw patch stream |
| MCP tool-call summary | Yes | User-meaningful for research-heavy tasks | Show tool name/status and latest progress message |
| Web-search summary | Yes | User-meaningful and already a native item type | Keep compact and recent-only |
| Plan snapshot | Yes, best effort | Useful if present, but should not block the feature | Use `turn/plan/updated` plus completed item data; label as best effort |
| Partial agent-message production summary | Yes, cautiously | Useful when users ask for more detail | Keep to high-level snippets, not raw token deltas |

### 4.3 Layer C — Debug Layer

| Event / Derived Signal | Keep? | Why | Access path |
|---|---|---|---|
| Raw JSON-RPC requests/responses/notifications | Yes | Needed for protocol debugging and regressions | Local debug export / logs, not normal chat |
| Command output deltas | Yes | Needed when a task looks stuck or failed | Local debug export / logs |
| File-change output deltas | Yes | Needed for implementation debugging | Local debug export / logs |
| Reasoning deltas and reasoning summaries | Yes | Useful for engineering diagnosis, not default UX | Debug-only export |
| Account/config/system notifications | Yes | Operational diagnostics | `ctb doctor`-adjacent debug surface |
| EOF/reconnect/parse errors | Yes | Critical to app-server troubleshooting | Bootstrap/app-server logs |

### 4.4 Notes on event promotion/demotion
Which signals are borderline and may move between layers later?

- `turn/plan/updated` and `item/plan/delta` should start in Layer B because plan deltas are explicitly experimental.
- Reasoning summaries could eventually move from Layer C to Layer B if they prove stable and user-comprehensible, but they should not be a V2 default.
- `thread/status/changed.activeFlags` should stay derived-only unless a concrete user-facing blocked state proves valuable.

---

## 5. Normalized Status Model Proposal

Define the product-level state model the bridge should expose.

### 5.1 Proposed top-level status object

```yaml
turn_status: idle | starting | running | blocked | interrupted | completed | failed | unknown
active_item_type: planning | commandExecution | fileChange | mcpToolCall | webSearch | agentMessage | reasoning | other | null
last_activity_at: ISO8601 | null
current_item_duration: seconds | null
latest_progress: string | null
inspect_available: boolean
debug_available: boolean
error_state: bridge_restart | app_server_lost | turn_failed | codex_not_authenticated | app_server_unavailable | unknown | null
```

### 5.2 Field definitions

| Field | Meaning | Source | Required? |
|---|---|---|---|
| turn_status | Product-level execution state for the active turn | turn lifecycle + thread status + local failure handling | Yes |
| active_item_type | Best current work-type label | `item/started` / `item/completed` item type mapping | No |
| last_activity_at | Most recent accepted event time | Local wall-clock timestamp when bridge processed the latest relevant event | Yes |
| current_item_duration | Seconds since current item became active | Local timer from active-item start | No |
| latest_progress | Last user-readable low-noise progress string | Prefer MCP progress; optionally other stable native summaries | No |
| inspect_available | Whether Layer B has meaningful data right now | Derived from retained event history | Yes |
| debug_available | Whether debug/raw export exists | Derived from runtime debug retention policy | Yes |
| error_state | Coarse reason when not healthy | Local failure reason + readiness state | No |

### 5.3 Fallback behavior
What should the bridge show when native signal quality is limited?

- If only the v1-era legacy signals are available, keep `turn_status` accurate and set `active_item_type = null`.
- If item typing fails or a new item type appears, map it to `other` rather than dropping the event.
- If the bridge reconnects and loses fine-grained event history, preserve honest state: last known turn status, degraded inspect availability, and explicit recovery wording.

### 5.4 Suggested progress status for this track
- Status: `Ready to build`
- Why: the event surface is confirmed by local runtime evidence, local schema generation, and official docs
- Next milestone: implement an event collector plus mapper that preserves raw events and emits a throttled normalized status object

---

## 6. Session Management Evaluation

### 6.1 Proposed V2 session scope
- Session list improvements:
  - show active marker explicitly
  - show state badge, last activity, and last result/failure summary
  - hide archived sessions by default with an explicit archived view/filter
- Session state visibility improvements:
  - keep execution status separate from archive state
  - add presentation for `failed` with concrete reason
  - make “current active session” obvious in `/sessions` and `/where`
- Current active session visibility:
  - continue using `chat_binding.active_session_id`
  - render the active marker in both normal list view and any inspect/session detail view
- Archive support:
  - recommended for V2
  - archive only idle/failed/interrupted sessions
  - map to both local bridge state and remote `thread/archive` / `thread/unarchive` when `threadId` exists
- Delete support:
  - do not ship user-facing hard delete in V2
  - there is verified archive/unarchive support, but no verified hard-delete thread API in the reviewed evidence set
  - PM preference is delete-cautious; engineering recommendation is to defer delete to V3
- Rename/pin implications:
  - keep current rename flow
  - keep project pinning project-scoped, not session-scoped
  - do not overload pinning as a substitute for archive or delete

### 6.2 Same-host rebind continuity
- What can realistically be preserved?
  - session rows in SQLite
  - the active session pointer
  - runtime notices
  - thread-backed session continuity when the same host still has the local database and the referenced thread ids remain valid
- What cannot be guaranteed?
  - in-flight turn continuation after bridge/app-server restart
  - continuity after DB corruption reset
  - any cross-host or cross-machine portability
  - continuity if remote thread data is missing or no longer readable
- What user-visible behavior is recommended?
  - say explicitly that same-host rebind may restore old sessions when local state still exists
  - keep the current honest recovery copy for interrupted/running turns
  - never imply that rebind recreates the in-progress execution state of a lost turn

### 6.3 Risks / edge cases
- Local session archive state and remote thread archive state can drift unless V2 defines a sync rule.
- Rebind continuity currently migrates prior sessions for the same authorized user id; V2 should keep that scope and avoid implying cross-user inheritance.
- Session delete without a verified remote delete contract would create confusing “deleted locally, still present remotely” behavior.

### 6.4 Recommendation
- V2 should ship archive-first session management with same-host continuity only.
- Keep delete out of the normal user-facing surface in V2.
- Extend the local session table with archive metadata rather than overloading `status`.

### 6.5 Suggested progress status for this track
- Status: `Feasible`
- Why: the store already persists sessions, active session pointers, rebind migration, and runtime notices; the missing work is productization, not foundational capability
- Next milestone: define local archive metadata and thread archive/unarchive sync behavior

---

## 7. Platform and Stability Evaluation

### 7.1 macOS / launchd
- Current support reality:
  - current installation/runtime management is Linux `systemd --user` only
  - paths and commands are hard-coded around `systemctl` and `~/.config/systemd/user`
  - there is no macOS persistence path in code today
- Proposed V2 scope:
  - add a service-manager abstraction with `systemd` and `launchd` backends
  - support install/start/stop/restart/status/uninstall on macOS via `launchd`
  - keep the bridge-owned app-server child model unchanged
- Install/run/uninstall expectations:
  - install should write the launch agent file, load it, and report active/degraded state
  - stop/restart/status should work symmetrically to Linux operator commands
  - uninstall should unload and remove the launch agent cleanly
- Risks / blockers:
  - `launchctl` semantics differ materially from `systemctl`
  - environment-file loading and user-session persistence behavior need platform-specific handling
  - this is a real V2 workstream, not a minor wrapper around current install code

### 7.2 Readiness / preflight checks
- Current gaps:
  - no Node runtime version preflight even though `package.json` requires `>=25.0.0`
  - no platform-manager compatibility preflight beyond “is `systemctl` present”
  - no install-root/config-root writability check
  - no minimum Codex version/capability check for V2 event features
  - no explicit platform mismatch guidance for macOS
- Proposed V2 checks:
  - Node version
  - Codex binary presence, version, login status
  - app-server handshake plus non-destructive follow-up probe
  - Telegram token validity
  - state/config/install directory writability
  - DB integrity / corruption status
  - service-manager availability and installed unit/plist health
  - capability check for required V2 event surface at startup
- User/operator output expectations:
  - explicit `ready / degraded / blocked` summary
  - actionable remediation, not silent failure
  - keep `/status` compact and `ctb doctor` richer

### 7.3 Restart / recovery / corruption behavior
- Bridge restart handling:
  - current behavior is already good v1 groundwork: running sessions are marked failed and a runtime notice is queued
  - V2 should keep this and make it visible in the richer status/session surfaces
- app-server disconnect/reconnect handling:
  - current code attempts one automatic restart and degrades readiness on failure
  - V2 should keep this contract, add clearer surfaced state, and avoid pretending the active turn continued
- state corruption handling:
  - current code rotates the corrupt DB, creates a new DB, and sets `bridge_unhealthy`
  - V2 should preserve this fallback and add clearer operator/user copy about continuity loss
- self-heal vs explicit reset recommendation:
  - self-heal transient transport failures
  - require explicit reset/rebind semantics for corruption or lost authorization state

### 7.4 Recommendation
- Treat `launchd`, expanded preflight, and clearer degraded-state reporting as required V2 completion items.
- Do not promise in-flight turn resumption across restart; promise safe degradation and honest recovery only.

### 7.5 Suggested progress status for this track
- Status: `Feasible`
- Why: the bridge already has readiness, restart, and corruption fallback primitives; the missing piece is platform abstraction and operator-facing completeness
- Next milestone: design service-manager abstraction and extend `ctb doctor` preflight matrix

---

## 8. UX / Telegram Delivery Notes

### 8.1 Default chat behavior
- Proposed behavior:
  - keep final-answer-first UX
  - during a running turn, maintain one bridge-owned compact status card for Layer A
- Update frequency / throttling:
  - update on state transition immediately
  - otherwise throttle to every 5 to 10 seconds for repetitive active-item/progress refresh
- Single-message edit vs multiple messages:
  - use a single edited in-progress card for default activity visibility
  - keep final answers, explicit failures, and picker/session flows as new messages
- Final-answer behavior:
  - unchanged from v1: send only final answer content, chunk when needed

### 8.2 Inspect behavior
- How user requests inspect mode:
  - recommend an explicit `/inspect` command for V2 first cut
  - optional inline button can come later after the command flow is stable
- What inspect returns:
  - recent activity timeline
  - current item summary
  - recent command/file/tool summaries
  - best-effort plan snapshot
- Limits / truncation policy:
  - keep inspect to recent/high-signal items
  - use the same chunking safety policy as final answers if a response is large

### 8.3 Debug behavior
- How debug data is accessed:
  - keep primary access local and operator-oriented
  - use logs and a dedicated debug export path rather than normal Telegram chat
- Whether debug should stay out of normal Telegram flow:
  - yes
  - V2 should not turn Telegram into a log tail
- Export/log strategy:
  - persist raw runtime debug buffers/logs locally
  - keep `ctb doctor` or an adjacent operator command as the main support surface

### 8.4 Progress reporting recommendation

How should engineering report progress back after evaluation starts?

- Suggested reporting cadence:
  - every 2 to 3 working days or at each track milestone exit
- Suggested milestone granularity:
  - event ingestion/status model
  - session archive/state model
  - platform manager/preflight
- Suggested blocker escalation rule:
  - escalate immediately if a local Codex version lacks a required V2 event or if `launchd` persistence proves materially less automatable than expected
- Suggested demo/verification checkpoints:
  - 2026-03-13: event inventory + normalized status model + layer mapping demo artifact
  - track-exit checkpoints with tests and protocol samples

---

## 9. Risks and Open Questions

### 9.1 Major risks
| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| High-frequency native events create Telegram noise or state bloat | High | Medium | Retain raw events in bounded buffers, throttle Layer A, keep raw deltas in debug only |
| Local Codex version/schema drift changes event names or semantics | High | Medium | Pin/test against a minimum Codex version and run startup capability checks |
| Local archive state drifts from remote thread archive state | Medium | Medium | Define a single reconciliation rule and archive only on known-safe session states |
| `launchd` lifecycle behavior differs enough from `systemd` to break install assumptions | High | Medium | Build a service-manager abstraction with platform-specific tests and manual verification |
| Rebind/recovery copy over-promises continuity after restart or corruption | High | Low | Keep same-host-only wording and preserve explicit failure/fallback messaging |

### 9.2 Open questions needing PM decision
- Should V2 inspect mode be command-only first, or should it also ship with inline Telegram buttons in the first cut?
- Should archived sessions be hidden from default `/sessions` output or shown at the bottom with a separate marker?
- Should best-effort plan snapshots appear in inspect by default even when the underlying plan delta surface is experimental?

### 9.3 Open questions needing protocol validation
- Whether `thread/list` plus `thread/read` returns enough stable metadata to drive all archive/list UX without extra local denormalization.
- Whether `thread/archive` / `thread/unarchive` should be considered complete on RPC success or only after follow-up notification/state confirmation.
- Whether V2 should keep listening to legacy `codex/event/task_complete` fast-path final-answer signals alongside the richer v2 item model for backward compatibility.

### 9.4 Decisions needed from PM before implementation

| Decision | Why needed | Recommended answer | Deadline |
|---|---|---|---|
| Session delete in V2? | Changes data-lifecycle promises and UX risk | No user-facing hard delete in V2 | Before implementation starts |
| Inspect trigger shape | Affects Telegram command/callback design | Ship `/inspect` first; add button later if needed | Before UX implementation |
| Archive visibility default | Affects session list behavior and copy | Hide archived by default; provide explicit archived view | Before session UI implementation |

---

## 10. Recommended Delivery Plan

### Option A — Single-phase V2
- Scope:
  - structured activity visibility
  - normalized status model
  - inspect path
  - archive-first session improvements
  - `launchd` support
  - expanded readiness/preflight and recovery messaging
- Why:
  - preserves PM intent that V2 feels complete
- Risks:
  - highest delivery risk
  - mixes protocol/UI/state/platform changes into one acceptance gate

### Option B — Phased V2

#### Phase 2A
- Scope:
  - event ingestion
  - normalized status model
  - Layer A default visibility
  - minimal Layer B inspect
  - raw event retention for debug
- Acceptance target:
  - long tasks visibly look alive without noisy log streaming

#### Phase 2B
- Scope:
  - richer session list/state rendering
  - archive/unarchive
  - same-host continuity wording and edge-case handling
- Acceptance target:
  - sessions are understandable, active state is obvious, archive works safely

#### Phase 2C
- Scope:
  - macOS `launchd`
  - expanded preflight/readiness
  - restart/recovery/corruption behavior polish and surfaced diagnostics
- Acceptance target:
  - platform/runtime completeness matches V2 product story

### Recommended option
- `Option B — Phased V2`
- Reason:
  - it respects the fixed priority order
  - it gives the primary user-facing win first
  - it still preserves `launchd` and stability work as real V2 scope instead of silent deferral

### 10.1 Implementation tracking proposal

| Workstream | Proposed milestone | Entry condition | Exit condition | Owner | ETA |
|---|---|---|---|---|---|
| Structured activity visibility | Event collector + status mapper | Evaluation accepted | Running turns show Layer A status and inspect has recent activity summaries | Bridge engineering | 2026-03-13 first checkpoint |
| Session management | Archive-first session model | Status mapper shape accepted | Session list shows active/state/archive correctly and same-host continuity is documented and tested | Bridge engineering | 2026-03-18 |
| Platform/stability | Service-manager abstraction + preflight expansion | Session model shape accepted | Linux `systemd` and macOS `launchd` both supported with explicit degraded-state reporting | Bridge engineering | 2026-03-24 |

---

## 11. Acceptance Readiness Check

For each product requirement area, provide a readiness judgement.

| Area | Ready now | Needs research | Needs PM change | Not recommended |
|---|---|---|---|---|
| Structured activity visibility | Yes |  |  |  |
| Visibility layering | Yes |  |  |  |
| Inspect path | Yes |  |  |  |
| Debug path | Yes |  |  |  |
| Session management |  | Yes |  |  |
| Same-host rebind continuity | Yes |  |  |  |
| macOS persistence |  | Yes |  |  |
| readiness / preflight | Yes |  |  |  |
| restart/recovery | Yes |  |  |  |
| corruption fallback | Yes |  |  |  |

### 11.1 Requirement-to-workstream traceability

| PRD area | Proposed workstream | Status | Owner | Evidence |
|---|---|---|---|---|
| Structured activity visibility | Event ingestion + status mapper + Layer A/B rendering | Ready to build | Bridge engineering | Generated v2 schema plus current v1 adapter gap |
| Session management enhancement | Archive-first session model + same-host continuity hardening | Feasible | Bridge engineering | Existing SQLite session/rebind implementation plus archive API evidence |
| Platform/stability completion | Service-manager abstraction + preflight/recovery expansion | Feasible | Bridge engineering | Existing readiness/recovery foundation plus Linux-only gap |

---

## 12. Final Engineering Recommendation

### Recommended V2 scope to build
- Build V2 as a phased release on the current bridge foundation.
- Make structured activity visibility the release-defining workstream.
- Add archive-first session management with same-host continuity only.
- Add macOS `launchd`, better preflight, and clearer degraded-state reporting as required V2 completion work.

### Recommended exclusions / V3 deferrals
- User-facing hard delete
- Cross-host portability or migration
- Debug-log-style Telegram streaming

### Suggested next implementation step
- Start with a narrow engineering checkpoint that defines:
  - the retained raw event model
  - the normalized status object
  - the Layer A/B/C mapping contract
  - the session archive state model

### First checkpoint output expected from engineering
- date: 2026-03-13
- expected artifact(s):
  - event-to-layer mapping table grounded in local schema/runtime evidence
  - normalized status model interface and storage/update rules
  - session archive/state model proposal
  - service-manager abstraction note covering `systemd` and `launchd`
- expected unresolved blockers by then:
  - final PM call on inspect trigger shape
  - final PM call confirming delete stays out of V2
