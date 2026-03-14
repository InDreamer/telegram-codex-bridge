# V3 Interaction Broker And Blocked Turn Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build V3 Phase 1 and Phase 2 by adding a generic server-request interaction broker, persisted pending interactions, Telegram-mediated approval/question flows, and blocked-turn continuation via `turn/steer`.

**Architecture:** Extend the app-server client so it can distinguish responses, notifications, and server requests. Normalize server requests into a bridge-owned interaction model, persist those interactions in SQLite, and let `BridgeService` render bridge-owned interaction cards in Telegram. User answers should resolve the original server request and, when appropriate, steer the blocked turn forward without collapsing the existing runtime-status model.

**Tech Stack:** TypeScript, Node built-in test runner via `tsx`, SQLite via `node:sqlite`, Telegram Bot API, Codex app-server JSON-RPC 2.0

---

## Scope For This Plan

Included in this plan:

- JSON-RPC server-request handling
- normalized interaction model
- SQLite persistence for pending interactions
- Telegram UI for approvals and structured questions
- service-side routing for callbacks and text answers
- `turn/steer` support for blocked-turn continuation
- inspect/debug/recovery support for pending interactions

Explicitly deferred to later V3 plans:

- `review/start`
- `skills/*`
- `model/list`
- collaboration mode selection
- thread fork / rollback / compact / metadata controls
- realtime and audio surfaces

## Design Constraints

- Keep existing `v1:` callback grammar unchanged for existing surfaces.
- Add new interaction callback grammar under a new `v3:` namespace.
- Do not break the existing reduced runtime-status card.
- Do not rely on Telegram as the source of truth for pending interaction state.
- One Telegram chat still has one active session and one active turn at a time.
- If the bridge shows a blocked interaction, it must have a real response path.

## Proposed Callback Contract For This Plan

Keep existing callback families untouched and add:

- `v3:ix:decision:{interaction_id}:{decision_key}`
- `v3:ix:question:{interaction_id}:{question_id}:{option_index}`
- `v3:ix:text:{interaction_id}:{question_id}`
- `v3:ix:cancel:{interaction_id}`

Notes:

- `decision_key` is a bridge-owned stable token such as `accept`, `acceptForSession`, `decline`, or `cancel`
- `option_index` is the 0-based index into the persisted question options for that question
- free-text answers should switch the chat into an interaction-answer mode keyed by `interaction_id` plus `question_id`
- keep the callbacks short and bridge-owned; never encode raw file paths or bulky JSON payloads into Telegram callback data

## Proposed Pending Interaction Schema

Add a new SQLite table and row type with this minimum shape:

```sql
CREATE TABLE pending_interaction (
  interaction_id TEXT PRIMARY KEY,
  telegram_chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  request_id INTEGER NOT NULL,
  request_method TEXT NOT NULL,
  interaction_kind TEXT NOT NULL,
  state TEXT NOT NULL,
  prompt_json TEXT NOT NULL,
  response_json TEXT NULL,
  telegram_message_id INTEGER NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT NULL,
  error_reason TEXT NULL
);

CREATE INDEX idx_pending_interaction_chat_state
  ON pending_interaction(telegram_chat_id, state, created_at DESC);

CREATE INDEX idx_pending_interaction_turn
  ON pending_interaction(thread_id, turn_id, created_at DESC);
```

Recommended state values for this phase:

- `pending`
- `awaiting_text`
- `answered`
- `expired`
- `failed`

`serverRequest/resolved` support can later introduce a stronger terminal `resolved` state without changing the core table.

## Task 1: Normalize Server Requests Into A Bridge-Owned Interaction Model

**Files:**
- Create: `src/interactions/normalize.ts`
- Create: `src/interactions/normalize.test.ts`

**Step 1: Write the failing tests**

Add tests that prove the normalizer can convert:

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

into one normalized union, and returns `null` for unsupported request methods.

Use a normalized shape along these lines:

```ts
export type NormalizedInteraction =
  | {
      kind: "approval";
      method: "item/commandExecution/requestApproval" | "item/fileChange/requestApproval";
      threadId: string;
      turnId: string;
      itemId: string;
      decisionKeys: string[];
      title: string;
      detail: string | null;
      rawParams: unknown;
    }
  | {
      kind: "permissions";
      method: "item/permissions/requestApproval";
      threadId: string;
      turnId: string;
      itemId: string;
      requestedPermissions: unknown;
      detail: string | null;
      rawParams: unknown;
    }
  | {
      kind: "questionnaire";
      method: "item/tool/requestUserInput";
      threadId: string;
      turnId: string;
      itemId: string;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        options: Array<{ label: string; description: string }> | null;
        isOther: boolean;
        isSecret: boolean;
      }>;
      rawParams: unknown;
    }
  | {
      kind: "elicitation";
      method: "mcpServer/elicitation/request";
      threadId: string;
      turnId: string | null;
      serverName: string;
      rawParams: unknown;
    };
```

**Step 2: Run the targeted test file**

Run:

```bash
node --import tsx --test src/interactions/normalize.test.ts
```

Expected:

- FAIL because the new normalizer module does not exist yet

**Step 3: Implement the normalizer**

Create `src/interactions/normalize.ts` with:

- exported normalized interaction types
- `normalizeServerRequest(method, params)` entrypoint
- method-specific parsers
- stable title/detail extraction for approval cards
- one-question-at-a-time questionnaire support by preserving raw question order and metadata

Implementation rules:

- preserve the raw params on the normalized object for later response generation
- do not drop `availableDecisions`
- do not flatten away `isOther` or `isSecret`
- treat malformed params as `null` rather than throwing, so the service can fail gracefully

**Step 4: Re-run the targeted test file**

Run:

```bash
node --import tsx --test src/interactions/normalize.test.ts
```

Expected:

- PASS with the new normalizer coverage

**Step 5: Commit**

```bash
git add src/interactions/normalize.ts src/interactions/normalize.test.ts
git commit -m "feat: add normalized app-server interaction model"
```

## Task 2: Teach The App-Server Client About Server Requests And Turn Steering

**Files:**
- Modify: `src/codex/app-server.ts`
- Modify: `src/codex/app-server.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- dispatching a method-plus-id frame as a server request
- keeping method-without-id notification behavior intact
- keeping response resolution intact
- sending a response back to a server request id
- sending `turn/steer` with `expectedTurnId`

Use a handler shape like:

```ts
type ServerRequestHandler = (request: {
  id: number;
  method: string;
  params?: unknown;
}) => void;
```

**Step 2: Run the app-server test file**

Run:

```bash
node --import tsx --test src/codex/app-server.test.ts
```

Expected:

- FAIL because method-plus-id frames are currently ignored and `turn/steer` is missing

**Step 3: Implement server-request routing**

In `src/codex/app-server.ts`:

- add a `JsonRpcServerRequest` type
- add `onServerRequest(handler)`
- add `respondToServerRequest(id, result)`
- add `respondToServerRequestError(id, code, message, data?)`
- add `steerTurn({ threadId, expectedTurnId, input })`
- update `handleMessage()` so the order is:
  1. notification: `method` without `id`
  2. server request: `method` with `id`
  3. response/error: `id` with `result` or `error`

The steer method should send this payload shape:

```ts
{
  threadId,
  expectedTurnId,
  input
}
```

**Step 4: Re-run the app-server test file**

Run:

```bash
node --import tsx --test src/codex/app-server.test.ts
```

Expected:

- PASS with both old and new behavior covered

**Step 5: Commit**

```bash
git add src/codex/app-server.ts src/codex/app-server.test.ts
git commit -m "feat: add app-server server-request and turn-steer support"
```

## Task 3: Persist Pending Interactions In SQLite

**Files:**
- Modify: `src/types.ts`
- Modify: `src/state/store.ts`
- Modify: `src/state/store.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- schema migration from version `3` to version `4`
- inserting a pending interaction
- listing pending interactions by chat / turn
- saving a Telegram message id for the interaction card
- marking an interaction as `awaiting_text`
- marking an interaction as answered / failed / expired
- loading persisted pending interactions after reopening the store

Add a row type like:

```ts
export interface PendingInteractionRow {
  interactionId: string;
  telegramChatId: string;
  sessionId: string;
  threadId: string;
  turnId: string;
  requestId: number;
  requestMethod: string;
  interactionKind: "approval" | "permissions" | "questionnaire" | "elicitation";
  state: "pending" | "awaiting_text" | "answered" | "expired" | "failed";
  promptJson: string;
  responseJson: string | null;
  telegramMessageId: number | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  errorReason: string | null;
}
```

**Step 2: Run the store test file**

Run:

```bash
node --import tsx --test src/state/store.test.ts
```

Expected:

- FAIL because version `4` migration and the new CRUD methods do not exist

**Step 3: Implement schema version 4 and store methods**

In `src/state/store.ts`:

- bump `CURRENT_SCHEMA_VERSION` to `4`
- add the `pending_interaction` table migration
- add mapping helpers
- add methods such as:
  - `createPendingInteraction(...)`
  - `getPendingInteraction(interactionId, telegramChatId?)`
  - `listPendingInteractionsByChat(telegramChatId, states?)`
  - `listPendingInteractionsByTurn(threadId, turnId)`
  - `setPendingInteractionMessageId(interactionId, messageId)`
  - `markPendingInteractionAwaitingText(interactionId)`
  - `markPendingInteractionAnswered(interactionId, responseJson)`
  - `markPendingInteractionFailed(interactionId, reason)`
  - `expirePendingInteractionsForTurn(threadId, turnId, reason)`
  - `listUnresolvedPendingInteractions()`

Implementation rule:

- store normalized prompt payloads as JSON strings
- do not depend on Telegram message text as the source of truth

**Step 4: Re-run the store test file**

Run:

```bash
node --import tsx --test src/state/store.test.ts
```

Expected:

- PASS with migration and persistence coverage

**Step 5: Commit**

```bash
git add src/types.ts src/state/store.ts src/state/store.test.ts
git commit -m "feat: persist pending codex interactions"
```

## Task 4: Add V3 Telegram Interaction Cards And Callback Parsing

**Files:**
- Modify: `src/telegram/ui.ts`
- Modify: `src/telegram/ui.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- parsing the new `v3:ix:*` callback families
- rendering an approval card
- rendering a questionnaire card for:
  - option questions
  - free-text questions
  - secret questions
- rendering resolved / expired interaction states

Use a view-model shape like:

```ts
{
  interactionId: "ix-1",
  title: "Codex needs approval",
  subtitle: "Command approval",
  body: "pnpm test",
  actions: [
    { text: "批准", callbackData: "v3:ix:decision:ix-1:accept" },
    { text: "本会话内总是批准", callbackData: "v3:ix:decision:ix-1:acceptForSession" },
    { text: "拒绝", callbackData: "v3:ix:decision:ix-1:decline" }
  ]
}
```

**Step 2: Run the UI test file**

Run:

```bash
node --import tsx --test src/telegram/ui.test.ts
```

Expected:

- FAIL because the new callback kinds and card builders do not exist

**Step 3: Implement the UI helpers**

In `src/telegram/ui.ts`:

- extend `ParsedCallbackData`
- add parser support for the new `v3:ix:*` callback formats
- add builders such as:
  - `buildInteractionApprovalCard(...)`
  - `buildInteractionQuestionCard(...)`
  - `buildInteractionResolvedCard(...)`
  - `buildInteractionExpiredCard(...)`

UI rules:

- keep existing `v1:` builders untouched
- render interaction cards as separate bridge-owned messages
- keep cards concise and Telegram-safe
- for free-text answers, instruct the user to send the next message directly in chat

**Step 4: Re-run the UI test file**

Run:

```bash
node --import tsx --test src/telegram/ui.test.ts
```

Expected:

- PASS with the new interaction-card coverage

**Step 5: Commit**

```bash
git add src/telegram/ui.ts src/telegram/ui.test.ts
git commit -m "feat: add v3 telegram interaction cards"
```

## Task 5: Wire A Generic Interaction Broker Into BridgeService

**Files:**
- Modify: `src/service.ts`
- Modify: `src/service.test.ts`

**Step 1: Write the failing tests**

Add service tests that prove:

- a server request received during an active turn becomes a persisted pending interaction
- the bridge sends a new interaction card message
- the interaction card message id is stored
- stale callbacks are rejected once the interaction is resolved or expired
- unresolved interactions are visible from `/inspect`

Focus this task on lifecycle plumbing, not yet on every approval decision family.

**Step 2: Run the service test file**

Run:

```bash
node --import tsx --test src/service.test.ts
```

Expected:

- FAIL because the service does not listen for server requests and has no interaction broker

**Step 3: Implement the broker plumbing**

In `src/service.ts`:

- register `this.appServer.onServerRequest(...)`
- add a handler that:
  - normalizes the request
  - verifies it belongs to the active turn
  - persists it
  - renders the interaction card
- add in-memory helpers for:
  - pending interaction lookup by id
  - awaiting free-text answer mode by chat
- update `/inspect` rendering to include pending-interaction summaries

Implementation rule:

- do not merge the interaction card into the runtime status card
- keep the status card responsible for reduced runtime state only

**Step 4: Re-run the service test file**

Run:

```bash
node --import tsx --test src/service.test.ts
```

Expected:

- PASS for the new broker-lifecycle coverage

**Step 5: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "feat: wire generic interaction broker into service"
```

## Task 6: Implement Approval Families End To End

**Files:**
- Modify: `src/service.ts`
- Modify: `src/service.test.ts`

**Step 1: Write the failing tests**

Add service tests for:

- command approval `accept`
- command approval `acceptForSession`
- command approval `decline`
- command approval `cancel`
- file-change approval decisions
- permissions approval accept path that returns the requested `permissions`
- resolved cards becoming non-actionable

Use response payloads like:

```ts
{ decision: "accept" }
{ decision: "acceptForSession" }
{ decision: "decline" }
{ decision: "cancel" }
{ permissions: requestedPermissions }
```

**Step 2: Run the service test file**

Run:

```bash
node --import tsx --test src/service.test.ts
```

Expected:

- FAIL because callback decisions are not mapped back to server-request responses

**Step 3: Implement approval response mapping**

In `src/service.ts`:

- on interaction-decision callbacks, load the persisted interaction
- produce the correct JSON-RPC response payload for each request family
- send the response through `appServer.respondToServerRequest(...)`
- update the interaction store row to `answered`
- edit the interaction card into a resolved state

Implementation rule:

- for `item/permissions/requestApproval`, accept should grant the requested permissions payload from the original request unless the user explicitly chooses a narrower future extension
- object-style decisions such as policy amendments should be deferred until a later V3 plan unless present in `availableDecisions` and required for correctness

**Step 4: Re-run the service test file**

Run:

```bash
node --import tsx --test src/service.test.ts
```

Expected:

- PASS for the approval families covered in this phase

**Step 5: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "feat: support codex approval requests in telegram"
```

## Task 7: Implement Structured Question Answers And MCP Elicitation

**Files:**
- Modify: `src/service.ts`
- Modify: `src/service.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- a single-choice `requestUserInput` question
- a free-text `requestUserInput` question
- a multi-question `requestUserInput` flow processed one question at a time
- a secret question stored only in the response payload path, not mirrored back into inspect text
- MCP elicitation `accept`
- MCP elicitation `decline`
- MCP elicitation `cancel`

For `requestUserInput`, target a response shape like:

```ts
{
  answers: {
    environment: { answers: ["staging"] },
    notes: { answers: ["deploy after backups finish"] }
  }
}
```

For MCP elicitation, target:

```ts
{ action: "accept" }
{ action: "decline" }
{ action: "cancel" }
```

**Step 2: Run the service test file**

Run:

```bash
node --import tsx --test src/service.test.ts
```

Expected:

- FAIL because questionnaire progression and free-text answer capture do not exist

**Step 3: Implement sequential questionnaire handling**

In `src/service.ts`:

- when a questionnaire interaction is created, render only the current question
- on option selection:
  - persist the selected answer for that question
  - advance to the next question or submit the final response
- on free-text mode:
  - mark the interaction as `awaiting_text`
  - route the next non-command chat message into that question
- on final question completion:
  - assemble the `answers` map
  - respond to the original server request
  - resolve the interaction card

Implementation rules:

- one pending text-answer interaction per chat at a time
- if the question is marked `isSecret`, avoid echoing the raw answer into user-visible inspect summaries
- if the interaction has already completed, text should no longer be captured into it

**Step 4: Re-run the service test file**

Run:

```bash
node --import tsx --test src/service.test.ts
```

Expected:

- PASS for questionnaire and elicitation coverage

**Step 5: Commit**

```bash
git add src/service.ts src/service.test.ts
git commit -m "feat: support codex question and elicitation flows"
```

## Task 8: Add Blocked-Turn Continuation With `turn/steer`

**Files:**
- Modify: `src/codex/app-server.ts`
- Modify: `src/service.ts`
- Modify: `src/service.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- plain text sent while a turn is blocked and no pending interaction is awaiting text becomes `turn/steer`
- the service uses `expectedTurnId = activeTurn.turnId`
- plain text sent while the turn is running but not blocked is still rejected
- plain text sent while a pending interaction is awaiting text answers the interaction instead of steering

**Step 2: Run the service test file**

Run:

```bash
node --import tsx --test src/service.test.ts
```

Expected:

- FAIL because the bridge currently rejects all text while a session is `running`

**Step 3: Implement steer routing**

Update `src/service.ts` so `handleMessage()` follows this order:

1. pending rename input
2. pending manual project path
3. pending interaction free-text answer
4. command parsing
5. if no command and active turn is blocked without a pending text-answer interaction:
   - call `appServer.steerTurn({
       threadId,
       expectedTurnId: activeTurn.turnId,
       input: [{ type: "text", text }]
     })`
6. otherwise keep the current running-turn rejection

Implementation rule:

- do not allow steering into a non-blocked running turn in this phase
- steering is a blocked-turn recovery path first, not a general "send another prompt while running" escape hatch

**Step 4: Re-run the service test file**

Run:

```bash
node --import tsx --test src/service.test.ts
```

Expected:

- PASS for blocked-turn continuation behavior

**Step 5: Commit**

```bash
git add src/codex/app-server.ts src/service.ts src/service.test.ts
git commit -m "feat: allow blocked turns to continue via turn steer"
```

## Task 9: Recovery, Expiration, And Inspect Details

**Files:**
- Modify: `src/state/store.ts`
- Modify: `src/service.ts`
- Modify: `src/service.test.ts`
- Modify: `src/telegram/ui.ts`
- Modify: `src/telegram/ui.test.ts`

**Step 1: Write the failing tests**

Add tests for:

- unresolved pending interactions being marked failed or expired during startup recovery
- turn completion / interruption / failure expiring unresolved interactions for that turn
- stale interaction callbacks returning expired
- `/inspect` showing pending interaction summaries and latest interaction note
- resolved interaction cards no longer offering action buttons

**Step 2: Run the affected test files**

Run:

```bash
node --import tsx --test src/state/store.test.ts
node --import tsx --test src/telegram/ui.test.ts
node --import tsx --test src/service.test.ts
```

Expected:

- FAIL because unresolved interaction cleanup and inspect rendering are incomplete

**Step 3: Implement cleanup and inspect visibility**

In `src/service.ts` and `src/state/store.ts`:

- during startup recovery, mark unresolved interactions from failed running turns as `failed`
- on turn completion/interruption/failure, expire unresolved interactions for that turn
- clear any in-memory awaiting-text mode for resolved interactions

In `src/telegram/ui.ts`:

- add an inspect section such as `Pending interactions`
- summarize:
  - interaction kind
  - request method
  - state
  - whether text input is awaited

**Step 4: Re-run the affected test files**

Run:

```bash
node --import tsx --test src/state/store.test.ts
node --import tsx --test src/telegram/ui.test.ts
node --import tsx --test src/service.test.ts
```

Expected:

- PASS with recovery and inspect coverage

**Step 5: Commit**

```bash
git add src/state/store.ts src/service.ts src/service.test.ts src/telegram/ui.ts src/telegram/ui.test.ts
git commit -m "feat: recover and inspect pending interactions"
```

## Task 10: Final Verification And V3 Doc Sync

**Files:**
- Modify: `docs/future/v3-prd.md`
- Modify: `docs/plans/2026-03-14-v3-interaction-broker-phase-1-2-implementation-plan.md`
- Modify: `docs/plans/2026-03-14-codex-cli-capability-alignment-design.md`

**Step 1: Update the docs**

Add a short implementation-progress reference from:

- `docs/future/v3-prd.md`
- `docs/plans/2026-03-14-codex-cli-capability-alignment-design.md`

to this plan file.

**Step 2: Run typecheck and the full test suite**

Run:

```bash
npm run check
npm test
```

Expected:

- PASS with no type errors and the full test suite green

**Step 3: Run a focused regression pass**

Run:

```bash
node --import tsx --test src/codex/app-server.test.ts
node --import tsx --test src/state/store.test.ts
node --import tsx --test src/telegram/ui.test.ts
node --import tsx --test src/service.test.ts
```

Expected:

- PASS with all interaction-related coverage green

**Step 4: Review the resulting diff**

Run:

```bash
git status --short
git diff --stat
```

Expected:

- only the planned source, test, and doc files changed

**Step 5: Commit**

```bash
git add src/codex/app-server.ts src/codex/app-server.test.ts src/interactions/normalize.ts src/interactions/normalize.test.ts src/state/store.ts src/state/store.test.ts src/types.ts src/telegram/ui.ts src/telegram/ui.test.ts src/service.ts src/service.test.ts docs/future/v3-prd.md docs/plans/2026-03-14-codex-cli-capability-alignment-design.md docs/plans/2026-03-14-v3-interaction-broker-phase-1-2-implementation-plan.md
git commit -m "feat: implement v3 interaction broker and blocked turn recovery"
```

## Implementation Notes For The Engineer

- Keep the first wave generic. Do not special-case command approval so hard that questionnaires need a second architecture.
- Favor persisted identifiers over in-memory-only routing.
- Existing `activeTurn` state can remain the anchor, but do not make pending interactions disappear if the bridge process restarts.
- The bridge currently marks running turns failed on restart. That behavior is acceptable for this plan; unresolved interactions should be failed or expired consistently with that restart policy rather than pretending they can resume.
- Do not widen the running-turn text-input path beyond blocked-turn steering in this phase.
- Preserve the current reduced status-card UX. New interaction cards should complement it, not replace it.
