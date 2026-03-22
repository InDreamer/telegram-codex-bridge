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

Never assume the current working directory is the skill directory. Resolve these first:

```bash
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/telegram-codex-linker"
INSTALL_SCRIPT="$SKILL_ROOT/scripts/install-bridge-from-github.sh"
ROOT_DISCOVERY_SCRIPT="$SKILL_ROOT/scripts/discover-project-scan-roots.sh"
CTB_BIN="${HOME}/.local/share/codex-telegram-bridge/bin/ctb"
```

Windows PowerShell equivalents:

```powershell
$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
$skillRoot = Join-Path $codexHome "skills\telegram-codex-linker"
$installScript = Join-Path $skillRoot "scripts\install-bridge-from-github.ps1"
$rootDiscoveryScript = Join-Path $skillRoot "scripts\discover-project-scan-roots.ps1"
$ctbBin = Join-Path $localAppData "codex-telegram-bridge\bin\ctb.cmd"
```

For first install, use the bundled script:

```bash
bash "$INSTALL_SCRIPT" --telegram-token '<token>' --project-scan-roots '<path1:path2:path3>'
```

On Windows, use PowerShell instead:

```powershell
powershell -ExecutionPolicy Bypass -File $installScript -TelegramToken '<token>' -ProjectScanRoots '<path1;path2;path3>'
```

That script is the default install path. Do not narrate the build steps unless the install fails.

## Rules

- do as much as possible automatically
- detect before asking
- ask for one thing at a time
- ask only when the missing step is truly outside Codex control
- choose the operating language from the user's recent messages
- tell the user once which language you are using by default and that they can switch
- use the bundled install script for first install
- use `ctb` for post-install status, repair, authorization, restart, and update
- if `ctb` is not on `PATH`, use `$CTB_BIN`
- on Windows, use the bundled `.ps1` install script and `ctb.cmd`
- collect or infer project scan roots before first install and pass them through `--project-scan-roots`
- if the user gives roots, use them
- if the user gives none, run `$ROOT_DISCOVERY_SCRIPT` and prepare recommended roots before install
- present recommended roots briefly and let the user override them
- if the user does not choose, use the default recommended roots
- if the user gives fewer than 3 roots, supplement with obvious disjoint roots when possible
- do not invent junk roots and do not pass overlapping parent-child roots
- canonicalize and deduplicate all roots before install
- do not ask the user to run local commands you can run yourself
- do not reinstall a healthy bridge
- if the skill can continue locally, continue locally

## Minimal Flow

1. Precheck using the strategy reference.
2. Decide whether this is install, repair, update, or rebind.
3. If install is needed and a token is available, recommend project scan roots, allow override, then run the bundled install script.
4. If install already exists, use `ctb status` and `ctb doctor` to choose repair, update, or rebind instead of blindly reinstalling.
5. Only interrupt for a token, a required Codex login, one root-selection reply if needed, or one Telegram message to the bot.
6. Finish by verifying the real Telegram path.

## Allowed User Interruptions

Only interrupt for these:

- missing or invalid Telegram bot token
- missing Codex login
- optional project-root selection when the recommended defaults may be wrong
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
"${CTB:-$CTB_BIN}" status
"${CTB:-$CTB_BIN}" doctor
"${CTB:-$CTB_BIN}" restart
```

If the installed release is stale:

```bash
"${CTB:-$CTB_BIN}" update
"${CTB:-$CTB_BIN}" restart
```

For a rebind:

```bash
"${CTB:-$CTB_BIN}" authorize clear
"${CTB:-$CTB_BIN}" authorize pending
"${CTB:-$CTB_BIN}" authorize pending --latest
```

Run these locally. The user should only be interrupted to message the bot once if required.

## Project Root Recommendation

When the user does not provide roots:

1. Run `$ROOT_DISCOVERY_SCRIPT`.
2. Combine that result with obvious context the agent already has, such as the current working tree or project names the user mentioned.
3. Produce a short recommended list with a clear default set.
4. Tell the user that if they do nothing, the default set will be used.
5. If the user chooses specific roots, use those instead.
6. Never pass duplicate or overlapping roots.

On Windows:

1. Run the PowerShell discovery script.
2. Use `;` as the root delimiter.
3. Prefer user-space paths like `C:\Users\<name>\projects`.

Recommended prompt shape:

1. `我默认用中文；如果你想切英文，直接说。`
2. `我推荐这几个项目目录：[A] ... [B] ... [C] ...。`
3. `如果你不选，我就用默认的 A+B。`

Do not turn this into a questionnaire unless the defaults are genuinely uncertain.

## Authorization Clarification

The "one Telegram message" rule means this:

- the skill does the local install, status checks, repair, and `ctb authorize ...` commands itself
- the user only needs to open Telegram and privately message the bot once when the bridge is waiting to bind that Telegram account
- after that, resume local commands and finish the bind

## Finish Condition

Stop only when:

- readiness is explicit from `ctb doctor`
- token state is valid
- authorization is bound
- service is running or an explicit fallback is in place
- Telegram `/status` works
