# Thread Archive Reconciliation Plan

> Truth status:
> - Current truth? No
> - Use for: implementation rationale, sequencing, and handoff history
> - Verify current behavior in: current product/architecture/operations docs and current code


> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the backend `thread archive` design for V2 so Telegram session archive stays locally authoritative while the bridge observes, correlates, and diagnoses Codex thread archive state transitions safely.

**Architecture:** Keep `session.archived` in SQLite as the Telegram UX source of truth, continue using `thread/archive` and `thread/unarchive` RPCs for mirror writes, and add a thin reconciliation layer in the bridge service for `thread/archived` and `thread/unarchived` notifications. Do not expose new user commands for low-level `thread/*` events, and do not switch to a remote-first session model.

**Tech Stack:** Node.js, TypeScript, SQLite, Codex app-server JSON-RPC over `stdio`, Telegram bot command routing, current `codex-cli 0.114.0` schema.

---

## 1. Research Summary

### 1.1 Current host and API facts

- Verified local runtime: `codex-cli 0.114.0`
- Current authoritative sources for exact app-server behavior:
  - `docs/research/codex-app-server-authoritative-reference.md`
  - `docs/research/codex-app-server-api-quick-reference.md`
  - locally generated JSON Schema from this host
- Archive-related app-server surface confirmed by current schema:
  - `thread/archive({ threadId })`
  - `thread/unarchive({ threadId })`
  - `thread/archived` notification with `threadId`
  - `thread/unarchived` notification with `threadId`
  - `thread/list({ archived, cursor, cwd, limit, modelProviders, searchTerm, sortKey, sourceKinds })`
  - `thread/read({ threadId, includeTurns })`
- Important schema limitation:
  - `thread/read` exposes `thread.status`, but does **not** expose an explicit `archived` boolean
  - remote archive truth is therefore easiest to observe from:
    - live `thread/archived` / `thread/unarchived` notifications
    - or list membership via `thread/list` with `archived = true|false`

### 1.2 Current project behavior

- The bridge runs one long-lived `codex app-server` child, not one child per session.
- One bridge session maps to one persisted Codex thread.
- Current user-facing archive behavior already exists:
  - `/archive`
  - `/sessions archived`
  - `/unarchive <n>`
- Current archive write path:
  1. `BridgeService.routeCommand("archive")`
  2. `handleArchive()`
  3. `CodexAppServerClient.archiveThread(threadId)`
  4. `BridgeStateStore.archiveSession(sessionId)`
- Current unarchive path mirrors the above with inverse methods.
- Current store guarantees already implemented:
  - archived sessions are hidden from default `/sessions`
  - archived sessions cannot stay active
  - startup normalizes stale active pointers that still reference archived sessions
  - direct store calls reject archive/unarchive of running sessions
  - local persistence failure after remote archive/unarchive triggers best-effort compensating RPC

### 1.3 Current gap

- `thread/archived` and `thread/unarchived` notifications are not yet modeled explicitly.
- `src/codex/notification-classifier.ts` currently treats those notifications as `other`.
- The bridge does not yet correlate archive/unarchive RPCs with subsequent remote notifications.
- The bridge does not yet distinguish:
  - expected remote confirmation of our own archive change
  - unexpected remote archive drift from another client or stale runtime behavior
- There is no dedicated repair path for archive drift today.

## 2. Design Decisions

### 2.1 Product boundary

- `thread/archived` and `thread/unarchived` remain **internal app-server events**, not Telegram commands.
- User-facing commands stay at the session layer:
  - `/archive`
  - `/sessions archived`
  - `/unarchive <n>`
- No new Telegram command should expose raw `thread/*` protocol terminology.

### 2.2 Source of truth

- **Local SQLite session state remains the source of truth for Telegram UX.**
- Remote thread archive state is a mirror and verification surface, not the primary data model.
- The bridge must not auto-flip local `session.archived` purely because an unsolicited `thread/archived` notification arrived.

### 2.3 Notification semantics

- `thread/archived` / `thread/unarchived` notifications should be interpreted as:
  - confirmation of a pending local operation when they match an in-flight expectation
  - drift evidence when they do not match local expectations
- Notifications should not be ignored anymore, but they also should not directly rewrite local state without correlation.

### 2.4 Reconciliation model

- Add an in-memory `pendingThreadArchiveOps` tracker in `BridgeService`, keyed by `threadId`.
- Each tracked entry should include:
  - `sessionId`
  - `expectedRemoteState`: `archived | unarchived`
  - `requestedAt`
  - `origin`: `telegram_archive` or `telegram_unarchive`
- The tracker is intentionally in-memory only:
  - it is for runtime correlation, not durable product state
  - on restart, unmatched operations degrade to logs/debug evidence rather than fake certainty

### 2.5 Drift handling

- If a notification matches a pending expected state:
  - clear the pending tracker entry
  - log a confirmation event
- If a notification conflicts with a pending expected state:
  - clear the pending entry
  - log a warning with `sessionId`, `threadId`, expected state, actual state
  - keep local SQLite unchanged
- If a notification arrives with no pending entry:
  - treat it as out-of-band remote drift
  - do not rewrite local archive state
  - log a warning and retain the raw notification in the debug journal

### 2.6 Repair scope

- Do **not** add automatic startup-wide archive repair in the first implementation of this plan.
- Add app-server client support for `thread/list` and `thread/read` only for diagnostics and future repair tooling.
- If a repair flow is added later, it should be an explicit operator-driven or diagnostic path, not a hidden hot-path mutation.

Reason:
- current schema does not expose a direct `archived` field on `thread/read`
- `thread/list` archive truth is available only through paginated membership queries
- automatic remote-first repair would add complexity and can surprise the Telegram UX

## 3. Implementation Plan

### Task 1: Model archive notifications explicitly

**Files:**
- Modify: `src/activity/types.ts`
- Modify: `src/codex/notification-classifier.ts`
- Test: `src/activity/tracker.test.ts`

**Step 1: Add new classified notification kinds**

- Extend `ClassifiedNotificationBase.kind` with:
  - `thread_archived`
  - `thread_unarchived`
- Add typed notification interfaces carrying:
  - `threadId`
  - `method`
  - `turnId` nullable like other thread notifications

**Step 2: Update classifier**

- Map `thread/archived` to `kind: "thread_archived"`
- Map `thread/unarchived` to `kind: "thread_unarchived"`
- Preserve existing context extraction rules

**Step 3: Add tests**

- Verify both notifications classify into explicit kinds rather than `other`
- Verify unknown future notifications still fall back to `other`

### Task 2: Add thread lookup and service-side correlation

**Files:**
- Modify: `src/state/store.ts`
- Modify: `src/service.ts`
- Test: `src/service.test.ts`

**Step 1: Add store lookup by thread id**

- Add `getSessionByThreadId(threadId: string): SessionRow | null`
- Do not return archived and unarchived separately; return the raw session row so drift can be diagnosed regardless of local archive flag

**Step 2: Add pending archive op tracker**

- In `BridgeService`, add an in-memory map keyed by `threadId`
- Register a pending entry immediately after successful `archiveThread()` / `unarchiveThread()` RPC and before local store mutation
- Clear the pending entry if local store mutation fails and compensation succeeds or fails

**Step 3: Add notification reconciliation hook**

- In `handleAppServerNotification`, after classification, route `thread_archived` and `thread_unarchived` to a dedicated handler
- Handler behavior:
  - find matching pending entry by `threadId`
  - if matched and state agrees, log confirmation and clear entry
  - if matched and state conflicts, log warning and clear entry
  - if unmatched, log drift warning

**Step 4: Keep local state unchanged on unsolicited remote notifications**

- Do not call `archiveSession()` or `unarchiveSession()` from notification handling
- Do not send Telegram user messages for internal confirmation events
- Preserve all raw evidence in the debug journal and logs

### Task 3: Expose diagnostic read/list hooks without changing user UX

**Files:**
- Modify: `src/codex/app-server.ts`
- Test: `src/codex/app-server.test.ts`

**Step 1: Add client wrappers**

- Add `listThreads(options)` with support for:
  - `archived`
  - `cursor`
  - `limit`
  - `cwd`
  - `sortKey`
- Add `readThread(threadId, includeTurns?)`

**Step 2: Keep them out of normal archive/unarchive flow**

- Do not make `/archive` or `/unarchive` block on `thread/list` or `thread/read`
- These helpers exist for diagnostics and future repair only

**Step 3: Test request shapes**

- Add tests that verify `listThreads` and `readThread` send the expected JSON-RPC params

### Task 4: Add archive-specific diagnostics and observability

**Files:**
- Modify: `src/service.ts`
- Modify: `docs/architecture/runtime-and-state.md`
- Modify: `docs/product/chat-and-project-flow.md`

**Step 1: Logging**

- Emit structured log lines for:
  - pending archive op registered
  - pending archive op confirmed
  - conflicting archive notification
  - unsolicited archive drift notification

**Step 2: Debug journal**

- No schema change needed; rely on existing raw notification retention
- Document that archive/unarchive notifications are intentionally kept in the debug journal for later diagnosis

**Step 3: Documentation**

- Clarify that:
  - session archive is a Telegram/session concept
  - `thread/archived` is an internal Codex protocol event
  - the bridge observes protocol events but does not expose them directly as commands

### Task 5: Future repair hook design (documented, not implemented in this batch)

**Files:**
- Document only in this plan unless scope is later promoted

**Design contract:**

- Future repair must be explicit and off the hot path.
- Repair candidate algorithm:
  1. gather known local sessions with `threadId`
  2. sweep `thread/list` with `archived = false`
  3. sweep `thread/list` with `archived = true`
  4. compare thread id membership with local `session.archived`
  5. report mismatches; do not auto-heal silently

**Not in current implementation scope:**
- startup auto-repair
- Telegram user-facing repair commands
- automatic local mutation based on thread-list sweeps

## 4. Test Plan

- Classification:
  - `thread/archived` becomes `thread_archived`
  - `thread/unarchived` becomes `thread_unarchived`
- Service correlation:
  - archive RPC success + matching notification clears pending entry
  - unarchive RPC success + matching notification clears pending entry
  - conflicting notification produces warning and preserves local SQLite state
  - unsolicited notification with no pending entry produces warning and preserves local SQLite state
- Store lookup:
  - `getSessionByThreadId()` returns the correct session for both archived and unarchived rows
- Client wrappers:
  - `listThreads()` and `readThread()` send exact JSON-RPC shapes
- Regression:
  - existing `/archive`, `/sessions archived`, `/unarchive <n>` tests remain green
  - no new Telegram user messages are emitted for internal `thread/archived` / `thread/unarchived` confirmations

## 5. Assumptions And Defaults

- Local session state remains the Telegram UX truth; remote thread archive state is observational and diagnostic.
- `thread/archived` and `thread/unarchived` are not new Telegram commands.
- `thread/read` lacking an explicit `archived` field is treated as a real current-schema constraint.
- Notification handling must be best-effort and must not make archive UX noisier.
- Repair remains a later explicit operator/diagnostic capability, not a hidden side effect of normal session operations.
