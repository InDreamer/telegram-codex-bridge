# Plan Mode Toggle And Runtime Card Implementation Plan

> Truth status:
> - Current truth? No
> - Use for: implementation rationale, sequencing, and handoff history
> - Verify current behavior in: current product/architecture/operations docs and current code


> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a session-level `/plan` toggle, persist plan mode through the session store, pass Codex `collaborationMode` on new turns, surface plan mode in `/where`, and simplify runtime cards so only `Session`, `State`, and `Progress` are fixed while all other fields are optional `/runtime` rows.

**Architecture:** Extend the session model with a persisted plan-mode field, thread that field through app-server `turn/start`, and update Telegram command/UI rendering so `/plan`, `/where`, and runtime-card preferences all reflect the same session-scoped state. Keep plan-mode toggling independent from model and reasoning effort, and keep blocker / plan-expansion / agent-expansion behavior outside runtime preference selection.

**Tech Stack:** TypeScript, Node.js, SQLite-backed session store, Telegram HTML card rendering, Node test runner.

---

### Task 1: Persist session plan mode

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state/store.ts`
- Test: `src/state/store.test.ts`

**Step 1: Write the failing test**

Add store coverage proving sessions default to plan mode off, can toggle on, and persist the value after reopening the database.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/state/store.test.ts`
Expected: FAIL because the session row does not yet expose or persist a plan-mode field.

**Step 3: Write minimal implementation**

Add the new session/runtime type, schema migration, row mapping, create-session default, and setter needed to persist plan mode without affecting model or reasoning effort.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/state/store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/state/store.ts src/state/store.test.ts
git commit -m "feat: persist session plan mode"
```

### Task 2: Add `/plan` command and turn-start wiring

**Files:**
- Modify: `src/telegram/commands.ts`
- Modify: `src/codex/app-server.ts`
- Modify: `src/service.ts`
- Test: `src/service.test.ts`

**Step 1: Write the failing test**

Add service tests proving:

- `/plan` toggles the active session between off and on
- the reply text changes based on the new mode and whether the session is running
- `turn/start` includes `collaborationMode: { mode: "plan" }` only when the session mode is on

**Step 2: Run test to verify it fails**

Run: `npm test -- src/service.test.ts`
Expected: FAIL because `/plan` is not routed and `turn/start` does not include collaboration mode.

**Step 3: Write minimal implementation**

Add the `/plan` command definition, implement a toggle handler in `src/service.ts`, and extend app-server turn-start params so plan mode is sent only for future turns started from a plan-enabled session.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/telegram/commands.ts src/codex/app-server.ts src/service.ts src/service.test.ts
git commit -m "feat: add session plan mode toggle"
```

### Task 3: Surface plan mode in `/where`

**Files:**
- Modify: `src/service.ts`
- Test: `src/service.test.ts`

**Step 1: Write the failing test**

Add `/where` coverage proving the rendered message includes `plan mode:on` and `plan mode:off` based on the session setting.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/service.test.ts`
Expected: FAIL because `/where` does not yet include the new line.

**Step 3: Write minimal implementation**

Render the session’s persisted plan mode in `/where` without inferring from live runtime state.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "feat: show plan mode in where output"
```

### Task 4: Simplify runtime-card fixed layout and add optional `Plan mode`

**Files:**
- Modify: `src/types.ts`
- Modify: `src/telegram/ui.ts`
- Modify: `src/service.ts`
- Modify: `src/state/store.ts`
- Test: `src/telegram/ui.test.ts`
- Test: `src/service.test.ts`
- Test: `src/state/store.test.ts`

**Step 1: Write the failing test**

Add tests proving:

- default runtime preferences contain no optional fields
- runtime preference UI includes a selectable `Plan mode` field
- runtime cards always show only fixed `Session`, `State`, and `Progress`
- optional fields render one per line instead of a `|`-delimited summary
- blocker text remains visible independently of runtime preference choices

**Step 2: Run test to verify it fails**

Run: `npm test -- src/telegram/ui.test.ts src/service.test.ts src/state/store.test.ts`
Expected: FAIL because the old status-line rendering and defaults are still in place.

**Step 3: Write minimal implementation**

Replace the old `statusLine` summary flow with ordered optional field rows, add `plan_mode` to runtime field types/labels/encoding, set the default runtime preference list to empty, and keep blocker/plan/agent sections outside preference control.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/telegram/ui.test.ts src/service.test.ts src/state/store.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts src/telegram/ui.ts src/service.ts src/state/store.ts src/telegram/ui.test.ts src/service.test.ts src/state/store.test.ts
git commit -m "feat: simplify runtime card field selection"
```

### Task 5: Update current-state docs

**Files:**
- Modify: `docs/product/chat-and-project-flow.md`
- Modify: `docs/architecture/runtime-and-state.md`

**Step 1: Write the documentation diff**

Update current-state docs so they describe `/plan`, `/where` plan-mode visibility, and the new `/runtime` behavior.

**Step 2: Verify docs against code**

Run targeted searches to confirm wording matches the shipped command names and runtime-card behavior.

Run: `rg -n "/plan|plan mode|Runtime Status|/runtime|/where" docs/product/chat-and-project-flow.md docs/architecture/runtime-and-state.md src/service.ts src/telegram/ui.ts`
Expected: matching current behavior without stale `status line` wording.

**Step 3: Commit**

```bash
git add docs/product/chat-and-project-flow.md docs/architecture/runtime-and-state.md
git commit -m "docs: document session plan mode and runtime fields"
```

### Task 6: Final verification

**Files:**
- Modify: none

**Step 1: Run focused test suite**

Run: `npm test -- src/state/store.test.ts src/service.test.ts src/telegram/ui.test.ts`
Expected: PASS

**Step 2: Run any additional targeted checks needed after failures**

If the focused suite uncovers regressions, fix them with the same red-green cycle before continuing.

**Step 3: Summarize residual risk**

Call out any untested areas such as manual Telegram interaction smoke tests if they were not executed locally.
