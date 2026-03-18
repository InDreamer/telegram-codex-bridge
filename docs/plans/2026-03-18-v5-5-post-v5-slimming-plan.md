# V5.5 Post-V5 Slimming Plan

> Planning document with verified current status.
> This file is not a current-behavior spec.
> It is the active post-V5 tracker for documentation cleanup, AGENTS routing, install/admin slimming, and test redistribution.

## Verification Basis

Verified on 2026-03-18 against:

- current repository code under `src/`
- current documentation under `docs/product/`, `docs/architecture/`, `docs/operations/`, and `docs/research/`
- current post-V5 module split already landed in `src/service/`, `src/telegram/ui-*.ts`, and `src/state/store-*.ts`
- current app-server adoption boundary documented in `docs/research/codex-app-server-authoritative-reference.md`
- last known local CLI baseline `codex-cli 0.115.0`
- current validation state: `npm run check` and `npm test` passing (`311/311`)

Important rule:

- V5.5 is a follow-up cleanup wave
- it must not reopen V5 by smuggling in protocol expansion or product redesign

## Goal

Finish the remaining slimming work that is still worth doing after V5:

- sync docs and AGENTS to the code that actually exists now
- modularize install/admin internals without changing the CLI surface
- redistribute UI tests so they match the already-landed UI split
- lock the remaining backlog instead of pretending everything belongs under V5

## Current Verified Snapshot

Observed current code shape on 2026-03-18:

- V5 core slimming is already landed in code
- `src/service.ts` is down to `2998` lines and now acts as the bridge shell
- `src/state/store.ts` is down to `687` lines and now acts as a stable public facade
- `src/telegram/ui.ts` is only a barrel; real UI logic lives in `src/telegram/ui-*.ts`
- production TypeScript is `52` files / `26,042` lines
- test TypeScript is `26` files / `17,970` lines

Real remaining hotspots:

- `src/install.ts` — `913`
- `src/activity/tracker.ts` — `1547`
- `src/telegram/ui.test.ts` — `1242`
- `src/service.test.ts` — `7917`

Real documentation and retrieval gaps before this wave:

- no dedicated current code-organization document existed
- docs indexes still treated V5 as the active repo-wide tracker
- `AGENTS.md` still routed some tasks toward barrel or facade files first
- current-state docs drifted on `/help`, `/language`, callback families, and state-store corruption handling

## Non-Negotiable Invariants

These remain hard constraints:

- single bridge process
- single long-lived local `codex app-server` child per bridge process
- single SQLite facade and coherent transaction boundary
- single `activeTurn` owner
- stable Telegram callback compatibility
- no product-surface changes disguised as refactors
- protocol capability must stay separate from adopted Telegram UX

## In Scope

V5.5 includes:

- docs and AGENTS cleanup anchored to current code
- internal install/admin modularization inside the existing package and process
- shared readiness, status, and doctor helper consolidation
- UI test redistribution after the UI split
- explicit backlog locking for what stays outside V5.5

## Out Of Scope

V5.5 does not include:

- app-server protocol expansion
- Telegram UX redesign
- store public API redesign
- `activity/tracker` structural split
- multi-process, multi-service, or multi-package work
- arbitrary cleanup that does not materially improve ownership or retrieval

## Phase Status

### Phase 1: Documentation And Agent Routing

Status: complete

Completed:

- add a code-derived `docs/architecture/current-code-organization.md`
- update root and docs indexes to point to the real active plan and current code map
- update `AGENTS.md` so agents can start from split modules instead of dead-end barrel or facade files
- correct current-state doc drift for `/help`, `/language`, callback families, and fail-closed state-store corruption handling

Exit rule:

- a new engineer or agent can find the right split module without opening `src/telegram/ui.ts` or `src/state/store.ts` first unless they actually need the barrel or facade

### Phase 2: Install/Admin Internal Split

Status: pending

Target internal ownership slices:

- release/install helpers: wrapper script, service unit or LaunchAgent writing, install manifest read and write, release copy and build
- service-manager adapters: detection plus `systemctl` and `launchctl` start, stop, restart, and state helpers
- status and doctor formatting: readiness snapshot rendering, state-store failure rendering, status block assembly
- auth-admin helpers: pending authorization listing and clear flows
- shared validation utilities: project-scan root validation and shared path helpers

Rules:

- keep `src/install.ts` as the public facade imported by `src/cli.ts`
- keep operator-visible command semantics unchanged
- reuse the existing readiness probe and Telegram command sync flow

Acceptance:

- `src/install.ts` becomes a thin orchestrator instead of a mixed implementation dump
- `ctb install`, `status`, `doctor`, `start`, `stop`, `restart`, `update`, `uninstall`, and `authorize *` behavior remains unchanged

### Phase 3: UI Test Redistribution

Status: pending

Tasks:

- move callback codec assertions into `src/telegram/ui-callbacks.test.ts`
- move final-answer rendering assertions into `src/telegram/ui-final-answer.test.ts`
- move message-builder assertions into `src/telegram/ui-messages.test.ts`
- move runtime, inspect, interaction-card, and rollback assertions into `src/telegram/ui-runtime.test.ts`
- keep only thin compatibility coverage around the `src/telegram/ui.ts` barrel if it still adds value
- reduce `src/service.test.ts` overlap only where focused collaborator tests already cover the same behavior

Acceptance:

- the test layout matches the landed UI split
- UI behavior is no longer defended mainly by one legacy `ui.test.ts`

### Phase 4: Backlog Lock And Closeout

Status: pending

Tasks:

- explicitly lock deferred work that is still outside V5.5: protocol adoption beyond the current bridge contract, `activity/tracker` slimming, store facade redesign, and any multi-process or multi-package work
- close V5.5 once Phase 2 and Phase 3 land and validation remains green
- move only superseded low-signal handoff material to `docs/archive/`; do not archive still-useful recent closeout trackers just for aesthetics

## Execution Order

Use this order:

1. land and stabilize docs plus AGENTS cleanup
2. split install/admin helpers behind the existing CLI surface
3. redistribute UI tests
4. trim obvious duplicated broad tests only after focused tests exist
5. close V5.5 and freeze the remaining backlog

## Immediate Next Step

The next real implementation step is Phase 2.

`src/install.ts` is the main remaining structural target that still offers meaningful payoff without reopening product or protocol scope.
