# src/AGENTS.md

Code router for `telegram-codex-bridge`.

Use this after the root `AGENTS.md` has already decided that the task is implementation-first.
The goal is to reach the **narrow owner** quickly.

## Default Rule

Prefer the narrow owner file over broad glue code.

Do **not** start with `src/service.ts` unless the question is specifically about bootstrap wiring, top-level startup flow, or a cross-cutting service boundary.

If you need a prose map of ownership before reading code, use:

- `docs/architecture/current-code-organization.md`

Then return here and choose a narrow file.

## First-File Router

| Need | Read first |
|---|---|
| CLI entrypoint, top-level command dispatch | `src/cli.ts` |
| install, doctor, update, admin/status flows | `src/install.ts` |
| config/env parsing and derived settings | `src/config.ts` |
| paths for config/state/log/runtime files | `src/paths.ts` |
| startup gating, readiness floors, degraded states | `src/readiness.ts` |
| top-level bridge bootstrap and wiring | `src/service.ts` |
| Telegram command registry and help-surface truth | `src/telegram/commands.ts` |
| Telegram polling ingress | `src/telegram/poller.ts` |
| Telegram Bot API wrapper | `src/telegram/api.ts` |
| callback decode and callback routing | `src/service/callback-router.ts` |
| command routing internals | `src/service/command-router.ts` |
| project picker, manual-path flow, session switching, rename, pin, archive, unarchive, `/status`, `/where` | `src/service/session-project-coordinator.ts` |
| project browsing tree and chooser flow | `src/service/project-browser-coordinator.ts` |
| filesystem project discovery | `src/project/discovery.ts` |
| Codex-backed command execution and per-turn orchestration | `src/service/codex-command-coordinator.ts` |
| turn lifecycle, finalization, turn-level glue | `src/service/turn-coordinator.ts` |
| rich input adaptation for photos, voice, and structured local inputs | `src/service/rich-input-adapter.ts` |
| bridge-owned approval or questionnaire flow | `src/service/interaction-broker.ts` |
| runtime cards, inspect/status/runtime surfaces, live progress | `src/service/runtime-surface-controller.ts` |
| runtime notices and broadcast behavior | `src/service/runtime-notice-broadcaster.ts` |
| runtime surface state internals | `src/service/runtime-surface-state.ts` |
| runtime trace persistence/sink behavior | `src/service/runtime-surface-trace-sink.ts` |
| final-answer Telegram rendering | `src/telegram/ui-final-answer.ts` |
| runtime-card Telegram rendering | `src/telegram/ui-runtime.ts` |
| generic Telegram messages/edit helpers | `src/telegram/ui-messages.ts` |
| browser/project-picker Telegram UI | `src/telegram/ui-browser.ts` |
| callback payload builders/parsers on Telegram side | `src/telegram/ui-callbacks.ts` |
| shared Telegram UI helpers | `src/telegram/ui-shared.ts` |
| app-server transport, method wrapper, bridge adoption of Codex protocol | `src/codex/app-server.ts` |
| Codex notification classification | `src/codex/notification-classifier.ts` |
| SQLite public facade | `src/state/store.ts` |
| auth persistence details | `src/state/store-auth.ts` |
| open/close transaction and DB boot logic | `src/state/store-open.ts` |
| pending interaction persistence | `src/state/store-pending-interactions.ts` |
| session persistence details | `src/state/store-sessions.ts` |
| runtime artifact persistence | `src/state/store-runtime-artifacts.ts` |
| record persistence details | `src/state/store-records.ts` |
| shared SQLite helpers and schema fragments | `src/state/store-shared.ts` |
| interaction normalization | `src/interactions/normalize.ts` |
| blocked-progress formatting or continuation helpers | `src/util/blocked-progress.ts` |
| activity reduction, runtime journal state, progress aggregation | `src/activity/tracker.ts` |
| debug journal persistence or trace files | `src/activity/debug-journal.ts` |
| subagent identity reconciliation/backfill | `src/service/subagent-identity-backfiller.ts` |
| archive reconciliation | `src/service/thread-archive-reconciler.ts` |
| turn artifact management | `src/service/turn-artifacts.ts` |

## Minimal Read Patterns

### Telegram command behavior

1. `src/telegram/commands.ts`
2. one narrow owner under `src/service/` or one narrow `src/telegram/ui-*.ts`

### Session or project flow

1. `src/service/session-project-coordinator.ts`
2. `src/service/project-browser-coordinator.ts` only if the question includes browse/picker details
3. `src/project/discovery.ts` only if project discovery rules matter

### Runtime surfaces or delivery

1. `src/service/runtime-surface-controller.ts`
2. one Telegram presentation file:
   - `src/telegram/ui-runtime.ts`
   - `src/telegram/ui-final-answer.ts`

### Protocol adoption

1. `src/codex/app-server.ts`
2. `src/codex/notification-classifier.ts` only if notifications matter

### Persistence

1. `src/state/store.ts`
2. one narrow `src/state/store-*.ts` file

### Install or diagnostics

1. `src/install.ts`
2. one of:
   - `src/readiness.ts`
   - `src/config.ts`
   - `src/paths.ts`
   - `src/service.ts`

## Test Files

Tests are useful as confirmation or examples, but they are not the first retrieval target.

Use `*.test.ts` only after you have already identified the owner file and need:

- edge-case confirmation
- current expected output examples
- behavior-lock expectations before refactoring

## Stop Rule

For most tasks, stop after:

- one owner file
- optionally one adjacent verifier

Do not fan out across multiple coordinators or UI modules unless the task is explicitly cross-cutting.
