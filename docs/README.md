# Documentation Map

This repository uses a layered documentation model.
The goal is to keep **current behavior**, **intended behavior**, **protocol evidence**, **future direction**, and **historical material** separate.

Do not treat every document as equal.
Read the smallest relevant layer first.

## Layer 0 — Entry points

Use these first depending on who is reading:

- `README.md` — human-facing repository overview
- `AGENTS.md` — agent-facing low-context retrieval router
- `docs/README.md` — human-readable documentation map and layer model

## Layer 1 — Current intended behavior

These docs describe the current intended product/runtime/operational shape of the bridge.
This is the default layer for most human readers.

### Product
- `docs/product/v1-scope.md`
- `docs/product/chat-and-project-flow.md`

### Architecture
- `docs/architecture/runtime-and-state.md`

### Operations
- `docs/operations/install-and-admin.md`

Use this layer for questions like:
- what v1 includes or excludes
- what the Telegram UX should do
- how runtime/state/recovery are supposed to work
- how operators install, run, and diagnose the bridge

## Layer 2 — Protocol and reference evidence

These docs describe Codex app-server protocol evidence and method-level reference.
They are not the same thing as shipped bridge behavior.

- `docs/research/codex-app-server-authoritative-reference.md`
- `docs/research/codex-app-server-api-quick-reference.md`
- `docs/research/app-server-phase-0-verification.md`

Use this layer for questions like:
- what Codex supports in principle
- exact request/notification shapes
- earlier protocol verification details

## Layer 3 — Delivery intent and future direction

These docs describe planned delivery sequencing and future product direction.
They are useful for roadmap and design discussions, not for claiming shipped behavior.

### Roadmap
- `docs/roadmap/phase-1-delivery.md`

### Future product/evaluation
- `docs/future/v2-prd.md`
- `docs/future/v3-prd.md`
- `docs/future/v2-engineering-evaluation.md`
- `docs/future/v2-engineering-evaluation-template.md`

Use this layer for questions like:
- what comes next
- what is intended for v2/v3
- how future directions were evaluated

## Layer 4 — Implementation planning and handoff history

These docs capture implementation plans, sequencing notes, and design handoff material.
They are useful for understanding why something was planned, not as automatic proof of current behavior.

- `docs/plans/`

Rule:
- when an implementation handoff is complete and no longer the active working set, move it into `docs/archive/`

Use this layer for:
- implementation history
- design sequencing
- engineering handoff context

## Layer 5 — Historical archive

These docs exist for reconstruction and context only.
They should not be treated as active behavior or active intent unless explicitly re-promoted.

- `docs/archive/`

Read this layer only when:
- current docs, code, API evidence, and user-reported behavior appear broken or contradictory
- the bridge has undergone a substantive behavior or business change and historical comparison is required

Do not read `docs/archive/` by default.

## Recommended reading paths

### I want to understand the product
1. `README.md`
2. `docs/product/v1-scope.md`
3. `docs/product/chat-and-project-flow.md`

### I want to understand runtime behavior and delivery
1. `docs/architecture/runtime-and-state.md`
2. then relevant `src/` files if needed

### I want to operate or deploy the bridge
1. `docs/operations/install-and-admin.md`

### I want to check protocol capabilities
1. `docs/research/codex-app-server-authoritative-reference.md`
2. `docs/research/codex-app-server-api-quick-reference.md`
3. verify adoption in `src/codex/app-server.ts`

### I want to understand future direction
1. `docs/roadmap/phase-1-delivery.md`
2. `docs/future/`
3. `docs/plans/` if handoff detail is needed

## Interpretation rule

When sources disagree, keep these questions separate:

- **What should happen?** -> active spec/product/architecture/operations docs
- **What happens today?** -> repository code/runtime
- **What does Codex support in principle?** -> protocol/reference docs
- **What is planned next?** -> roadmap/future/plans

Do not collapse these into one blended answer.
