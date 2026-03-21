# telegram-codex-bridge

[![CI](https://github.com/InDreamer/telegram-codex-bridge/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/InDreamer/telegram-codex-bridge/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/InDreamer/telegram-codex-bridge?style=flat)](https://github.com/InDreamer/telegram-codex-bridge/stargazers)

Turn Telegram into a remote control for the Codex installation that already runs on your server.

This bridge exists for one simple reason: Codex on a VPS is useful, but using it from a phone through a raw terminal is awful. `telegram-codex-bridge` gives you a Telegram-native control surface without pretending to be a second Codex runtime, a second sandbox, or a provider-management layer.

```mermaid
flowchart LR
  TG[Telegram chat] --> BR[telegram-codex-bridge]
  BR --> CX[local Codex app-server]
  CX --> PRJ[project files on the server]
```

## Why This Project Is Interesting

- project-aware session startup from Telegram instead of blind remote execution
- compact runtime cards plus `/inspect` and `/where` instead of terminal spam
- bridge-owned approval and questionnaire UX when Codex asks for input
- multi-session flow with archive, unarchive, rename, and switching
- Telegram photo upload mapped into `localImage` input
- optional Telegram voice-message transcription
- `/review`, `/rollback`, `/compact`, model selection, plugin/app/MCP surfaces where the current Codex CLI supports them
- one-line GitHub install scripts for both the bridge and the bundled Codex setup skill

## What It Is

- Telegram is the control surface
- Codex remains the execution engine
- the bridge runs as a VPS or always-on host service
- the bridge adapts Telegram UX to a high-trust Codex runtime

## What It Is Not

- not a second Codex environment
- not a second permission system
- not a provider-management layer
- not a multi-user team chat bot
- not a fake terminal stuffed into Telegram

## Fastest Install Paths

### Option 1: Let Codex Set It Up

Install the bundled Codex skill:

```bash
curl -fsSL https://raw.githubusercontent.com/InDreamer/telegram-codex-bridge/master/scripts/install-skill-from-github.sh | bash
```

Then tell Codex:

```text
Use $telegram-codex-linker to set up my Telegram bridge.
```

This is the cleanest install path. The skill handles bridge setup, repair, token collection, authorization, and verification, and only interrupts you for the parts a bot cannot do for you.

### Option 2: Install The Bridge Directly

```bash
curl -fsSL https://raw.githubusercontent.com/InDreamer/telegram-codex-bridge/master/scripts/install-from-github.sh | bash -s -- --telegram-token "<BOT_TOKEN>" --project-scan-roots "$HOME/projects:$HOME/work"
```

## Requirements

- an always-on Linux or macOS machine
- an existing Codex installation on that machine
- a Telegram bot token
- Node `>=25.0.0` if you build from source

## Typical Telegram Flow

1. Run `/new` and choose the project instead of silently guessing a worktree.
2. Send a task, or send a photo/voice message when that fits the job.
3. Watch the runtime card and use `/inspect` or `/interrupt` when needed.
4. Use `/sessions`, `/archive`, `/review`, `/rollback`, `/compact`, `/model`, `/plugins`, `/apps`, or `/mcp` as the task demands.

## Development

```bash
npm ci
npm run check
npm run test
npm run build
```

For local development:

```bash
npm run dev
```

CLI entrypoint:

```bash
ctb
```

## Documentation

Start with the smallest relevant doc instead of trawling the whole repo for no reason.

- product scope and trust model: `docs/product/v1-scope.md`
- Telegram product router: `docs/product/chat-and-project-flow.md`
- auth, project picker, browse, and session flow: `docs/product/auth-and-project-flow.md`
- Codex-backed commands and structured rich inputs: `docs/product/codex-command-reference.md`
- runtime surfaces, inspect, and final-answer delivery: `docs/product/runtime-and-delivery.md`
- callback payload contract: `docs/product/callback-contract.md`
- runtime, state, and recovery: `docs/architecture/runtime-and-state.md`
- current code organization: `docs/architecture/current-code-organization.md`
- volatile current snapshot: `docs/generated/current-snapshot.md`
- install, admin, and diagnostics: `docs/operations/install-and-admin.md`
- Codex protocol reference: `docs/research/codex-app-server-authoritative-reference.md`
- agent routing guidance: `AGENTS.md`

## Current Status

The project is in active development. The current product, runtime, and operational docs are intentionally separated from protocol research and future planning so the repo does not blur shipped behavior with wishful thinking.

Practical reading rule:
- current intended behavior: `docs/product/`, `docs/architecture/`, `docs/operations/`
- observed current behavior: repository code
- protocol capability: `docs/research/` plus live generated schema
- future direction or historical planning: `docs/future/`, `docs/plans/`, `docs/roadmap/`

Do not treat future or planning docs as proof that behavior is already shipped.
