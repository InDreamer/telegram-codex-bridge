# Project Picker Single-Instance Implementation Plan

> Truth status:
> - Current truth? No
> - Use for: implementation rationale, sequencing, and handoff history
> - Verify current behavior in: current product/architecture/operations docs and current code


> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `/new` and every project-picker return path recreate a fresh picker message so users always regain a visible session-creation entry point.

**Architecture:** Move project-picker lifecycle management in `SessionProjectCoordinator` from edit-in-place semantics to delete-old-then-send-new semantics. Keep picker validity anchored to the newest tracked picker message id, and update product docs plus regression tests so the behavior is explicit and stable.

**Tech Stack:** TypeScript, Node test runner, Telegram bridge coordinator/state helpers, Markdown product docs

---

### Task 1: Update the product spec for picker lifecycle

**Files:**
- Modify: `docs/product/chat-and-project-flow.md`
- Reference: `docs/plans/2026-03-20-project-picker-single-instance-design.md`

**Step 1: Write the failing doc expectation**

Document the intended changes before touching runtime code:
- `/new` recreates a fresh picker message
- returning to the picker recreates a fresh picker message
- only one picker is valid at a time

**Step 2: Verify the current doc text is outdated**

Run: `rg -n "update the current project-picker surface in place|replace the current picker surface" docs/product/chat-and-project-flow.md`

Expected: matches for stale in-place wording

**Step 3: Update the doc text**

Edit the `/new`, `扫描本地项目`, and `手动输入路径` sections so they describe the single-instance lifecycle instead of in-place picker reuse.

**Step 4: Verify the doc text**

Run: `sed -n '140,210p' docs/product/chat-and-project-flow.md`

Expected: the updated sections mention recreating a fresh picker and keeping one valid picker

**Step 5: Commit**

```bash
git add docs/product/chat-and-project-flow.md docs/plans/2026-03-20-project-picker-single-instance-design.md
git commit -m "docs: define single-instance project picker lifecycle"
```

### Task 2: Add coordinator tests for fresh picker recreation

**Files:**
- Modify: `src/service/session-project-coordinator.test.ts`
- Reference: `src/service/session-project-coordinator.ts`

**Step 1: Write the failing tests**

Add focused tests for:
- `handleNew` deletes the previously tracked picker and sends a fresh picker
- `returnToProjectPicker` deletes the current picker and sends a fresh picker
- stale picker message ids are rejected after a newer picker is sent

Prefer explicit captured arrays for:
- deleted message ids
- sent message ids/text
- picker state `interactiveMessageId`

**Step 2: Run the targeted tests to verify they fail**

Run: `npm test -- src/service/session-project-coordinator.test.ts`

Expected: FAIL because the coordinator still treats picker refresh as edit/reuse

**Step 3: Write the minimal test helpers**

If needed, extend the existing coordinator test harness to record:
- `safeSendMessageResult` calls
- `safeDeleteMessage` calls
- `safeEditMessageText` calls that should stop being used for picker recreation

Keep the helper changes local to the test file.

**Step 4: Re-run the targeted tests**

Run: `npm test -- src/service/session-project-coordinator.test.ts`

Expected: still FAIL, but now clearly on the intended lifecycle assertions

**Step 5: Commit**

```bash
git add src/service/session-project-coordinator.test.ts
git commit -m "test: cover fresh project picker recreation"
```

### Task 3: Change coordinator picker lifecycle to delete-old-then-send-new

**Files:**
- Modify: `src/service/session-project-coordinator.ts`
- Reference: `src/service/runtime-surface-state.ts`

**Step 1: Identify the lifecycle entry points**

Confirm every picker-show path that must use the new policy:
- `showProjectPicker`
- scan refresh paths that render picker/no-results surfaces
- `returnToProjectPicker`

Run: `rg -n "replaceInteractivePickerMessage|sendNewestInteractivePickerMessage|showProjectPicker|returnToProjectPicker|handleScanMore" src/service/session-project-coordinator.ts`

Expected: all picker-render entry points are visible

**Step 2: Implement the minimal lifecycle change**

Refactor picker rendering so project-picker recreation:
- no longer relies on edit-in-place success
- deletes the previous tracked picker when present
- sends a fresh message
- records the new `interactiveMessageId`

Keep the change scoped to project-picker surfaces only. Do not alter unrelated bridge-owned surfaces.

**Step 3: Preserve stale-button protection**

Ensure `requireActivePickerState` and callback handling still reject earlier picker message ids once a new picker has been issued.

**Step 4: Run the coordinator tests**

Run: `npm test -- src/service/session-project-coordinator.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/service/session-project-coordinator.ts src/service/session-project-coordinator.test.ts
git commit -m "fix: recreate project picker as a fresh message"
```

### Task 4: Add service-level regression coverage for `/new` and scan/manual flows

**Files:**
- Modify: `src/service.test.ts`
- Reference: `src/service/session-project-coordinator.ts`

**Step 1: Write the failing service regressions**

Add or extend service-level tests for:
- repeated `/new` deletes the old picker and sends a new picker
- scan refresh deletes the old picker and sends a new picker/no-results surface
- returning from manual-path mode sends a fresh picker instead of reusing an old one

Use the existing fake Telegram API capture arrays for `sent`, `deleted`, and callback payloads.

**Step 2: Run the targeted service tests to verify they fail**

Run: `npm test -- src/service.test.ts`

Expected: at least the new repeated-`/new` or picker-refresh assertions FAIL against old behavior

**Step 3: Make only minimal test fixture adjustments**

If existing fake APIs assume edit-in-place, update them only enough to represent the new picker lifecycle.

**Step 4: Re-run the targeted service tests**

Run: `npm test -- src/service.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/service.test.ts
git commit -m "test: cover single-instance project picker flows"
```

### Task 5: Run focused verification and summarize residual risk

**Files:**
- Modify: none unless a discovered test break requires a minimal fix

**Step 1: Run focused verification**

Run: `npm test -- src/service/session-project-coordinator.test.ts src/service.test.ts`

Expected: PASS

**Step 2: Run the broader project check if it is fast enough**

Run: `npm run test`

Expected: PASS, or a clear list of unrelated pre-existing failures

**Step 3: Inspect diff for scope control**

Run: `git diff -- docs/product/chat-and-project-flow.md src/service/session-project-coordinator.ts src/service/session-project-coordinator.test.ts src/service.test.ts`

Expected: only picker lifecycle, docs, and regression-test changes

**Step 4: Write completion notes**

Capture:
- what changed
- how repeated `/new` now behaves
- any remaining known edge cases such as Telegram delete failure without confirmation

**Step 5: Commit**

```bash
git add docs/product/chat-and-project-flow.md src/service/session-project-coordinator.ts src/service/session-project-coordinator.test.ts src/service.test.ts
git commit -m "fix: enforce single-instance project picker lifecycle"
```
