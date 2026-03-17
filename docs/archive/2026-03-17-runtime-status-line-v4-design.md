# Runtime Status Line V4 Design

**Status:** Approved

**Date:** 2026-03-17

**Goal:** Align the Telegram bridge runtime status-line surface with Codex CLI semantics for Codex-owned fields while preserving existing bridge-specific fields as supported extensions for v4.

## Context

The bridge currently exposes a Telegram `/runtime` configuration flow with a custom field model and bridge-owned labels. Some token and context-related fields were described in bridge-local terms that diverge from Codex CLI semantics.

Codex CLI already defines a status-line field set and specific runtime meanings for the context and token indicators. In particular:

- `context-remaining` and `context-used` are derived from `last_token_usage` plus `model_context_window`
- `used-tokens` is derived from `total_token_usage`
- missing values are omitted rather than replaced with bridge-invented substitutes

For v4, the bridge should stop inventing its own semantics for Codex-owned indicators.

## Intended Behavior

The `/runtime` field picker should expose two groups:

- `Codex CLI`
- `Bridge Extensions`

The `Codex CLI` group should use Codex CLI field identifiers and Codex CLI semantics:

- `model-name`
- `model-with-reasoning`
- `current-dir`
- `project-root`
- `git-branch`
- `context-remaining`
- `context-used`
- `five-hour-limit`
- `weekly-limit`
- `codex-version`
- `context-window-size`
- `used-tokens`
- `total-input-tokens`
- `total-output-tokens`
- `session-id`

The `Bridge Extensions` group should keep the bridge-specific fields that the operator still uses:

- `session_name`
- `project_name`
- `project_path`
- `model_reasoning`
- `thread_id`
- `turn_id`
- `blocked_reason`
- `current_step`
- `last_token_usage`
- `total_token_usage`
- `context_window`
- `final_answer_ready`

## Data Semantics

### Codex CLI-aligned fields

- `context-remaining`
  Compute using the Codex CLI estimate formula based on `last_token_usage.totalTokens`, `modelContextWindow`, and the CLI baseline token reserve.
- `context-used`
  Compute as `100 - context-remaining`.
- `used-tokens`
  Use `total_token_usage.totalTokens`.
- `total-input-tokens`
  Use `total_token_usage.inputTokens`.
- `total-output-tokens`
  Use `total_token_usage.outputTokens`.
- `context-window-size`
  Use `modelContextWindow`.
- `session-id`
  Use the bridge session thread id because it is the Telegram bridge equivalent of the active Codex thread/session identity surfaced to the user.

Fields like `project-root` and `git-branch` should only render when the bridge has truthful data available. v4 should not invent guessed values.

### Bridge extension fields

These remain bridge-defined and do not claim Codex CLI equivalence:

- `session_name`
- `project_name`
- `project_path`
- `model_reasoning`
- `thread_id`
- `turn_id`
- `blocked_reason`
- `current_step`
- `last_token_usage`
- `total_token_usage`
- `context_window`
- `final_answer_ready`

Not every Codex CLI field is exposed in the Telegram picker immediately. Fields that the bridge cannot currently render truthfully should stay hidden from the picker until bridge-side data exists, even though the v4 type model may reserve them for future parity.

## Preference Migration

Persisted runtime-card preferences should be migrated lazily for pre-v4 saved records.

Migration rules:

- map `project_path` -> `current-dir`
- map `model_reasoning` -> `model-with-reasoning`
- map `thread_id` -> `session-id`
- retain existing bridge extension fields, including old bridge-only token/context fields
- retain already-valid Codex CLI field ids
- drop only fields that no longer exist after the v4 schema update

If migration yields no fields, fall back to the Codex CLI default ordering:

- `model-with-reasoning`
- `context-remaining`
- `current-dir`

## Required Code Changes

- replace the runtime status-field type definition with a combined `Codex CLI + Bridge Extensions` model
- add grouped runtime picker rendering in Telegram UI
- replace bridge-local token/context wording with Codex CLI-aligned wording for CLI-owned fields
- compute CLI-owned token/context values using the Codex CLI formulas
- migrate persisted runtime preferences on load
- update tests for migration, picker rendering, and status-line content semantics

## Non-Goals

- exact replication of every Codex CLI surface outside the status-line field model
- fake or inferred values for unavailable CLI fields
- removing bridge-specific fields that are still intentionally used by the operator
