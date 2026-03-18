# AGENTS.md

Agent router for `telegram-codex-bridge`.

This file is for LLM coding agents.
Goal: use the **least context** that still allows a correct answer or change.

## Prime directive

Read the **smallest relevant source first**.
Then stop.
Read more only if you are blocked by missing detail, ambiguity, or a real conflict.

Do **not** preload the repo.
Do **not** read all linked docs.
Do **not** mistake planned behavior for shipped behavior.

## What this project is

A VPS-hosted Telegram bridge that controls the Codex installation already present on the server.

- Telegram = control surface
- Codex = execution engine
- the bridge is not a second Codex runtime
- the bridge is not a second permission system
- the bridge is not a provider-management layer

## Retrieval budget

Default budget for most tasks:

1. Read **1 doc** from the router below.
2. If needed, read **1 more doc or 1-2 code files**.
3. Stop as soon as the answer or edit is well-supported.

Only exceed this when the task is explicitly architectural, cross-cutting, or conflict-heavy.

## Evidence model

This repo is still evolving.
There is **no single permanent source of truth**.
Use the right source for the right question.

### Source categories

1. **Active user/task instruction**
   - Highest priority for the active task.

2. **Active product/spec docs**
   - Intended behavior.
   - Answer: **what should happen**.

3. **Repository code/runtime**
   - Observed current behavior.
   - Answer: **what happens today**.

4. **Live Codex API / generated schema**
   - Protocol capability and exact method/notification shape.
   - Answer: **what Codex supports in principle**.

5. **Roadmap / future / plans / archive docs**
   - Context only, unless the active task explicitly promotes one of them.

## Required separation in reasoning and answers

When sources differ, keep these separate:

- **Observed behavior** = what current code/runtime does
- **Intended behavior** = what the active spec says should happen
- **Protocol capability** = what Codex supports
- **Required action** = update code, update docs, or both

Never collapse those into one vague claim.

## Conflict policy

- If the **user gives a direct instruction**, follow it for the active task.
- If **code differs from current spec docs**, treat it as a real mismatch.
- If **docs lag behind accepted implementation**, update docs to match confirmed behavior.
- If **code lags behind active intended behavior**, update code to match the active spec.
- If **protocol docs show a capability**, verify bridge adoption before claiming Telegram UX supports it.
- If you cannot tell which doc is active, say so explicitly.

## First-file router

Pick **one** starting file based on the task.

### Scope / trust model / v1 boundary
Read first:
- `docs/product/v1-scope.md`

Use for:
- in-scope vs out-of-scope
- trust model
- operator assumptions
- product boundary

### Telegram UX / commands / auth / project flow / sessions
Read first:
- `docs/product/chat-and-project-flow.md`

Use for:
- `/help`, `/start`, `/cancel`
- `/new`, `/sessions`, `/archive`, `/unarchive`, `/use`, `/rename`, `/pin`
- `/plan`, `/model`, `/status`, `/runtime`, `/inspect`, `/where`
- `/skills`, `/plugins`, `/apps`, `/mcp`, `/account`
- `/review`, `/fork`, `/rollback`, `/compact`
- `/thread`, `/local_image`, `/mention`, `/interrupt`
- auth flow
- project picker
- session switching
- user-visible Telegram behavior
- Telegram photo and voice input adaptation

### Runtime / lifecycle / state / recovery / answer delivery
Read first:
- `docs/architecture/runtime-and-state.md`

Use for:
- app-server lifecycle
- SQLite state
- recovery rules
- readiness/degraded behavior
- runtime-card reduction
- final-answer delivery

### Current code organization / module ownership / refactor state
Read first:
- `docs/architecture/current-code-organization.md`

Use for:
- post-V5 and post-V5.5 code shape
- service/UI/store/install ownership boundaries
- current hotspots and where to read next in `src/`
- distinguishing shell or facade files from extracted collaborators

### Install / config / service / update / diagnostics
Read first:
- `docs/operations/install-and-admin.md`

Use for:
- `ctb` commands
- install flow
- env/config keys
- service ownership
- voice-input backends
- restart/update/doctor/status

### Readiness / capability checks
Read code first when needed:
- `src/readiness.ts`
- Node/Codex version floors

### Codex protocol / app-server methods
Read first:
- `docs/research/codex-app-server-authoritative-reference.md`

Then only if needed:
- `docs/research/codex-app-server-api-quick-reference.md`

Use for:
- app-server methods
- notifications
- request/response shape
- protocol capability
- current schema guidance

### Historical verification detail
Read only if needed:
- `docs/research/app-server-phase-0-verification.md`

Use only for:
- older confirmed event names
- earlier extraction notes
- historical verification detail

Do **not** use it as the top source for the latest CLI surface.

### Planning / future direction / history
Read only when the task is explicitly about planning or future direction:
- `docs/plans/2026-03-18-v5-5-post-v5-slimming-plan.md`
- `docs/plans/2026-03-18-v5-project-slimming-plan.md`
- `docs/roadmap/phase-1-delivery.md`
- `docs/future/v2-prd.md`
- `docs/future/v3-prd.md`
- `docs/future/v2-engineering-evaluation.md`
- `docs/future/v2-engineering-evaluation-template.md`
- `docs/plans/`
- `docs/archive/`

These are **not shipped behavior** unless the active task explicitly says otherwise.

Archive warning:
- prefer **not** to read `docs/archive/` at all
- only consult archive material when current code, current docs, API/schema evidence, and the active user request appear broken or contradictory
- archive material is also acceptable when the project clearly went through a substantive behavior or business transition and you need historical comparison
- if archive evidence conflicts with current sources, current sources win unless the user explicitly asks for history

## Code anchors

If docs are insufficient, verify against the **narrowest relevant source file**.

### CLI / admin surface
- `src/cli.ts`

### Config / install / service / paths
- `src/config.ts`
- `src/install.ts`
- `src/service.ts`
- `src/service/`
- `src/paths.ts`

### Telegram behavior
- `src/telegram/commands.ts`
- `src/telegram/ui-callbacks.ts`
- `src/telegram/ui-messages.ts`
- `src/telegram/ui-runtime.ts`
- `src/telegram/ui-final-answer.ts`
- `src/telegram/ui-shared.ts`
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

## Minimal retrieval patterns

Use these patterns unless the task clearly needs more.

### User-visible command behavior
1. `docs/product/chat-and-project-flow.md`
2. then `src/telegram/commands.ts` or the narrow `src/telegram/ui-*.ts` module if needed

### Actual runtime behavior
1. `docs/architecture/runtime-and-state.md`
2. then the relevant `src/` file
3. use `src/readiness.ts` when the question is really about startup gating, capability floors, or degraded states

### Install or operations
1. `docs/operations/install-and-admin.md`
2. then `src/install.ts`, `src/readiness.ts`, `src/service.ts`, `src/config.ts`, or `src/paths.ts`

### Current module ownership or refactor status
1. `docs/architecture/current-code-organization.md`
2. then the narrow module under `src/service/`, `src/telegram/ui-*.ts`, `src/state/store-*.ts`, or `src/install.ts`

### Codex protocol support
1. `docs/research/codex-app-server-authoritative-reference.md`
2. then `docs/research/codex-app-server-api-quick-reference.md` if needed
3. then `src/codex/app-server.ts` to confirm bridge adoption

### Shipped vs planned
1. check current product/architecture/operations docs
2. check code
3. only then consult roadmap/future/plans if needed
4. consult `docs/archive/` only as a last resort under the archive warning above

## Stop conditions

Stop reading when one of these is true:

- you can answer the question with clear source support
- you can make the requested change safely
- the remaining uncertainty is explicitly about an unresolved source conflict

If a conflict remains, report the conflict instead of reading the whole repo.

## Directory labels

Use these labels mentally:

- `docs/product/` = current intended product behavior
- `docs/architecture/` = current runtime behavior and verified implementation-structure maps
- `docs/operations/` = current operational reference
- `docs/research/` = protocol/reference evidence; freshness varies
- `docs/roadmap/` = delivery intent
- `docs/future/` = future product/evaluation input
- `docs/plans/` = active or closed implementation planning / handoff history
- `docs/archive/` = historical context only; avoid by default

## Anti-patterns

Avoid these mistakes:

- reading every doc listed here "just in case"
- treating roadmap/future/plans as shipped behavior
- treating archive docs as normal reference material
- claiming protocol support means bridge support
- assuming current code is automatically correct intent
- assuming current docs are automatically implemented
- giving one blended answer when observed, intended, and protocol differ

## Final instruction

Default behavior:
- read less
- verify narrowly
- separate observed vs intended vs protocol
- stop early when supported
- do not over-claim
