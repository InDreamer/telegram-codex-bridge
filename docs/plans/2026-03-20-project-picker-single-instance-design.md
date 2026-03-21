# Project Picker Single-Instance Design

> Truth status:
> - Current truth? No
> - Use for: implementation rationale, sequencing, and handoff history
> - Verify current behavior in: current product/architecture/operations docs and current code


## Problem

The current project picker behaves like a reusable bridge-owned message. Repeating `/new` can reuse an older picker message instead of sending a fresh one. If that older picker has been pushed far up in chat, the user can lose the visible entry point for creating a new session even though the bridge is still handling `/new`.

Observed current behavior:
- `/new` may reuse `interactiveMessageId` instead of creating a fresh picker surface.
- A Telegram `message is not modified` result is treated as a committed update.
- The user can therefore see no new bottom-of-chat feedback after `/new`.

This creates a recovery failure for session creation, not just a weak UX detail.

## Goal

Make the project picker a single-instance, temporary interaction surface:
- at most one valid picker per chat
- every new picker request creates a fresh bottom-of-chat picker
- any prior picker is deleted first when possible
- stale picker buttons cannot create a session

## Intended Behavior

### Lifecycle

- The project picker is a temporary bridge-owned surface for session creation and project selection.
- Each chat may have at most one valid picker at a time.
- Any action that shows a picker must use the same lifecycle rules, not only `/new`.

### Show Picker

When the bridge needs to show a picker:
1. read the currently tracked picker message id for that chat
2. try to delete that message
3. continue even if Telegram reports the message is already gone
4. send a brand-new picker message at the bottom of the chat
5. track that new message as the only valid picker

### Use Picker

- Selecting a project from the current picker creates a new session.
- After successful session creation, the picker message is consumed and removed as it is today.

### Stale Picker Handling

- If an older picker still exists in chat, it must be treated as stale.
- Stale picker callbacks must not create a session.
- Stale picker callbacks should return the existing expired-button message.

## Scope

This lifecycle applies to all picker-entry flows:
- `/new`
- scan-refresh flows that return to a picker
- manual-path back/cancel flows that return to a picker
- any other coordinator path that re-shows the project picker

This change does not alter the lifecycle of:
- runtime status cards
- final answer cards
- project browser surfaces
- rename pickers

## Data Flow

The project picker coordinator should stop treating picker refresh as an in-place edit operation.

Selected behavior:
- picker refresh becomes delete-old-then-send-new
- successful delete outcomes are `deleted` and `not_found`
- delete failure does not block sending a replacement picker
- only the latest tracked picker message id is eligible for callback continuation

## Failure Handling

- If deleting the prior picker returns `not_found`, continue and send the new picker.
- If deleting the prior picker fails for another reason, still send the new picker and invalidate the old picker in local state.
- If sending the new picker fails, keep the old state only if it is still the latest known picker; do not incorrectly bless a stale picker as refreshed.

## Product Impact

This is an intentional behavior change:
- `/new` becomes a reliable recovery command that always restores a visible picker entry point.
- Users no longer need to scroll back to find an earlier picker.
- Repeating `/new` no longer depends on the visibility or editability of an old message.

## Documentation Updates Required

Current product docs still describe some picker flows as updating or replacing the current surface in place. That language should be updated to match the new single-instance lifecycle.

Docs to update:
- `docs/product/chat-and-project-flow.md`

The updated spec should say, in effect:
- `/new` always reopens the picker as a fresh bridge-owned message
- returning to the picker also recreates the picker as a fresh message
- the bridge keeps only one valid picker per chat

## Primary Code Areas

- `src/service/session-project-coordinator.ts`
- `src/service/session-project-coordinator.test.ts`
- `src/service.test.ts`
- `docs/product/chat-and-project-flow.md`

## Acceptance Criteria

- Repeating `/new` always yields a fresh picker message at the bottom of chat.
- The previously tracked picker is deleted first when possible.
- Only the latest picker can create a session.
- Returning from manual-path mode recreates the picker as a fresh message.
- Scan refreshes recreate the picker as a fresh message rather than editing in place.
- Project selection still deletes the active picker after creating a session.
