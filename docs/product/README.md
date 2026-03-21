# Product Docs

This directory describes the current intended product behavior of the bridge.

Files:
- `v1-scope.md` — v1 scope, trust model, out-of-scope boundary
- `chat-and-project-flow.md` — lightweight router for the split Telegram UX docs
- `auth-and-project-flow.md` — authorization, project discovery, project picker, session flow, browse
- `codex-command-reference.md` — Codex-backed Telegram commands and structured rich-input flows
- `runtime-and-delivery.md` — runtime hubs/cards, inspect/status/runtime, final-answer delivery, blocked-turn continuation
- `callback-contract.md` — bridge-owned Telegram callback payload families and encoding rules

Read this directory when you need to answer:
- what the bridge is supposed to do for users
- what v1 includes or excludes
- how user-facing Telegram behavior should work

Suggested reading order for Telegram UX work:
1. `chat-and-project-flow.md` if you need the high-level router first
2. then exactly one narrow product doc from the split set above

Do not use this directory alone to prove current code behavior.
If needed, verify implementation in `src/telegram/commands.ts`, `src/telegram/ui-*.ts`, and the narrow owner under `src/service/` such as `session-project-coordinator.ts`, `project-browser-coordinator.ts`, `codex-command-coordinator.ts`, `rich-input-adapter.ts`, or `runtime-surface-controller.ts`.
