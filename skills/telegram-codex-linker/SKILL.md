---
name: telegram-codex-linker
description: Install, configure, repair, update, or rebind the Telegram Codex Bridge after the user installs this skill. Use when the user wants Codex to take over bridge setup with minimal user action, only interrupting for unavoidable external steps like providing a Telegram bot token or messaging the bot once.
---

# Telegram Codex Linker

## Overview

This skill exists so the public entrypoint is only "install the skill". After that, the skill should do the bridge work itself.

The user should not be told to manually `git clone`, `npm install`, `npm run build`, or poke service managers unless local automation is genuinely blocked.

## Primary Entry

Assume the user already installed this skill with a one-line GitHub command.

After that, the user should be able to say things like:

- `Use $telegram-codex-linker to set up my Telegram bridge`
- `Install the Telegram Codex Bridge`
- `Repair my Telegram bridge`
- `Rebind the bridge to a new Telegram account`

Your job is to take over from there.

## Non-Negotiables

- do as much as possible automatically
- detect before asking
- ask for one thing at a time
- ask only when the missing step is truly outside Codex control
- prefer `ctb` over ad hoc shell guesses after install
- never dump a full tutorial when one short instruction is enough
- never send the user off to run a stack of commands you can run yourself
- if the bridge is already healthy, do not reinstall it just because the user said "install"
- if the skill can continue locally, continue locally

## Execution Model

Treat the flow as:

1. detect
2. install or repair locally
3. interrupt only for an unavoidable user-side action
4. resume locally
5. verify end to end

Keep the user on the shortest path.

## Detect First

Always check these before asking for anything:

- whether `codex` exists
- whether `codex --version` satisfies the bridge floor, currently `>=0.114.0`
- whether `codex login status` is ready
- whether Node satisfies the project floor, currently `>=25.0.0`
- whether the bridge is already installed
- whether `ctb` exists or the installed wrapper exists at `~/.local/share/codex-telegram-bridge/bin/ctb`
- whether a Telegram token is already configured
- whether an authorized Telegram user is already bound
- whether the bridge service is already running
- whether the host uses `systemd --user`, `launchd`, or neither
- whether the state store is safe enough to trust normal bridge commands

If the bridge is installed, `ctb status` and `ctb doctor` are the source of truth.

## Readiness States

Use the readiness result directly:

- `ready`: do not reinstall; verify smoke checks
- `awaiting_authorization`: ask the user to message the exact bot once, then confirm locally
- `codex_not_authenticated`: fix Codex login first
- `telegram_token_invalid`: ask for a replacement token
- `app_server_unavailable`: treat as a real runtime failure
- `bridge_unhealthy`: fix the blocker before proceeding

If `ctb status` reports `state_store_open=failed`, do not wipe state and do not reinstall blindly.

## Install Rules

Use the current bridge install contract. If a source checkout is needed, perform it yourself and then run:

```bash
npm install
npm run build
node dist/cli.js install --telegram-token '<token>'
```

After install, switch to the installed operator surface:

```bash
ctb status
ctb doctor
```

If `ctb` is not on `PATH`, use `~/.local/share/codex-telegram-bridge/bin/ctb`.

Do not keep using repo-local `status` or `doctor` after install.

## When To Interrupt The User

There are only a few valid interruptions.

### Missing or invalid Telegram token

Ask only for the token, nothing else.

Use the shortest path:

1. Open BotFather in Telegram.
2. Run `/newbot`.
3. Copy the token.
4. Send the token back here.

Once the token arrives, continue locally without re-explaining the flow.

### Authorization pending

If the bridge is waiting for authorization:

1. fetch the exact bot username locally
2. tell the user to send one private message to that exact handle
3. run:

```bash
ctb authorize pending
ctb authorize pending --latest
```

Do not ask the user to run those commands.

### Telegram smoke check

Only after local readiness is good, ask for the smallest real-world verification:

- message the bot once if authorization is missing
- try `/status`
- try `/new` only if needed to validate the real task path

Do not ask for multiple unrelated Telegram actions in the same prompt unless one message can cover them cleanly.

## Repair Rules

For an existing install, prefer:

1. `ctb status`
2. `ctb doctor`
3. fix the specific blocker
4. `ctb restart`
5. reinstall only if the release or config is actually broken

For stale code on disk:

```bash
ctb update
ctb restart
```

For a rebind:

```bash
ctb authorize clear
ctb authorize pending
ctb authorize pending --latest
```

Run those locally. The user's only job is messaging the bot once when needed.

## Verification Standard

Do not stop at "looks installed".
Finish only when the user path is real:

- bridge install exists
- readiness is explicit from `ctb doctor`
- token validates
- service is running or an explicit manual-supervisor fallback is in place
- authorization is bound
- Telegram `/status` works
- Telegram `/new` works or an equivalent first-task flow is confirmed

If local readiness says `ready` but Telegram still behaves like stale state, restart with `ctb restart` before escalating.

## Communication Rules

- lead with what you will do locally
- ask for one thing at a time
- when you need user action, give the exact one-line action
- avoid operational trivia in the happy path
- do not ask the user to guess which bot to message if you can fetch the handle
- do not suggest destructive cleanup unless the user explicitly wants it
- default to: "I will handle this locally; you only need to do X"
