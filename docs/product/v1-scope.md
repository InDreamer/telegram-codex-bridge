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
- compact structured runtime visibility in Telegram
- separate final-answer delivery
- on-demand `/inspect` task snapshots and `/where` session locators
- multiple sessions with switching
- one active session per chat
- Telegram-driven interrupt of the active turn
- bridge-owned Telegram interaction cards for approvals and structured user input when Codex emits server requests
- model discovery and per-session model selection
- review start, skills discovery and selection, and thread fork / rollback / compact / rename / metadata controls where the current CLI exposes stable support
- plugin discovery plus install/uninstall where the current CLI exposes stable support
- app discovery where the current CLI exposes stable support
- MCP status, reload, and OAuth-login-link surfaces where the current CLI exposes stable support
- account diagnostics and thread background-terminal cleanup where the current CLI exposes stable support
- rich input submission for `text`, `localImage`, `skill`, and `mention`
- Telegram photo upload adaptation into bridge-managed `localImage` input
- optional Telegram voice-message adaptation into transcribed text input when voice input is enabled
- one-line install plus local self-check
- operator-managed full-access runtime with adapted Telegram UX instead of a raw terminal

## Out Of Scope

- group chats
- multi-user access
- Telegram-side execution policy beyond access identity
- raw or token-level streaming of tool calls, patches, or reasoning
- reasoning surfaces in the normal Telegram chat flow
- Telegram-driven provider setup
- general collaboration-mode discovery or preset selection beyond the existing `/plan` toggle
- direct Telegram command support for schema-level remote URL `image` input
- raw-terminal emulation or fake terminal widgets
- client-managed dynamic tool execution via `item/tool/call`, because the live schema exposes only generic tool name plus arguments and does not give the bridge a stable Telegram-safe tool registry
- client-managed ChatGPT token refresh via `account/chatgptAuthTokens/refresh`, because the bridge does not own ChatGPT access tokens or workspace ids and Telegram is not the provider-setup UX
- `command/exec*`, `feedback/upload`, `fuzzyFileSearch*`, and `externalAgentConfig/*`
- a first-class Telegram transport inside Codex core

## Runtime Assumption

v1 assumes the server operator intentionally runs Codex in a high-trust, full-access Codex environment.

That means:
- Telegram is still the control plane into a high-trust runtime.
- The bridge may relay explicit Codex server requests back to Telegram, but that relay is bridge UX, not a second sandbox or policy engine.
- Execution risk is intentionally accepted by the server operator as part of the deployment model.

This is a deliberate product boundary, not a missing feature.

## Risk Boundary

v1 should be deployed only by operators who explicitly accept that:
- Telegram is a direct control plane into a high-trust Codex runtime.
- access control at the Telegram identity boundary matters more, not less
- the bridge may rank or group project choices, but it must never silently choose one

## User-Facing Copy Rules

Prefer:
- `选择要新建会话的项目`
- `已收藏`
- `最近使用`
- `本地发现`
- `扫描本地项目`
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

The bridge may rank visible project choices, but it must never silently choose the project.

Before the first real task is sent, the user must always be able to see which project the next Codex session will operate on.
