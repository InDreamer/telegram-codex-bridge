# Current Code Organization

Verified against the current `src/` tree on 2026-03-21.

This is a code-derived implementation map.
It is not a roadmap and it is not a product spec.

Use it when you need to know where ownership lives today before reading source files.

## Volatile Snapshot Reference

High-drift counts and version baselines live in:
- `docs/generated/current-snapshot.md`

Read that file when exact line counts, module sizes, or current CLI/version facts matter.
This document focuses on ownership and code-reading strategy rather than repeating volatile numbers.

## Current Concentration Snapshot

The important point is not raw size.
The important point is that ownership is now split across service collaborators, UI modules, and store internals, even though a few dense orchestrators still remain.

The main remaining concentration points are:
- `src/service.ts` as the shell and top-level glue layer
- `src/service/runtime-surface-controller.ts` as the largest runtime-surface owner
- `src/telegram/ui-runtime.ts` as the largest Telegram presentation module
- `src/activity/tracker.ts` as the main reducer/journal hotspot
- `src/install.ts` as the main install/admin hotspot
- `src/codex/app-server.ts` as the protocol wrapper boundary

## Top-Level Layout

- `src/cli.ts` is the `ctb` entrypoint. It routes install/admin commands into `src/install.ts` and service startup into `runBridgeService`.
- `src/service.ts` is still the bridge shell. It owns bootstrap, readiness/store/api wiring, authorization gating, Telegram ingress, top-level command and callback routing, app-server lifecycle wiring, and safe Telegram send/edit helpers.
- `src/service/` holds the extracted runtime-domain owners plus a few small helper modules used by those owners.
- `src/telegram/ui.ts` is only a barrel. Real Telegram UI logic lives in `src/telegram/ui-*.ts`.
- `src/state/store.ts` is the public SQLite facade. Store internals live in `src/state/store-*.ts`.
- `src/install.ts` still owns most install/admin/status/doctor/update logic and remains the main operations hotspot.
- `src/activity/tracker.ts` and `src/service/runtime-surface-controller.ts` are now the biggest dense reducers/orchestrators, but each still has a coherent runtime-focused domain.

## Bridge Service Ownership

`src/service.ts` is still the runtime entry shell, but it is no longer the single owner of every domain.

Current extracted collaborators under `src/service/`:

- `command-router.ts`: registry-driven Telegram command dispatch.
- `callback-router.ts`: parsed callback dispatch.
- `session-project-coordinator.ts`: project picker, manual-path flow, session switching, rename, pin, archive and unarchive, `/status`, `/where`, and session plan-mode toggling.
- `project-browser-coordinator.ts`: `/browse`, in-project directory navigation, text preview pagination, image preview handoff, and root-path confinement.
- `codex-command-coordinator.ts`: model picker and reasoning effort, skills, plugins, apps, MCP, account, review, fork, rollback, compact, and thread metadata commands.
- `rich-input-adapter.ts`: `/skill`, `/local_image`, `/mention`, queued structured inputs, Telegram photo adaptation, and voice-input orchestration.
- `interaction-broker.ts`: bridge-owned interaction cards, pending-interaction persistence, free-text interaction mode, resolution, expiry, and failure cleanup.
- `runtime-surface-controller.ts`: runtime hubs, runtime status and error cards, inspect rendering, runtime-field selection UI, rollback picker, and bridge-owned runtime-surface update policy.
- `turn-coordinator.ts`: active-turn ownership, turn start and resume, blocked-turn continuation, interrupt, notification consumption, terminal cleanup, final-answer delivery, and history-backed recovery.
- `runtime-notice-broadcaster.ts`: deferred runtime notices.
- `thread-archive-reconciler.ts`: archive and unarchive reconciliation plus pending-op cleanup.
- `subagent-identity-backfiller.ts`: protocol-backed subagent naming recovery.
- `runtime-surface-trace-sink.ts`: structured Telegram runtime-surface trace logging.

Small supporting modules under `src/service/` that are still worth knowing about:

- `runtime-surface-state.ts`: shared runtime-card and hub state helpers plus Telegram edit/delete outcome handling.
- `turn-artifacts.ts`: focused helpers for extracting final-answer artifacts from thread history.

A few bridge-level behaviors still live in `src/service.ts` itself because they need direct access to shell-level state:

- bridge-wide `/language` picker handling and callback refresh
- the plan-result `implement` action callback
- top-level glue between coordinators

Read `src/service.ts` first only when you need shell-level wiring.
If you already know the domain, jump straight to the matching collaborator.

## Telegram UI Split

`src/telegram/ui.ts` is not the right place to start anymore.
It only re-exports split modules.

Current UI ownership:

- `ui-callbacks.ts`: Telegram command parsing plus callback encoding and decoding.
- `ui-messages.ts`: project picker, session list, model picker, status, where, and other non-runtime command replies.
- `ui-runtime.ts`: runtime hubs, runtime cards, inspect views, interaction cards, rollback picker, project-browser surfaces, and runtime-field labels.
- `ui-final-answer.ts`: Markdown-to-Telegram HTML rendering, collapsible final answers, streamed message formatting, and plan-result views.
- `ui-shared.ts`: HTML escaping, relative time, reasoning-effort labels, button chunking, and shared formatting helpers.

The test layout has caught up in some places, but not everywhere.
Focused tests now exist for collaborators such as `project-browser-coordinator.ts`, `runtime-surface-controller.ts`, `turn-coordinator.ts`, and `codex-command-coordinator.ts`, while `src/telegram/ui.test.ts` and especially `src/service.test.ts` still carry broad cross-module regression coverage.

## Store Split

`src/state/store.ts` remains the only public store entrypoint.
That is deliberate.
The public facade and transaction boundary stayed stable while internals moved out.

Current store internals:

- `store-open.ts`: open, schema initialization, integrity handling, and state-store failure markers.
- `store-records.ts`: row types, row mappers, session select helpers, and active-session preference logic.
- `store-auth.ts`: authorized user, chat binding, and pending authorization persistence.
- `store-sessions.ts`: sessions, recent projects, project-scan cache, project aliases, and active-session normalization.
- `store-runtime-artifacts.ts`: runtime notices, runtime-card preferences, UI language, final-answer views, turn-input sources, and readiness snapshots.
- `store-pending-interactions.ts`: pending-interaction CRUD and lifecycle transitions.

Read `src/state/store.ts` when you need the public behavior.
Read the narrow `store-*.ts` module when you need the real implementation.

## Remaining Hotspots After The Latest Split Wave

These are the real remaining concentration points:

- `src/service.ts`: still the highest-level shell and still the single largest production file.
- `src/service/runtime-surface-controller.ts`: now owns most hub orchestration, reanchor policy, inspect rendering, and runtime-preference flow.
- `src/install.ts`: still mixes release build/copy, wrapper and unit generation, service-manager adapters, status/doctor formatting, update, and uninstall behavior.
- `src/service.test.ts`: still provides very broad end-to-end regression coverage.
- `src/telegram/ui.test.ts`: still spans multiple UI subdomains.

These are intentionally not automatic slimming targets unless scope changes:

- `src/activity/tracker.ts`: large but still cohesive.
- `src/codex/app-server.ts`: protocol wrapper surface is explicit and should not be churned casually.
- `src/state/store.ts`: public facade redesign is out of scope.

## How To Read The Code Now

- operator/admin commands: `src/cli.ts` -> `src/install.ts`
- runtime startup and Telegram ingress: `src/service.ts`
- session and project behavior: `src/service/session-project-coordinator.ts`
- project browsing: `src/service/project-browser-coordinator.ts`
- protocol-backed user commands: `src/service/codex-command-coordinator.ts`
- rich input and voice/photo handling: `src/service/rich-input-adapter.ts`
- runtime hubs, inspect, interactions, and rollback UI: `src/service/runtime-surface-controller.ts` plus `src/telegram/ui-runtime.ts`
- turn lifecycle and final-answer recovery: `src/service/turn-coordinator.ts` plus `src/service/turn-artifacts.ts`
- final-answer rendering: `src/telegram/ui-final-answer.ts`
- persistence behavior: `src/state/store.ts` -> narrow `src/state/store-*.ts`

## Post-V5.5 Direction

The next worthwhile slimming work is not another rewrite.

It is:

- internal install/admin modularization behind the existing CLI surface
- further redistribution of broad regression coverage out of `src/service.test.ts`
- selective decomposition inside `runtime-surface-controller.ts` only if hub orchestration, inspect rendering, and runtime-preference flows start diverging materially

It is not:

- protocol-surface expansion for its own sake
- multi-process or multi-package decomposition
- store facade redesign
- activity tracker surgery for its own sake
