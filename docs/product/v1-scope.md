# Telegram Codex Bridge v1 Scope

## Goal

Build a VPS-hosted Telegram bridge that wakes and controls the Codex installation that already exists on the server.

Telegram is the control surface.
Codex remains the execution engine.
The bridge is not a second Codex environment, not a provider-management layer, and not a second permission system.

## In Scope

- single authorized Telegram user
- Telegram private chat only
- one bridge service per server
- reuse the server's existing Codex environment
- project-aware session startup
- final-answer-only Telegram output
- multiple sessions with switching
- one active session per chat
- one-line install plus local self-check
- operator-managed full access / no-Telegram-approval runtime model

## Out Of Scope

- group chats
- multi-user access
- Telegram-side execution policy beyond access identity
- rich streaming of tool calls, patches, or reasoning
- Telegram-driven provider or model setup
- Codex approval relay
- Telegram approval UI or callback flow
- a first-class Telegram transport inside Codex core

## Runtime Assumption

v1 assumes the server operator intentionally runs Codex in a full-access, no-Telegram-approval mode.

That means:
- Telegram does not provide a second approval barrier.
- The bridge does not wait for user confirmation before Codex proceeds.
- Execution risk is intentionally accepted by the server operator as part of the deployment model.

This is a deliberate product boundary, not a missing feature.

## Risk Boundary

v1 should be deployed only by operators who explicitly accept that:
- Telegram is a direct control plane into a high-trust Codex runtime.
- access control at the Telegram identity boundary matters more, not less
- the bridge may recommend a project, but it must never silently choose one

## User-Facing Copy Rules

Prefer:
- `选择这次要操作的项目`
- `继续上次项目：{project_name}`
- `其他常用项目`
- `扫描更多仓库`
- `手动输入路径`
- `当前项目：{project_name}`

Avoid in the main user flow:
- `workdir`
- `cwd`
- `API key`
- `provider`
- `transport`
- `sandbox mode`

Those terms may appear in local administrator diagnostics only.

## Final v1 Rule

The bridge may recommend a project, but it must never silently choose the project.

Before the first real task is sent, the user must always be able to see which project the next Codex session will operate on.
