# Documentation Map

This repository uses a **three-tier documentation model**.
The goal is to keep current truth, protocol evidence, and planning/history separate so readers do not have to preload the whole doc tree.

For coding agents, the preferred path is:

1. root `AGENTS.md`
2. `docs/AGENTS.md` or `src/AGENTS.md`
3. one leaf file

This file is the **human-readable map** of the doc system.

## Tier 1 — Current truth

Use this tier by default for current behavior.

### Product

- `docs/product/v1-scope.md`
- `docs/product/chat-and-project-flow.md`
- `docs/product/auth-and-project-flow.md`
- `docs/product/codex-command-reference.md`
- `docs/product/runtime-and-delivery.md`
- `docs/product/callback-contract.md`

### Architecture

- `docs/architecture/runtime-and-state.md`
- `docs/architecture/current-code-organization.md`

### Operations

- `docs/operations/install-and-admin.md`

### High-drift current facts

- `docs/generated/current-snapshot.md`

Use Tier 1 for questions like:

- what v1 includes or excludes
- how the Telegram UX is supposed to behave now
- how runtime, state, recovery, and delivery are intended to work now
- how operators install, configure, run, and diagnose the bridge now
- what the current version baselines or code-size snapshots are

## Tier 2 — Protocol evidence

Use this tier only when the question is about Codex app-server capability or exact payload shape.

- `docs/research/codex-app-server-authoritative-reference.md`
- `docs/research/codex-app-server-api-quick-reference.md`
- `docs/research/app-server-phase-0-verification.md`

Use Tier 2 for questions like:

- what Codex app-server supports in principle
- exact request and notification shapes
- earlier protocol verification details

Rule:

- Tier 2 proves **protocol capability**
- Tier 2 does **not** automatically prove shipped Telegram behavior

## Tier 3 — Planning and history

Use this tier only for future direction, engineering sequencing, or historical reconstruction.

- `docs/roadmap/`
- `docs/future/`
- `docs/plans/`
- `docs/archive/`

Use Tier 3 for questions like:

- what comes next
- what was planned for later phases
- why an implementation sequence was chosen
- how older behavior differed from the current model

Rule:

- Tier 3 is context, not default truth

## Recommended Reading Paths

### I want to understand the current product

1. `docs/product/v1-scope.md`
2. `docs/product/chat-and-project-flow.md` if you need a router
3. exactly one narrow product doc from the split set

### I want the current implementation map

1. `docs/architecture/current-code-organization.md`
2. then use `src/AGENTS.md` to choose one code owner file

### I want install or admin guidance

1. `docs/operations/install-and-admin.md`
2. then `src/install.ts` or `src/readiness.ts` only if implementation verification is needed

### I want Codex protocol details

1. `docs/research/codex-app-server-authoritative-reference.md`
2. `docs/research/codex-app-server-api-quick-reference.md` only if you need a fast method lookup
3. then `src/codex/app-server.ts` only if bridge adoption must be confirmed

### I want roadmap, future, or historical context

1. the smallest relevant file in `docs/roadmap/`, `docs/future/`, `docs/plans/`, or `docs/archive/`
2. then Tier 1 or code if you need to compare past intent with current truth

## Local Directory Maps

The directory `README.md` files under these folders remain useful as local maps for humans:

- `docs/product/`
- `docs/architecture/`
- `docs/operations/`
- `docs/research/`

Coding agents should usually prefer `docs/AGENTS.md` over these local maps.

## Final Rule

Read the smallest relevant tier first.
Do not treat every document as equal.
Do not preload the whole docs tree.
