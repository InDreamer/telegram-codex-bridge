# Product Docs

This directory describes the current intended product behavior of the bridge.

Files:
- `v1-scope.md` — v1 scope, trust model, out-of-scope boundary
- `chat-and-project-flow.md` — Telegram UX, commands, auth, project/session flow

Read this directory when you need to answer:
- what the bridge is supposed to do for users
- what v1 includes or excludes
- how user-facing Telegram behavior should work

Do not use this directory alone to prove current code behavior.
If needed, verify implementation in `src/telegram/` and related runtime code.
