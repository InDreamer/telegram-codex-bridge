# Review Final Answer Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ensure `/review` always delivers the actual review result to Telegram instead of the fallback "no final answer" message.

**Architecture:** The fix should stop assuming that the `review/start` turn id is the same turn id that later holds the durable review result in `thread/resume` history. We should persist or derive the effective result-bearing turn, then recover terminal text from that exact turn while keeping the existing non-review final-answer path unchanged.

**Tech Stack:** TypeScript, Node.js, Codex app-server JSON-RPC, SQLite-backed bridge state, Node test runner

---

## Investigation Summary

Observed runtime behavior on 2026-03-21:

- Bridge sends `/review` through `review/start` and tracks `result.turn.id` as the active turn id.
- The live notification stream for a failed Telegram delivery case recorded:
  - an outer review turn id: `019d0fe8-dc95-7b10-91c6-e462e5f731d7`
  - a separate inner turn id started by the app-server: `019d0fe8-e2bd-73a3-886a-2a2c7444045b`
  - the review result text attached to the inner turn in `thread/resume`
- `thread/resume` did not contain the outer turn id at all, so history lookup by the stored active turn id returned no target turn.
- Bridge therefore logged `hasFinalMessage=false` and sent the fallback terminal message.

This means the current fix in `src/service/turn-artifacts.ts` improved extraction within a located turn, but it did not solve the more important problem: `/review` can finish on a different durable turn id than the one passed back from `review/start`.

## Task 1: Add a failing regression for review outer-turn versus durable-turn mismatch

**Files:**
- Modify: `src/service/turn-coordinator.test.ts`

**Step 1: Write the failing test**

Add a test where:
- `beginActiveTurn()` starts with the outer review turn id returned by `review/start`
- `resumeThread()` returns durable history containing only the inner turn id
- the inner turn contains `exitedReviewMode.review` and trailing `agentMessage`
- `turn/completed` arrives for the outer turn id

Expected result:
- Telegram receives the review text
- Telegram does not receive the fallback "本次操作已完成，但没有可返回的最终答复。"

**Step 2: Run the test to verify it fails**

Run:

```bash
node --import tsx --test src/service/turn-coordinator.test.ts --test-name-pattern "review outer turn"
```

Expected:
- FAIL because current logic looks up the outer turn id in resumed history and finds nothing

## Task 2: Decide the authoritative review-result locator

**Files:**
- Modify: `src/service/turn-coordinator.ts`
- Modify: `src/service/turn-artifacts.ts`
- Reference: `src/codex/app-server.ts`

**Step 1: Prefer a durable locator strategy**

Implement one narrow strategy:

1. Continue using the active turn id for normal turns.
2. For review-mode completions, if history lookup by active turn id misses:
   - scan the resumed thread tail for the most recent completed turn that contains `exitedReviewMode`
   - treat that turn as the durable result-bearing turn

This keeps the fix protocol-driven and avoids relying on non-durable transient notification ids.

**Step 2: Keep extraction order explicit**

Within the chosen target turn, recover final text in this order:

1. non-empty `agentMessage` with `phase === "final_answer"`
2. non-empty `exitedReviewMode.review`
3. non-empty trailing `agentMessage` with non-commentary phase or null phase

**Step 3: Do not broaden non-review matching unnecessarily**

Only use the review-tail scan when:
- the primary turn lookup misses
- and the resumed history clearly shows review-mode artifacts

This avoids accidentally binding an unrelated nearby turn as the final answer source.

## Task 3: Cover the real history shapes seen in production

**Files:**
- Modify: `src/service/turn-coordinator.test.ts`
- Optional: `src/service/turn-artifacts.ts`

**Step 1: Add the missing review-history shape tests**

Add focused tests for:

- outer review turn id missing from resumed history, inner turn contains `exitedReviewMode.review`
- outer review turn id missing from resumed history, inner turn has empty `review` but non-empty trailing `agentMessage`
- same-turn review history still works
- non-review turns do not accidentally bind to neighboring turns

**Step 2: Keep the prior regression**

Retain the earlier test for same-turn review extraction so both shapes stay covered.

## Task 4: Improve observability for future protocol drift

**Files:**
- Modify: `src/service/turn-coordinator.ts`
- Optional: `src/service/turn-artifacts.ts`

**Step 1: Add targeted logging**

When final-answer recovery misses on a completed review turn, log:

- active turn id
- whether resumed history contained that turn id
- whether a fallback review-bearing turn was found
- which artifact type produced the final message

This should stay compact and not dump the full review text into logs.

**Step 2: Preserve existing behavior for non-review turns**

The extra log branch should only activate when review-mode artifacts are involved.

## Task 5: Verify end-to-end behavior

**Files:**
- No additional production files required

**Step 1: Run focused tests**

```bash
node --import tsx --test src/service/turn-coordinator.test.ts --test-name-pattern "review"
```

Expected:
- PASS

**Step 2: Run broader turn-coordinator coverage**

```bash
npm test -- src/service/turn-coordinator.test.ts
```

Expected:
- PASS

**Step 3: Manual runtime verification after deploy**

1. restart the bridge service
2. trigger `/review` on a known target that yields review findings
3. confirm Telegram receives the review findings instead of the fallback
4. inspect:

```bash
rg -n "sending final answer|hasFinalMessage|turn artifact recovery failed" ~/.local/state/codex-telegram-bridge/logs/bridge.log | tail -n 50
```

Expected:
- `hasFinalMessage=true` for the review completion
- no fallback final-answer send for that turn

## Success Criteria

This plan is successful when:

- `/review` delivers review findings for both same-turn and split-turn history shapes
- the fallback "no final answer" message only appears when neither notifications nor durable history contain any usable terminal result
- non-review final-answer handling remains unchanged
- logs make future review-history mismatches diagnosable without reopening the entire protocol investigation

## Risks And Guardrails

### Risk: matching the wrong neighboring turn

Guardrail:
- only use the neighboring-turn fallback when review-mode artifacts are present
- prefer the most recent completed turn with `exitedReviewMode`

### Risk: masking future app-server contract changes

Guardrail:
- keep explicit logging for "outer turn id missing from resumed history"
- document the split-turn shape in tests

### Risk: overfitting to one observed sample

Guardrail:
- test both `review`-present and `review`-missing plus trailing-agent-message shapes
- keep the original same-turn path green
