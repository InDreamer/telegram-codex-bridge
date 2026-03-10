# Project Documents Guide

This file is a low-token document index for Codex and other agents.
Read the smallest relevant document first.

Read progressively:
- Treat `docs/product/`, `docs/architecture/`, `docs/operations/`, and `docs/research/` as the current-state set.
- Treat `docs/roadmap/`, `docs/future/`, `docs/plans/`, and `docs/archive/` as document-defined planning or history, not live runtime behavior.
- Do not load every document by default.

## Primary Reading Order

1. `docs/product/v1-scope.md`
   - Use this first for product boundary, trust model, and what v1 includes or excludes.
   - This is the fastest project-intent refresher.

2. `docs/product/chat-and-project-flow.md`
   - Use this for Telegram UX, authorization flow, session switching, project picking, and callback behavior.
   - It is the user-facing command contract.

3. `docs/architecture/runtime-and-state.md`
   - Use this for bridge runtime shape, app-server integration, persistence, recovery, and concurrency.
   - It is the main technical contract for service behavior.

4. `docs/operations/install-and-admin.md`
   - Use this for install paths, systemd ownership, `ctb` commands, update behavior, and diagnostics.
   - Read this before changing deployment or operator workflows.

5. `docs/roadmap/phase-1-delivery.md`
   - Use this for acceptance criteria and delivery sequencing.
   - Treat it as roadmap intent, not proof that a behavior is already shipped.

6. `docs/research/app-server-phase-0-verification.md`
   - Use this when touching the Codex protocol adapter or checking verified event names and payload fields.
   - This is the evidence-backed protocol reference.

## Future And History

- `docs/future/v2-prd.md`
  - Future product draft for activity visibility, richer session management, and platform hardening.
  - Do not treat it as current behavior.

- `docs/future/v2-engineering-evaluation-template.md`
  - Template for evaluating the V2 PRD.
  - Use it only for future-scope engineering review.

- `docs/plans/2026-03-10-documentation-information-architecture.md`
  - Process note for the docs split and AGENTS index design.
  - Read this only when maintaining the documentation system itself.

- `docs/archive/legacy-v1-engineering-plan-draft.md`
  - Historical note for the retired monolithic draft.
  - Use this only when reconstructing drafting history.

## Fast Lookup

- "What is this product and what is out of scope?"
  - `docs/product/v1-scope.md`

- "How should Telegram commands, buttons, project picking, or auth behave?"
  - `docs/product/chat-and-project-flow.md`

- "How does the bridge talk to Codex, store state, recover, or degrade?"
  - `docs/architecture/runtime-and-state.md`

- "How is the service installed, managed, updated, or diagnosed?"
  - `docs/operations/install-and-admin.md`

- "Which docs describe current implementation versus planning?"
  - Current state: `docs/product/`, `docs/architecture/`, `docs/operations/`, `docs/research/`
  - Planning and history: `docs/roadmap/`, `docs/future/`, `docs/plans/`, `docs/archive/`

- "What does Phase 1 need to ship?"
  - `docs/roadmap/phase-1-delivery.md`

- "What exact app-server methods and fields were verified on March 9, 2026?"
  - `docs/research/app-server-phase-0-verification.md`

- "What is planned for a future V2, and how should engineering evaluate it?"
  - `docs/future/v2-prd.md`
  - `docs/future/v2-engineering-evaluation-template.md`
