# Runtime Hub Slot-Model Implementation Plan

> Truth status:
> - Current truth? No
> - Use for: implementation rationale, sequencing, and handoff history for the runtime-hub slot model
> - Verified current behavior here? No; the main outcome landed later and current docs/code now outrank this plan
> - For shipped behavior, prefer current product docs and current code

## Status

Implemented later and retained as historical planning context. This document captures the runtime-hub redesign agreed for the hub-card optimization discussion on 2026-03-21.

## Problem

The current hub card mixes two different ideas:
- a live window over currently running turns
- a lightweight history summary for recently finished turns

That creates several UX mismatches for the desired Telegram behavior:
- the operator wants to reason about a hub as a stable five-slot container
- the current implementation numbers sessions by render order instead of stable slot id
- recently ended sessions are chat-scoped summaries instead of hub-scoped slot state
- completed hubs disappear instead of remaining visible as finished context
- the session switch controls use names rather than stable numeric slot selection
- the plan button consumes horizontal space with the current plan-step summary

The requested redesign is to make each hub behave like a stable, numbered five-slot surface that can show current, running, and finished state without mixing in unrelated sessions.

## Observed Current Behavior

Observed in current docs and code:
- live hubs are derived from the current running-turn list in windows of five (`RUNTIME_HUB_WINDOW_SIZE = 5`)
- when active turns reach zero, live hubs are deleted rather than retained as completed hubs
- finished-session rows come from a chat-level `terminalSummaries` list with a limit of three, not from the hub's own slots
- the rendered hub shows the focused session first and numbers rows by display order
- hub switch buttons are labeled with session names and may wrap into multiple rows
- the collapsed plan button shows the current plan-step summary
- plan and agent controls are rendered on separate rows
- live hubs can render a separate `current input session` block when the active input target is outside the running set

This is the behavior to change.

## Goal

Redesign the live runtime hub into a stable slot-based model with these properties:
- each hub owns five fixed slots
- slot numbering is stable and user-visible
- a session enters a slot only when it first becomes truly running
- ended sessions remain in their original slot
- finished state shown in a hub comes only from that hub's own slots
- a fully terminal hub remains visible and is marked as completed
- session switching is done by slot number rather than by session name

## Resolved Product Decisions

These decisions were explicitly aligned in the discussion and should be treated as fixed for this implementation:

### Hub structure
- each hub has exactly five slots
- slot ids are `1..5`
- slots fill from left to right
- no middle holes are supported in V1
- do not migrate a session from one hub to another just because another hub has capacity

### Current viewed session
- show at most one `current viewed session`
- show that section only on the hub that owns the viewed session
- if the viewed session is already terminal, it still appears in the `current viewed session` section
- when that happens, do not repeat it under `recent ended sessions`

### `/new` and hub admission
- bare `/new` only opens the project picker; it does not create a session
- choosing a project creates the session
- a newly created but not-yet-running session does **not** appear in the runtime hub
- the session joins a hub only when it starts its first real running turn
- when first admitted, it enters the smallest empty slot of the current hub
- if the current hub is full, create a new hub

### Section rendering
- a hub may contain these sections:
  - `current viewed session`
  - `other running sessions`
  - `recent ended sessions`
- `other running sessions` and `recent ended sessions` must only use sessions from that hub's own slots
- empty sections should be hidden completely

### Buttons
- session-switch controls use slot numbers, not names
- render a single row with five positions
- occupied slots render clickable numbers
- empty slots render `·`
- ended sessions remain selectable
- the current viewed session does not need an extra dedicated button beyond its slot number

### Secondary controls
- `Plan` and `Agent` controls share one row
- the collapsed plan button label is fixed text and does not include the current plan-step summary
- Chinese labels should be:
  - `计划清单`
  - `收起计划清单`

### Completed hub lifecycle
- when a hub has at least one occupied slot and no running sessions, mark it completed
- completed hub header text should be `Hub：x/y · 已完成`
- completed hubs are retained rather than immediately reused or deleted

## Intended Behavior

### 1. Persistent hub model

A hub is no longer just a rolling window over the active-turn list.

Instead:
- each chat owns an ordered list of hubs
- each hub owns five stable slots
- each slot is either empty or bound to one session
- once a session is assigned to a slot, that slot remains its identity within the hub
- terminal state remains attached to the slot after the session finishes

V1 intentionally does **not** support:
- rebalancing sessions across hubs
- hole filling in the middle of an existing hub
- manual slot deletion or slot compaction

### 2. Admission into a hub

A session is admitted into a slot only when it first becomes an active running turn.

Admission rules:
1. if the session already has a hub slot, reuse it
2. otherwise, find the currently selected hub context for that chat
3. if that hub has an empty slot, use the smallest empty slot number
4. if not, create a new hub and assign slot `1`

This keeps `/new` session creation separate from runtime-hub membership.

### 3. Rendering rules

For a given hub card:
- show `current viewed session` only if the active viewed session belongs to that hub
- show `other running sessions` for the hub's remaining running slots
- show `recent ended sessions` for the hub's own terminal slots
- if the viewed session is terminal and belongs to that hub, keep it in the `current viewed session` section and exclude it from `recent ended sessions`
- hide any section whose item count is zero

### 4. Numbering rules

Displayed numbering uses slot number, not list position.

Because V1 does not allow middle holes:
- occupied slots always form a contiguous prefix from `1`
- rows naturally appear as `1`, `1 2`, `1 2 3`, and so on
- V1 should never produce `1 2 4`

### 5. Button rules

The hub card shows one slot-selector row with five positions.

Examples:
- `1 · · · ·`
- `1 2 3 · ·`
- `1 2 3 4 5`

Behavior:
- number buttons switch the viewed session to that slot's session
- `·` is a visual placeholder and should use a no-op callback
- ended slots remain selectable

### 6. Completed hub rules

A hub is completed when:
- it has at least one occupied slot
- none of its occupied slots are still running

Completed hubs:
- remain visible in chat
- keep their slot rows and switch controls
- render the header as `Hub：x/y · 已完成`
- are not reused automatically in this phase

## Scope

In scope:
- live runtime-hub state model
- hub render payload generation
- hub text and button rendering
- slot-based hub selection callbacks
- completed-hub retention inside the running bridge process
- UI and controller tests for the new behavior
- doc updates after code lands

Out of scope:
- recovery-hub redesign
- persisting completed hubs across bridge restart
- auto-rebalancing sessions across existing hubs
- middle-hole slot management
- changing `/new` project-picker lifecycle beyond the already shipped create-on-selection behavior
- introducing a separate draft-session area in the runtime hub

## Implementation Sequence

### Phase 1 - lock the UI contract with tests

Primary files:
- `src/telegram/ui.test.ts`

Add or update tests for:
- a single current viewed session only
- empty sections hidden
- slot-number rendering rather than display-order numbering
- current viewed terminal session excluded from `recent ended sessions`
- fixed five-position selector row using numbers plus `·`
- no project or session names in selector buttons
- fixed collapsed plan label (`计划清单`)
- plan and agent buttons sharing one row
- completed hub header text (`Hub：x/y · 已完成`)

This phase should intentionally fail against current implementation and define the target render contract.

### Phase 2 - replace the windowed runtime-hub model with persistent slots

Primary files:
- `src/service/runtime-surface-controller.ts`
- `src/service/runtime-surface-controller.test.ts`

Replace the current runtime-hub data model so it can represent:
- persistent hubs per chat
- five slots per hub
- session-to-slot ownership
- completed hubs that remain visible after terminal completion
- current hub context for first-time slot admission

Expected structural changes:
- stop using the current running-turn window as the primary hub identity
- stop using chat-level `terminalSummaries` as the hub's finished-session source
- introduce a hub-owned slot structure that can distinguish empty, running, and terminal slot states
- keep enough visible-state data to map callbacks by slot number rather than by rendered list order

### Phase 3 - rebuild hub render payload generation from slot state

Primary files:
- `src/service/runtime-surface-controller.ts`

Update hub payload building so that each rendered hub derives from its own slot facts rather than from the active-turn window plus a chat-level terminal list.

Required behavior:
- compute whether the viewed session belongs to this hub
- derive `current viewed session`, `other running sessions`, and `recent ended sessions` from slot state
- exclude the viewed terminal session from `recent ended sessions`
- preserve stable `x/y` numbering across retained completed hubs

### Phase 4 - update runtime hub message rendering

Primary files:
- `src/telegram/ui-runtime.ts`

Update rendering logic to match the new slot model:
- render slot numbers rather than display-order numbering
- rename the focused section to `当前查看中的会话`
- remove live-hub reliance on the separate `current input session` block
- hide empty sections entirely
- show completed header text when requested
- render only hub-owned terminal rows under `最近结束的会话`

Also change the collapsed plan button label builder so the collapsed Chinese text is simply `计划清单`.

### Phase 5 - change selector buttons and callback wiring

Primary files:
- `src/telegram/ui-runtime.ts`
- `src/telegram/ui-callbacks.ts`
- `src/service/callback-router.ts`
- `src/service/runtime-surface-controller.ts`

Change selector controls from name-based buttons to fixed slot buttons:
- one row, five positions
- numeric buttons for occupied slots
- `·` placeholders for empty slots
- no-op callback handling for placeholder positions
- slot-based session selection lookup instead of rendered-index selection lookup

Also place `Plan` and `Agent` controls on the same row when both are present.

### Phase 6 - retain completed hubs and validate turn lifecycle transitions

Primary files:
- `src/service/runtime-surface-controller.ts`
- `src/service/runtime-surface-controller.test.ts`
- possibly `src/service.test.ts`

Validate that:
- finished slots stay attached to their hub
- the last running session leaving a hub marks it completed instead of deleting it
- creating and starting a new session after `/new` uses the current hub when space exists
- creating and starting a new session opens a new hub when the current hub is full
- existing fast paths for single-session hub reuse do not break the slot model

### Phase 7 - update shipped docs after implementation lands

Primary files:
- `docs/product/chat-and-project-flow.md`
- `docs/architecture/runtime-and-state.md`
- `docs/operations/install-and-admin.md`

Important separation:
- do **not** update current product or architecture docs before code ships
- this plan doc is the place for intended future behavior during implementation
- once behavior is implemented and verified, update the shipped docs to match

Those doc updates should cover:
- slot-based hub identity
- completed-hub retention
- `/new` session admission only on first running turn
- numeric slot selector buttons
- fixed collapsed plan label and shared plan/agent row

## Primary Code Areas

- `src/service/runtime-surface-controller.ts`
- `src/telegram/ui-runtime.ts`
- `src/telegram/ui-callbacks.ts`
- `src/service/callback-router.ts`
- `src/telegram/ui.test.ts`
- `src/service/runtime-surface-controller.test.ts`
- `src/service.test.ts` (targeted regression coverage only if needed)

## Acceptance Criteria

Implementation is complete when all of the following are true:
- each live runtime hub behaves as a fixed five-slot container
- a session enters a slot only when it first becomes truly running
- newly created but not-yet-running sessions do not appear in the runtime hub
- hub state shown under `recent ended sessions` only comes from that hub's own slots
- `current viewed session` appears on only one hub and shows at most one session
- a terminal viewed session is not duplicated under `recent ended sessions`
- slot numbering is stable in both text and buttons
- selector buttons render as one five-position row using numbers plus `·`
- selector buttons do not include project or session names
- ended slots remain selectable
- completed hubs remain visible and render `Hub：x/y · 已完成`
- empty sections are hidden
- collapsed plan button text is `计划清单`
- `Plan` and `Agent` controls share one row

## Risks And Watchpoints

- The current single-session hub adoption path may assume that a hub's identity is tied to the active-turn window; this must be revalidated under persistent slots.
- Terminal handoff and reanchor flows currently expect hubs to disappear when active turns drain; those flows must be audited for completed-hub retention.
- Telegram inline keyboards do not support a true disabled button, so `·` placeholders need a no-op callback path.
- Recovery-hub behavior should not be accidentally coupled to the live-hub redesign unless separately planned.
- Current product and architecture docs must not be rewritten early in a way that makes planned behavior look shipped before implementation is complete.
