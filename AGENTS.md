# Project Documents Guide

Low-token docs router. There is no root `README`.
Read the smallest relevant file first.

## Read In This Order

1. `docs/product/v1-scope.md`
   - Product boundary, trust model, and what v1 includes or excludes.

2. `docs/product/chat-and-project-flow.md`
   - Telegram UX, auth flow, project picker, sessions, and user-facing command behavior.

3. `docs/architecture/runtime-and-state.md`
   - App-server model, SQLite state, recovery rules, and concurrency limits.

4. `docs/operations/install-and-admin.md`
   - Install paths, env keys, Node floor, `ctb` commands, systemd, update flow, and diagnostics.

5. `docs/research/codex-app-server-authoritative-reference.md`
   - Use this first for current Codex app-server usage guidance, source priority, API inventory, and refresh workflow.
   - This is the LLM-first app-server reference and should outrank older runtime samples when they disagree.

6. `docs/research/codex-app-server-api-quick-reference.md`
   - Use this for per-method app-server lookup, schema file names, required params, and approval/notification gotchas.
   - Read this after the authoritative reference when implementation needs exact API guidance.

7. `docs/research/app-server-phase-0-verification.md`
   - Verified protocol facts, event names, and final-answer extraction details.
   - Treat this as dated runtime verification rather than the top source for the latest CLI surface.

8. `docs/roadmap/phase-1-delivery.md`
   - Use this for acceptance criteria and delivery sequencing.
   - Treat it as roadmap intent, not proof that a behavior is already shipped.

## Current Truth vs Planning

- Current-state docs: `docs/product/`, `docs/architecture/`, `docs/operations/`, `docs/research/`.
- If a current-state doc conflicts with runtime behavior, verify against `package.json`, `src/cli.ts`, `src/config.ts`, `src/paths.ts`, `src/service.ts`, and `src/state/store.ts`.
- Planning and non-primary docs: `docs/roadmap/`, `docs/future/`, `docs/plans/`, `docs/archive/`.
- In `docs/future/`, treat `v2-prd.md` and `v2-engineering-evaluation*.md` as product/evaluation inputs, not shipped behavior.
- Do not treat roadmap, future, plan, or archive docs as shipped behavior.

## Fast Lookup

- Scope, trust model, out-of-scope
  - `docs/product/v1-scope.md`

- Telegram commands, buttons, auth, `/new`, `/use`, `/pin`, `/inspect`
  - `docs/product/chat-and-project-flow.md`

- Runtime shape, app-server lifecycle, state, recovery, failure modes
  - `docs/architecture/runtime-and-state.md`

- Install, config, env vars, Node version, systemd, `ctb`, update, diagnostics
  - `docs/operations/install-and-admin.md`

- Verified protocol fields, event names, final-answer extraction
  - `docs/research/app-server-phase-0-verification.md`

- Current Codex app-server usage guidance and source priority
  - `docs/research/codex-app-server-authoritative-reference.md`

- Per-method Codex app-server API quick reference
  - `docs/research/codex-app-server-api-quick-reference.md`

- Phase 1 acceptance criteria
  - `docs/roadmap/phase-1-delivery.md`

- V2 product intent and scope
  - `docs/future/v2-prd.md`

- V2 feasibility and engineering assessment
  - `docs/future/v2-engineering-evaluation.md`

- V2 evaluation response template
  - `docs/future/v2-engineering-evaluation-template.md`

- Future implementation handoffs and rollout sequencing
  - `docs/plans/`

- Historical drafts
  - `docs/archive/`
