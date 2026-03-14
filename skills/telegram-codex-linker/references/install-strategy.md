# Telegram Bridge Install Strategy

Use this exact order. Do not improvise unless the normal path fails.

## 1. Precheck

Check:

- `codex --version`
- `codex login status`
- `node -v`
- `command -v ctb`
- `~/.local/share/codex-telegram-bridge/bin/ctb`

If the bridge is already installed, use:

```bash
ctb status
ctb doctor
```

Or use the installed wrapper path when `ctb` is not on `PATH`.

## 2. Decide

### Bridge not installed

- if Telegram token is missing: ask only for the token
- if token is available: run the bundled install script

Command:

```bash
bash scripts/install-bridge-from-github.sh --telegram-token '<token>'
```

### Bridge installed

- trust `ctb status` and `ctb doctor`
- do not reinstall unless the release or config is actually broken

## 3. Handle readiness

### `ready`

- do not reinstall
- verify `/status`

### `awaiting_authorization`

1. get the exact bot handle locally
2. ask the user to message that bot once
3. run:

```bash
ctb authorize pending
ctb authorize pending --latest
```

### `codex_not_authenticated`

- tell the user to log into Codex
- do not continue until it is fixed

### `telegram_token_invalid`

- ask for a replacement token only
- rerun install or config update with the new token

### `app_server_unavailable` or `bridge_unhealthy`

- inspect the specific blocker
- prefer targeted repair over reinstall

## 4. Repair

Default repair sequence:

```bash
ctb status
ctb doctor
ctb restart
```

If code is stale:

```bash
ctb update
ctb restart
```

If binding must be reset:

```bash
ctb authorize clear
ctb authorize pending
ctb authorize pending --latest
```

## 5. User interaction rules

Only interrupt for:

- Telegram bot token
- Codex login
- one private message to the bot
- final Telegram smoke check

Do not ask the user to run shell commands you can run locally.
