# App-Server Phase 0 Verification

Read `docs/research/codex-app-server-authoritative-reference.md` first when you need the latest app-server usage guidance or broader API inventory.

This document is a dated runtime sample captured on 2026-03-09 and should be treated as historical verification evidence, not the top source for the latest CLI surface.

This document records the observed protocol facts gathered from the local `codex app-server` binary on 2026-03-09.

Use this document as dated runtime evidence for behaviors observed in the `codex-cli 0.112.0` sample. When it conflicts with the current CLI, generated schema, or `docs/research/codex-app-server-authoritative-reference.md`, prefer the newer sources and keep this file for historical comparison.

## Verified Environment

Binary:
- `codex` at `/home/ubuntu/.local/bin/codex`

Version:
- `codex-cli 0.112.0`

## Verified Startup Contract

Start command:

```bash
codex app-server --listen stdio://
```

Verified rules:
- pass `--listen stdio://` explicitly even though it is the default
- startup should complete within 5 seconds
- stdout should carry JSON-RPC frames only
- stderr may remain empty during healthy startup
- bridge readiness should require a non-destructive follow-up request after `initialize` and `initialized`

Verified follow-up probe:
- `thread/list`

## Handshake Verification

Before initialization, the server rejects operational calls:

```json
{ "id": 1, "method": "thread/start", "params": { "cwd": "/home/ubuntu/Repo" } }
```

Observed error:

```json
{ "error": { "code": -32600, "message": "Not initialized" }, "id": 1 }
```

Verified initialize request:

```json
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "phase0_probe",
      "version": "0.1.0"
    }
  }
}
```

Observed response shape:

```json
{
  "id": 1,
  "result": {
    "userAgent": "phase0_probe/0.112.0 (Ubuntu 24.4.0; x86_64) ..."
  }
}
```

Verified notification:

```json
{ "method": "initialized", "params": {} }
```

Repeated `initialize` returns:

```json
{ "error": { "code": -32600, "message": "Already initialized" }, "id": 3 }
```

## Verified Thread Lifecycle

Verified `thread/start` request:

```json
{
  "id": 2,
  "method": "thread/start",
  "params": {
    "cwd": "/home/ubuntu/Repo",
    "approvalPolicy": "never"
  }
}
```

Observed response shape includes:
- `result.thread.id`
- `result.thread.status`
- `result.cwd`
- `result.approvalPolicy`
- `result.sandbox`

Observed follow-up notification:

```json
{ "method": "thread/started", "params": { "thread": { "id": "..." } } }
```

Verified `thread/resume`:
- request uses `threadId`
- response includes the resumed thread plus historical turns

## Verified Turn Lifecycle

Verified `turn/start` request:

```json
{
  "id": 3,
  "method": "turn/start",
  "params": {
    "threadId": "019cd26e-b837-7532-b767-cba59c4a39b3",
    "input": [
      { "type": "text", "text": "Reply with exactly: PHASE0_OK" }
    ],
    "cwd": "/home/ubuntu/Repo",
    "approvalPolicy": "never"
  }
}
```

Observed immediate response:

```json
{
  "id": 3,
  "result": {
    "turn": {
      "id": "019cd26e-b845-7fd2-ad3f-f5539f138f41",
      "items": [],
      "status": "inProgress",
      "error": null
    }
  }
}
```

Observed notifications:
- `turn/started`
- `turn/completed`

## Verified Final-Answer Extraction

Observed fast-path runtime event:
- `method = codex/event/task_complete`
- `params.msg.last_agent_message = "PHASE0_OK"`

Observed durable historical path through resumed turns:
- `items[].type = "agentMessage"`
- `items[].text = "PHASE0_OK"`
- `items[].phase = "final_answer"`

Observed extra stdout namespaces:
- `codex/event/*`
- `thread/status/changed`
- `account/rateLimits/updated`

Conclusion:
- stdout must be treated as a mixed notification stream, not only `thread/*` and `turn/*`

## Approval Surface

Runtime `requestApproval` behavior was not captured reliably.

This does not block v1 because approval handling is explicitly out of scope.

## Verified Interrupt Behavior

Verified request:

```json
{
  "id": 6,
  "method": "turn/interrupt",
  "params": {
    "threadId": "019cd26e-b837-7532-b767-cba59c4a39b3",
    "turnId": "019cd26e-cd7c-7be1-a0fc-7026e988fee0"
  }
}
```

Observed immediate response:

```json
{ "id": 6, "result": {} }
```

Observed follow-up:
- `codex/event/turn_aborted`
- `turn/completed` with `turn.status = "interrupted"`

## Verified Connection-Close Behavior

When the local app-server child was terminated by the parent:
- the process exited with code `0` in the verified run
- stdout reached EOF
- no protocol-level shutdown frame was observed
- stderr remained empty in the verified run

Operational conclusion:
- child exit and stdout EOF are the authoritative connection-close signals for the bridge

## Verified Field Names

Important observed fields:
- thread id: `thread.id` and `params.threadId`
- turn id: `turn.id` and `params.turnId`
- final assistant message from resumed history: `items[].text` where `items[].type = "agentMessage"` and `phase = "final_answer"`
- fast final shortcut: `params.msg.last_agent_message` on `codex/event/task_complete`
- interrupt targets: `threadId`, `turnId`

## Mismatches Versus Earlier Assumptions

1. stdout event traffic is broader than only `thread/*`, `turn/*`, and `item/*`
2. `thread/start` returns a richer payload than the earlier minimal assumption
3. approval remains unverified at runtime, but no longer blocks v1
4. readiness should include a non-destructive follow-up request after initialization

## Final Phase 0 Conclusion

Phase 1 can proceed.

The handshake, thread lifecycle, turn lifecycle, final-answer extraction, interrupt behavior, and connection-close behavior are sufficiently verified for the narrowed v1 scope.
