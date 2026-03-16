# Research Docs

This directory contains protocol evidence and reference material.

Files:
- `codex-app-server-authoritative-reference.md` — primary app-server protocol/reference guide
- `codex-app-server-api-quick-reference.md` — method-by-method quick lookup
- `app-server-phase-0-verification.md` — earlier verification findings

Read this directory when you need to answer:
- what Codex app-server supports
- exact method or notification shapes
- what earlier protocol verification established

Do not assume protocol capability means the bridge already exposes that capability in Telegram.
Verify actual bridge adoption in `src/codex/app-server.ts` and related code.
