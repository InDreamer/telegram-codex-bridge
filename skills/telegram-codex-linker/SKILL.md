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

Before acting, read `references/install-strategy.md`.

For first install, use the bundled script:

```bash
bash scripts/install-bridge-from-github.sh --telegram-token '<token>'
```

That script is the default install path. Do not narrate the build steps unless the install fails.

## Rules

- do as much as possible automatically
- detect before asking
- ask for one thing at a time
- ask only when the missing step is truly outside Codex control
- use the bundled install script for first install
- use `ctb` for post-install status, repair, authorization, restart, and update
- do not ask the user to run local commands you can run yourself
- do not reinstall a healthy bridge
- if the skill can continue locally, continue locally

## Minimal Flow

1. Precheck using the strategy reference.
2. If install is needed and a token is available, run the bundled install script.
3. If install already exists, use `ctb status` and `ctb doctor`.
4. Only interrupt for a token, a required Codex login, or one Telegram message to the bot.
5. Finish by verifying the real Telegram path.

## Allowed User Interruptions

Only interrupt for these:

- missing or invalid Telegram bot token
- missing Codex login
- one private Telegram message to the exact bot handle when authorization is pending
- final Telegram smoke check such as `/status`

When asking for a token, keep it brutally short:

1. Open BotFather.
2. Run `/newbot`.
3. Copy the token.
4. Send it here.

## Repair Path

For installed bridges, prefer:

```bash
ctb status
ctb doctor
ctb restart
```

If the installed release is stale:

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

Run these locally. The user should only be interrupted to message the bot once if required.

## Finish Condition

Stop only when:

- readiness is explicit from `ctb doctor`
- token state is valid
- authorization is bound
- service is running or an explicit fallback is in place
- Telegram `/status` works
