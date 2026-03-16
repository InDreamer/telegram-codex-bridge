# telegram-codex-bridge

A VPS-hosted Telegram bridge for controlling the Codex installation that already exists on the server.

- **Telegram** is the control surface
- **Codex** remains the execution engine
- the bridge is **not** a second Codex environment
- the bridge is **not** a second permission system
- the bridge is **not** a provider-management layer

## Current project status

This project is in active development.
Docs and code are both evolving.
There is not yet a single permanent source of truth for every question.

In general:
- current product intent lives under `docs/product/`
- runtime/architecture intent lives under `docs/architecture/`
- install and admin reference lives under `docs/operations/`
- protocol/reference material lives under `docs/research/`
- roadmap/future/plans/archive are not the same as shipped behavior

## Who should read what

### Humans
Start with `docs/README.md`, then jump to the smallest relevant doc.

Common starting points:

- product scope: `docs/product/v1-scope.md`
- Telegram UX / commands / sessions: `docs/product/chat-and-project-flow.md`
- runtime / state / recovery: `docs/architecture/runtime-and-state.md`
- install / admin / diagnostics: `docs/operations/install-and-admin.md`
- Codex app-server protocol/reference: `docs/research/codex-app-server-authoritative-reference.md`

### LLM coding agents
Use `AGENTS.md`.
It is the low-token router for gradual disclosure and narrow verification.

## Runtime and tooling

Package scripts:

```bash
npm run build
npm run dev
npm run check
npm run test
```

CLI entrypoint:

```bash
ctb
```

Node requirement:
- `>=25.0.0`

## Operator/admin surface

Main admin commands:

```bash
ctb install --telegram-token <token> [--codex-bin <bin>]
ctb install-skill
ctb status
ctb doctor
ctb start
ctb stop
ctb restart
ctb update
ctb uninstall [--purge-state]
ctb authorize pending
ctb authorize clear
ctb service run
```

For operational details, caveats, paths, and diagnostics, read:
- `docs/operations/install-and-admin.md`

## Repository layout

```text
src/         implementation
skills/      bundled Codex skills
scripts/     install / helper scripts
docs/        layered docs: current behavior, reference, planning, history
AGENTS.md    agent-facing low-token router
README.md    human-facing overview
```

## Important interpretation rule

When reading this repo, keep these questions separate:

- **What should the bridge do?** -> active product/spec docs
- **What does the bridge do today?** -> repository code/runtime
- **What does Codex support in principle?** -> live Codex API/schema and protocol docs

Do not assume those are always identical during early development.
