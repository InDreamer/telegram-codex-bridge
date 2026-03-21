# docs/AGENTS.md

Documentation router for `telegram-codex-bridge`.

Use this file only after the root `AGENTS.md` has already decided that the task is doc-first.
This file should end in a **leaf document**, not another agent layer.

## Three-Tier Doc Model

### Tier 1 — Current truth

Use this tier by default for current behavior.

- `docs/product/`
- `docs/architecture/`
- `docs/operations/`
- `docs/generated/current-snapshot.md` for high-drift facts only

This tier answers questions like:

- what the bridge is supposed to do now
- what v1 includes or excludes
- how runtime, state, recovery, and delivery are intended to work
- how operators install, run, diagnose, and update the bridge

### Tier 2 — Protocol evidence

Use this tier only when the question is about what Codex app-server supports in principle or what exact request/notification shapes look like.

- `docs/research/codex-app-server-authoritative-reference.md`
- `docs/research/codex-app-server-api-quick-reference.md`
- `docs/research/app-server-phase-0-verification.md`

Protocol evidence is **not** the same thing as shipped Telegram UX.

### Tier 3 — Planning and history

Use this tier only for future direction, implementation sequencing, or conflict reconstruction.

- `docs/roadmap/`
- `docs/future/`
- `docs/plans/`
- `docs/archive/`

This tier is context, not default truth.

## First-File Router

Read the smallest matching leaf doc.

| Need | Read |
|---|---|
| v1 scope, trust model, out-of-scope boundary | `docs/product/v1-scope.md` |
| high-level product router before choosing a narrow Telegram doc | `docs/product/chat-and-project-flow.md` |
| authorization, project discovery, project picker, `/browse`, session switching, archive, unarchive, rename, pin | `docs/product/auth-and-project-flow.md` |
| Codex-backed Telegram commands, structured inputs, `/model`, `/skills`, `/plugins`, `/apps`, `/mcp`, `/account`, `/review`, `/fork`, `/rollback`, `/compact`, `/thread`, `/local_image`, `/mention` | `docs/product/codex-command-reference.md` |
| `/where`, `/inspect`, `/interrupt`, `/status`, runtime hubs/cards, blocked-turn continuation, final-answer delivery | `docs/product/runtime-and-delivery.md` |
| Telegram callback payload families, encoding rules, stale callback handling | `docs/product/callback-contract.md` |
| runtime lifecycle, SQLite state, recovery, concurrency, degraded behavior | `docs/architecture/runtime-and-state.md` |
| code-derived ownership map for `src/` | `docs/architecture/current-code-organization.md` |
| install flow, config keys, paths, services, update, diagnostics | `docs/operations/install-and-admin.md` |
| exact current versions, module counts, size snapshot, other high-drift facts | `docs/generated/current-snapshot.md` |
| authoritative Codex app-server protocol reference | `docs/research/codex-app-server-authoritative-reference.md` |
| method-by-method protocol lookup | `docs/research/codex-app-server-api-quick-reference.md` |
| earlier protocol verification details | `docs/research/app-server-phase-0-verification.md` |
| roadmap or future-phase intent | the smallest relevant file under `docs/roadmap/` or `docs/future/` |
| active implementation planning or handoff context | the smallest relevant file under `docs/plans/` |
| historical reconstruction only | the smallest relevant file under `docs/archive/` |

## Tier Switching Rules

Stay in **Tier 1** unless one of these is true:

- the question is explicitly about Codex protocol capability
- you need an exact protocol payload or method name
- the task is explicitly about roadmap, future work, or historical reasoning
- Tier 1 and code disagree and you need historical or planning context to explain why

## Verification Rules

When a current-behavior answer needs implementation confirmation:

- verify in `src/` using `src/AGENTS.md`
- prefer the narrow owner file instead of opening broad orchestrators first

Typical examples:

- product doc -> `src/telegram/commands.ts` for registry truth
- runtime doc -> `src/service/runtime-surface-controller.ts` or `src/telegram/ui-runtime.ts`
- session/project doc -> `src/service/session-project-coordinator.ts` or `src/service/project-browser-coordinator.ts`
- operations doc -> `src/install.ts`, `src/readiness.ts`, `src/config.ts`, or `src/paths.ts`

## Human vs Agent Entry Points

For humans:

- `docs/README.md` is the readable map of the doc system
- directory `README.md` files under `docs/product/`, `docs/architecture/`, `docs/operations/`, and `docs/research/` are local maps

For agents:

- prefer this file over `docs/README.md`
- go straight from this router to one leaf doc

## Stop Rule

Stop after one leaf doc unless the task shows a real need for:

- one verifying source file in `src/`
- one protocol doc in Tier 2
- one planning/history doc in Tier 3

Do not read the entire docs tree.
