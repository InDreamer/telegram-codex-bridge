# Telegram Codex Bridge V3 PRD

Status: Active direction; Phase 1 and Phase 2 baseline partially implemented
Owner: Product
Last updated: 2026-03-15
Related docs:
- `docs/future/v2-prd.md`
- `docs/plans/2026-03-14-codex-cli-capability-alignment-design.md`
- `docs/plans/2026-03-14-v3-interaction-broker-phase-1-2-implementation-plan.md`

---

## 1. Document Purpose

This document defines the **product direction for Telegram Codex Bridge V3**.

Its purpose is to establish that the next major version is no longer primarily about visibility polish or session ergonomics. V3 is the release where the bridge should close the largest remaining capability gap with the current Codex app-server protocol.

This is a product document, not a protocol schema and not an implementation plan.

### Current implementation snapshot

As of 2026-03-15, the repository now includes the first real V3 slice:

- JSON-RPC server-request routing in the app-server client
- persisted pending interactions in SQLite
- Telegram interaction cards under the `v3:ix:*` callback namespace
- Telegram-mediated handling for:
  - command approval
  - file-change approval
  - permissions approval
  - structured `requestUserInput`
  - MCP elicitation
  - legacy approval compatibility for `applyPatchApproval` and `execCommandApproval`
- blocked-turn continuation via `turn/steer`
- `/inspect` visibility for pending interactions

This means V3 is no longer purely a design target.
However, V3 is **not complete** yet.
The remaining work is concentrated in control-plane parity, rich input parity, broader runtime visibility, and long-tail protocol surfaces.

---

## 2. Relationship to v1 and v2

### v1

V1 established:

- the single-user Telegram control plane
- the bridge-owned session model
- the long-lived local app-server child
- final-answer delivery plus reduced runtime visibility

V1 also deliberately excluded:

- Telegram approval relay
- Telegram approval callbacks
- structured user-input response flow

### v2

V2 remains focused on:

- structured activity visibility
- better session management
- platform and runtime completeness

V2 does **not** reopen:

- Telegram approval flow
- broad protocol-surface parity
- major expansion beyond the default Telegram-oriented interaction model

### v3

V3 is the release where the product intentionally expands from:

- a Telegram bridge that can start and observe Codex turns

to:

- a Telegram bridge that can participate in the broader Codex app-server interaction contract

This is the first version where protocol-level capability alignment becomes an explicit product goal.

---

## 3. V3 Product Goal

The primary goal of V3 is:

> Make Telegram Codex Bridge capable of completing most Codex app-server mediated tasks inside Telegram without requiring fallback to the native Codex CLI for protocol-supported interactions.

In practical terms, V3 should reduce the class of tasks that currently:

1. start correctly,
2. become blocked on a Codex-side question, approval, or interaction,
3. can only be observed from Telegram,
4. but cannot be completed from Telegram.

---

## 4. Core Product Decision

### Selected V3 direction

V3 should target **protocol parity first, UI parity second**.

That means:

- V3 should aim to support the meaningful Codex app-server protocol surfaces that are relevant to task completion and remote control
- V3 should not aim to reproduce a literal terminal experience inside Telegram
- when terminal-style interactions do not map cleanly, the bridge should provide an adapted Telegram UX rather than pretend to be a raw shell

### Explicit V3 stance

V3 should introduce:

- Telegram-mediated approval flows
- Telegram-mediated structured user-input flows
- blocked-turn recovery and continuation
- broader control-plane parity such as model, review, skills, and richer thread operations

V3 should still avoid:

- turning the default Telegram chat into a protocol dump
- forcing users to read raw JSON-RPC surfaces
- promising full TTY equivalence with the native CLI

---

## 5. Product Tracks

V3 has four product tracks.

### 5.1 Interactive execution continuity

Users should be able to continue tasks that require Codex-side interaction, including:

- command approval
- file-change approval
- permissions approval
- structured question answering
- MCP elicitation
- turn continuation after blocked states

This is the highest-priority V3 track.

### 5.2 Control-plane parity

Users should be able to access more of Codex's protocol-defined control plane from Telegram, including:

- model discovery and selection
- review start flows
- skills discovery and selection
- collaboration mode discovery and selection
- richer thread controls such as fork, rollback, compact, rename, and metadata updates

### 5.3 Rich input parity

V3 should move beyond plain-text prompts where the protocol already supports richer inputs, including:

- image input
- local image input
- structured skill input
- mention-like structured references

### 5.4 Operational parity and visibility

V3 should broaden visibility into protocol-defined runtime and control signals, including:

- request lifecycle visibility
- richer thread and model change signals
- hook, diff, token-usage, and related runtime events
- inspect and audit surfaces strong enough to troubleshoot blocked or drifting sessions

---

## 6. Priority Order

V3 priorities are ordered as follows:

1. **Interactive execution continuity**
2. **Control-plane parity**
3. **Rich input parity**
4. **Operational parity and visibility**

If engineering cannot deliver all tracks equally in one pass, this order wins.

The product must not ship broad control-surface additions while still leaving approval and blocked-turn continuation fundamentally broken.

---

## 7. In Scope

### In scope for V3

1. Telegram handling for protocol server requests
2. approval decisions and structured user-input response flows
3. blocked-turn continuation and turn steering
4. persistence and recovery for pending interactions
5. richer Codex input types supported by the current protocol
6. model, review, skills, and collaboration-mode control surfaces
7. richer thread-control surfaces
8. more complete runtime and audit visibility for these interactions

### Out of scope for V3

1. literal raw-terminal parity
2. full-screen or curses-style terminal UX
3. keystroke-level remote console interaction
4. making Telegram the preferred transport for every realtime or terminal-native workflow
5. cross-machine session migration as a committed scope item
6. arbitrary Telegram browsing of host directories outside the configured project-scan boundary

Deferred note:
- if Telegram-side directory browsing is revisited later, bind it to configured project scan roots instead of exposing the whole host filesystem

---

## 8. Product Principles

### 8.1 No more display-only dead ends

If the bridge shows that Codex is waiting for approval or user input, the user should generally be able to respond from Telegram.

### 8.2 Protocol-backed capability beats invented UX

If the current Codex app-server protocol supports a capability, V3 should prefer implementing it over inventing a parallel bridge-specific substitute.

### 8.3 Telegram remains adapted, not raw

V3 should embrace Telegram-native controls such as messages, buttons, follow-up prompts, and inspect views.
It should not chase fake terminal parity.

### 8.4 Persist first, then render

Any interaction that can change Codex execution state must survive bridge restart and stale-click scenarios.

### 8.5 Keep default chat readable

V3 expands capability, not noise.
The default chat should remain concise, with deeper detail available on demand.

---

## 9. Success Criteria

V3 is successful when the bridge can usually handle, from Telegram alone, the high-value Codex interactions that are currently protocol-supported but bridge-missing.

Product-level success indicators:

1. tasks that require approval or question answering no longer routinely force fallback to native CLI
2. blocked turns can usually be continued in Telegram
3. users can deliberately choose models or review targets when those are protocol-supported
4. the bridge behaves more like a remote Codex control plane than a final-answer adapter
5. remaining non-parity areas are mostly transport-native, not implementation omissions

### Current pending areas

The current bridge still does **not** implement these V3 areas:

1. control-plane parity such as model selection, review start, skills selection, collaboration mode selection, and richer thread controls
2. rich input parity for `image`, `localImage`, `skill`, and `mention`
3. broader runtime notification parity such as token usage, diffs, hooks, terminal interaction, deprecation/config warnings, and `serverRequest/resolved`
4. dynamic or specialized server requests such as `item/tool/call` and `account/chatgptAuthTokens/refresh`
5. realtime/audio and transport-specific extensions

There are also two important implementation-boundary notes for the first V3 slice:

- the persisted interaction lifecycle currently uses `pending`, `awaiting_text`, `answered`, `expired`, and `failed`; there is no separate persisted `canceled` terminal state yet
- interaction creation and resolution still do not emit dedicated debug-journal records beyond the existing turn journal machinery

---

## 10. Engineering Input Expected

Engineering should use:

- the live local `codex-cli` version
- generated JSON Schema from that exact CLI
- current repository code
- current research docs

Engineering should return:

1. a protocol-by-protocol alignment matrix
2. the proposed generic interaction broker design
3. the proposed persistence model for pending interactions
4. the proposed Telegram UX model for approvals and structured questions
5. the proposed blocked-turn continuation model
6. a phased implementation proposal
7. explicit non-goals where Telegram cannot or should not mimic native CLI behavior

The current engineering input document for this is:

- `docs/plans/2026-03-14-codex-cli-capability-alignment-design.md`

The current implementation handoff for the first V3 build slice is:

- `docs/plans/2026-03-14-v3-interaction-broker-phase-1-2-implementation-plan.md`

---

## 11. Final Product Summary

V3 is the release where the bridge should stop being mostly a prompt launcher plus status reducer and start becoming a more complete Telegram-hosted Codex control surface.

V3 is not about copying the native terminal UX.

V3 is about making the bridge capable enough that, for most protocol-defined interactions, the user does not need to abandon Telegram to finish the job.
