# Runtime Status Line V4 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align Telegram runtime status-line semantics with Codex CLI for Codex-owned fields, preserve bridge-specific fields as v4 extensions, and migrate saved preferences safely.

**Architecture:** Update the bridge runtime-field model so Codex CLI fields and bridge extensions share one typed preference list. Compute Codex-owned fields using the same formulas Codex CLI uses, migrate saved preferences lazily in the state layer, and refresh the Telegram runtime picker to show grouped CLI and bridge-extension options.

**Tech Stack:** TypeScript, Node.js, SQLite state store, Telegram UI rendering, Node test runner.

---

### Task 1: Add failing tests for v4 field definitions and migration

**Files:**
- Modify: `src/state/store.test.ts`
- Modify: `src/telegram/ui.test.ts`
- Modify: `src/service.test.ts`

**Step 1: Write the failing tests**

- Add a store test that seeds legacy runtime preference JSON and expects lazy migration to CLI-style ids such as `current-dir`, `model-with-reasoning`, and `session-id`.
- Add a UI test that expects the runtime picker to include CLI-style fields and preserve bridge extension fields.
- Add a service/status-line test that expects CLI token/context semantics instead of the old bridge wording.

**Step 2: Run tests to verify they fail**

Run: `npm test -- src/state/store.test.ts src/telegram/ui.test.ts src/service.test.ts`

Expected: FAIL with assertion mismatches for missing v4 fields or old text.

**Step 3: Commit**

```bash
git add src/state/store.test.ts src/telegram/ui.test.ts src/service.test.ts
git commit -m "test: add failing runtime status line v4 coverage"
```

### Task 2: Update runtime field types and defaults

**Files:**
- Modify: `src/types.ts`

**Step 1: Write the failing type-level or behavior-driven test**

- Use the tests from Task 1 as the failing coverage for the type changes.

**Step 2: Run test to verify it still fails**

Run: `npm test -- src/state/store.test.ts src/telegram/ui.test.ts src/service.test.ts`

Expected: FAIL with missing field ids or labels.

**Step 3: Write minimal implementation**

- Replace the old token/context-oriented field ids with the Codex CLI ids.
- Keep bridge extension ids in the union.
- Change the default status-line field order to the Codex CLI default.

**Step 4: Run test to verify progress**

Run: `npm test -- src/state/store.test.ts src/telegram/ui.test.ts src/service.test.ts`

Expected: Some tests still fail, but type-driven failures move forward.

**Step 5: Commit**

```bash
git add src/types.ts
git commit -m "refactor: define runtime status line v4 fields"
```

### Task 3: Implement lazy preference migration in the state layer

**Files:**
- Modify: `src/state/store.ts`
- Test: `src/state/store.test.ts`

**Step 1: Write the failing test**

- Reuse or refine the migration test so the exact migrated order is asserted.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/state/store.test.ts`

Expected: FAIL because legacy ids are not migrated.

**Step 3: Write minimal implementation**

- Add a migration helper that maps legacy ids to v4 ids.
- Preserve bridge extensions.
- Drop unknown ids.
- Fall back to v4 defaults when migration yields nothing.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/state/store.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/state/store.ts src/state/store.test.ts
git commit -m "feat: migrate runtime status line preferences to v4"
```

### Task 4: Align Telegram runtime picker labels and grouping

**Files:**
- Modify: `src/telegram/ui.ts`
- Test: `src/telegram/ui.test.ts`

**Step 1: Write the failing test**

- Assert that CLI fields appear with CLI-aligned labels and bridge extensions remain available.
- Assert that the rendered message distinguishes CLI and bridge-extension groups.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/telegram/ui.test.ts`

Expected: FAIL because the picker still renders old labels and ungrouped options.

**Step 3: Write minimal implementation**

- Update labels for CLI fields.
- Render grouped sections or clearly separated pages for CLI fields and bridge extensions.
- Keep callback and ordering behavior intact.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/telegram/ui.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/telegram/ui.ts src/telegram/ui.test.ts
git commit -m "feat: render runtime status line v4 picker"
```

### Task 5: Align service-side status-line computations with Codex CLI semantics

**Files:**
- Modify: `src/service.ts`
- Test: `src/service.test.ts`

**Step 1: Write the failing test**

- Add or refine tests for:
  - `context-remaining`
  - `context-used`
  - `used-tokens`
  - `total-input-tokens`
  - `total-output-tokens`
  - omission when CLI-owned values are unavailable

**Step 2: Run test to verify it fails**

Run: `npm test -- src/service.test.ts`

Expected: FAIL because old bridge logic still renders old token/context fields.

**Step 3: Write minimal implementation**

- Port the Codex CLI context estimate formula.
- Render CLI fields with CLI semantics.
- Preserve bridge extension fields unchanged.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/service.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "feat: align runtime status line semantics with codex cli"
```

### Task 6: Run focused verification and document residual gaps

**Files:**
- Modify: `docs/plans/2026-03-17-runtime-status-line-v4-design.md`
- Modify: `docs/plans/2026-03-17-runtime-status-line-v4-plan.md`

**Step 1: Run focused verification**

Run: `npm test -- src/state/store.test.ts src/telegram/ui.test.ts src/service.test.ts`

Expected: PASS

**Step 2: Run one broader verification slice**

Run: `npm test`

Expected: PASS, or capture unrelated failures explicitly.

**Step 3: Document residual gaps if any**

- If fields like `git-branch` or rate-limit windows remain unavailable in bridge runtime snapshots, record that as an intentional omission rather than inventing values.

**Step 4: Commit**

```bash
git add docs/plans/2026-03-17-runtime-status-line-v4-design.md docs/plans/2026-03-17-runtime-status-line-v4-plan.md
git commit -m "docs: record runtime status line v4 design and plan"
```
