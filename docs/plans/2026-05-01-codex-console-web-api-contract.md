# Codex Console Web API Contract — Phase 3

## Goal

Define the minimal product-shaped API boundary for the rebuilt Codex Console Web UI. This phase defines types, endpoint shapes, and safety rules only. It does not wire real Bridge state, persistence, route handlers, auth changes, or preview scripts.

Boundary:

```text
Bridge internals -> ConsoleBridgeAdapter -> Web Console API -> Frontend
```

The adapter is responsible for translating Bridge-owned records into opaque Web Console records and for stripping platform/runtime internals before data reaches the Web API.

## Identifier and safety rules

The Web Console contract uses only opaque web IDs:

- projects: `prj_...`
- sessions: `ses_...`
- messages: `msg_...`
- runs: `run_...`
- approvals: `apr_...`
- artifacts: `art_...`

The adapter must not expose raw Telegram IDs, Feishu IDs, callback IDs, chat IDs, local filesystem paths, tokens, process IDs, raw terminal logs, or raw persisted session IDs. File names shown in the UI are display labels only; they must not be absolute server paths.

## Contract objects

The TypeScript contract defines the minimal objects needed by the accepted fake-data UI:

- `ConsoleBootstrap`
- `ConsoleCapabilities`
- `ConsoleProject`
- `ConsoleSessionSummary`
- `ConsoleSessionDetail`
- `ConsoleMessage`
- `ConsoleRunState`
- `ConsoleRunStep`
- `ConsoleDiffSummary`
- `ConsoleApprovalRequest`
- `ConsoleApprovalAnswerRequest`
- `ConsoleArtifactSummary`
- `ConsoleSendMessageRequest`
- `ConsoleSendMessageResult`
- `ConsoleEvent`
- `ConsoleApiError`

Capability states are part of the response body so the frontend can keep the same UI contract while disabling or degrading archive, create-session, send-message, approval, upload, event-stream, or artifact actions.

## Minimal endpoints

### `GET /api/console/bootstrap`

Returns `ConsoleBootstrap` with owner viewer info, global capabilities, project drawer data, selected project/session IDs, command/model/mode options, and degraded-state cards.

### `GET /api/projects`

Returns `ConsoleProject[]` for the project drawer/sidebar. Archived projects may be omitted by default unless a later query option is added.

### `POST /api/projects/:projectId/archive`

Archives a project by opaque `prj_...` ID. Requires `archiveProject.state === "enabled"`. Returns the updated `ConsoleProject` or `ConsoleApiError` with `code: "capability_disabled"` when disabled.

### `GET /api/projects/:projectId/sessions`

Returns `ConsoleSessionSummary[]` under a project by opaque `prj_...` ID.

### `POST /api/projects/:projectId/sessions`

Creates a new empty session under a project by opaque `prj_...` ID. Requires `createSession.state === "enabled"`. Returns `ConsoleSessionDetail`.

### `GET /api/sessions/:sessionId`

Returns `ConsoleSessionDetail` by opaque `ses_...` ID, including messages, current run state, diff summaries, approval requests, artifact summaries, and the session event URL.

### `POST /api/sessions/:sessionId/messages`

Accepts `ConsoleSendMessageRequest` with text plus optional model, mode, and opaque artifact attachments. Requires `sendMessage.state === "enabled"`. Returns `ConsoleSendMessageResult` with the accepted user message and optional started run state.

### `GET /api/sessions/:sessionId/events`

SSE-first event stream for live session updates. Event payloads are `ConsoleEvent` JSON. The defined event families cover message, run, diff, approval, artifact, session, and error updates. A later fallback polling endpoint may be added without changing these event payloads.

### `POST /api/approvals/:approvalId/answer`

Accepts `ConsoleApprovalAnswerRequest` for an opaque `apr_...` ID. Requires `answerApproval.state === "enabled"`. Returns an approval answer result or a `ConsoleApiError`.

### `GET /api/artifacts/:artifactId`

Returns artifact metadata and safe preview/download data by opaque `art_...` ID. Requires `fetchArtifacts.state !== "disabled"`. It must never reveal server-local paths or raw logs.

## Auth and write expectations

- Owner-only auth is assumed for this phase.
- POST routes are same-origin only and are expected to use CSRF protection before real write integration.
- API errors use `ConsoleApiError` with safe messages and retry/capability hints.

## Out of scope for Phase 3

- No real Bridge integration.
- No HTTP route handlers.
- No persistence.
- No auth or preview-script changes.
