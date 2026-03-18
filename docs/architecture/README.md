# Architecture Docs

This directory describes the current intended runtime shape of the bridge.

Files:
- `runtime-and-state.md` — lifecycle, state, recovery, runtime-card behavior, final-answer delivery, concurrency limits
- `current-code-organization.md` — verified current module ownership and where the split runtime, UI, store, and install code actually lives

Read this directory when you need to answer:
- how the bridge is supposed to run internally
- how state and recovery are supposed to work
- how runtime delivery differs from final-answer delivery
- how the current codebase is split after the V5 slimming wave

If you need to confirm actual implementation, verify against the relevant `src/` files.
