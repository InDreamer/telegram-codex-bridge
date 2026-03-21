# Plans Docs

This directory contains implementation plans, design sequencing notes, and handoff records.

Current active repo-wide follow-up tracker:

- `2026-03-18-v5-5-post-v5-slimming-plan.md` - active V5.5 follow-up for docs cleanup, AGENTS routing, install/admin slimming, and UI test redistribution

Recent task-scoped plans whose outcomes are now reflected in current docs and code:

- `2026-03-21-runtime-hub-reuse-refresh-cap-archive-plan.md` - historical plan for latest-hub reuse, immediate accepted-work reanchor, live-hub cap/eviction, and archive/unarchive hub lifecycle
- `2026-03-21-runtime-hub-slot-model-implementation-plan.md` - historical plan for the slot-based runtime-hub redesign, completed-hub retention, and hub-card UI alignment

Recently closed repo-wide slimming tracker:

- `2026-03-18-v5-project-slimming-plan.md` - verified V5 closeout tracker for the main service, UI, and store slimming wave

Examples include:
- design plans
- implementation plans
- documentation architecture plans
- migration or reconciliation plans

Everything else in this directory is implementation history unless the active task explicitly promotes it.
Individual files now carry a top-level truth-status banner; respect it.
Task-scoped plan files often keep their original task framing even after implementation lands, so always cross-check their status blocks against current docs and current code.

Read this directory when you need to answer:
- how a change was planned
- why a sequence or design choice was proposed
- what implementation handoff context exists

These docs are useful engineering context, but they are not automatically current behavior or active product spec.
