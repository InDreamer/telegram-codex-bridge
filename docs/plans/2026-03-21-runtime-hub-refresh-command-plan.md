# Runtime Hub Refresh Command Plan

> Truth status:
> - Current truth? No
> - Use for: implementation scope, product rules, and handoff for the `/hub` runtime-surface refresh flow
> - Verify current shipped behavior in: current product docs and current code

## Status

Planned. This document captures the agreed direction for making runtime-hub access simpler and less disruptive in Telegram chats.

## Problem

The current runtime hub solves live-state visibility, but it creates two opposite UX problems:

- if the hub is only edited in place, later messages push it upward and users lose sight of live state
- if the hub is refreshed too aggressively, it steals the bottom of the chat from the message the user actually wants to read

The current refresh behavior leans too much toward bridge-driven reanchoring after result or inspection messages. That is backwards for the desired chat experience.

The desired behavior is:

- when a user sends work, it should be easy to confirm that work is running
- when a user asks for a result or detail view, that result should remain at the bottom
- when a user wants the hub again, there should be one simple, explicit way to pull it back

## Goal

Introduce `/hub` as the primary runtime-hub access command and reduce automatic hub refreshes to a few narrow moments that help users without fighting the chat.

## Product Decisions

These decisions are fixed for this phase.

### Primary access model

- add `/hub` as the single manual command for pulling the latest runtime hub to the bottom of the chat
- `/hub` is not a detail query like `/status` or `/inspect`
- `/hub` exists only to re-surface the live runtime card

### Behavior of `/hub`

- if the chat has one or more running sessions, `/hub` re-sends the latest live hub to the bottom of the chat
- if multiple sessions are running, the refreshed hub should focus the active session
- if there is no running session, reply with `当前没有运行中的会话。`
- if the chat is currently waiting on actionable interaction cards, do not refresh the hub; keep the interaction controls as the user's next action

### Automatic hub refresh policy

Only two situations should automatically refresh the hub:

1. a newly started turn remains running after a short delay
2. a previously blocked turn becomes running again and remains running after a short delay

All other automatic hub reanchors should be removed for this phase.

### Delayed refresh policy

Automatic refresh should be delayed rather than immediate.

- on new-turn start: wait about `1-2s`
- on blocked-to-running recovery: wait about `1s`
- if the turn ends before the delay expires, do not refresh
- if the turn becomes blocked again before the delay expires, do not refresh
- each turn should auto-refresh at most once for `start` and at most once for `recovery`

### Result-first rule

Messages whose purpose is to show the user a result, answer, or confirmation should stay at the bottom and must not be immediately followed by a hub reanchor.

That includes:

- final answers
- plan results
- `/status`
- `/inspect`
- `/where`
- `/help`
- interrupt success or failure notices
- turn-failed notices
- session-switch or rename confirmations
- plan-mode toggle confirmations

### Interaction-first rule

If the chat currently contains actionable interaction cards, those cards outrank the runtime hub.

In that state:

- do not auto-refresh the hub
- `/hub` should not move the hub below those cards
- reminder text may still mention `/hub`, but should not create pressure to ignore the interaction

## User-Facing Rules

### 1. Manual runtime access

Users can always type `/hub` when they want the running-state card back at the bottom.

Expected user understanding:
- "I want to see whether the model is still working."
- "I know the task is running, but the hub got pushed up."

### 2. Automatic visibility when work begins

When the user sends a task and it becomes a real running turn, the bridge may automatically surface the hub once after a short delay.

This gives users a visible "it is running" confirmation without causing immediate chat churn for very short turns.

### 3. No automatic interruption of result reading

When the bridge sends a result-like message, the user should be left to read that message. The bridge should not immediately move the hub underneath it.

### 4. No automatic interruption of interaction handling

When the bridge is waiting for a button click, approval, or text response, the user should not be asked to choose between the interaction and the hub. The interaction stays visually primary.

## Reminder Strategy

`/hub` is useful, but it is still a command and some users will not discover it on their own. The bridge should teach it lightly.

### Reminder text

Use one short line:

`需要查看运行卡片时，可发送 /hub。`

### When to show the reminder

Show it only in low-frequency, high-value contexts:

1. when a turn has started running and the bridge auto-surfaces the hub for the first time
2. when the user sends a new message during an already running turn and the bridge replies that the current project is still busy

Suggested busy-turn copy:

`当前项目仍在执行，请等待完成或发送 /interrupt。需要查看运行卡片可发送 /hub。`

### When not to show the reminder

Do not attach `/hub` reminders to:

- final answers
- `/status`
- `/inspect`
- `/where`
- `/help`
- failure notices
- interrupt replies
- interaction-card prompts

### Reminder frequency control

Keep reminders intentionally rare:

- at most once per turn
- stop reminding a chat after the user has successfully used `/hub`
- if per-chat persistence is easy, remember that the user has already learned `/hub`

## Command Responsibilities

Keep the command boundaries simple:

- `/hub`: bring back the live runtime surface
- `/status`: bridge and runtime summary
- `/inspect`: deep detail snapshot
- `/where`: current session and project context
- `/interrupt`: try to stop the current turn

`/hub` should not become a second `/status` or a second `/inspect`.

## Trigger Matrix

### Should auto-refresh the hub

- a new turn starts and is still running after the delay
- a blocked turn resumes running and is still running after the delay

### Should not auto-refresh the hub

- `/status`
- `/inspect`
- `/where`
- `/help`
- final answer delivery
- plan result delivery
- failure notices
- interrupt notices
- session and project management confirmations
- language change confirmation

### Should only remind about `/hub`

- user sends a new request while a turn is already running and the bridge rejects the new request

### Should block hub refresh entirely

- actionable pending interaction cards exist in the chat

## Implementation Scope

In scope:

- add `/hub` command routing
- add user-visible `/hub` help text
- add low-frequency `/hub` reminder text
- change hub auto-refresh trigger policy
- add delayed auto-refresh scheduling for new turns and blocked-to-running recovery
- add tests for reminder frequency and no-reanchor result flows
- update product docs after implementation lands

Out of scope:

- pin-based runtime entry
- menu-button changes
- Mini App runtime surface
- redesigning `/status` or `/inspect`
- a new persistent runtime dashboard outside the chat flow

## Implementation Sequence

### Task 1: Define the `/hub` command surface

Files:
- Modify: `docs/product/codex-command-reference.md`
- Modify: `src/telegram/commands.ts`
- Reference: `src/service.ts`

Work:
- add `/hub` to the command list and help text
- define the user-facing copy for:
  - successful hub refresh
  - no running session
  - interaction-pending refusal
- keep the command description short and obvious

### Task 2: Add runtime-surface controller support for manual hub pull-up

Files:
- Modify: `src/service/runtime-surface-controller.ts`
- Modify: `src/service.ts`

Work:
- add a dedicated manual refresh path for `/hub`
- refresh the correct live hub at the bottom
- preserve the current interaction-first guard so `/hub` does not bury actionable cards
- keep the behavior focused on re-surfacing the hub, not sending extra detail

### Task 3: Remove result-driven reanchors that fight reading flow

Files:
- Modify: `src/service.ts`
- Modify: `src/service/turn-coordinator.ts`
- Modify: `src/service/session-project-coordinator.ts`

Work:
- stop reanchoring the hub after result-style or inspection-style bridge replies
- keep those replies visually final in the chat
- preserve any reanchor logic that is only needed for correctness rather than UX, but do not use it for ordinary result flows

### Task 4: Add delayed auto-refresh for start and recovery

Files:
- Modify: `src/service/runtime-surface-controller.ts`
- Modify: `src/service/turn-coordinator.ts`

Work:
- schedule a one-shot delayed hub refresh when a turn first becomes truly running
- schedule a one-shot delayed hub refresh when a blocked turn resumes running
- cancel the delayed refresh if the turn completes, fails, or blocks again before the timer fires
- keep the trigger count bounded so one turn does not refresh repeatedly

### Task 5: Add reminder text with strict frequency control

Files:
- Modify: `src/service.ts`
- Modify: `src/state/store.ts` or the narrowest existing state helper if persistence is needed

Work:
- append the short `/hub` reminder to the busy-turn rejection message
- optionally mark chats that have already used `/hub`
- ensure reminders do not repeat excessively

### Task 6: Add tests for the new policy

Files:
- Modify: `src/service/runtime-surface-controller.test.ts`
- Modify: `src/service.test.ts`
- Modify: `src/service/turn-coordinator.test.ts`

Add focused tests for:

- `/hub` refreshes the live hub to the bottom
- `/hub` returns `当前没有运行中的会话。` when nothing is running
- `/hub` does not reanchor past actionable interaction cards
- new-turn delayed auto-refresh fires once when the turn stays running
- recovery delayed auto-refresh fires once when a blocked turn resumes
- final answers no longer trigger a hub reanchor
- `/status` and `/inspect` no longer trigger a hub reanchor
- busy-turn rejection message includes the `/hub` reminder
- reminders stop once the chat has already learned `/hub`

## Success Criteria

This plan is successful when:

- users can reliably recover the runtime hub with `/hub`
- result and inspection messages remain readable at the bottom of the chat
- automatic hub refreshes happen rarely and only at the moments that signal real work is running
- interaction cards remain visually primary when user action is required
- the bridge teaches `/hub` without becoming repetitive

## Risks And Guardrails

### Risk: `/hub` becomes undiscoverable

Guardrail:
- include it in help text
- use the short reminder only in high-value moments

### Risk: delayed auto-refresh still feels noisy

Guardrail:
- keep delays short but non-zero
- refresh at most once per turn-start and once per recovery

### Risk: users still lose the hub after long-running work

Guardrail:
- `/hub` remains the stable manual recovery mechanism
- the busy-turn rejection reminder teaches the command in context

### Risk: interaction cards get buried

Guardrail:
- preserve the current no-reanchor behavior when actionable pending interactions exist
