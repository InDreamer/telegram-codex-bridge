# Callback Contract

Current intended behavior for bridge-owned Telegram callback payloads.

This file covers:
- callback namespace families emitted by the bridge
- compact encoding rules and stale/duplicate-click semantics
- which interactions stay as text commands versus callback actions

When implementation detail matters, verify against:
- `src/telegram/ui-callbacks.ts`
- `src/service/callback-router.ts`
- the narrow owner under `src/service/` for the relevant surface

## Versioned Callback Families

Versioned callback families currently emitted by the bridge:
- `v1` project picker and session-surface callbacks: `pick:{project_key}`, `scan:more`, `path:manual`, `path:back`, `path:confirm:{project_key}`, `rename:session:{session_id}`, `rename:project:{session_id}`, `rename:project:clear:{session_id}`, `plan:expand|collapse:{session_id}`, `agent:expand|collapse:{session_id}`, `final:open|close|page:{answer_id}[:{page}]`
- `v2` model picker callbacks: `model:default|close:{session_id}`, `model:page:{session_id}:{page36}`, `model:pick:{session_id}:{model_index36}`, `model:effort:{session_id}:{model_index36}:{effort|default}`
- `v3` interaction callbacks: compact `ix:d|q|t|c|a:...` forms using base64url interaction tokens plus base36 indexes; legacy `v3:ix:decision|question|text|cancel:...` callbacks are still accepted for compatibility
- `v4` runtime and long-tail UI callbacks: `plan:open|close|page:{answer_id}[:{page}]`, `rt:p|t|s|r|c:{token}[:{value}]`, `lg:s:{zh|en}` and `lg:c`, `in:e|c|p|x:{session_id}[:{page36}]`, `rb:p|k|c|b|x:{session_id}:...`, `pr:i:{answer_id}`
- `v5` targeted runtime status and project-browser callbacks: `st:i|x:{session_id}`, `br:o|p|u|r|f|b|c:{token}[:{value36}]`
- `v6` runtime-hub slot selector callbacks: `hb:s:{token}:{version36}:{slot36}`

Rules:
- `project_key` is a stable short hash of the project path, never the raw path
- `interaction_token` is a bridge-owned compact token for the persisted interaction id, not a raw protocol id
- decision and question selectors are compact bridge-local indexes, not raw `decision_key` or `question_id` values
- runtime field selectors use short bridge-owned codes such as `mn`, `mw`, `pm`, and `fr`
- compact callback indexes use base36 encoding to stay within Telegram size limits
- bridge-emitted callback payloads must stay within Telegram's 64-byte `callback_data` limit; interaction callbacks are the tightest budget
- duplicate clicks must be idempotent and return `这个操作已处理。`
- stale callbacks must return a compact expiry notice; generic interaction flows use `这个按钮已过期，请重新操作。`, while surface-specific flows may ask the user to re-send `/browse`, `/runtime`, `/inspect`, or `/rollback`
- list-based session switching and pinning remain text commands (`/use <n>` and `/pin`); runtime-hub slot selection is a separate bridge-owned callback action
- interaction callbacks are bridge-owned UX for persisted pending interactions, not raw protocol passthrough
- rename, model, runtime, language, inspect, rollback, plan-result, and hub-selector callbacks are bridge-owned UI contracts, not raw Codex callback passthrough
