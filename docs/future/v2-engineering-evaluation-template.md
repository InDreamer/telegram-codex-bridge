# Telegram Codex Bridge V2 Engineering Evaluation Template

> Truth status:
> - Current truth? No
> - Use for: future direction, PM intent, or dated evaluation
> - Verify current behavior in: current docs, current code, and live schema


Status: Template
For: Engineering evaluation response
Related PRD: `docs/future/v2-prd.md`
Related v1 docs: `AGENTS.md`, `docs/product/v1-scope.md`, `docs/roadmap/phase-1-delivery.md`

---

## 1. Evaluation Summary

### 1.0 Response metadata
- Evaluator:
- Date:
- Repo / branch / commit reviewed:
- Runtime version reviewed:
- Confidence level: `High / Medium / Low`
- Current status: `Researching / Validated / Ready to build / Blocked`

### 1.1 Overall feasibility
- Feasibility: `Fully feasible / Feasible with constraints / Partially feasible / Not recommended as scoped`
- Overall recommendation:
- Recommended V2 scope:
- Recommended deferrals to V3:

### 1.2 One-paragraph conclusion
-

### 1.3 Progress tracking snapshot

| Track | Priority | Status | Confidence | Owner | Main blocker | Next step |
|---|---|---|---|---|---|---|
| Structured activity visibility | P0 |  |  |  |  |  |
| Session management enhancement | P1 |  |  |  |  |  |
| Platform/stability completion | P2 |  |  |  |  |  |

---

## 2. Validation Inputs

Engineering should explicitly confirm what was reviewed.

- [ ] Main v1 docs reviewed
- [ ] Current PRD reviewed
- [ ] Current implementation/code reviewed
- [ ] Current Codex app-server protocol/schema reviewed
- [ ] Official docs reviewed
- [ ] Web research completed if needed

### Notes
- Code/branch/repo reviewed:
- Runtime / Codex version reviewed:
- Protocol/schema source reviewed:
- External docs / links reviewed:

### Evidence register

| Evidence type | Link / path / command | Key finding |
|---|---|---|
| v1 plan |  |  |
| PRD |  |  |
| current code |  |  |
| protocol/schema |  |  |
| official docs |  |  |
| web research |  |  |

---

## 3. Event Surface Assessment

### 3.1 Confirmed native event surface
List the Codex-native events/signals confirmed to exist and be usable.

| Event / Signal | Confirmed? | Stability | Notes |
|---|---|---|---|
| turn lifecycle |  |  |  |
| thread status |  |  |  |
| item started/completed |  |  |  |
| MCP progress |  |  |  |
| plan updates |  |  |  |
| command output delta |  |  |  |
| reasoning stream |  |  |  |
| raw protocol frames |  |  |  |

### 3.2 Event gaps / uncertainty
-

### 3.3 Protocol mismatches vs product expectation
-

---

## 4. Visibility Layer Mapping Proposal

Map events/features into the three-layer visibility model.

### 4.1 Layer A — Default User Layer

| Event / Derived Signal | Show? | Why | Rendering notes |
|---|---|---|---|
|  |  |  |  |

### 4.2 Layer B — User Inspect Layer

| Event / Derived Signal | Show? | Why | Rendering notes |
|---|---|---|---|
|  |  |  |  |

### 4.3 Layer C — Debug Layer

| Event / Derived Signal | Keep? | Why | Access path |
|---|---|---|---|
|  |  |  |  |

### 4.4 Notes on event promotion/demotion
Which signals are borderline and may move between layers later?

-

---

## 5. Normalized Status Model Proposal

Define the product-level state model the bridge should expose.

### 5.1 Proposed top-level status object

```yaml
turn_status:
active_item_type:
last_activity_at:
current_item_duration:
latest_progress:
inspect_available:
debug_available:
error_state:
```

### 5.2 Field definitions

| Field | Meaning | Source | Required? |
|---|---|---|---|
| turn_status |  |  |  |
| active_item_type |  |  |  |
| last_activity_at |  |  |  |
| current_item_duration |  |  |  |
| latest_progress |  |  |  |
| inspect_available |  |  |  |
| debug_available |  |  |  |
| error_state |  |  |  |

### 5.3 Fallback behavior
What should the bridge show when native signal quality is limited?

-

### 5.4 Suggested progress status for this track
- Status: `Not started / Researching / Feasible / Blocked / Ready to build / In implementation`
- Why:
- Next milestone:

---

## 6. Session Management Evaluation

### 6.1 Proposed V2 session scope
- Session list improvements:
- Session state visibility improvements:
- Current active session visibility:
- Archive support:
- Delete support:
- Rename/pin implications:

### 6.2 Same-host rebind continuity
- What can realistically be preserved?
- What cannot be guaranteed?
- What user-visible behavior is recommended?

### 6.3 Risks / edge cases
-

### 6.4 Recommendation
-

### 6.5 Suggested progress status for this track
- Status: `Not started / Researching / Feasible / Blocked / Ready to build / In implementation`
- Why:
- Next milestone:

---

## 7. Platform and Stability Evaluation

### 7.1 macOS / launchd
- Current support reality:
- Proposed V2 scope:
- Install/run/uninstall expectations:
- Risks / blockers:

### 7.2 Readiness / preflight checks
- Current gaps:
- Proposed V2 checks:
- User/operator output expectations:

### 7.3 Restart / recovery / corruption behavior
- Bridge restart handling:
- app-server disconnect/reconnect handling:
- state corruption handling:
- self-heal vs explicit reset recommendation:

### 7.4 Recommendation
-

### 7.5 Suggested progress status for this track
- Status: `Not started / Researching / Feasible / Blocked / Ready to build / In implementation`
- Why:
- Next milestone:

---

## 8. UX / Telegram Delivery Notes

### 8.1 Default chat behavior
- Proposed behavior:
- Update frequency / throttling:
- Single-message edit vs multiple messages:
- Final-answer behavior:

### 8.2 Inspect behavior
- How user requests inspect mode:
- What inspect returns:
- Limits / truncation policy:

### 8.3 Debug behavior
- How debug data is accessed:
- Whether debug should stay out of normal Telegram flow:
- Export/log strategy:

---

### 8.4 Progress reporting recommendation

How should engineering report progress back after evaluation starts?

- Suggested reporting cadence:
- Suggested milestone granularity:
- Suggested blocker escalation rule:
- Suggested demo/verification checkpoints:

---

## 9. Risks and Open Questions

### 9.1 Major risks
| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
|  |  |  |  |

### 9.2 Open questions needing PM decision
-

### 9.3 Open questions needing protocol validation
-

---

### 9.4 Decisions needed from PM before implementation

| Decision | Why needed | Recommended answer | Deadline |
|---|---|---|---|
|  |  |  |  |

---

## 10. Recommended Delivery Plan

### Option A — Single-phase V2
- Scope:
- Why:
- Risks:

### Option B — Phased V2

#### Phase 2A
- Scope:
- Acceptance target:

#### Phase 2B
- Scope:
- Acceptance target:

#### Phase 2C
- Scope:
- Acceptance target:

### Recommended option
-

---

### 10.1 Implementation tracking proposal

| Workstream | Proposed milestone | Entry condition | Exit condition | Owner | ETA |
|---|---|---|---|---|---|
| Structured activity visibility |  |  |  |  |  |
| Session management |  |  |  |  |  |
| Platform/stability |  |  |  |  |  |

---

## 11. Acceptance Readiness Check

For each product requirement area, provide a readiness judgement.

| Area | Ready now | Needs research | Needs PM change | Not recommended |
|---|---|---|---|---|
| Structured activity visibility |  |  |  |  |
| Visibility layering |  |  |  |  |
| Inspect path |  |  |  |  |
| Debug path |  |  |  |  |
| Session management |  |  |  |  |
| Same-host rebind continuity |  |  |  |  |
| macOS persistence |  |  |  |  |
| readiness / preflight |  |  |  |  |
| restart/recovery |  |  |  |  |
| corruption fallback |  |  |  |  |

### 11.1 Requirement-to-workstream traceability

| PRD area | Proposed workstream | Status | Owner | Evidence |
|---|---|---|---|---|
| Structured activity visibility |  |  |  |  |
| Session management enhancement |  |  |  |  |
| Platform/stability completion |  |  |  |  |

---

## 12. Final Engineering Recommendation

### Recommended V2 scope to build
-

### Recommended exclusions / V3 deferrals
-

### Suggested next implementation step
-

### First checkpoint output expected from engineering
- date:
- expected artifact(s):
- expected unresolved blockers by then:
