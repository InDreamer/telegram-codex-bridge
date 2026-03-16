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
- `/new`, `/use`, `/pin`, `/inspect`, `/where`
- auth flow
- project picker
- session switching
- user-visible Telegram behavior

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

### Install / config / service / update / diagnostics
Read first:
- `docs/operations/install-and-admin.md`

Use for:
- `ctb` commands
- install flow
- env/config keys
- service ownership
- restart/update/doctor/status
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
- `docs/roadmap/phase-1-delivery.md`
- `docs/future/v2-prd.md`
- `docs/future/v3-prd.md`
- `docs/future/v2-engineering-evaluation.md`
- `docs/future/v2-engineering-evaluation-template.md`
- `docs/plans/`
- `docs/archive/`

These are **not shipped behavior** unless the active task explicitly says otherwise.

## Code anchors

If docs are insufficient, verify against the **narrowest relevant source file**.

### CLI / admin surface
- `src/cli.ts`

### Config / install / service / paths
- `src/config.ts`
- `src/install.ts`
- `src/service.ts`
- `src/paths.ts`

### Telegram behavior
- `src/telegram/commands.ts`
- `src/telegram/ui.ts`
- `src/telegram/api.ts`
- `src/telegram/poller.ts`

### Codex integration
- `src/codex/app-server.ts`
- `src/codex/notification-classifier.ts`

### Runtime state
- `src/state/store.ts`

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
2. then `src/telegram/commands.ts` or `src/telegram/ui.ts` if needed

### Actual runtime behavior
1. `docs/architecture/runtime-and-state.md`
2. then the relevant `src/` file

### Install or operations
1. `docs/operations/install-and-admin.md`
2. then `src/install.ts`, `src/service.ts`, `src/config.ts`, or `src/paths.ts`

### Codex protocol support
1. `docs/research/codex-app-server-authoritative-reference.md`
2. then `docs/research/codex-app-server-api-quick-reference.md` if needed
3. then `src/codex/app-server.ts` to confirm bridge adoption

### Shipped vs planned
1. check current product/architecture/operations docs
2. check code
3. only then consult roadmap/future/plans if needed

## Stop conditions

Stop reading when one of these is true:

- you can answer the question with clear source support
- you can make the requested change safely
- the remaining uncertainty is explicitly about an unresolved source conflict

If a conflict remains, report the conflict instead of reading the whole repo.

## Directory labels

Use these labels mentally:

- `docs/product/` = current intended product behavior
- `docs/architecture/` = current intended runtime behavior
- `docs/operations/` = current operational reference
- `docs/research/` = protocol/reference evidence; freshness varies
- `docs/roadmap/` = delivery intent
- `docs/future/` = future product/evaluation input
- `docs/plans/` = implementation planning / handoff history
- `docs/archive/` = historical context only

## Anti-patterns

Avoid these mistakes:

- reading every doc listed here "just in case"
- treating roadmap/future/plans as shipped behavior
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
