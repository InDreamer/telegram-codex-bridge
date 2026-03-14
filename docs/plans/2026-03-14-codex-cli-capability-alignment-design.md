# V3 Codex CLI Capability Alignment Design

**Date:** 2026-03-14

**Status**

Draft engineering design input for V3 planning

**Related docs**

- `docs/future/v2-prd.md`
- `docs/future/v3-prd.md`
- `docs/plans/2026-03-14-v3-interaction-broker-phase-1-2-implementation-plan.md`

**Goal**

Define the V3 protocol-level capability-alignment target for the Telegram bridge so future implementation work can close the gap between the current bridge and the current `codex app-server` surface without confusing protocol parity with terminal-UI parity.

**Audience**

- Primary: maintainers implementing the next bridge phases
- Secondary: in-repo agents that need one stable gap-analysis document before changing app-server integration

**Version placement**

This document is the engineering design input for V3, not V2.

Reason:

- `docs/future/v2-prd.md` explicitly keeps Telegram approval flow and similar major protocol-surface expansion out of V2 scope
- the capability gaps analyzed here are therefore a V3 planning concern

**Target Boundary**

The alignment target for this document is:

- maximize parity with the current `codex app-server` protocol surface
- preserve Telegram as the control surface
- accept that Telegram will not become a 1:1 terminal emulator

This document does not target:

- full TTY parity with the native CLI
- curses/full-screen terminal UX
- keystroke-level terminal interactions

## Truth Sources

Use this order when the document and runtime disagree:

1. local `codex-cli` on the host
2. JSON Schema generated from that exact CLI
3. official Codex CLI and app-server docs
4. repository code
5. historical local docs

Local verification performed for this design:

- `codex --version` returned `codex-cli 0.114.0`
- `codex app-server --help` confirmed `stdio://`, `ws://`, `generate-ts`, and `generate-json-schema`
- generated schema from:

```bash
codex app-server generate-json-schema --experimental --out /tmp/codex-schema-0314
```

Schema inventory captured from the generated files:

- `61` client requests
- `46` server notifications
- `9` server requests

## V3 Positioning

V3 should be the release where the bridge aligns much more closely with the current app-server protocol surface.

That means this document is not asking whether the bridge should become a raw terminal clone.
It is defining how V3 should reduce the bridge's current protocol omissions.

## Current Bridge Snapshot

The current bridge intentionally implements a narrow v1 subset.

### Requests used today

The bridge currently uses or directly wraps only:

- `initialize`
- `thread/list`
- `thread/start`
- `thread/resume`
- `thread/archive`
- `thread/unarchive`
- `thread/read`
- `turn/start`
- `turn/interrupt`
- `initialized` as a client notification

Evidence:

- `src/codex/app-server.ts`
- `src/service.ts`

### Notifications meaningfully consumed today

The bridge currently classifies and reduces only a subset of runtime notifications:

- `turn/started`
- `turn/completed`
- `thread/status/changed`
- `thread/archived`
- `thread/unarchived`
- `item/started`
- `item/completed`
- `item/mcpToolCall/progress`
- `item/webSearch/progress`
- `turn/plan/updated`
- `item/plan/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `item/agentMessage/delta`
- `error`
- legacy compatibility events:
  - `codex/event/task_complete`
  - `codex/event/turn_aborted`

Everything else is effectively treated as non-user-facing `other`.

### Server requests handled today

None.

This is the most important capability gap in the entire bridge.

The current JSON-RPC frame handler routes:

- method-without-id frames as notifications
- id-only result/error frames as responses to pending client requests

It does not route method-plus-id server requests into any bridge-owned handler. As a result, protocol features that require a client response are not merely hidden from Telegram; they are currently unimplemented end-to-end.

### User-facing interaction surface today

Telegram currently exposes only fixed bridge-owned interactions:

- project picker
- manual project path confirmation
- runtime plan expand/collapse
- final-answer expand/collapse/page
- fixed slash commands such as `/new`, `/sessions`, `/where`, `/inspect`, `/interrupt`

There is no dynamic Telegram interaction surface for:

- approvals
- structured question/answer prompts
- model selection
- review target selection
- skill selection
- collaboration mode selection

## Why Native Codex CLI Feels More Capable

The native CLI can exercise protocol surfaces the bridge does not currently wire through. The gap is therefore mostly an implementation gap, not a hard protocol limitation.

The only place where full parity is unrealistic is transport UX:

- Telegram is message-oriented, not terminal-oriented
- Telegram cannot cleanly replicate raw TTY behavior
- long-lived interactive shell behaviors need adaptation, not literal mirroring

Working rule:

- aim for protocol parity
- accept adapted Telegram UX where terminal semantics do not map cleanly

## Capability Alignment Classes

Every capability should be classified into one of these buckets before implementation.

### Class A: Should reach near-full parity in Telegram

These are protocol capabilities that should be bridgeable with modest UX adaptation:

- approvals
- structured user-input questions
- MCP elicitation
- `turn/steer`
- model discovery and selection
- review start flows
- skills discovery and selection
- collaboration mode discovery and selection
- thread fork / rollback / compact / rename / metadata
- richer `UserInput` variants
- more complete runtime notifications
- restart-safe recovery of pending interactions

### Class B: Should be supported with adapted UX, not literal parity

- image and local-image submission
- mention-style structured references
- dynamic tool calls that require a message/card workflow
- terminal interaction notifications
- command-exec side channels
- richer inspect and audit views

These should work, but may use Telegram cards, forms, and follow-up prompts rather than a native terminal flow.

### Class C: Explicitly not worth 1:1 parity

- raw TTY session mirroring
- full-screen terminal UX
- resize- and cursor-driven console interaction
- realtime audio parity with a desktop client

These may eventually be exposed in reduced or admin-only forms, but should not drive the bridge architecture.

## Protocol-Level Capability Alignment Checklist

Use this as the master alignment checklist for implementation.

### 1. Frame Routing And Interaction Foundation

- [ ] Add explicit JSON-RPC frame classification for:
  - responses
  - notifications
  - server requests
- [ ] Add a bridge-owned server-request dispatcher
- [ ] Persist pending server requests in SQLite
- [ ] Add correlation fields for `threadId`, `turnId`, request method, and request id
- [ ] Add request lifecycle transitions:
  - pending
  - answered
  - canceled
  - expired
  - failed
- [ ] Add restart recovery for unresolved server requests
- [ ] Add `/inspect` visibility for pending interactions
- [ ] Add structured debug-journal records for request creation and resolution

This is `P0`. Without it, the bridge cannot truthfully claim protocol-level parity.

### 2. Approval And Question/Answer Flows

- [ ] Implement `item/commandExecution/requestApproval`
- [ ] Implement `item/fileChange/requestApproval`
- [ ] Implement `item/permissions/requestApproval`
- [ ] Implement `item/tool/requestUserInput`
- [ ] Implement `mcpServer/elicitation/request`
- [ ] Implement `applyPatchApproval`
- [ ] Implement `execCommandApproval`
- [ ] Support decision payloads, not only yes/no answers
- [ ] Support answer maps keyed by question id
- [ ] Support option-based, free-text, secret, and "other" answers
- [ ] Add explicit Telegram UX for:
  - accept
  - accept for session
  - decline
  - cancel
  - structured permission responses
- [ ] Add timeout and stale-request behavior
- [ ] Add idempotent re-click handling

This is `P0`.

### 3. Blocked Turn Recovery And Turn Steering

- [ ] Implement `turn/steer`
- [ ] Allow Telegram replies to be routed into an active blocked turn when appropriate
- [ ] Distinguish:
  - bridge-owned command input
  - answer to a pending request
  - user-initiated steer of the running turn
- [ ] Track `expectedTurnId`
- [ ] Prevent accidental steering into the wrong turn after restart or switch
- [ ] Make blocked state actionable, not display-only

This is `P0`.

### 4. Richer User Input Parity

- [ ] Support `text`
- [ ] Support `image`
- [ ] Support `localImage`
- [ ] Support `skill`
- [ ] Support `mention`
- [ ] Preserve input provenance in inspect/debug surfaces
- [ ] Add Telegram-side upload and attachment handling where feasible

This is `P1`.

### 5. Thread And Session Control Parity

- [ ] Expose `thread/fork`
- [ ] Expose `thread/read` more broadly than final-answer fallback
- [ ] Expose `thread/name/set`
- [ ] Expose `thread/metadata/update`
- [ ] Expose `thread/rollback`
- [ ] Expose `thread/compact/start`
- [ ] Expose `thread/backgroundTerminals/clean`
- [ ] Expose `thread/loaded/list` when useful for diagnostics
- [ ] Reconcile bridge session identity with remote thread mutations

This is `P1`.

### 6. Model, Feature, And Collaboration Selection

- [ ] Expose `model/list`
- [ ] Support per-thread model override
- [ ] Support per-turn model override
- [ ] Expose `collaborationMode/list`
- [ ] Expose `experimentalFeature/list` where it affects bridge behavior
- [ ] Use `config/read` when runtime config truth matters
- [ ] Surface `model/rerouted` visibly in inspect/runtime views

This is `P1`.

### 7. Review And Skills Parity

- [ ] Expose `review/start`
- [ ] Support all known review target families:
  - uncommitted changes
  - base branch
  - commit
  - custom instructions
- [ ] Expose `skills/list`
- [ ] Expose `skills/remote/list`
- [ ] Expose `skills/remote/export`
- [ ] Expose `skills/config/write`
- [ ] Surface `skills/changed` notifications

This is `P1`.

### 8. Runtime Notification Parity

- [ ] Handle `thread/started`
- [ ] Handle `thread/name/updated`
- [ ] Handle `thread/tokenUsage/updated`
- [ ] Handle `thread/closed`
- [ ] Handle `thread/compacted`
- [ ] Handle `turn/diff/updated`
- [ ] Handle `item/commandExecution/terminalInteraction`
- [ ] Handle `item/reasoning/*` with clear non-user-facing policy
- [ ] Handle `command/exec/outputDelta`
- [ ] Handle `hook/started`
- [ ] Handle `hook/completed`
- [ ] Handle `serverRequest/resolved`
- [ ] Handle `configWarning`
- [ ] Handle `deprecationNotice`

This is `P1`.

### 9. Discovery, Admin, And Long-Tail Surfaces

- [ ] Evaluate `mcpServer/oauth/login`
- [ ] Evaluate `config/mcpServer/reload`
- [ ] Evaluate `mcpServerStatus/list`
- [ ] Evaluate `externalAgentConfig/detect`
- [ ] Evaluate `externalAgentConfig/import`
- [ ] Evaluate `plugin/list`
- [ ] Evaluate `plugin/install`
- [ ] Evaluate `plugin/uninstall`
- [ ] Evaluate `app/list`
- [ ] Evaluate `account/*` and `feedback/upload`
- [ ] Evaluate `fuzzyFileSearch*`
- [ ] Evaluate `command/exec*`

This is `P2`.

These are protocol-visible and should be assessed deliberately, but they are not first-wave parity blockers.

### 10. Realtime And Audio Surface

- [ ] Evaluate `thread/realtime/start`
- [ ] Evaluate `thread/realtime/appendAudio`
- [ ] Evaluate `thread/realtime/appendText`
- [ ] Evaluate `thread/realtime/stop`
- [ ] Evaluate realtime notifications and audio output deltas

This is `P3`.

Telegram can support parts of this, but not as a native-terminal equivalent.

## Current Gap Matrix

| Capability Area | Protocol Availability | Current Bridge State | Alignment Class | Priority |
| --- | --- | --- | --- | --- |
| Core thread + turn lifecycle | Available | Partially implemented | A | Existing |
| Server requests | Available | Not implemented | A | P0 |
| Approval workflows | Available | Not implemented | A | P0 |
| Structured user input | Available | Not implemented | A | P0 |
| Blocked turn steering | Available | Not implemented | A | P0 |
| Rich input variants | Available | Text only | A/B | P1 |
| Model + collaboration selection | Available | Not implemented | A | P1 |
| Review + skills | Available | Not implemented | A | P1 |
| Rich thread controls | Available | Minimally implemented | A | P1 |
| Notification coverage | Available | Narrow subset only | A/B | P1 |
| Admin / plugin / MCP management | Available | Not implemented | B | P2 |
| Realtime / audio | Available | Not implemented | C | P3 |
| Raw terminal parity | Not a protocol goal | Not implemented | C | Never 1:1 |

## Recommended Implementation Program

Implementation should follow this order.

### Phase 1: Interaction Broker Foundation

Build the minimum architecture required for any serious parity work:

- JSON-RPC server-request routing
- pending interaction persistence
- Telegram interaction cards and answer collection
- response dispatch back to app-server
- restart recovery
- inspect/debug visibility

Deliverable:

- one generic interaction framework that can support approval, questions, elicitation, and future dynamic tools

### Phase 2: Unblock Turn Continuation

Build the ability to recover blocked turns:

- `turn/steer`
- answer routing for blocked turns
- session-safe and turn-safe steering rules
- clear UX distinction between:
  - new prompt
  - answer to pending request
  - steer current turn

Deliverable:

- no more "display-only blocked state" dead ends

### Phase 3: First-Wave Parity Surfaces

Use the broker to implement:

- approvals
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`
- image/local-image/mention/skill inputs
- model selection
- collaboration mode selection

Deliverable:

- bridge can complete most protocol-defined interactive tasks without falling back to native CLI

### Phase 4: Review, Skills, And Rich Thread Controls

Implement:

- `review/start`
- `skills/*`
- thread fork / rollback / compact / rename / metadata
- improved session-thread reconciliation

Deliverable:

- bridge is useful as a serious remote control plane, not only a prompt relay

### Phase 5: Runtime And Long-Tail Parity

Broaden notification and admin coverage:

- `serverRequest/resolved`
- `model/rerouted`
- token usage, diffs, hooks, terminal interaction
- MCP/admin/plugin/app/account surfaces

Deliverable:

- parity on high-value operational visibility

### Phase 6: Realtime And Transport-Specific Extensions

Only after the above:

- realtime text/audio evaluation
- any Telegram-specific adaptations for streaming/realtime control

Deliverable:

- optional transport expansion, not a prerequisite for parity on core task execution

## Non-Negotiable Design Rules For Future Implementation

- Never guess request or response shapes when the generated schema can answer them.
- Never ship a blocked-state UI without a corresponding response path.
- Do not couple Telegram UI widgets directly to protocol methods without a persisted interaction model.
- Keep bridge-owned runtime reductions separate from raw debug/audit data.
- Prefer generic interaction plumbing over one-off special cases.
- Preserve restart safety for any interaction that changes Codex execution state.
- Treat protocol parity and UX parity as different goals.

## Suggested Follow-Up Deliverables

After this design document, the next implementation documents should be:

1. a detailed implementation plan for Phase 1 and Phase 2
2. a schema-backed interaction-state model design
3. a Telegram interaction UX spec for approvals and structured questions
4. a thread-steering and blocked-turn recovery spec

Current first implementation plan:

- `docs/plans/2026-03-14-v3-interaction-broker-phase-1-2-implementation-plan.md`

## Verification Notes

This design was derived from:

- local host `codex-cli 0.114.0`
- generated schema in `/tmp/codex-schema-0314`
- current repository docs in `docs/product/`, `docs/architecture/`, and `docs/research/`
- current bridge implementation in `src/codex/app-server.ts`, `src/service.ts`, `src/codex/notification-classifier.ts`, `src/activity/tracker.ts`, and `src/telegram/ui.ts`

It should be refreshed whenever the host `codex-cli` version changes or the bridge begins consuming server requests.
