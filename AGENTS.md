# Project Documents Guide

This file is a low-token document index for Codex and other agents.
Read the smallest relevant document first.

Read progressively:
- Treat `docs/product/`, `docs/architecture/`, `docs/operations/`, and `docs/research/` as the current-state set derived from code, config, and verified runtime behavior.
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

5. `docs/research/codex-app-server-authoritative-reference.md`
   - Use this first for current Codex app-server usage guidance, source priority, API inventory, and refresh workflow.
   - This is the LLM-first app-server reference and should outrank older runtime samples when they disagree.

6. `docs/research/codex-app-server-api-quick-reference.md`
   - Use this for per-method app-server lookup, schema file names, required params, and approval/notification gotchas.
   - Read this after the authoritative reference when implementation needs exact API guidance.

7. `docs/research/app-server-phase-0-verification.md`
   - Use this when touching the Codex protocol adapter or checking the dated March 9, 2026 runtime sample.
   - This is evidence-backed historical verification, not the top source for the latest CLI surface.

8. `docs/roadmap/phase-1-delivery.md`
   - Use this for acceptance criteria and delivery sequencing.
   - Treat it as roadmap intent, not proof that a behavior is already shipped.

## Future And Plans

- `docs/future/v2-prd.md`
  - Future product draft for activity visibility, richer session management, and platform hardening.
  - Do not treat it as current behavior.

- `docs/future/v2-engineering-evaluation.md`
  - Completed engineering evaluation for the V2 PRD, including feasibility, cut line, and recommended sequencing.
  - Read this before starting or re-scoping V2 implementation work.

- `docs/future/v2-engineering-evaluation-template.md`
  - Template for evaluating the V2 PRD.
  - Use it only for future-scope engineering review.

- `docs/plans/2026-03-10-v2-implementation-plan.md`
  - Execution-oriented V2 rollout plan with phase ordering and cut-line guidance.
  - Use this when coordinating V2 work; it is a plan, not proof that work is shipped.

- `docs/plans/2026-03-10-v2-2a-detailed-design.md`
  - Detailed implementation handoff for V2 Phase 2A structured activity visibility.
  - Read this when building or reviewing 2A-specific changes.

- `docs/plans/2026-03-10-documentation-information-architecture.md`
  - Process note for the docs split and AGENTS index design.
  - Read this only when maintaining the documentation system itself.

## History

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

- "What exact app-server methods and fields were verified on March 9, 2026?"
  - `docs/research/app-server-phase-0-verification.md`

- "How should LLMs use Codex app-server correctly and avoid stale knowledge?"
  - `docs/research/codex-app-server-authoritative-reference.md`

- "Where is the broader current Codex app-server API inventory?"
  - `docs/research/codex-app-server-authoritative-reference.md`

- "Where is the per-method Codex app-server API quick reference?"
  - `docs/research/codex-app-server-api-quick-reference.md`

- "Which source outranks older app-server verification notes?"
  - `docs/research/codex-app-server-authoritative-reference.md`

- "Which docs describe current implementation versus planning?"
  - Current state: `docs/product/`, `docs/architecture/`, `docs/operations/`, `docs/research/`
  - Planning and history: `docs/roadmap/`, `docs/future/`, `docs/plans/`, `docs/archive/`

- "What does Phase 1 need to ship?"
  - `docs/roadmap/phase-1-delivery.md`

- "What is planned for a future V2?"
  - `docs/future/v2-prd.md`

- "What is the current evaluated engineering recommendation for V2?"
  - `docs/future/v2-engineering-evaluation.md`

- "How should engineering evaluate the V2 PRD from scratch?"
  - `docs/future/v2-engineering-evaluation-template.md`

- "What should V2 implementation build next, and in what order?"
  - `docs/plans/2026-03-10-v2-implementation-plan.md`

- "What exactly should Phase 2A implement?"
  - `docs/plans/2026-03-10-v2-2a-detailed-design.md`
