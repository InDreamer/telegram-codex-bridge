# V5 Project Slimming Plan

> Planning document with verified implementation status.
> This file is not a current-behavior spec.
> It is the verified V5 execution tracker and closeout guide.
> V5 is now closed; deferred follow-up work moved to `docs/plans/2026-03-18-v5-5-post-v5-slimming-plan.md`.

## Verification Basis

Verified on 2026-03-18 against:

- current repository code under `src/`
- current V5 worktree shape
- current test suite shape
- `docs/research/codex-app-server-authoritative-reference.md`
- local CLI runtime `codex-cli 0.115.0`
- current bridge app-server wrapper in `src/codex/app-server.ts`
- current validation state: `npm run check` and `npm test` passing (`311/311`)

Important rule:

- this document tracks V5 execution and remaining work
- it must not be used to claim shipped product behavior unless code and current-state docs agree

## Goal

Reduce project-wide maintenance cost by shrinking god objects, tightening ownership boundaries, and moving stable responsibilities behind explicit collaborators without changing the product boundary.

V5 remains intentionally conservative:

- keep one bridge process
- keep one local `codex app-server` child
- keep one SQLite facade
- keep one runtime owner for the active turn
- keep Telegram callback compatibility

This is a slimming plan, not a rewrite.

## Current Verified Snapshot

Observed current code shape on 2026-03-18:

- production TypeScript is roughly `26.0k` lines across `52` non-test source files
- `src/service.ts` is still the largest file at `2998` lines, but it has now dropped below the earlier ~4.7k post-extraction shell
- `src/state/store.ts` is down to `687` lines and is now acting like a true facade/orchestration shell
- the repo already has dedicated service collaborators under `src/service/`
- store internals now also have dedicated internal modules under `src/state/`

Current extracted collaborators:

- `SessionProjectCoordinator`
- `InteractionBroker`
- `RuntimeSurfaceController`
- `RuntimeSurfaceTraceSink`
- `CodexCommandCoordinator`
- `RichInputAdapter`
- `RuntimeNoticeBroadcaster`
- `ThreadArchiveReconciler`
- `SubagentIdentityBackfiller`
- `TurnCoordinator`
- `routeBridgeCommand`
- `routeBridgeCallback`
- `store-open`
- `store-records`
- `store-auth`
- `store-sessions`
- `store-runtime-artifacts`
- `store-pending-interactions`

Current large modules after the recent slimming waves:

- `src/service.ts` — `2998`
- `src/service/runtime-surface-controller.ts` — `1624`
- `src/telegram/ui-runtime.ts` — `1596`
- `src/activity/tracker.ts` — `1547`
- `src/service/interaction-broker.ts` — `1546`
- `src/service/codex-command-coordinator.ts` — `1224`
- `src/codex/app-server.ts` — `956`
- `src/install.ts` — `913`
- `src/state/store-sessions.ts` — `849`

Current closeout deltas now landed:

- archive and unarchive orchestration now live in `SessionProjectCoordinator`
- model picker and reasoning-effort selection now live in `CodexCommandCoordinator`
- transitional interaction helpers and legacy questionnaire parsing were removed from `src/service.ts`
- current validation is green after that closeout pass (`npm run check`, `npm test`, `311/311`)

This means V5 core slimming is no longer "in progress in principle"; the main refactor target is materially landed.

## Non-Negotiable Invariants

These are hard constraints, not preferences:

- single process bridge runtime
- single long-lived local app-server child per bridge process
- single SQLite facade and coherent transaction boundary
- single `activeTurn` owner in memory
- final-answer persistence and replay semantics remain intact
- pending-interaction persistence and terminal-state handling remain intact
- archive and unarchive reconciliation remains behaviorally identical
- callback tokens stay wire-compatible across refactors
- protocol capability must not be confused with adopted Telegram UX support

Any step that violates one of these constraints failed V5 even if the diff looks modular.

## Explicit Non-Goals

V5 does not include:

- multi-process or multi-service decomposition
- multi-package or workspace splitting
- callback format redesign
- Telegram UX redesign
- broad `store` public API redesign
- app-server capability expansion for its own sake
- first-wave refactors of `activity/tracker`, `readiness`, or install/admin flows
- "one command per file" fragmentation

## Verified App-Server Adoption Boundary

The current bridge has already adopted more protocol surface than the early V5 draft implied.

### Adopted by bridge code

- thread lifecycle: start, resume, archive, unarchive, read, fork, rollback, compact, metadata update, background terminal cleanup
- turn lifecycle: start, steer, interrupt
- model discovery
- skills listing
- plugin list, install, uninstall
- app listing
- MCP server status, reload, OAuth login
- account read and rate-limit read
- realtime thread audio flow for voice fallback
- server-request lifecycle for bridge-owned interactions

### Explicitly not adopted as Telegram UX

- `fs/*`
- `skills/remote/*`
- `externalAgentConfig/*`
- arbitrary experimental app-server expansion not already wrapped in `src/codex/app-server.ts`

Rule for the rest of V5:

- do not mix structural slimming with protocol-surface expansion
- if a protocol exists but the bridge has not adopted it, treat it as out of scope for this refactor

## Target End-State

By the end of V5, the desired structure is:

- thin bridge shell
  - startup
  - dependency construction
  - Telegram polling ingress
  - app-server wiring
  - top-level retry and recovery
- command truth source
  - command help
  - Telegram command sync
  - command dispatch metadata
- callback truth source
- `SessionProjectCoordinator`
- `InteractionBroker`
- `RuntimeSurfaceController`
- `CodexCommandCoordinator`
- `RichInputAdapter`
- `TurnCoordinator`
- unchanged external `BridgeStateStore` facade with narrower internal implementation files

Important clarification:

- `CodexCommandCoordinator` is now part of the intended V5 end-state
- it owns protocol-backed command flows that are not the active-turn lifecycle owner
- `TurnCoordinator` will still be the only runtime owner once extracted

## Phase Status

### Phase 0: Freeze Guardrails And Create A Scorecard

Status: effectively complete

What is true now:

- the refactor has consistently preserved single-process, single-child, single-store, single-owner rules
- every landed slice has been validated with `npm run check` and `npm test`
- callback ABI compatibility has been preserved through dedicated routing rather than silent rewrites

Gap remaining:

- the guardrails live in code-review discipline and this document, not in a separate dedicated scorecard artifact

### Phase 1: Stabilize The Current UI Split

Status: mostly complete

Completed:

- `ui.ts` is now a barrel
- callback codec has a dedicated home
- runtime/final-answer/message/shared rendering are split into dedicated files
- callback compatibility remains covered by tests

Not fully complete:

- UI-focused tests still largely live in `src/telegram/ui.test.ts` instead of being fully redistributed per split module
- this is acceptable for now, but the test layout still reflects the pre-split era

### Phase 2: Unify Command And Callback Truth Sources

Status: complete

Completed:

- command registry exists and is the truth source for command routing and help alignment
- callback routing is extracted into `routeBridgeCallback`
- command routing is extracted into `routeBridgeCommand`
- focused router tests exist

### Phase 3: Finish Session And Project Extraction

Status: complete

Completed:

- project picker flows
- manual-path validation and confirmation
- session list and switching
- rename and alias flows
- pin
- plan-mode toggle
- status and where

Current owner:

- `SessionProjectCoordinator`

### Phase 4: Extract InteractionBroker

Status: complete

Completed:

- approval handling
- permissions handling
- questionnaire and elicitation handling
- awaiting-text ownership
- resolved/expired/failed/answered transitions
- Telegram card lifecycle and persistence coupling

Current owner:

- `InteractionBroker`

### Phase 5: Extract RuntimeSurfaceController

Status: mostly complete

Completed:

- `/runtime` draft state and callbacks
- persisted final-answer replay callbacks
- persisted plan-result replay callbacks
- `/inspect` rendering and paging callbacks
- status-card rendering and update policy
- error-card rendering and update policy
- reanchor rules for bridge-owned runtime surfaces
- retry/backoff scheduling for runtime surface edits
- runtime trace-event ownership for surface transitions
- subagent identity backfill implementation moved behind a dedicated collaborator
- runtime trace sink moved behind a dedicated collaborator

Still intentionally left in `src/service.ts`:

- root `activeTurn` ownership
- session-derived runtime card context helpers
- trace logger sink construction

Why Phase 5 is not called fully complete yet:

- the controller now owns surface behavior, but it still receives some session-derived display context through injected `service.ts` callbacks
- this is deliberate; moving `activeTurn` itself before `TurnCoordinator` would blur lifecycle ownership and churn existing regression tests for no real payoff

### Phase 6: Extract RichInputAdapter

Status: complete

Completed:

- Telegram photo adaptation
- `/local_image`
- `/mention`
- pending rich-input composer ownership
- voice queueing and transcription flow
- realtime voice fallback
- blocked-turn rich-input admission rules
- rich-input `/cancel` cleanup integration

Current owner:

- `RichInputAdapter`

### Phase 7: Extract The Single TurnCoordinator

Status: complete

Completed:

- `activeTurn` ownership moved behind `TurnCoordinator`
- recent-activity ownership moved behind `TurnCoordinator`
- thread ensure and resume
- text and structured turn start
- interrupt flow
- active-turn notification consumption orchestration
- terminal completion / interruption / failure cleanup
- terminal final-answer delivery
- terminal plan-result delivery
- terminal history-artifact recovery
- active-turn debug-journal routing
- active-turn app-server-exit failure handling
- known unsupported server-request rejection while a turn is active
- global runtime-notice fanout moved behind a dedicated broadcaster collaborator
- thread archive and unarchive reconciliation moved behind a dedicated reconciler collaborator
- focused `TurnCoordinator` tests for start / recreate / completion / plan-result / interruption / unsupported-request / exit paths

Why Phase 7 is now called complete:

- the coordinator now depends on narrow bridge-level collaborators instead of service-shell helper implementations
- remaining work is no longer about turn-lifecycle ownership; it is about focused tests and store-internal slimming

### Phase 8: Split Store Internals Behind The Existing Facade

Status: complete

Current reality:

- `BridgeStateStore` still owns open, migrations, integrity handling, auth, sessions, runtime views, pending interactions, preferences, and input sources
- this is still the right call because upper-layer seams were not stable until the current waves landed

What landed now:

- open/schema/integrity/failure-marker handling has been extracted behind a dedicated internal module
- shared row types, row mappers, and session-select helpers now live behind a dedicated internal records module
- auth, pending-authorization, and chat-binding persistence now live behind a dedicated internal auth module
- session, recent-project, project-scan, and active-session normalization logic now live behind a dedicated internal sessions module
- runtime notices, runtime-card preferences, UI language, final-answer persistence, turn-input-source persistence, and readiness snapshot persistence now live behind a dedicated internal runtime-artifacts module
- pending-interaction CRUD and lifecycle transitions now live behind a dedicated internal interactions module
- the public `BridgeStateStore` facade and external imports stayed unchanged
- full validation is still green after the extraction (`npm run check`, `npm test`, `311/311`)

Why Phase 8 is now called complete:

- store persistence concerns are now split behind internal modules while `BridgeStateStore` remains the only public entrypoint
- cross-entity transaction boundaries still live in the facade, which is the intended end-state rather than leftover debt
- remaining work has shifted from store decomposition to residual cleanup and documentation follow-through

Rule:

- keep the public facade stable
- split internals only after `TurnCoordinator` exists

### Phase 9: Cleanup, Documentation Sync, And Residual Slimming Review

Status: complete for V5 scope

Completed:

- removed transitional shell logic from `src/service.ts`
- moved archive and unarchive ownership into `SessionProjectCoordinator`
- moved model picker and reasoning-effort callback ownership into `CodexCommandCoordinator`
- removed stale interaction helper duplication from `src/service.ts`
- synced this tracker to the current code shape and validation state

Explicitly deferred out of V5:

- install/admin slimming as a post-V5 wave
- any app-server surface expansion beyond the already adopted bridge contract

## Current Test Posture

Verified current test posture:

- full test suite remains green (`311/311`)
- command router has focused tests
- callback router has focused tests
- interaction broker has focused tests
- runtime notice broadcasting has focused tests
- thread archive reconciliation has focused tests
- subagent identity backfill has focused tests
- turn coordinator has focused tests covering start, missing-thread recreation, terminal completion, plan-result delivery, interruption, unsupported server requests, and app-server exit
- runtime surface controller has focused tests covering runtime preference save/expiry, failed-edit retry, and blocked-to-running reanchor
- codex command coordinator has focused tests covering model selection, skills, plugins, review-session creation, and direct rollback state updates
- rich input adapter has focused tests covering `/local_image`, `/mention`, pending-interaction admission blocking, and backgrounded voice processing
- UI split behavior is covered, but still mostly from `src/telegram/ui.test.ts`
- archive and unarchive compensation is still covered by broader `service` tests even after ownership moved out of the shell, which is fine
- some runtime surface and codex-command behavior is still also covered by broader `service` tests, which is fine; the extracted owners are no longer relying only on those broader regressions

## Remaining Execution Order

No blocking V5 execution order remains.

If another slimming wave is opened later, use this order:

1. keep app-server protocol scope frozen unless product scope explicitly changes
2. decide whether install/admin deserves extraction on its own rather than piggybacking on V5
3. only then revisit remaining large-but-cohesive modules such as `activity/tracker`

## Immediate Next Step

There is no mandatory next implementation step inside V5.

The next decision is productively a roadmap choice, not a refactor prerequisite:

- either stop here and treat V5 as complete
- or open a separate post-V5 slimming wave for install/admin only

## Validation Rule

Every remaining V5 phase must keep all of these true:

- `npm run check` passes
- `npm test` passes
- callback compatibility remains intact
- no second runtime owner appears
- the store public surface does not widen

High-risk regression paths to watch after every wave:

- callback compatibility
- blocked interaction handling
- app-server exit recovery
- archive and unarchive reconciliation
- rollback and compact behavior
- final-answer recovery and replay
- voice and photo input flows

## End-State Summary

V5 is complete only when the project reaches this shape:

- one thin shell
- one interaction owner
- one runtime-surface owner
- one protocol-command owner
- one rich-input owner
- one active-turn owner
- one stable store facade
- one command truth source
- one callback truth source

Current reality:

- the repo has reached the intended V5 ownership shape
- `src/service.ts` is now a materially thinner shell instead of a mixed-domain god object
- the stable store facade is already preserved and internally split
- any further slimming work is optional post-V5 backlog, not required completion work

That is the actual V5 status today, verified against code and protocol evidence rather than guessed from the original draft.
