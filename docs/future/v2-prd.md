# Telegram Codex Bridge V2 PRD

Status: Draft for engineering evaluation
Owner: Product
Last updated: 2026-03-10
Related v1 docs: `AGENTS.md`, `docs/product/v1-scope.md`, `docs/roadmap/phase-1-delivery.md`

---

## 1. Document Purpose

This document defines the **product requirements for Telegram Codex Bridge V2**.

Its purpose is to give engineering a clear, bounded product target to evaluate and implement.
Engineering should use:

1. the current v1 documentation set,
2. the current code / current implementation progress,
3. official Codex app-server protocol/docs,
4. web research if needed,

to assess feasibility, confirm interfaces, propose implementation details, and identify any contract mismatches.

This is a **PM-level product requirements document**, not a protocol spec and not an implementation design.

---

## 2. Relationship to v1

V2 does **not** change the frozen v1 boundary:

- v1 runtime assumption remains: `operator-managed full access / no-Telegram-approval`
- Telegram remains the control plane for the Codex runtime already on the host
- v2 does not introduce Telegram approval flow
- v2 does not introduce tool-log live streaming as the main user experience
- v2 does not introduce cross-machine migration as a committed scope item

V2 is an enhancement release on top of the existing product boundary.

### v2 product intent

V2 should move the product from:
- **usable but opaque**

to:
- **observable, inspectable, and better structured**

without turning Telegram chat into a noisy debugging console.

---

## 3. Product Goal

The primary goal of V2 is:

> Make Telegram Codex Bridge feel like a more complete product by improving long-task visibility, session manageability, and deployment/runtime robustness — while keeping the default Telegram experience simple.

V2 has three product tracks:

1. **Structured activity visibility**
   - let users understand whether a task is active
   - let users understand what kind of work Codex is currently doing
   - let users inspect more detail when needed

2. **Session management enhancement**
   - make multiple sessions easier to understand and operate
   - improve session continuity after same-host rebind
   - improve session listing and state clarity

3. **Platform and stability completion**
   - improve readiness checks and operational diagnostics
   - improve restart/recovery behavior and safe fallback behavior
   - close the macOS persistence gap, especially `launchd`-based installation/runtime persistence

This should be achieved by using **Codex-native structured activity signals** where available, rather than inventing an AI-generated narration layer.

### 3.1 Priority order

V2 priorities are ordered as follows:

1. **Structured activity visibility**
2. **Session management enhancement**
3. **Platform and stability completion**

If engineering finds that all three tracks cannot be delivered at equal depth in one pass, this priority order wins.

V2 should not lose the first track in order to over-invest in lower-priority tracks.

### 3.2 PM preferred shape of V2

To keep engineering aligned with product intent, PM preference for V2 is:

1. **Activity visibility** is the primary user-facing win and should ship first.
2. **Session management** should become clearer and safer, but should stay conservative:
   - same-host continuity only,
   - archive-first thinking,
   - do not imply hard-delete-heavy management unless it is clearly safe.
3. **Platform/stability** should close credibility gaps that make the product feel unfinished:
   - macOS `launchd` matters,
   - readiness/preflight clarity matters,
   - restart/corruption behavior must be understandable.

---

## 4. Core Product Decision

### Selected V2 direction

V2 uses **structured activity flow**, not productized narration flow.

That means:
- bridge should consume Codex native events
- bridge should preserve raw activity information internally
- bridge should expose a simplified structured status by default
- bridge may allow the user to inspect more detail on demand
- bridge should keep low-level debug data available for diagnostics

### Explicit non-goal for V2

V2 does **not** aim to generate polished stage copy such as:
- "正在分析关键文件"
- "正在整理结论"

unless such wording is directly backed by a stable Codex-native signal.

The bridge should **map**, **summarize**, and **gate visibility**, but should not invent a fake semantic state machine.

---

## 5. User Problem

In v1, long-running tasks can feel too opaque.

Typical user perception today:
- task started
- then little or no visible signal for a long time
- final answer eventually arrives

This is acceptable for short tasks, but poor for long tasks (for example 10 minutes, 1 hour, or 2 hours).

Users need to know:
1. whether the task is still alive,
2. what kind of work is happening now,
3. whether there is more detail available if they want it,
4. how to get debugging information when something appears stuck or broken.

---

## 6. Scope of V2

### In scope

1. **Structured activity visibility**
   - surface current task activity using Codex-native event flow
   - show stable, low-noise status in Telegram by default

2. **Visibility layering**
   - default user layer
   - user inspect / expanded layer
   - debug layer

3. **Raw signal preservation**
   - bridge should retain raw event information needed for later inspection and debugging
   - visibility policy should not require discarding source data

4. **Long-task observability**
   - improve user confidence during long-running turns
   - avoid single stale "still processing" state for extended durations when native activity is available

5. **Product-level event classification policy**
   - define which event classes are default-visible
   - define which are inspect-only
   - define which are debug-only

6. **Session management enhancement**
   - clearer session list and session state visibility
   - session archive/delete strategy assessment and product decision
   - same-host rebind continuity expectations and recovery behavior
   - better current-session awareness and session switching clarity

7. **Platform and stability completion**
   - macOS `launchd`-based persistence / service installation experience
   - clearer readiness / preflight checks
   - better recovery from bridge restart, app-server loss, and state damage
   - safer self-heal or explicit fallback behavior instead of silent failure

### Out of scope

1. Cross-machine migration / session portability
2. Telegram approval / approval callback flow
3. Full tool-log live streaming as the default user experience
4. Provider/model/prompt reasoning visualization
5. New transport architecture beyond existing app-server-based bridge direction
6. Re-defining v1 authorization model
7. Rich UI beyond Telegram-compatible message/update mechanics
8. Cross-host data replication or migration workflows

---

## 7. Key Product Principles

### 7.1 Preserve everything, show selectively

The bridge should preserve raw activity signals internally.
The product should decide visibility at the presentation layer, not by dropping information at collection time.

### 7.2 Default chat should remain simple

Normal Telegram usage should stay clean.
The default path should not become a log tail, debug console, or protocol frame viewer.

### 7.3 Use Codex-native structure first

If Codex provides a stable structured signal, V2 should use it.
If Codex does not provide a stable signal, V2 should avoid pretending the bridge knows more than it does.

### 7.4 Inspect is not debug

There must be a clear distinction between:
- more detail useful to a normal user
- low-level detail useful only for troubleshooting

### 7.5 Long tasks must look alive

For long-running tasks, the product should provide enough structured activity to reassure the user that work is continuing, without flooding them.

### 7.6 Session continuity must be defined precisely

V2 should improve session management and continuity, but only within the same bridge host boundary.

Product wording must not imply cross-machine portability.
If continuity cannot be guaranteed after a given recovery path, the product must say so clearly.

### 7.7 Stability gaps should be closed at the product level

Platform/runtime reliability is part of the product, not just an implementation detail.

If macOS persistence, readiness checks, restart recovery, or corruption fallback remain incomplete, V2 should explicitly define the intended product behavior and expected user/operator experience.

---

## 8. Visibility Model

V2 introduces three visibility layers.

### 8.1 Layer A — Default User Layer

This is what a user sees in normal Telegram usage.

Purpose:
- provide minimal, useful, low-noise visibility

This layer should answer only:
1. has the turn started,
2. is it still active,
3. what kind of work is currently active,
4. when was the last observable activity,
5. did it complete / fail / get interrupted.

#### Expected content in default layer

- turn state
- current active item/activity type
- last activity timestamp / relative age
- current activity duration (if useful and stable)
- latest human-readable native progress message when available and low-noise (for example MCP progress)

#### Examples of acceptable default outputs

- `turn: running`
- `active: commandExecution`
- `last activity: 12s ago`
- `active: webSearch`
- `turn: interrupted`

This layer should stay compact.

---

### 8.2 Layer B — User Inspect Layer

This layer is **hidden by default**, but available when the user explicitly requests more detail.

Purpose:
- provide structured operational detail without exposing raw protocol/debug noise

This layer should include structured summaries such as:
- activity timeline
- recent activity transitions
- current or recent command summary
- current or recent file-change summary
- current or recent web-search summary
- current or recent MCP tool-call summary
- plan snapshot when available and useful
- recent structured activity list

This layer is for a user asking:
- "show me what it is doing"
- "show more detail"
- "inspect current task"

This layer should still be readable by a normal product user.
It should not require protocol literacy.

---

### 8.3 Layer C — Debug Layer

This layer is not part of the normal chat flow.

Purpose:
- provide low-level troubleshooting data for implementation validation, bug investigation, and operational diagnostics

This layer may include:
- raw event deltas
- raw command output deltas
- raw file change deltas
- reasoning-related stream events
- raw JSON-RPC notifications / requests / responses
- reconnect / EOF / framing / protocol errors
- account / config / system notifications
- other noisy or low-level runtime details

This layer should be treated as:
- diagnostic output,
- support tooling,
- debug export,
- `/doctor`-style visibility,

not as normal Telegram UX.

---

## 9. Event Classification Requirements

Engineering should classify Codex-native events into the three visibility layers above.

### 9.1 Default-visible event categories

By product intent, the following categories should normally be visible in Layer A:

1. **Turn lifecycle**
   - started
   - completed
   - failed
   - interrupted

2. **Current active work type**
   - planning
   - command execution
   - file change
   - MCP tool call
   - web search
   - agent message production
   - other stable activity types confirmed by implementation

3. **Low-noise progress presence**
   - last activity time
   - active duration
   - limited native progress message if stable and useful

### 9.2 Inspect-visible event categories

By product intent, the following should normally appear in Layer B rather than Layer A:

1. activity transition history
2. command summary (not raw rolling output)
3. file change summary (not raw diff stream)
4. plan snapshot / plan status when meaningful
5. tool call summary
6. recent structured items/events relevant to user understanding

### 9.3 Debug-only event categories

By product intent, the following should default to Layer C:

1. raw output deltas
2. reasoning stream events
3. raw protocol frames
4. high-frequency internal notifications
5. account/config/system noise not directly tied to the user’s task state
6. reconnect / transport / framing details

---

## 10. Required Product Behavior

### 10.1 Collection behavior

The bridge must preserve raw activity information required for:
- default status rendering,
- inspect rendering,
- debug rendering,
- diagnostics,
- future iteration.

V2 must not depend on losing raw signal fidelity.

### 10.2 Default Telegram behavior

When a user is not asking for detail:
- show only Layer A information during execution
- keep updates compact
- avoid noisy repeated messages
- avoid exposing raw deltas/log tails
- preserve final-answer-first experience at turn completion

### 10.3 On-demand inspect behavior

When a user explicitly asks for more detail:
- show Layer B information
- present structured summaries rather than raw protocol data
- keep it readable in Telegram
- make it clear that this is an expanded view, not the default view

### 10.4 Debug behavior

When debugging is explicitly requested or when engineering diagnostics are being used:
- Layer C data must be accessible
- the product may expose debug output through dedicated diagnostic surfaces, commands, exports, or logs
- raw debug detail should not accidentally leak into normal task conversation flow

### 10.5 Long-running task behavior

For long-running turns, the bridge should continue reflecting current structured activity whenever native events continue to arrive.

The user should not be left with one stale generic state for an extended period when the underlying Codex runtime is still emitting structured activity.

### 10.6 Unknown or unsupported native signals

If the runtime emits signals that are:
- unstable,
- undocumented,
- too noisy,
- or not clearly user-useful,

engineering may keep them in preserved raw data and classify them into Layer C until a future product decision upgrades them.

### 10.7 Session management behavior

V2 must also improve session management as a product surface.

At minimum, engineering should evaluate and specify:
- what a user can see in the session list,
- what session states are user-visible,
- whether archive/delete is supported in V2 and under what guardrails,
- how current active session is identified,
- how same-host rebind affects old sessions,
- what happens when continuity cannot be restored.

#### Product requirements for session management

1. Session list must be easier to understand than v1.
2. Session state must be clearer to the user.
3. Same-host rebind continuity should be improved where underlying data still exists.
4. Product copy and behavior must remain honest when continuity is not possible.
5. Cross-machine continuity must not be implied.
6. PM preference is **archive-first, delete-cautious** unless engineering proves a stronger deletion model is safe and understandable.
7. At minimum, the session list should be able to represent:
   - session name,
   - project,
   - last activity / last used time,
   - state,
   - current active-session marker.

### 10.8 Platform and stability behavior

V2 must also improve platform/runtime completeness.

At minimum, engineering should evaluate and specify:
- macOS `launchd` persistence/install story,
- startup/readiness checks,
- diagnostics surface expectations,
- restart recovery behavior,
- state corruption handling,
- app-server disconnect/reconnect behavior,
- self-heal vs explicit reset policy.

#### Product requirements for platform/stability

1. The product should provide a more complete macOS experience, not only Linux/VPS friendliness.
2. The product should detect missing prerequisites earlier and explain them more clearly.
3. Restart and reconnect behavior should be easier for users/operators to understand.
4. Corruption or invalid state should fail explicitly and recover safely.
5. Silent broken states should be minimized.
6. PM expectation is that macOS `launchd` persistence is part of the intended V2 product story; if engineering cannot ship it in V2, that gap must be called out explicitly as a partial delivery rather than silently downgraded.
7. PM expectation is that readiness/preflight and recovery behavior should be defined as visible product behavior, not only internal implementation notes.

---

## 11. Product Deliverables

### 11.0 Release-gate rule

V2 should not be declared "product-complete" if it improves only one secondary area while leaving the primary visibility problem essentially unchanged.

Likewise, V2 should not present itself as a complete Mac story if macOS persistence remains materially unresolved.


V2 should deliver the following product outcomes:

1. **A stable visibility policy**
   - event categories mapped into default / inspect / debug layers

2. **A stable status model**
   - a normalized product-level representation of current turn state and current active activity

3. **A clean default Telegram experience for long tasks**
   - enough visibility to reassure the user the task is active
   - no raw log streaming by default

4. **An inspect path**
   - users can request more detail without needing full debug mode

5. **A debug path**
   - engineering/support can access raw details when needed

6. **A clearer session-management surface**
   - easier session list, state visibility, and same-host continuity expectations

7. **A stronger platform/runtime surface**
   - improved macOS persistence story
   - clearer readiness checks and diagnostics
   - better restart/recovery/corruption behavior

---

## 12. Product Acceptance Criteria

V2 can be considered product-complete only if all of the following are true.

### 12.1 Default experience

1. A long-running task no longer appears as a mostly opaque black box.
2. A user can tell whether a turn is running, completed, failed, or interrupted.
3. A user can see the current active work type at a high level.
4. Default Telegram output remains concise and non-noisy.

### 12.2 Inspect experience

5. A user can explicitly request more task detail.
6. The expanded view provides structured detail that is more informative than the default view.
7. The expanded view does not degrade into raw protocol noise.

### 12.3 Debug experience

8. Raw runtime details remain available for troubleshooting.
9. Debug data does not spill into the normal user flow by default.
10. Engineering can use preserved raw data to validate or diagnose bridge behavior.

### 12.4 Session management

11. Session list and session state are clearer than in v1.
12. Same-host rebind continuity behavior is explicitly defined and reflected honestly in product behavior.
13. V2 does not imply cross-machine session portability.

### 12.5 Platform and stability

14. macOS persistence/install expectations are explicitly addressed in the product and engineering plan.
15. Readiness/preflight failures are surfaced more clearly than in v1.
16. Restart/recovery/corruption behavior is defined and testable.
17. Silent broken states are reduced.

### 12.6 Scope discipline

18. V2 does not drift into approval flow, cross-machine migration, or productized AI narration.
19. V2 remains compatible with the frozen v1 trust/runtime boundary.

---

## 13. Engineering Evaluation Request

Engineering should evaluate this PRD against:

1. the current main v1 plan,
2. the current bridge implementation status,
3. the real Codex app-server protocol surface available in the target runtime,
4. official docs / generated schema / protocol bindings,
5. web research if any contract or behavior remains unclear.

Engineering should return:

1. a feasibility assessment,
2. the proposed event-to-layer mapping table,
3. the proposed normalized status model,
4. the proposed session-management scope and behavior for V2,
5. the proposed macOS/platform/stability scope and behavior for V2,
6. an explicit recommended cut line if full V2 scope cannot ship in one pass,
7. identified protocol/runtime/platform dependencies and risks,
8. any mismatch between product expectations and real Codex runtime behavior,
9. a phased implementation proposal if required.

---

## 14. V3 Markers (Not in V2)

The following topics are explicitly deferred to V3 or later unless product re-opens scope:

1. cross-machine session migration / portability
2. richer productized narration or semantic explanation layers
3. more advanced migration/export/import flows
4. richer UI surfaces beyond current Telegram-oriented interaction model
5. any major expansion beyond structured activity visibility, session-management enhancement, and platform/stability completion

---

## 15. Final Product Summary

V2 is not about making Telegram verbose.

V2 is about making the bridge feel more complete across three dimensions:

- **structured activity visibility**,
- **better session management**,
- **stronger platform/runtime completeness**.

Within that, V2 introduces a disciplined visibility model:

- **collect everything**,
- **show simple structured status by default**,
- **allow deeper structured inspection on demand**,
- **keep raw detail for debugging**.

That is the product target engineering should now validate and implement.
