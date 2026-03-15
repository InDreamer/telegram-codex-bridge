# Project Documents Guide

Low-token docs router for the bridge. There is no root `README`.
Read the smallest relevant file first.

Truth-source priority for this repo:
1. project runtime and code
2. live Codex API / generated schema
3. repository docs

Practical rule:
- shipped bridge behavior follows the repository first
- Codex protocol shape follows the live CLI/schema first
- docs summarize both and should be corrected when either one disagrees

## Read In This Order

1. `docs/product/v1-scope.md`
   - Product boundary, trust model, and what v1 includes or excludes.

2. `docs/product/chat-and-project-flow.md`
   - Telegram UX, auth flow, project picker, sessions, and user-facing command behavior.

3. `docs/architecture/runtime-and-state.md`
   - App-server model, SQLite state, runtime-card reduction, final-answer delivery, recovery rules, and concurrency limits.

4. `docs/operations/install-and-admin.md`
   - Install paths, env keys, Node floor, `ctb` commands, service ownership, update flow, restart caveats, and diagnostics.

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

- Current bridge behavior docs: `docs/product/`, `docs/architecture/`, `docs/operations/`.
- API/protocol reference docs: `docs/research/`.
- If a current-state doc conflicts with runtime behavior, trust the repository and verify against `package.json`, `src/cli.ts`, `src/config.ts`, `src/install.ts`, `src/paths.ts`, `src/service.ts`, `src/state/store.ts`, `src/telegram/ui.ts`, and `src/codex/app-server.ts`.
- For Codex app-server questions, split them cleanly:
  - bridge adoption and shipped Telegram UX follow repository code first
  - protocol availability and exact request or notification shapes follow the live CLI plus generated schema
- Never treat API availability as proof that the bridge already exposes that surface.
- Planning and non-primary docs: `docs/roadmap/`, `docs/future/`, `docs/plans/`, `docs/archive/`.
- In `docs/future/`, treat `v2-prd.md`, `v3-prd.md`, and `v2-engineering-evaluation*.md` as product/evaluation inputs, not shipped behavior.
- Do not treat roadmap, future, plan, or archive docs as shipped behavior.

## Fast Lookup

- Scope, trust model, out-of-scope
  - `docs/product/v1-scope.md`

- Telegram commands, buttons, auth, `/new`, `/use`, `/pin`, `/inspect`
  - `docs/product/chat-and-project-flow.md`

- Runtime shape, app-server lifecycle, state, recovery, failure modes
  - `docs/architecture/runtime-and-state.md`

- Final-answer rendering, runtime-card vs final-message boundary
  - `docs/architecture/runtime-and-state.md`
  - `docs/product/chat-and-project-flow.md`

- Install, config, env vars, Node version, systemd, `ctb`, update, diagnostics
  - `docs/operations/install-and-admin.md`

- Update, reinstall, and service restart expectations
  - `docs/operations/install-and-admin.md`

- Verified protocol fields, event names, final-answer extraction
  - `docs/research/app-server-phase-0-verification.md`

- Current Codex app-server usage guidance and source priority
  - `docs/research/codex-app-server-authoritative-reference.md`
  - Use this for protocol facts and for the repo-vs-API split, not as a substitute for checking `src/`.

- Per-method Codex app-server API quick reference
  - `docs/research/codex-app-server-api-quick-reference.md`
  - Use this for method lookup after checking whether the bridge actually wires that method today.

- Current bridge app-server adoption versus broader protocol surface
  - `docs/research/codex-app-server-authoritative-reference.md`
  - `docs/research/codex-app-server-api-quick-reference.md`
  - verify implementation against `src/codex/app-server.ts` and `src/service.ts`

- Phase 1 acceptance criteria
  - `docs/roadmap/phase-1-delivery.md`

- V2 product intent and scope
  - `docs/future/v2-prd.md`

- V3 product intent and capability-alignment scope
  - `docs/future/v3-prd.md`

- V2 feasibility and engineering assessment
  - `docs/future/v2-engineering-evaluation.md`

- V2 evaluation response template
  - `docs/future/v2-engineering-evaluation-template.md`

- Future implementation handoffs and rollout sequencing
  - `docs/plans/`
  - Treat these as implementation records, not current behavior.

- V3 engineering design for protocol-capability alignment
  - `docs/plans/2026-03-14-codex-cli-capability-alignment-design.md`

- V3 first implementation plan for interaction broker and blocked-turn recovery
  - `docs/plans/2026-03-14-v3-interaction-broker-phase-1-2-implementation-plan.md`

- Historical drafts
  - `docs/archive/`
