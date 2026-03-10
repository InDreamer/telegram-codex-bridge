# Documentation Information Architecture Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the monolithic planning document into a small set of durable project documents and add a low-token `AGENTS.md` index for progressive discovery.

**Architecture:** Keep product intent, runtime design, operations, roadmap, and protocol evidence in separate documents with clear boundaries. Preserve earlier drafting context in an archive note instead of leaving duplicate active plan files in conflicting locations.

**Tech Stack:** Markdown, Git, repository-local documentation only.

---

### Task 1: Define The Stable Document Layers

**Files:**
- Create: `AGENTS.md`
- Create: `docs/product/v1-scope.md`
- Create: `docs/product/chat-and-project-flow.md`
- Create: `docs/architecture/runtime-and-state.md`
- Create: `docs/operations/install-and-admin.md`
- Create: `docs/roadmap/phase-1-delivery.md`
- Create: `docs/research/app-server-phase-0-verification.md`

**Step 1: Identify the natural document boundaries**

Use the earlier monolithic draft to group sections by:
- product scope and trust model
- user-facing Telegram and project-selection behavior
- runtime and persistence design
- installation and admin operations
- roadmap and acceptance
- protocol verification evidence

**Step 2: Write each durable document with minimal overlap**

For each document:
- keep it focused on one concern
- avoid copying operational details into product docs
- avoid copying user-flow details into runtime docs
- keep headings direct and skimmable

**Step 3: Create `AGENTS.md` as the low-token entry point**

`AGENTS.md` should:
- explain that it is a progressive-disclosure index
- list the documents in recommended reading order
- say when to read each one
- include a fast lookup section for common maintenance questions

### Task 2: Preserve Process Context Without Leaving Duplicate Active Docs

**Files:**
- Create: `docs/archive/legacy-v1-engineering-plan-draft.md`
- Delete: `docs/plan/telegram-codex-bridge-plan-draft.md`
- Delete: `docs/plans/telegram-codex-bridge-plan-draft.md`

**Step 1: Replace conflicting active draft locations**

Remove the duplicate plan-draft files so the repository no longer presents two equally plausible entry points.

**Step 2: Keep a lightweight archive note**

Add a short archive note that explains:
- a monolithic draft used to exist
- the durable source of truth is now the split docs
- the archive is for historical reconstruction only

### Task 3: Verify The New Discovery Surface

**Files:**
- Verify: `AGENTS.md`
- Verify: all new `docs/**` files

**Step 1: Run document discovery checks**

Run:
- `find docs -maxdepth 3 -type f | sort`
- `git diff --stat`

Expected:
- the new document tree exists
- no duplicate active plan-draft remains

**Step 2: Run link and status checks**

Run:
- `rg -n "docs/" AGENTS.md`
- `git status --short`

Expected:
- every path referenced by `AGENTS.md` exists
- git status reflects the intended adds, deletes, and edits
