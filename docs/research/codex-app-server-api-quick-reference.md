# Codex App-Server API Quick Reference

Last refreshed: 2026-03-15

Version basis:
- local host `codex-cli 0.114.0`

Read this after:
- `docs/research/codex-app-server-authoritative-reference.md`

Use this document when you want:
- a per-method quick reference
- the current schema file names to inspect
- the highest-value required params and response shapes
- the main notification and approval gotchas that trip up LLMs

When this document and the live generated schema disagree:
- trust the live generated schema

## Fast Start

Get the current truth source first:

```bash
codex --version
codex app-server --help
codex app-server generate-json-schema --experimental --out <dir>
```

Useful inspection commands:

```bash
jq -r '.oneOf[]?.properties.method.enum[]? // empty' <dir>/ClientRequest.json
jq -r '.oneOf[]?.properties.method.enum[]? // empty' <dir>/ServerNotification.json
jq -r '.oneOf[]?.properties.method.enum[]? // empty' <dir>/ServerRequest.json
```

## Transport And Handshake

Transport from current CLI help:
- default: `stdio://`
- available: `ws://IP:PORT`
- official stability note:
  - WebSocket remains experimental in the official app-server docs

Handshake order:
1. start app-server
2. send `initialize`
3. send `initialized`
4. send a non-destructive probe such as `thread/list`

### `initialize`

- Method: `initialize`
- Params schema: `v1/InitializeParams.json`
- Response schema: `v1/InitializeResponse.json`
- Required params:
  - `clientInfo`
- Key response fields:
  - `userAgent`

### `initialized`

- Type: client notification, not request
- Schema entry: `ClientNotification.json`
- Practical rule:
  - do not skip it after `initialize`

## Core Request Quick Reference

### `thread/start`

- Params schema: `v2/ThreadStartParams.json`
- Response schema: `v2/ThreadStartResponse.json`
- Required params:
  - none
- High-value params:
  - `cwd`
  - `model`
  - `approvalPolicy`
  - `sandbox`
- Key response fields:
  - `thread`
  - `cwd`
  - `approvalPolicy`
  - `sandbox`
  - also includes model info
- Repo status:
  - used today

### `thread/resume`

- Params schema: `v2/ThreadResumeParams.json`
- Response schema: `v2/ThreadResumeResponse.json`
- Required params:
  - `threadId`
- High-value params:
  - `approvalPolicy`
- Key response fields:
  - `thread`
  - `cwd`
  - `approvalPolicy`
  - `sandbox`
  - also includes model info
- Repo status:
  - used today

### `thread/list`

- Params schema: `v2/ThreadListParams.json`
- Response schema: `v2/ThreadListResponse.json`
- Required params:
  - none
- High-value params:
  - `limit`
  - `cursor`
- Key response fields:
  - `data`
  - `nextCursor`
- Gotcha:
  - the current response shape is `data`, not `threads`
- Repo status:
  - used today as readiness probe

### `thread/read`

- Params schema: `v2/ThreadReadParams.json`
- Response schema: `v2/ThreadReadResponse.json`
- Required params:
  - `threadId`
- High-value params:
  - `beforeTurnId`
  - `afterTurnId`
  - `limit`
  - `cursor`
- Key response fields:
  - `thread`
- Gotcha:
  - the top-level response shape is `thread`, not `data`
- Repo status:
  - used today for `/inspect` history fallback

### `thread/fork`

- Params schema: `v2/ThreadForkParams.json`
- Response schema: `v2/ThreadForkResponse.json`
- Required params:
  - `threadId`
- High-value params:
  - `turnIndex`
  - `turnId`
- Repo status:
  - not used today

### `thread/archive`

- Params schema: `v2/ThreadArchiveParams.json`
- Response schema: `v2/ThreadArchiveResponse.json`
- Required params:
  - `threadId`
- Repo status:
  - used today to mirror Telegram archive actions to the remote thread

### `thread/unarchive`

- Params schema: `v2/ThreadUnarchiveParams.json`
- Response schema: `v2/ThreadUnarchiveResponse.json`
- Required params:
  - `threadId`
- Repo status:
  - used today to mirror Telegram unarchive actions to the remote thread

### `thread/name/set`

- Params schema: `v2/ThreadSetNameParams.json`
- Response schema: `v2/ThreadSetNameResponse.json`
- Required params:
  - `threadId`
  - `name`
- Repo status:
  - not used today

### `thread/metadata/update`

- Params schema: `v2/ThreadMetadataUpdateParams.json`
- Response schema: `v2/ThreadMetadataUpdateResponse.json`
- Required params:
  - `threadId`
- High-value params:
  - `metadata`
- Repo status:
  - not used today

### `thread/rollback`

- Params schema: `v2/ThreadRollbackParams.json`
- Response schema: `v2/ThreadRollbackResponse.json`
- Required params:
  - inspect current schema before use
- Repo status:
  - not used today

### `thread/compact/start`

- Params schema: `v2/ThreadCompactStartParams.json`
- Response schema: `v2/ThreadCompactStartResponse.json`
- Required params:
  - `threadId`
- Repo status:
  - not used today

### `thread/backgroundTerminals/clean`

- Params schema: `v2/ThreadBackgroundTerminalsCleanParams.json`
- Response schema: `v2/ThreadBackgroundTerminalsCleanResponse.json`
- Required params:
  - inspect current schema before use
- Repo status:
  - not used today

### `turn/start`

- Params schema: `v2/TurnStartParams.json`
- Response schema: `v2/TurnStartResponse.json`
- Required params:
  - `threadId`
  - `input`
- High-value params:
  - `cwd`
  - `model`
  - `approvalPolicy`
  - `sandboxPolicy`
- Key response fields:
  - `turn`
- Gotchas:
  - `input` is an array of `UserInput`
  - current `UserInput` union includes at least:
  - `text`
  - `image`
  - `localImage`
  - `skill`
  - `mention`
- Repo status:
  - used today

### `turn/steer`

- Params schema: `v2/TurnSteerParams.json`
- Response schema: `v2/TurnSteerResponse.json`
- Required params:
  - `expectedTurnId`
  - `input`
  - `threadId`
- Gotcha:
  - the precondition field is `expectedTurnId`, not `turnId`
- Repo status:
  - not used today

### `turn/interrupt`

- Params schema: `v2/TurnInterruptParams.json`
- Response schema: `v2/TurnInterruptResponse.json`
- Required params:
  - `threadId`
  - `turnId`
- Repo status:
  - used today

### `model/list`

- Params schema: `v2/ModelListParams.json`
- Response schema: `v2/ModelListResponse.json`
- Required params:
  - none
- Key response fields:
  - `data`
- Repo status:
  - not used today

### `experimentalFeature/list`

- Params schema: `v2/ExperimentalFeatureListParams.json`
- Response schema: `v2/ExperimentalFeatureListResponse.json`
- Required params:
  - none
- Key response fields:
  - `data`
- Repo status:
  - not used today

### `config/read`

- Params schema: `v2/ConfigReadParams.json`
- Response schema: `v2/ConfigReadResponse.json`
- Use when:
  - you need the runtime config truth instead of assuming approval or sandbox defaults
- Repo status:
  - not used today

### `command/exec`

- Params schema: `v2/CommandExecParams.json`
- Response schema: `v2/CommandExecResponse.json`
- Related methods:
  - `command/exec/write`
  - `command/exec/terminate`
  - `command/exec/resize`
- Repo status:
  - not used today
- LLM warning:
  - do not confuse this with the bridge's own local shell tools

## Extended Request Families

These are present in the current schema and should be considered available unless the host CLI changes.

Realtime:
- `thread/realtime/start`
- `thread/realtime/appendAudio`
- `thread/realtime/appendText`
- `thread/realtime/stop`

Skills, plugins, apps, and review:
- `skills/list`
- `skills/remote/list`
- `skills/remote/export`
- `skills/config/write`
- `plugin/list`
- `plugin/install`
- `plugin/uninstall`
- `app/list`
- `review/start`

Account, config, and environment:
- `account/login/start`
- `account/login/cancel`
- `account/logout`
- `account/rateLimits/read`
- `account/read`
- `config/value/write`
- `config/batchWrite`
- `configRequirements/read`
- `externalAgentConfig/detect`
- `externalAgentConfig/import`
- `collaborationMode/list`

MCP and related:
- `mcpServer/oauth/login`
- `config/mcpServer/reload`
- `mcpServerStatus/list`
- `fuzzyFileSearch`
- `fuzzyFileSearch/sessionStart`
- `fuzzyFileSearch/sessionUpdate`
- `fuzzyFileSearch/sessionStop`

Experimental or platform-specific:
- `mock/experimentalMethod`
- `windowsSandbox/setupStart`

## Notification Quick Reference

### Core lifecycle notifications

`thread/started`
- Schema: `v2/ThreadStartedNotification.json`
- Use for:
  - confirming thread creation

`thread/status/changed`
- Schema: `v2/ThreadStatusChangedNotification.json`
- Required fields:
  - `threadId`
  - `status`
- High-value fields:
  - `status.type`
  - `status.activeFlags` when `status.type = active`
- Shape note on `codex-cli 0.114.0`:
  - current runtime notifications send `status` as a structured object such as `{ "type": "active", "activeFlags": [] }` or `{ "type": "idle" }`
- Repo status:
  - used today

`turn/started`
- Schema: `v2/TurnStartedNotification.json`
- Use for:
  - turn lifecycle start
- Repo status:
  - used today

`turn/completed`
- Schema: `v2/TurnCompletedNotification.json`
- Required fields:
  - `threadId`
  - `turn`
- Gotcha:
  - check `turn.status` from the embedded `turn` object
- Repo status:
  - used today

### Item notifications

`item/started`
- Schema: `v2/ItemStartedNotification.json`
- Required fields:
  - `item`
  - `threadId`
  - `turnId`
- Repo status:
  - used today

`item/completed`
- Schema: `v2/ItemCompletedNotification.json`
- Required fields:
  - `item`
  - `threadId`
  - `turnId`
- LLM rule:
  - for commentary-aware integrations, prefer `item.type = agentMessage` plus `item.phase`
  - treat this completed item as authoritative over prior `item/agentMessage/delta` text
- Repo status:
  - used today

`item/agentMessage/delta`
- Schema: `v2/AgentMessageDeltaNotification.json`
- Use for:
  - streamed assistant text
- LLM rule:
  - do not treat this delta stream as the authoritative commentary record
- Repo status:
  - used today

`item/plan/delta`
- Schema: `v2/PlanDeltaNotification.json`
- Use for:
  - incremental plan text
- Repo status:
  - used today

`turn/plan/updated`
- Schema: `v2/TurnPlanUpdatedNotification.json`
- Use for:
  - structured plan state
- Repo status:
  - used today

`item/commandExecution/outputDelta`
- Schema: `v2/CommandExecutionOutputDeltaNotification.json`
- Repo status:
  - used today

`item/fileChange/outputDelta`
- Schema: `v2/FileChangeOutputDeltaNotification.json`
- Repo status:
  - used today

`item/mcpToolCall/progress`
- Schema: `v2/McpToolCallProgressNotification.json`
- Repo status:
  - used today

Reasoning notifications:
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`
- LLM warning:
  - do not treat reasoning deltas as the final answer

### Other useful notifications

Model and config:
- `model/rerouted`
- `configWarning`
- `deprecationNotice`

Account and app:
- `account/updated`
- `account/rateLimits/updated`
- `account/login/completed`
- `app/list/updated`
- `skills/changed`

Other runtime:
- `hook/started`
- `hook/completed`
- `command/exec/outputDelta`
- `serverRequest/resolved`
- `thread/compacted`

Realtime:
- `thread/realtime/started`
- `thread/realtime/itemAdded`
- `thread/realtime/outputAudio/delta`
- `thread/realtime/error`
- `thread/realtime/closed`

Platform-specific:
- `windows/worldWritableWarning`
- `windowsSandbox/setupCompleted`

## Approval And Server Request Quick Reference

### `item/commandExecution/requestApproval`

- Params schema: `CommandExecutionRequestApprovalParams.json`
- Response schema: `CommandExecutionRequestApprovalResponse.json`
- Required params:
  - `itemId`
  - `threadId`
  - `turnId`
- High-value optional fields:
  - `approvalId`
  - `command`
  - `reason`
- Critical response rule:
  - the response uses `decision`, not `approved`
- Current decision variants include:
  - `accept`
  - `acceptForSession`
  - `decline`
  - `cancel`
  - object variants for execpolicy or network policy amendments

### `item/fileChange/requestApproval`

- Params schema: `FileChangeRequestApprovalParams.json`
- Response schema: `FileChangeRequestApprovalResponse.json`
- Required params:
  - `itemId`
  - `threadId`
  - `turnId`
- High-value optional fields:
  - `approvalId`
  - `changes`
  - `reason`
- Critical response rule:
  - the response uses `decision`
- Current decision variants include:
  - `accept`
  - `acceptForSession`
  - `decline`
  - `cancel`

### `item/permissions/requestApproval`

- Params schema: `PermissionsRequestApprovalParams.json`
- Response schema: `PermissionsRequestApprovalResponse.json`
- Required params:
  - `itemId`
  - `permissions`
  - `threadId`
  - `turnId`
- High-value optional fields:
  - `approvalId`
  - `command`
  - `reason`
- Critical response rule:
  - the response returns `permissions`
  - it may also set `scope`
  - this is not a simple boolean approval

### `item/tool/requestUserInput`

- Params schema: `ToolRequestUserInputParams.json`
- Response schema: `ToolRequestUserInputResponse.json`
- Required params:
  - `itemId`
  - `questions`
  - `threadId`
  - `turnId`
- Critical response rule:
  - the response returns `answers`
  - answers are keyed by question id
  - each answer currently contains an `answers` string array

### Other server requests

Dynamic or specialized server requests present in the current schema:
- `item/tool/call`
- `mcpServer/elicitation/request`
- `applyPatchApproval`
- `execCommandApproval`
- `account/chatgptAuthTokens/refresh`

LLM rule:
- if you need any of these, inspect the exact generated schema before implementation

## Current Repo Adoption Matrix

Used today by the bridge:
- `initialize`
- `initialized`
- `thread/list`
- `thread/start`
- `thread/resume`
- `thread/read`
- `thread/archive`
- `thread/unarchive`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- approval and user-input request handling for:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
  - `item/tool/requestUserInput`
  - `mcpServer/elicitation/request`
  - `applyPatchApproval`
  - `execCommandApproval`
- selected lifecycle and item notifications
- legacy compatibility events such as `codex/event/task_complete`

Not used today by the bridge, but present in current schema:
- thread naming and other advanced thread-control APIs
- realtime APIs
- `command/exec`
- review, skills, plugin, app, and MCP admin surfaces
- `item/tool/call`
- `account/chatgptAuthTokens/refresh`

Important distinction:
- these adoption notes describe what the current bridge implementation actually uses
- they do not describe everything the current Codex protocol supports

## LLM Gotchas

- `thread/list` response uses `data`, not `threads`.
- `thread/read` response uses `thread`, not `data`.
- `turn/steer` requires `expectedTurnId`.
- `turn/start` input is an array of `UserInput`, not a single text field.
- approval responses often use `decision`, not `approved`.
- permissions approval returns a granted permission profile, not a yes or no flag.
- the bridge's current implementation surface is much smaller than the current app-server schema.

## Refresh Workflow

To refresh this quick reference:

1. regenerate schema from the current local CLI
2. inspect the files named in this document
3. update the version basis and date
4. sync any changed method names, required fields, or response shapes

If the local CLI version changed:
- update `docs/research/codex-app-server-authoritative-reference.md` first
- then update this quick reference
