# Telegram Runtime V4.5 Design

> Truth status:
> - Current truth? No
> - Use for: implementation rationale, sequencing, and handoff history
> - Verify current behavior in: current product/architecture/operations docs and current code


**Date:** 2026-03-17

**Status**

Approved design capturing the current discussion decisions. This is a planning document, not shipped behavior.

**Related docs**

- `docs/architecture/runtime-and-state.md`
- `docs/product/chat-and-project-flow.md`
- `docs/plans/2026-03-16-telegram-runtime-card-rollback-voice-decisions.md`
- `docs/plans/2026-03-17-plan-mode-runtime-design.md`

## 1. Purpose

This document records the agreed v4.5 direction for:

- runtime-status-card ordering in Telegram chat
- runtime-card rendering clarity on mobile
- bridge-wide Chinese and English presentation modes
- the non-goal status of Telegram pinning for this pass

The immediate goal is to make runtime surfaces feel more natural in Telegram:

- interactive messages should keep focus while the user is deciding
- runtime status should return to the bottom only when the task is truly running again
- runtime cards should read clearly on mobile without consuming much more height
- bridge copy should stop mixing English and Chinese within the same UI surface

## 2. Observed Current Behavior

Current bridge behavior in code today:

- the active turn starts with one runtime status card
- ordinary runtime updates edit the current status card in place
- some bridge-owned surfaces cause the status card to be re-anchored by sending a new status message
- the old status message remains in chat history after re-anchoring
- server-request interaction cards currently trigger this re-anchoring flow
- runtime error cards currently also trigger this re-anchoring flow
- the result is that an approval or option card may briefly be the newest message, but the runtime card is then posted after it and becomes the newest visible message again

Observed UX problem:

- the newest actionable Telegram message is sometimes not the actual interaction the user must handle next
- repeated re-anchoring leaves historical runtime-card noise in chat
- the current runtime-card text style is readable but not visually clean, especially on mobile when labels and values sit too close together
- runtime copy is currently mixed-language rather than intentionally localized

## 3. V4.5 Decision Summary

### 3.1 Runtime ordering principle

Decision:

- runtime status should not always occupy the bottom of the chat
- the newest actionable surface should own the bottom while the user is expected to react
- runtime status should move back to the bottom only when the task has genuinely resumed running

Interpretation:

- user-focus surfaces win while the turn is waiting on the user
- runtime-focus surfaces win when the turn is actively executing again

### 3.2 Default runtime-card behavior

Decision:

- the active runtime status card should edit in place by default
- normal progress updates should not create extra runtime-card messages

Intent:

- keep runtime noise low
- preserve a stable message during routine progress refreshes

### 3.3 Re-anchor trigger rules

Decision:

- do not re-anchor runtime while the turn is blocked on user action
- re-anchor runtime only after the turn has actually recovered to `active`
- use the same rule whether recovery happens because of user action or automatic system recovery

Specific cases:

- approval or questionnaire appears: do not re-anchor runtime after the interaction card is sent
- user answers the interaction but the turn remains blocked: do not re-anchor runtime
- user answers the interaction and the turn returns to `active`: re-anchor runtime
- the system resolves a blocked state without user action and the turn returns to `active`: re-anchor runtime
- a non-terminal error card appears and the turn later resumes `active`: re-anchor runtime after recovery
- a terminal failure ends the turn: do not re-anchor runtime
- a final answer or final plan result ends the turn: do not re-anchor runtime
- a user sends a new normal input and a new turn starts: runtime should appear at the bottom for that new work
- a user runs bridge commands such as `/inspect`, `/where`, or `/runtime` while a turn is active: runtime should return to the bottom after that bridge reply

### 3.4 Re-anchor implementation policy

Decision:

- when runtime must move back to the bottom, use this order:
  - send the new runtime card
  - if send succeeds, delete the old runtime card
- do not delete the old card before the new card exists

Reason:

- this keeps the UX robust against Telegram delivery or edit failures
- the intended visible outcome is still "one current runtime card" even though the move itself requires a new message under Telegram semantics

### 3.5 Runtime-card content layout

Decision:

- optimize for mobile first
- avoid significantly increasing vertical height
- keep short fields on one line
- replace the current label-value styling emphasis with a lighter middle-dot separator

Examples:

- `State · Running`
- `Session · Repo / Main`
- `Model · gpt-5 + high`

Progress rule:

- short progress stays one line: `Progress · Searching docs`
- long progress becomes a compact two-line block:
  - `Progress`
  - `{progress text}`

Intent:

- preserve compactness for the common case
- prevent long progress text from becoming hard to scan

### 3.6 Language modes

Decision:

- do not localize runtime card alone
- localize the entire Telegram bridge UI as one coherent surface
- support exactly two explicit language modes:
  - full Chinese
  - full English
- store this as a global bridge-level setting, not a per-session setting
- do not auto-follow Telegram client language or system language

Implications:

- runtime cards, command replies, interaction cards, buttons, notices, and errors should all use the selected bridge language
- mixed-language UI should be treated as a design bug rather than a normal state

### 3.7 Telegram pinning

Decision:

- do not use Telegram pinning as the primary runtime-card ordering solution in v4.5
- keep pinning as a possible future enhancement only

Reason:

- pinning helps rediscovery, not current-chat focus
- pinning does not solve the "what should be the newest visible message right now" problem
- if runtime cards are re-anchored over time, using pinning as the main mechanism would create extra coordination noise

## 4. Trigger Matrix

### 4.1 Do not re-anchor runtime

- a new interaction card is sent and the user still needs to act
- the user finishes one interaction step but the turn is still blocked
- a terminal failure message becomes the final focus
- a final answer or plan result becomes the final focus

### 4.2 Re-anchor runtime

- the turn transitions from blocked or interrupted waiting state back to `active`
- that recovery is automatic rather than user-driven
- the user sends a new message that starts fresh active work
- a bridge command posts a chat reply while active work is ongoing and runtime should become the latest execution surface again

## 5. Documentation And Implementation Consequences

Future implementation should update at least:

- `docs/architecture/runtime-and-state.md`
- `docs/product/chat-and-project-flow.md`
- runtime-card rendering and re-anchor tests in `src/service.test.ts`
- runtime-card rendering helpers in `src/telegram/ui.ts`
- runtime-card re-anchor logic in `src/service.ts`
- bridge-wide presentation copy once the global language setting is introduced

Implementation should preserve these distinctions:

- observed current behavior: some bridge-owned cards immediately re-anchor runtime and leave history behind
- intended v4.5 behavior: actionable surfaces keep focus until the turn truly resumes
- required action: change both runtime re-anchor logic and runtime text presentation; do not treat this as a copy-only adjustment

## 6. Acceptance Direction

V4.5 should feel correct if these statements are true in practice:

- when the user must choose or approve something, that interaction remains the newest meaningful message
- when the task resumes, runtime status visibly becomes the newest execution surface again
- repeated runtime re-anchors do not accumulate visible stale runtime cards in normal success cases
- runtime-card copy is easier to scan on a phone
- the Telegram bridge reads as fully Chinese or fully English rather than mixed
