# Runtime Hub Reuse, Immediate Refresh, And Archive Lifecycle Plan

> Truth status:
> - Current truth? No
> - Use for: implementation scope, source-change handoff, and doc follow-up for the next hub UX adjustment
> - Verify current shipped behavior in: `docs/product/runtime-and-delivery.md`, `docs/product/auth-and-project-flow.md`, `src/service/runtime-surface-controller.ts`, and `src/service/session-project-coordinator.ts`

## Status

Implemented later and retained as historical planning context.

This document captures the agreed follow-up hub UX change set after the slot-model and `/hub` refresh work.
Current product docs and current code now outrank this plan for shipped behavior.

## Relationship To Existing Plans

This follow-up intentionally changes parts of two older task plans:

- `docs/plans/2026-03-21-runtime-hub-slot-model-implementation-plan.md`
- `docs/plans/2026-03-21-runtime-hub-refresh-command-plan.md`

What changes from those older plans:

- completed latest hubs are now reusable when they still have empty slots
- middle holes can now exist after archive-driven slot removal and may later be refilled in the latest hub
- accepted user work should reanchor the hub immediately instead of waiting only for the delayed start auto-refresh
- interaction-driven handoff messages should point users at `/hub` explicitly
- live hubs now have a target cap of three with oldest non-running eviction

## Problem

The current hub UX still has five gaps:

1. if the latest hub is completed, a new running session opens a brand-new hub even when the latest hub still has empty slots
2. when the user sends work, the hub is not pulled to the bottom immediately, so the user cannot confirm runtime state right away
3. interaction surfaces do not consistently hand users back to `/hub`
4. live hubs can grow without a practical cap
5. archive and unarchive do not have an explicit runtime-hub lifecycle contract

## Observed Current Behavior

Observed in current code and current product docs:

- live hub slot admission currently refuses a completed latest hub and creates a new hub instead
- delayed auto-refresh exists for turn start and blocked-to-running recovery, but accepted user work does not immediately reanchor the hub
- `/hub` reminder copy is currently limited to delayed first auto-refresh and busy-turn rejection
- there is no max-live-hub cap
- archived sessions are rejected when a retained hub slot is tapped, but the archive operation does not yet define immediate live-hub removal semantics
- unarchive restores session visibility, but hub reentry semantics are not specified

## Fixed Decisions

These are aligned and should be treated as fixed for implementation.

### 1. Admission target

New running work checks **only the latest live hub**.

It does **not**:
- scan all older hubs for holes
- use the user-focused older hub as the admission target

Reason: slot admission must stay stable and predictable, and must not depend on which older hub the operator is currently viewing.

### 2. Reuse rule

If the latest live hub has at least one empty slot, the new running session goes into the **smallest empty slot** of that latest hub.

This is true even if that latest hub is currently rendered as completed.

Only when the latest hub is full should the bridge create a new hub.

### 3. Hub cap rule

Target live-hub cap is **3**.

Before creating a fourth live hub:
- evict the **oldest** hub that has **no running sessions**
- then create the new hub

If all existing hubs still have running sessions:
- do **not** delete a live hub
- allow temporary overflow beyond 3

### 4. Archive rule

When a session is archived:
- remove it from bridge-owned hub surfaces immediately
- free its live-hub slot immediately
- if that makes a hub empty, delete that hub
- keep stale buttons expired if an old retained message still survives Telegram deletion failure

This removal applies to both:
- live hubs
- recovery hubs, if the archived session is present there

### 5. Unarchive rule

Unarchive does **not** place the session back into a hub.

Unarchive only restores session visibility and normal switching semantics.
The restored session re-enters a hub only when it next becomes **truly running**.
At that point it follows normal admission rules and is treated like fresh runtime admission into the latest hub.

### 6. Immediate refresh after accepted user work

When the bridge accepts user work that is meant to reach Codex, it should reanchor the owning hub to the bottom immediately.

This covers:
- plain-text work that starts a turn
- structured or rich input that starts a turn
- accepted continuation input where the bridge should hand the operator back to runtime state

This immediate reanchor should happen before the delayed start auto-refresh would normally teach the user anything.

### 7. Interaction handoff policy

Bridge-owned interaction surfaces stay visually primary.
Do **not** force-refresh the hub underneath them.

Instead:
- add one `/hub` hint line on the initial interaction surface
- add the same `/hub` hint line on the resolved interaction result surface

This hint is a navigation handoff, not a discovery reminder.
It should not depend on whether the chat has already “learned” `/hub`.

### 8. Delayed refresh still exists, but must not duplicate immediate start refresh

Keep delayed auto-refresh for:
- blocked -> running recovery
- any non-user-driven runtime resumption path that still needs it

But when the bridge already performed the new immediate accepted-work reanchor for that start path, the delayed start auto-refresh must not create duplicate churn.

## User-Facing Intended Behavior

### New running session admission

- if latest hub has space, reuse it
- if latest hub is full, open a new hub
- if that would create a fourth hub, first evict the oldest non-running hub
- if all three are still running, allow temporary overflow

### Slot shapes

Middle holes are now valid.

Examples that may now exist:
- `1 · 3 · ·`
- `1 2 · 4 ·`

Rules:
- hole creation can happen after archive-driven slot removal
- latest-hub admission still fills the smallest empty slot
- older hubs are not scanned for refill

### Archive and unarchive

- archive immediately removes the session from hub surfaces
- unarchive does not create hub presence by itself
- only the next real running turn puts the session back into the latest hub

### Accepted user work

When the user sends work and the bridge accepts it, the hub should come back to the bottom immediately so the user can see current runtime state without waiting for the delayed start refresh.

### Interaction surfaces

Interaction surfaces and their resolved result cards append one line:

`如需查看或刷新 Hub，可发送 /hub。`

That line exists to keep the operator oriented while the interaction card remains primary.

## Proposed Source API And File Changes

### 1. `src/service/runtime-surface-controller.ts`

Primary owner for hub lifecycle changes.

### Admission changes

Change `ensureLiveHubSlotAssignments()` so that:
- it reuses an existing slot if the session already owns one
- otherwise it checks only the latest live hub
- it no longer rejects the latest hub just because that hub is currently completed
- it fills the smallest empty slot in that latest hub
- it creates a new hub only when the latest hub is full or absent

### New internal helpers

Add narrow helpers for the new lifecycle:

- `getLatestLiveHub(chatState)`
- `findSmallestEmptySlot(hubState)` or reuse existing empty-slot helper explicitly for hole filling
- `evictOldestNonRunningHubIfNeeded(chatId, runningSessionIds)`
- `removeSessionFromLiveAndRecoveryHubs(chatId, sessionId, reason)`
- `getDisplayHubIndex(chatState, hubState)` or equivalent dense display-order calculation

### Hub-cap changes

Add a constant such as:
- `MAX_LIVE_RUNTIME_HUBS = 3`

Before creating a new hub:
- try oldest non-running eviction first
- never evict a hub that still owns a running session

### Dense display order

Do **not** rely on raw `windowIndex` for user-visible `x/y` after eviction.

Implementation must either:
- renumber remaining live hubs densely after eviction, or
- keep internal hub identity separate and compute displayed order from the ordered live-hub array

This is mandatory so the UI never renders impossible headers like `2/2` for the oldest remaining hub.

### Archive lifecycle hook

Expose one explicit runtime-surface entrypoint for session visibility changes.
Suggested shape:

- `handleSessionArchived(chatId: string, sessionId: string, reason?: string): Promise<void>`
- optional `handleSessionUnarchived(chatId: string, sessionId: string, reason?: string): Promise<void>`

Expected behavior:
- archive: remove session from live/recovery hub state, rerender or delete affected hubs, repair focus if needed
- unarchive: no slot admission; only refresh hub state if active-session focus or recovery rendering needs cleanup

### Immediate accepted-work reanchor

Use the existing reanchor machinery, but introduce a clear reason path such as:
- `accepted_user_work`
- `accepted_structured_work`
- `accepted_turn_continue`

Whether this becomes a new public wrapper or new reason codes on `reanchorRuntimeAfterBridgeReply()` is implementation detail.
The requirement is one shared controller path, not ad hoc sends from multiple callers.

### 2. `src/service/session-project-coordinator.ts`

Archive and unarchive already live here.

### Archive path

After local archive persistence succeeds:
- call the new runtime-surface archive hook immediately
- do not leave the archived session occupying a live-hub slot

### Unarchive path

After local unarchive persistence succeeds:
- do **not** admit the session into a hub
- only call a lightweight runtime-surface reconciliation hook if needed for active-session cleanup

### Dependency additions

Extend `SessionProjectCoordinatorDeps` with narrow runtime-surface hooks, for example:
- `handleSessionArchived(chatId: string, sessionId: string, reason: string): Promise<void>`
- `handleSessionUnarchived(chatId: string, sessionId: string, reason: string): Promise<void>`

### 3. `src/service.ts`

Top-level wiring changes only.

- wire the new session-archive/session-unarchive runtime-surface hooks into `SessionProjectCoordinator`
- route accepted user-work reanchor through the existing shell -> runtime-surface boundary instead of scattering Telegram send logic
- keep the shell responsible for reason naming consistency across text, structured input, and continuation paths

### 4. `src/service/turn-coordinator.ts`

Turn start already centralizes accepted work.

### Start paths

After a new turn has been accepted and `beginActiveTurn()` has created runtime state:
- invoke the immediate hub reanchor path for accepted user work
- ensure the later delayed start auto-refresh does not re-send the same “start surfaced” churn for that same turn

### Structured input parity

Apply the same rule to:
- `startTextTurn()`
- `startStructuredTurn()`

If blocked-turn continuation enters through a different accepted-work path, that path should share the same runtime-surface helper rather than reimplementing Telegram-side resend logic.

### 5. `src/service/interaction-broker.ts`

Interaction cards and their resolved cards should carry the `/hub` handoff line.

### Scope for this phase

To keep implementation narrow, treat **bridge-owned interaction cards** as the user-visible “interactive command” surface for this change.
That covers the main cases where a live turn is waiting on the user and the hub is no longer at the bottom.

### Rendering changes

Append the hub hint line on:
- initial approval / permissions / elicitation / questionnaire surfaces
- answered result surfaces
- canceled result surfaces

Do **not** append it on:
- expired cards
- failed cards

The exact exclusion of failed cards can be relaxed later if product wants it, but the minimum requirement is initial + resolved-result surfaces.

### 6. `src/telegram/ui-runtime.ts`

Extend interaction-card builders with an optional footer hint.
Suggested optional parameters:

- `hubHint?: string | null` on `buildInteractionApprovalCard()`
- `hubHint?: string | null` on `buildInteractionQuestionCard()`
- `hubHint?: string | null` on `buildInteractionResolvedCard()`

If the expired-card path is later included, extend `buildInteractionExpiredCard()` separately.

The hint should render as plain final-line helper text, not as another button row.

## Test Plan

### 1. `src/service/runtime-surface-controller.test.ts`

Add or update tests for:
- latest completed hub with free slot is reused by the next running session
- admission checks only the latest hub, not older hubs with holes
- archive removes a session from a live hub immediately
- archive deletes the hub when that removal empties it
- archive removes a session from a recovery hub if present
- unarchive does not place an idle session into a hub
- oldest non-running hub is evicted before creating a fourth hub
- if first three hubs are all running, a fourth hub is allowed temporarily
- display `x/y` stays dense after hub eviction
- immediate accepted-work reanchor does not double-send with delayed start auto-refresh

### 2. `src/service/session-project-coordinator.test.ts`

Add tests for:
- `handleArchive()` calls the runtime-surface archive hook after persistence succeeds
- `handleUnarchive()` does not call hub admission and only triggers lightweight reconciliation if needed

### 3. `src/service/interaction-broker.test.ts`

Add tests for:
- pending interaction cards include the `/hub` hint line
- answered interaction cards include the `/hub` hint line
- canceled interaction cards include the `/hub` hint line
- expired / failed cards do not include the hint in this phase

### 4. `src/telegram/ui.test.ts`

Add focused render tests if builder contracts change:
- interaction approval card with hint
- interaction question card with hint
- resolved card with hint

### 5. `src/service.test.ts` and/or `src/service/turn-coordinator.test.ts`

Add integration coverage for:
- accepted plain-text work resurfaces the hub immediately to the bottom
- structured accepted work follows the same rule
- interaction result delivery keeps the interaction surface primary and points the user to `/hub` instead of force-reanchoring the hub under it

## Documentation Follow-Up

Because current product docs describe current shipped behavior, this plan originally left those docs unchanged until code landed.

### Docs updated in the original planning task

- add this plan document
- update `docs/plans/README.md`
- add cross-references from the older 2026-03-21 hub plans

### Docs updated after implementation landed

- `docs/product/runtime-and-delivery.md`
  - latest-hub-only slot admission
  - reusable completed latest hub when space exists
  - live-hub cap and oldest non-running eviction
  - immediate accepted-user-work reanchor
  - interaction `/hub` hint policy
- `docs/product/auth-and-project-flow.md`
  - archive removes the session from hub surfaces immediately
  - unarchive restores visibility only and does not add the session to a hub until the next real running turn

## Risks And Guardrails

- **Middle holes are now real.** Old assumptions that slots are always a contiguous prefix must be removed or revalidated.
- **Display order must stay dense.** Eviction cannot leave broken `x/y` numbering.
- **Latest hub means latest hub.** User focus on an older hub must not silently redirect new slot admission.
- **Do not teach `/hub` by spam.** Keep the old learned-chat reminder logic for discovery; treat the new interaction hint as contextual navigation only.
- **Do not resurrect archived sessions into runtime by accident.** Unarchive is visibility recovery, not runtime recovery.
- **Do not delete a hub that still contains live running work.** Temporary overflow is explicitly allowed for that reason.

## Success Criteria

This plan is complete when implementation makes all of the following true:

- a new running session reuses empty space in the latest hub before creating a new one
- accepted user work resurfaces the hub immediately
- interaction surfaces and their resolved results hand the user back to `/hub`
- the bridge keeps live hubs at a target cap of 3 without deleting still-running hubs
- archive immediately removes the session from runtime hubs
- unarchive does not create runtime hub presence until the next real running turn
- docs are updated after code lands without presenting planned behavior as already shipped
