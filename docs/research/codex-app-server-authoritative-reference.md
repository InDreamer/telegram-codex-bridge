# Codex App-Server Authoritative Reference

Last refreshed: 2026-03-12

Primary audience:
- in-repo Codex/LLM agents

Secondary audience:
- human maintainers who need a quick current-state reference

## What This Document Is For

Use this document when you need to:
- decide whether a feature should use `codex app-server`
- add or change Codex integration behavior in this repository
- discover the broader current API surface without relying on stale model memory
- resolve conflicts between older local verification notes and newer CLI/schema facts

For a per-method schema-oriented lookup, read:
- `docs/research/codex-app-server-api-quick-reference.md`

This document is the repository's LLM-first app-server guide. It is intentionally opinionated about source priority so agents do not over-trust outdated knowledge.

## Source Priority

When sources disagree, use this order:

1. Current local `codex-cli` version on the host
2. JSON Schema or TypeScript bindings generated from that exact CLI version
3. Official OpenAI Codex app-server and CLI docs
4. Repository code and current-state docs
5. Historical verification docs and planning docs

For this host on 2026-03-12:
- `codex --version` returned `codex-cli 0.114.0`
- `codex app-server --help` confirmed:
  - `--listen stdio://` default transport
  - `--listen ws://IP:PORT` available
  - `generate-ts`
  - `generate-json-schema`

Important implication:
- the older runtime sample in `docs/research/app-server-phase-0-verification.md` remains useful evidence, but it is a dated `0.112.0` sample and must not outrank the current `0.114.0` CLI plus generated schema.

## Official References

Primary official docs:
- App Server: <https://developers.openai.com/codex/app-server>
- CLI reference: <https://developers.openai.com/codex/cli/reference>

Official guidance that matters for this repository:
- use app-server for deep integrations that need threads, streaming events, approvals, history, or richer control surfaces
- use `codex exec` or SDK-style automation for non-interactive one-shot automation and CI
- app-server uses JSON-RPC 2.0 style messages
- default transport is `stdio://`
- `ws://` is available but still experimental
- schema generation is an officially supported path and should be preferred over memory for exact surface details

## Decision Guide

Use `codex app-server` when you need:
- a long-lived local integration
- durable threads and resumable conversations
- turn lifecycle control
- event streaming
- structured tool, item, and plan notifications
- approval or user-input surfaces
- richer product integrations such as chat bridges, IDEs, or custom agent shells

Do not default to app-server when you only need:
- one-shot automation
- CI or batch execution
- a simple non-interactive command

In those cases, prefer:
- `codex exec`
- the Codex SDK wrapper around CLI execution

## Repository-Specific Contract

This repository currently uses app-server in a narrow but production-relevant way:

- transport: one long-lived local `codex app-server` child over `stdio`
- ownership: the bridge process starts, monitors, restarts, and reconnects the child
- readiness: `initialize` -> `initialized` -> `thread/list`
- session model: one bridge session maps to one Codex thread
- turn model: normal Telegram text becomes `turn/start` input
- output policy: Telegram receives only the final answer, not raw tool chatter

Relevant local docs:
- `docs/architecture/runtime-and-state.md`
- `docs/research/app-server-phase-0-verification.md`

Implementation rule for this repo:
- use the broader app-server surface to inform future work, but do not assume current bridge code already consumes it

## Correct Usage Rules For LLMs

Follow these rules before changing any app-server integration:

1. Check the local CLI version first with `codex --version`.
2. If exact methods or fields matter, generate schema from the current CLI before editing code.
3. Prefer `stdio://` unless the product explicitly needs remote or GUI-oriented WebSocket transport.
4. Always include the full initialization sequence before operational calls.
5. Treat stdout as a mixed event stream, not only `thread/*` and `turn/*`.
6. Do not invent field names from memory when the schema can answer them exactly.
7. Treat historical `codex/event/*` samples as compatibility evidence, not as the primary spec.
8. If a change depends on approval or user-input flows, inspect `ServerRequest.json` from the current schema first.
9. If a change depends on richer item semantics, inspect `item/*` notifications and `thread/read` or `thread/resume` response shapes before coding.
10. If the current CLI and older repo docs disagree, update the docs and code toward the current CLI unless the repository intentionally pins older behavior.

## Minimal Correct Integration Flow

### Startup and readiness

1. Start `codex app-server`
2. Send `initialize`
3. Send `initialized`
4. Send a non-destructive probe such as `thread/list`
5. Only then treat the server as ready

Why:
- historical runtime verification showed operational calls fail before initialization
- official docs treat initialization as part of the JSON-RPC contract

### New conversation flow

1. `thread/start`
2. persist `thread.id`
3. `turn/start`
4. consume notifications until turn completion
5. derive or recover the final answer

### Existing conversation flow

1. `thread/resume`
2. `turn/start`
3. consume notifications until turn completion

### Interrupt flow

1. `turn/interrupt`
2. expect completion or interruption signals after the request returns

### Final answer handling

Preferred order:
1. live final assistant content from the current event stream
2. durable turn history from `thread/read` or `thread/resume`
3. only then fall back to compatibility shortcuts such as historically observed `codex/event/task_complete`

Commentary rule for integrations:
- treat completed `agentMessage` items as authoritative when `phase = commentary`
- treat `item/agentMessage/delta` as streamed text only, not the authoritative commentary record

## Current Host Baseline

Current host runtime facts captured on 2026-03-12:

- CLI version: `codex-cli 0.114.0`
- app-server help confirms:
  - `--listen stdio://` default
  - `--listen ws://IP:PORT`
  - `generate-ts`
  - `generate-json-schema`
- schema generation command used:

```bash
codex app-server generate-json-schema --experimental --out <dir>
```

LLM rule:
- when in doubt, regenerate schema instead of guessing

## API Surface Inventory

This section summarizes the current `0.114.0` schema inventory. For exact request and response fields, generate JSON Schema or TypeScript bindings from the current CLI.

### Client requests

Core lifecycle and thread control:
- `initialize`
- `thread/start`
- `thread/resume`
- `thread/fork`
- `thread/archive`
- `thread/unarchive`
- `thread/unsubscribe`
- `thread/list`
- `thread/loaded/list`
- `thread/read`
- `thread/name/set`
- `thread/metadata/update`
- `thread/rollback`
- `thread/compact/start`
- `thread/backgroundTerminals/clean`
- `thread/increment_elicitation`
- `thread/decrement_elicitation`

Turn control:
- `turn/start`
- `turn/steer`
- `turn/interrupt`

Realtime thread surface:
- `thread/realtime/start`
- `thread/realtime/appendAudio`
- `thread/realtime/appendText`
- `thread/realtime/stop`

Model and runtime discovery:
- `model/list`
- `experimentalFeature/list`
- `collaborationMode/list`

Review, skills, apps, and plugins:
- `review/start`
- `skills/list`
- `skills/remote/list`
- `skills/remote/export`
- `skills/config/write`
- `plugin/list`
- `plugin/install`
- `plugin/uninstall`
- `app/list`

MCP and external agent support:
- `mcpServer/oauth/login`
- `config/mcpServer/reload`
- `mcpServerStatus/list`
- `externalAgentConfig/detect`
- `externalAgentConfig/import`

Account and feedback:
- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/rateLimits/read`
- `account/read`
- `feedback/upload`

Command execution and utilities:
- `command/exec`
- `command/exec/write`
- `command/exec/terminate`
- `command/exec/resize`
- `fuzzyFileSearch`
- `fuzzyFileSearch/sessionStart`
- `fuzzyFileSearch/sessionUpdate`
- `fuzzyFileSearch/sessionStop`

Config management:
- `config/read`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`

Experimental or test-only surface visible in current schema:
- `mock/experimentalMethod`
- `windowsSandbox/setupStart`

### Server notifications

Core lifecycle:
- `error`
- `thread/started`
- `thread/status/changed`
- `thread/archived`
- `thread/unarchived`
- `thread/closed`
- `thread/name/updated`
- `thread/tokenUsage/updated`
- `turn/started`
- `turn/completed`
- `turn/diff/updated`
- `turn/plan/updated`

Item streaming:
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/fileChange/outputDelta`
- `item/mcpToolCall/progress`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`

Command and hook side channels:
- `command/exec/outputDelta`
- `hook/started`
- `hook/completed`

Model, config, and deprecation signals:
- `model/rerouted`
- `configWarning`
- `deprecationNotice`

Account, app, and skills signals:
- `account/updated`
- `account/rateLimits/updated`
- `account/login/completed`
- `app/list/updated`
- `skills/changed`

MCP and server-request bookkeeping:
- `mcpServer/oauthLogin/completed`
- `serverRequest/resolved`

Fuzzy file search:
- `fuzzyFileSearch/sessionUpdated`
- `fuzzyFileSearch/sessionCompleted`

Context and realtime signals:
- `thread/compacted`
- `thread/realtime/started`
- `thread/realtime/itemAdded`
- `thread/realtime/outputAudio/delta`
- `thread/realtime/error`
- `thread/realtime/closed`

Platform-specific signals:
- `windows/worldWritableWarning`
- `windowsSandbox/setupCompleted`

### Server requests

Approval and user-input surface:
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

Dynamic tool and patch-related surface:
- `item/tool/call`
- `applyPatchApproval`
- `execCommandApproval`

Auth refresh:
- `account/chatgptAuthTokens/refresh`

Important rule:
- if your feature needs approvals, permissions, or structured user input, do not guess the request/response format. Inspect the current generated schema first.

## High-Value Parameter Facts From The Current Schema

These are especially useful because they affect how integrations should be written.

`TurnStartParams`:
- required: `threadId`, `input`
- optional overrides include:
  - `cwd`
  - `model`
  - `approvalPolicy`
  - `sandboxPolicy`

`ThreadStartParams`:
- optional fields include:
  - `cwd`
  - `model`
  - `approvalPolicy`
  - `sandbox`

`ThreadResumeParams`:
- required: `threadId`
- optional:
  - `approvalPolicy`

`TurnInterruptParams`:
- required: `threadId`, `turnId`

Practical implication:
- model, approval, cwd, and sandbox choices can be scoped at thread start and at turn start
- future work should not hardcode only one of those layers without checking the current schema

## Legacy And Extra Runtime Signals

The historical local verification sample recorded additional runtime namespaces such as:
- `codex/event/task_complete`
- `codex/event/turn_aborted`

Those names were useful in the bridge's early implementation and may still appear for compatibility, but they are not the primary source for new work. For new integrations:
- prefer the current generated schema
- keep compatibility handling only when the repository already depends on it
- document any newly observed runtime-only signals with date and CLI version

## What This Repository Uses Today

Current bridge usage is intentionally narrower than the full `0.114.0` schema surface.

Implemented today:
- app-server child over `stdio`
- `initialize` + `initialized`
- readiness probe with `thread/list`
- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/interrupt`
- classification of selected notifications such as:
  - `turn/started`
  - `turn/completed`
  - `thread/status/changed`
  - `item/started`
  - `item/completed`
  - `item/agentMessage/delta`
  - `item/plan/delta`
  - `item/commandExecution/outputDelta`
  - `item/fileChange/outputDelta`
  - `item/mcpToolCall/progress`
  - compatibility handling for `codex/event/task_complete`
  - compatibility handling for `codex/event/turn_aborted`

Explicitly not relied on by current v1 bridge behavior:
- approval workflows
- server-side user-input workflows
- realtime thread APIs
- plugin or skills management APIs
- MCP OAuth flows
- command/exec surface

LLM warning:
- do not assume unimplemented surfaces are unsupported by Codex; many are present in the current schema and simply not wired into this bridge yet

## Refresh Workflow

When you need to refresh this document:

1. Record the date and host
2. Run:

```bash
codex --version
codex app-server --help
codex app-server generate-json-schema --experimental --out <dir>
```

3. Extract the inventories:

```bash
jq -r '.oneOf[]?.properties.method.enum[]? // empty' <dir>/ClientRequest.json
jq -r '.oneOf[]?.properties.method.enum[]? // empty' <dir>/ServerNotification.json
jq -r '.oneOf[]?.properties.method.enum[]? // empty' <dir>/ServerRequest.json
```

4. Re-read official docs:
- <https://developers.openai.com/codex/app-server>
- <https://developers.openai.com/codex/cli/reference>

5. Compare against:
- `docs/architecture/runtime-and-state.md`
- `docs/research/app-server-phase-0-verification.md`
- `src/codex/app-server.ts`
- `src/codex/notification-classifier.ts`
- `src/service.ts`

6. Update this document's:
- refresh date
- local CLI version
- API inventories
- repository usage notes
- legacy compatibility notes

## Hard Rules For Future LLM Work

- Never treat historical repo verification alone as the full current API spec.
- Never invent app-server fields from memory when the local CLI can generate schema.
- Never assume the current bridge already consumes the full item, approval, or realtime surface.
- Never prefer future/planning docs over current generated schema.
- Always mention the CLI version when documenting new app-server behavior.
