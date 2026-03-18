# Codex App-Server Authoritative Reference Design

**Date:** 2026-03-12

**Goal**

Create one LLM-first authoritative reference for Codex app-server usage in this repository so future implementation work prefers current local CLI facts over stale memory.

**Audience**

- Primary: in-repo Codex/LLM agents
- Secondary: human maintainers who need a quick orientation

**Problem**

The repository currently has:
- project runtime guidance in `docs/architecture/runtime-and-state.md`
- one historical protocol verification sample in `docs/research/app-server-phase-0-verification.md`

That is enough for the current bridge implementation, but not enough to safely guide future LLM-driven development across the broader Codex app-server surface. The existing verification document is also tied to an older runtime sample (`codex-cli 0.112.0`) and should not silently outrank the current host runtime.

**Chosen Approach**

Create a new current-state research document in `docs/research/` that combines:
- latest local CLI evidence from the current host
- generated schema inventory from the current CLI
- official OpenAI app-server and CLI reference links
- repository-specific integration rules and anti-patterns

Update `AGENTS.md` so LLMs discover this document before the historical phase-0 sample when they need Codex app-server or API guidance.

**Why This Approach**

- One canonical document minimizes LLM path divergence.
- Local CLI and generated schema are the strongest truth source for exact methods, notifications, and request families.
- Official prose docs remain valuable for intent, stability notes, and transport guidance.
- Historical runtime verification remains useful, but only as a dated sample.

**Source Hierarchy**

1. Current local `codex-cli` version on the host
2. Schema generated from that exact CLI version
3. Official OpenAI Codex app-server and CLI docs
4. Repository code and current-state docs
5. Historical verification samples and planning docs

**Document Structure**

The new reference should include:
- how to use the document
- truth-source ordering and drift rules
- when to use app-server versus `codex exec` or SDK paths
- startup, handshake, thread, turn, interrupt, and answer extraction guidance
- grouped API inventory from the generated schema
- server notification inventory
- server-request and approval inventory
- repository-specific rules for this bridge
- refresh workflow for future LLMs

**AGENTS Impact**

`AGENTS.md` should:
- add the new document to the primary reading order near the existing app-server verification doc
- route questions about app-server usage, API surface, and source priority to the new document first
- keep the historical phase-0 verification doc clearly labeled as evidence-backed but version-dated

**Out Of Scope**

- changing the bridge transport or runtime behavior
- generating checked-in machine-readable schema snapshots
- rewriting future/planning documents to match current state
- exhaustive per-field restatement of every schema object inline

**Verification Plan**

Before claiming completion:
- verify new files exist
- verify `AGENTS.md` references the new document
- verify the reference explicitly states the current local CLI version
- verify the source hierarchy is present and readable
