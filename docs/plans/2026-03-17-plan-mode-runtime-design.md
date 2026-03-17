# Plan Mode Toggle And Runtime Card Design

**Date:** 2026-03-17

**Status**

Approved design for implementation in the current repository session.

**Related docs**

- `docs/product/v1-scope.md`
- `docs/product/chat-and-project-flow.md`
- `docs/architecture/runtime-and-state.md`
- `docs/research/codex-app-server-authoritative-reference.md`

**Goal**

Add a Telegram `/plan` command that toggles the current session between default mode and Codex plan mode, surface the current plan-mode state in `/where`, and simplify runtime cards so only core execution state is fixed while all extra status fields are opt-in through `/runtime`.

## 1. Problem

The native Codex CLI exposes a plan-mode toggle, but the bridge currently only consumes best-effort plan updates after a turn has already started. The bridge does not let the user explicitly place the next turn into plan mode, and the runtime card still mixes fixed fields with a configurable one-line summary that is hard to scan in Telegram.

## 2. Scope

This design includes:

- a session-level Telegram `/plan` toggle command
- persistence of the current session's plan-mode setting
- passing the selected collaboration mode into `turn/start`
- `/where` visibility for the current session's plan-mode state
- a new `/runtime` optional field for plan mode
- runtime-card layout simplification so only `Session`, `State`, and `Progress` are always shown
- conversion of optional runtime fields from a pipe-delimited status line into one-field-per-line rendering

This design does not include:

- a separate `/plan on` or `/plan off` syntax
- a standalone `/plan` read-only status command
- changing the session model selection or reasoning-effort selection when plan mode is toggled
- changing an already-running turn in place
- exposing collaboration-mode discovery or arbitrary collaboration preset selection in Telegram

## 3. Source Of Truth Rules

Use these distinctions when implementing and documenting the feature:

- Protocol capability: current `codex-cli 0.114.0` app-server schema allows `turn/start.collaborationMode` and defines a `plan` mode.
- Intended bridge behavior after this change: Telegram exposes only a binary toggle between default mode and plan mode.
- Current bridge behavior before this change: plan updates can be rendered when emitted, but the bridge does not let the user choose plan mode ahead of time.

## 4. User Experience

### 4.1 `/plan`

`/plan` is a pure toggle command for the active session.

Behavior:

- if the current session is in default mode, `/plan` switches it to plan mode
- if the current session is in plan mode, `/plan` switches it back to default mode
- if there is no active session, reply with `当前没有活动会话。`
- if the active session is currently running, the new setting is still persisted but applies only to the next turn

Response copy:

- switching on while idle: `已为当前会话开启 Plan mode。下次任务开始时生效。`
- switching off while idle: `已为当前会话关闭 Plan mode。下次任务开始时生效。`
- switching on while running: `已为当前会话开启 Plan mode。当前任务不受影响，下次任务开始时生效。`
- switching off while running: `已为当前会话关闭 Plan mode。当前任务不受影响，下次任务开始时生效。`

### 4.2 `/where`

`/where` gains a fixed line:

- `plan mode:on`
- `plan mode:off`

This line should use the session's persisted mode, not inferred runtime notifications.

### 4.3 `/runtime`

`/runtime` continues to configure optional runtime-card fields, with these changes:

- runtime cards always keep only three fixed fields:
  - `Session`
  - `State`
  - `Progress`
- all other display fields become optional and are controlled by `/runtime`
- optional fields are rendered one field per line instead of a single `|`-delimited status line
- add a new optional field:
  - label: `Plan mode`
  - value: `on` or `off`
- default optional runtime-field selection becomes empty

### 4.4 Runtime Card

The runtime card keeps these fixed sections:

- title
- `Session`
- `State`
- `Progress`

The runtime card also keeps these runtime-specific sections outside `/runtime` configuration:

- `Blocked on` when the turn is blocked
- expandable current plan section
- expandable agent section
- trailing `/inspect` hint

Reason:

- blocker visibility is operationally important and should not be hidden by preference changes
- plan and agent expansions are interactive sections, not simple status fields

## 5. Data Model

Session state gains one new persisted field representing the current collaboration mode for the session.

Recommended stored shape:

- a nullable or string field with values representing:
  - default mode
  - plan mode

Behavioral rule:

- the field is session-scoped, like selected model and selected reasoning effort
- toggling plan mode must not overwrite selected model or selected reasoning effort
- creating or forking sessions should preserve the appropriate mode in the same way model and reasoning settings are preserved where that is already expected

## 6. App-Server Integration

For new turns:

- if the session is in default mode, omit `collaborationMode`
- if the session is in plan mode, include `collaborationMode` with `mode: "plan"`

This change applies to all paths that start a real turn, including normal text input and structured-input submission.

Non-goal:

- do not attempt to mutate an active in-flight turn's collaboration mode

## 7. Testing

Implementation must add or update tests for:

- session persistence of the new plan-mode field
- `/plan` toggling behavior when idle
- `/plan` toggling behavior while a turn is running
- `turn/start` payloads in default mode and plan mode
- `/where` output including `plan mode:on/off`
- `/runtime` preferences including the new `Plan mode` field
- runtime-card rendering using fixed `Session/State/Progress` plus optional fields on separate lines
- reset/default runtime preferences producing no extra optional fields

## 8. Documentation Updates

After code changes land, update current-state docs so they explicitly describe:

- `/plan` as a session-level toggle
- `/where` plan-mode visibility
- `/runtime` as optional-field configuration rather than a one-line summary composer
- runtime cards showing optional fields one per line
