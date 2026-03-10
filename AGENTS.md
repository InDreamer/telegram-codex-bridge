# Project Documents Guide

This file is a low-token document index for Codex and other agents.

Read progressively:
- Start with the smallest document that answers the current question.
- Do not load every document by default.
- Use the archive only when reconstructing earlier drafting context.

## Primary Reading Order

1. `docs/product/v1-scope.md`
   - Use this first to understand what the bridge is, what v1 explicitly includes or excludes, the trust model, and the top-level UX rules.
   - This is the quickest way to recover project intent without loading runtime details.

2. `docs/product/chat-and-project-flow.md`
   - Use this when working on Telegram UX, authorization, session selection, project picking, callbacks, or user-facing command behavior.
   - It defines the authorized-user model, project recommendation rules, and Telegram command semantics.

3. `docs/architecture/runtime-and-state.md`
   - Use this when changing the bridge runtime, Codex app-server integration, persistence, concurrency rules, or failure handling.
   - It is the main technical contract for how the service runs.

4. `docs/operations/install-and-admin.md`
   - Use this for installer behavior, local paths, systemd ownership, `ctb` commands, diagnostics, updates, and uninstall behavior.
   - Read this before changing deployment or operator workflows.

5. `docs/roadmap/phase-1-delivery.md`
   - Use this for acceptance criteria, implementation order, and near-term scope checks.
   - Read this when planning work or validating whether a change still fits v1.

6. `docs/research/app-server-phase-0-verification.md`
   - Use this when touching the Codex protocol adapter or verifying event names, payload fields, startup behavior, or final-answer extraction.
   - This is the evidence-backed source of truth for the observed `codex app-server` protocol.

## Future Drafts

- `docs/future/v2-prd.md`
  - Product draft for a possible V2 focused on activity visibility, richer session management, and platform hardening.
  - Read this only when planning future-scope work, not when implementing the current v1 baseline.

- `docs/future/v2-engineering-evaluation-template.md`
  - Template for engineering feasibility review of the V2 PRD.
  - Use this when turning the V2 draft into a scoped engineering assessment.

## Process And History

- `docs/plans/2026-03-10-documentation-information-architecture.md`
  - Process note for the documentation split and AGENTS index design.
  - Read this only when maintaining the documentation system itself.

- `docs/archive/legacy-v1-engineering-plan-draft.md`
  - Historical note for the earlier monolithic draft location.
  - Do not use this as the primary project source unless you need drafting history.

## Fast Lookup

- "What is this product and what is out of scope?"
  - `docs/product/v1-scope.md`

- "How should Telegram commands, buttons, project picking, or auth behave?"
  - `docs/product/chat-and-project-flow.md`

- "How does the bridge talk to Codex, store state, recover, or degrade?"
  - `docs/architecture/runtime-and-state.md`

- "How is the service installed, managed, updated, or diagnosed?"
  - `docs/operations/install-and-admin.md`

- "What does Phase 1 need to ship?"
  - `docs/roadmap/phase-1-delivery.md`

- "What exact app-server methods and fields were verified on March 9, 2026?"
  - `docs/research/app-server-phase-0-verification.md`

- "What is planned for a future V2, and how should engineering evaluate it?"
  - `docs/future/v2-prd.md`
  - `docs/future/v2-engineering-evaluation-template.md`
