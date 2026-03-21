# AGENTS.md

Agent router for `telegram-codex-bridge`.

This file is for LLM coding agents.
Goal: use the **least context** that still allows a correct answer or change.

## Quick Start

1. Read **one** current doc or **one** narrow code file first.
2. Prefer **current docs** for intended behavior, **code** for observed behavior, **live schema** for protocol capability.
3. Read more only when blocked by missing detail, ambiguity, or a real conflict.
4. Stop as soon as the answer or edit is well-supported.
5. Keep these separate in reasoning and answers:
   - **Intended behavior**
   - **Observed behavior**
   - **Protocol capability**
   - **Planned or historical context**

Do **not** preload the repo.
Do **not** read all linked docs.
Do **not** mistake planned behavior for shipped behavior.

## Project Boundary

This project is:
- a VPS-hosted Telegram bridge for the Codex installation already on the server
- Telegram as the control surface
- Codex as the execution engine

This project is **not**:
- a second Codex runtime
- a second permission system
- a provider-management layer

## Retrieval Budget

Default budget for most tasks:
1. Read **1** starting doc from the router below.
2. If needed, read **1** more doc or **1-2** code files.
3. Stop early.

Only exceed this when the task is explicitly architectural, cross-cutting, or conflict-heavy.

## Source Model

Use the right source for the right question.

1. **Active user/task instruction**
   - Highest priority.
2. **Current product / architecture / operations docs**
   - Intended current behavior.
3. **Repository code and runtime behavior**
   - Observed current behavior.
4. **Live Codex CLI / generated schema**
   - Protocol capability and exact payload shape.
5. **Roadmap / future / plans / archive docs**
   - Context only unless the active task explicitly promotes them.

## Fast First-File Router

Pick **one** starting file.

| Task | Read first |
|---|---|
| v1 boundary, trust model, product scope | `docs/product/v1-scope.md` |
| unsure which Telegram product doc you need | `docs/product/chat-and-project-flow.md` |
| auth flow, project discovery, project picker, `/browse`, sessions, archive, rename, pin | `docs/product/auth-and-project-flow.md` |
| Codex-backed Telegram commands, rich inputs, `/model`, `/skills`, `/plugins`, `/apps`, `/mcp`, `/account`, `/review`, `/fork`, `/rollback`, `/compact`, `/thread`, `/local_image`, `/mention` | `docs/product/codex-command-reference.md` |
| `/where`, `/inspect`, `/interrupt`, `/status`, `/runtime`, runtime hubs/cards, final-answer delivery | `docs/product/runtime-and-delivery.md` |
| Telegram callback payload families and stale/duplicate callback rules | `docs/product/callback-contract.md` |
| current module ownership / where to read next in `src/` | `docs/architecture/current-code-organization.md` |
| runtime lifecycle, SQLite state, recovery, degraded behavior | `docs/architecture/runtime-and-state.md` |
| install, config, service, update, diagnostics | `docs/operations/install-and-admin.md` |
| volatile counts or current version baselines | `docs/generated/current-snapshot.md` |
| Codex protocol / app-server methods | `docs/research/codex-app-server-authoritative-reference.md` |
| historical protocol verification only | `docs/research/app-server-phase-0-verification.md` |
| roadmap / future / planning | current file under `docs/roadmap/`, `docs/future/`, or `docs/plans/` **only if the task is actually about future or history** |

Then verify against the narrowest relevant source file if needed.

## Conflict Rules

- If the **user gives a direct instruction**, follow it for the active task.
- If **code differs from current spec docs**, treat it as a real mismatch.
- If **docs lag behind accepted implementation**, update docs to match confirmed behavior.
- If **code lags behind active intended behavior**, update code to match the active spec.
- If **protocol docs show a capability**, verify bridge adoption before claiming Telegram UX supports it.
- If you cannot tell which doc is active, say so explicitly.

## Stop Rules

Stop reading when one of these is true:
- you can answer the question with clear source support
- you can make the requested change safely
- the remaining uncertainty is explicitly about an unresolved source conflict

If a conflict remains, report the conflict instead of reading the whole repo.

---

## Appendix A — Code Anchors

If docs are insufficient, verify against the **narrowest relevant source file**.

### CLI / admin surface
- `src/cli.ts`

### Config / install / service / paths
- `src/config.ts`
- `src/install.ts`
- `src/service.ts`
- `src/service/`
- `src/paths.ts`
- `src/readiness.ts`

### Telegram behavior
- `src/telegram/commands.ts`
- `src/telegram/ui-callbacks.ts`
- `src/telegram/ui-messages.ts`
- `src/telegram/ui-runtime.ts`
- `src/telegram/ui-final-answer.ts`
- `src/telegram/ui-shared.ts`
- `src/service/session-project-coordinator.ts`
- `src/service/project-browser-coordinator.ts`
- `src/service/codex-command-coordinator.ts`
- `src/service/rich-input-adapter.ts`
- `src/service/runtime-surface-controller.ts`
- `src/service/interaction-broker.ts`
- `src/telegram/api.ts`
- `src/telegram/poller.ts`

### Codex integration
- `src/codex/app-server.ts`
- `src/codex/notification-classifier.ts`

### Runtime state
- `src/state/store.ts`
- `src/state/store-*.ts`

### Interaction handling
- `src/interactions/normalize.ts`
- `src/util/blocked-progress.ts`

### Activity/debug tracking
- `src/activity/tracker.ts`
- `src/activity/debug-journal.ts`

## Appendix B — Minimal Retrieval Patterns

### User-visible command behavior
1. Read **one** product doc first:
   - if unsure, start with `docs/product/chat-and-project-flow.md`
   - otherwise go straight to one narrow doc:
     - `docs/product/auth-and-project-flow.md`
     - `docs/product/codex-command-reference.md`
     - `docs/product/runtime-and-delivery.md`
     - `docs/product/callback-contract.md`
2. Then `src/telegram/commands.ts` for command registry / help-menu truth if needed.
3. Then the narrow owner under `src/service/` or `src/telegram/ui-*.ts`.

### Actual runtime behavior
1. `docs/architecture/runtime-and-state.md`
2. then the relevant `src/` file
3. use `src/readiness.ts` when the question is really about startup gating, capability floors, or degraded states

### Install or operations
1. `docs/operations/install-and-admin.md`
2. then `src/install.ts`, `src/readiness.ts`, `src/service.ts`, `src/config.ts`, or `src/paths.ts`

### Current module ownership
1. `docs/architecture/current-code-organization.md`
2. then the narrow module under `src/service/`, `src/telegram/ui-*.ts`, `src/state/store-*.ts`, or `src/install.ts`

### Codex protocol support
1. `docs/research/codex-app-server-authoritative-reference.md`
2. then `docs/research/codex-app-server-api-quick-reference.md` if needed
3. then `src/codex/app-server.ts` to confirm bridge adoption

### Shipped vs planned
1. check current product / architecture / operations docs
2. check code
3. only then consult roadmap / future / plans if needed
4. consult `docs/archive/` only as a last resort

## Appendix C — Planning / Archive Warning

Read `docs/future/`, `docs/plans/`, or `docs/archive/` only when the task is explicitly about future direction, implementation history, or conflict reconstruction.

Remember:
- `docs/future/` = future product / evaluation input
- `docs/plans/` = implementation rationale, sequencing, handoff history
- `docs/archive/` = historical context only

Do not use those directories to claim shipped behavior unless the active task explicitly promotes them and current docs/code agree.

## Appendix D — Anti-Patterns

Avoid these mistakes:
- reading every doc listed here just in case
- treating roadmap / future / plans as shipped behavior
- treating archive docs as normal reference material
- claiming protocol support means bridge support
- assuming current code is automatically correct intent
- assuming current docs are automatically implemented
- giving one blended answer when intended, observed, and protocol differ

## Final Instruction

Default behavior:
- read less
- verify narrowly
- separate intended vs observed vs protocol vs planned
- stop early when supported
- do not over-claim
