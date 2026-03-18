# Codex App-Server Authoritative Reference Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add one LLM-first authoritative Codex app-server reference and route repository agents to it before older or narrower docs.

**Architecture:** The work is documentation-only. A new current-state research document will combine local CLI 0.114.0 evidence, generated schema inventory, official OpenAI references, and repository-specific integration rules. `AGENTS.md` will be updated so LLMs discover this document first for app-server/API questions.

**Tech Stack:** Markdown, local Codex CLI, generated JSON Schema, repository docs

---

### Task 1: Capture the documentation contract

**Files:**
- Create: `docs/plans/2026-03-12-codex-app-server-authoritative-reference-design.md`
- Create: `docs/plans/2026-03-12-codex-app-server-authoritative-reference-plan.md`

**Step 1: Write the design document**

Write the approved design with source hierarchy, audience, structure, and AGENTS impact.

**Step 2: Verify the design document exists**

Run: `test -f docs/plans/2026-03-12-codex-app-server-authoritative-reference-design.md`
Expected: exit code `0`

**Step 3: Write the implementation plan**

Document the execution tasks below for future handoff.

**Step 4: Verify the plan exists**

Run: `test -f docs/plans/2026-03-12-codex-app-server-authoritative-reference-plan.md`
Expected: exit code `0`

### Task 2: Author the authoritative research document

**Files:**
- Create: `docs/research/codex-app-server-authoritative-reference.md`
- Reference: `docs/architecture/runtime-and-state.md`
- Reference: `docs/research/app-server-phase-0-verification.md`

**Step 1: Write the document skeleton**

Add sections for source priority, official links, repo integration rules, API inventory, approval/server-request handling, and refresh workflow.

**Step 2: Fill in local evidence**

Use the current host runtime facts:
- `codex-cli 0.114.0`
- `codex app-server --help`
- generated JSON Schema inventory from the current CLI

**Step 3: Fill in official guidance**

Use official OpenAI Codex app-server and CLI docs for:
- transport guidance
- intended use cases
- schema-generation guidance
- experimental/stability framing

**Step 4: Verify the document states the source hierarchy**

Run: `rg -n "Source Priority|0.114.0|app-server|model/list|turn/start|requestApproval" docs/research/codex-app-server-authoritative-reference.md`
Expected: matches for the hierarchy, current version, and representative API surface

### Task 3: Update AGENTS discoverability

**Files:**
- Modify: `AGENTS.md`

**Step 1: Update primary reading order**

Insert the new authoritative reference ahead of the older historical verification sample for app-server/API work.

**Step 2: Update fast lookup**

Add lookup entries for:
- how to use Codex app-server correctly
- where to find the broader API inventory
- which source outranks older verification notes

**Step 3: Verify AGENTS references the new document**

Run: `rg -n "codex-app-server-authoritative-reference" AGENTS.md`
Expected: at least one match in reading order and one match in fast lookup

### Task 4: Verify documentation output

**Files:**
- Verify: `docs/research/codex-app-server-authoritative-reference.md`
- Verify: `AGENTS.md`

**Step 1: Verify file presence**

Run: `test -f docs/research/codex-app-server-authoritative-reference.md && test -f AGENTS.md`
Expected: exit code `0`

**Step 2: Verify the new document is linked from AGENTS**

Run: `rg -n "codex-app-server-authoritative-reference" AGENTS.md docs/research/codex-app-server-authoritative-reference.md`
Expected: matches in both files

**Step 3: Review the changed diff**

Run: `git diff -- docs/research/codex-app-server-authoritative-reference.md AGENTS.md docs/plans/2026-03-12-codex-app-server-authoritative-reference-design.md docs/plans/2026-03-12-codex-app-server-authoritative-reference-plan.md`
Expected: only the intended documentation additions and edits
