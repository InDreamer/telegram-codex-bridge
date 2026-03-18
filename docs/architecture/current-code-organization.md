# Current Code Organization

Verified against the current `src/` tree on 2026-03-18.

This is a code-derived implementation map.
It is not a roadmap and it is not a product spec.

Use it when you need to know where ownership lives today before reading source files.

## Current Size Snapshot

- production TypeScript: `52` files, `26,042` lines
- test TypeScript: `26` files, `17,970` lines
- largest current non-test modules:
  - `src/service.ts` — `2998`
  - `src/service/runtime-surface-controller.ts` — `1624`
  - `src/telegram/ui-runtime.ts` — `1596`
  - `src/activity/tracker.ts` — `1547`
  - `src/service/interaction-broker.ts` — `1546`
  - `src/service/codex-command-coordinator.ts` — `1224`
  - `src/install.ts` — `913`

The important point is not raw size.
The important point is that the old single-file service and store concentrations are already split, while install/admin and some test files are still concentrated.

## Top-Level Layout

- `src/cli.ts` is the `ctb` entrypoint. It routes install/admin commands into `src/install.ts` and service startup into `runBridgeService`.
- `src/service.ts` is now the bridge shell. It owns bootstrap, readiness/store/api wiring, authorization gating, Telegram ingress, top-level routing, app-server lifecycle wiring, and safe Telegram send/edit helpers.
- `src/service/` holds the extracted runtime-domain owners.
- `src/telegram/ui.ts` is only a barrel. Real Telegram UI logic lives in `src/telegram/ui-*.ts`.
- `src/state/store.ts` is the public SQLite facade. Store internals live in `src/state/store-*.ts`.
- `src/install.ts` still owns most install/admin/status/doctor/update logic and is the main remaining operations hotspot.
- `src/activity/tracker.ts` remains large, but it is still a cohesive reducer/journal module rather than a random dumping ground.

## Bridge Service Ownership

`src/service.ts` is still the runtime entry shell, but it is no longer the single owner of every domain.

Current extracted collaborators under `src/service/`:

- `command-router.ts`: registry-driven Telegram command dispatch.
- `callback-router.ts`: parsed callback dispatch.
- `session-project-coordinator.ts`: project picker, manual-path flow, session switching, rename, pin, archive and unarchive, status, where, and session plan-mode toggling.
- `codex-command-coordinator.ts`: model picker and reasoning effort, skills, plugins, apps, MCP, account, review, fork, rollback, compact, and thread metadata commands.
- `rich-input-adapter.ts`: `/local_image`, `/mention`, queued structured inputs, Telegram photo adaptation, and voice-input orchestration.
- `interaction-broker.ts`: bridge-owned interaction cards, pending-interaction persistence, free-text interaction mode, resolution, expiry, and failure cleanup.
- `runtime-surface-controller.ts`: runtime status and error cards, inspect rendering, runtime-field selection UI, and bridge-owned runtime-surface update policy.
- `turn-coordinator.ts`: active-turn ownership, turn start and resume, interrupt, notification consumption, terminal cleanup, final-answer delivery, plan-result delivery, and history-backed recovery.
- `runtime-notice-broadcaster.ts`: deferred runtime notices.
- `thread-archive-reconciler.ts`: archive and unarchive reconciliation and pending-op cleanup.
- `subagent-identity-backfiller.ts`: protocol-backed subagent naming recovery.
- `runtime-surface-trace-sink.ts`: structured surface trace logging.

Read `src/service.ts` first only when you need shell-level wiring.
If you already know the domain, jump straight to the matching collaborator.

## Telegram UI Split

`src/telegram/ui.ts` is not the right place to start anymore.
It only re-exports split modules.

Current UI ownership:

- `ui-callbacks.ts`: Telegram command parsing plus callback encoding and decoding.
- `ui-messages.ts`: project picker, session list, model picker, status, where, and other non-runtime command replies.
- `ui-runtime.ts`: runtime cards, inspect views, interaction cards, rollback picker, and runtime-field labels.
- `ui-final-answer.ts`: Markdown-to-Telegram HTML rendering, collapsible final answers, streamed message formatting, and plan-result views.
- `ui-shared.ts`: HTML escaping, relative time, reasoning-effort labels, button chunking, and shared formatting helpers.

The test layout has not fully caught up with this split.
`src/telegram/ui.test.ts` is still large and should be redistributed in the next slimming wave.

## Store Split

`src/state/store.ts` remains the only public store entrypoint.
That is deliberate.
The public facade and transaction boundary stayed stable while internals moved out.

Current store internals:

- `store-open.ts`: open, schema initialization, integrity handling, and state-store failure markers.
- `store-records.ts`: row types, row mappers, session select helpers, and active-session preference logic.
- `store-auth.ts`: authorized user, chat binding, and pending authorization persistence.
- `store-sessions.ts`: sessions, recent projects, project-scan cache, and active-session normalization.
- `store-runtime-artifacts.ts`: runtime notices, runtime-card preferences, UI language, final-answer views, turn-input sources, and readiness snapshots.
- `store-pending-interactions.ts`: pending-interaction CRUD and lifecycle transitions.

Read `src/state/store.ts` when you need the public behavior.
Read the narrow `store-*.ts` module when you need the real implementation.

## Remaining Hotspots After V5

These are the real remaining structural targets:

- `src/install.ts`: still mixes release build and copy, wrapper and unit generation, service-manager adapters, status and doctor formatting, update and uninstall behavior, and authorization admin commands.
- `src/telegram/ui.test.ts`: still reflects the pre-split UI era.
- `src/service.test.ts`: still carries broad regression coverage that overlaps the newer focused collaborator tests.

These are intentionally not current slimming targets unless scope changes:

- `src/activity/tracker.ts`: large but cohesive.
- `src/codex/app-server.ts`: protocol wrapper surface is already explicit and should not be churned casually.
- `src/state/store.ts`: public facade redesign is out of scope.

## How To Read The Code Now

- operator/admin commands: `src/cli.ts` -> `src/install.ts`
- runtime startup and Telegram ingress: `src/service.ts`
- session and project behavior: `src/service/session-project-coordinator.ts`
- protocol-backed user commands: `src/service/codex-command-coordinator.ts`
- rich input and voice/photo handling: `src/service/rich-input-adapter.ts`
- runtime cards, inspect, and interaction UI: `src/service/runtime-surface-controller.ts` plus `src/telegram/ui-runtime.ts`
- final-answer rendering: `src/telegram/ui-final-answer.ts`
- persistence behavior: `src/state/store.ts` -> narrow `src/state/store-*.ts`

## Post-V5.5 Direction

The next worthwhile slimming work is not another rewrite.

It is:

- internal install/admin modularization behind the existing CLI surface
- shared status/doctor/readiness helper extraction
- UI test redistribution so tests match the existing UI split

It is not:

- protocol-surface expansion
- multi-process or multi-package decomposition
- store facade redesign
- activity tracker surgery for its own sake
