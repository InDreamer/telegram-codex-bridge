# Final Answer Telegram Format Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Render final Codex answers in Telegram with safe formatted output instead of raw plain text.

**Architecture:** Keep runtime cards as plain text, but add a dedicated final-answer formatter that converts a safe subset of Markdown into Telegram HTML. Chunk rendered output on block boundaries so formatting is not broken across Telegram messages.

**Tech Stack:** Node.js, TypeScript, Telegram Bot API, existing bridge service and UI helpers.

---

### Task 1: Lock expected final-answer delivery behavior with tests

**Files:**
- Modify: `src/service.test.ts`
- Test: `src/service.test.ts`

**Step 1: Write the failing test**

- Add a test that completes a turn with a Markdown-rich final answer.
- Assert the final-answer message is sent with `parseMode: "HTML"`.
- Assert bold text, inline code, fenced code blocks, list items, and links are rendered into Telegram-safe HTML.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/service.test.ts`
Expected: FAIL because final answers are currently sent as plain text with no parse mode.

**Step 3: Add a chunking regression test**

- Add a test for a long final answer containing multiple Markdown blocks.
- Assert the formatter splits at safe boundaries and later chunks keep valid HTML instead of broken tags or partial code fences.

**Step 4: Run test to verify it fails**

Run: `npm test -- src/service.test.ts`
Expected: FAIL because current chunking is character-only and unaware of formatted blocks.

### Task 2: Implement final-answer formatting and chunk-safe delivery

**Files:**
- Modify: `src/service.ts`
- Modify: `src/telegram/api.ts`
- Modify: `src/telegram/ui.ts`

**Step 1: Add a final-answer renderer**

- Add a helper that:
  - escapes unsafe HTML
  - converts a safe subset of Markdown into Telegram HTML
  - preserves fenced code blocks, inline code, bold text, links, and simple list lines

**Step 2: Add block-aware chunking**

- Split formatted output into safe Telegram-sized chunks without cutting inside HTML tags or code blocks.
- Prefix continuation chunks with `(2/N)` markers as current product behavior requires.

**Step 3: Wire the renderer into final-answer sending**

- Extend Telegram API typings to allow HTML parse mode on final-answer sends.
- Update `sendFinalAnswer()` to send rendered HTML chunks with `parseMode: "HTML"`.

**Step 4: Run targeted tests to verify they pass**

Run: `npm test -- src/service.test.ts`
Expected: PASS

### Task 3: Verify no regressions in adjacent UI helpers

**Files:**
- Test: `src/telegram/ui.test.ts`

**Step 1: Run focused UI/service verification**

Run: `npm test -- src/service.test.ts src/telegram/ui.test.ts`
Expected: PASS

**Step 2: Run full project verification**

Run: `npm test`
Expected: PASS
