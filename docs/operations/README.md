# Operations Docs

This directory describes the operator/admin surface of the bridge.

Files:
- `install-and-admin.md` — install flow, config keys, paths, services, voice-input backends, update/restart behavior, diagnostics

Read this directory when you need to answer:
- how to install or run the bridge
- what `ctb` commands exist
- where config/state/log files live
- how to diagnose or repair the service

This is operational reference, not product UX specification.
If needed, verify implementation in `src/install.ts`, `src/readiness.ts`, `src/service.ts`, `src/config.ts`, and `src/paths.ts`.
