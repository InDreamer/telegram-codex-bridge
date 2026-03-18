# Telegram Bridge Install Strategy

Use this exact order. Do not improvise unless the normal path fails.

Resolve stable paths first:

```bash
SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/telegram-codex-linker"
INSTALL_SCRIPT="$SKILL_ROOT/scripts/install-bridge-from-github.sh"
ROOT_DISCOVERY_SCRIPT="$SKILL_ROOT/scripts/discover-project-scan-roots.sh"
CTB_BIN="${HOME}/.local/share/codex-telegram-bridge/bin/ctb"
CTB="$(command -v ctb 2>/dev/null || true)"
if [[ -z "$CTB" && -x "$CTB_BIN" ]]; then
  CTB="$CTB_BIN"
fi
```

## 0. Language

Choose the user-facing language from the user's recent messages.

Rules:

- if the user is mainly writing in Chinese, default to Chinese
- if the user is mainly writing in English, default to English
- if mixed but the current request is Chinese, use Chinese
- tell the user once which language you are using by default and that they can switch

Suggested one-liners:

- Chinese: `我默认用中文；想切英文直接说。`
- English: `I'll use English by default; say so if you want Chinese.`

## 1. Precheck

Check:

- `codex --version`
- `codex login status`
- `node -v`
- `command -v ctb`
- `$CTB_BIN`

If the bridge is already installed, use:

```bash
"$CTB" status
"$CTB" doctor
```

Do not assume `ctb` is on `PATH`. The installed wrapper path is the fallback.

Before first install, inspect `HOME` for likely project roots.
Rules:

- if the user gives explicit roots, use them
- if the user gives fewer than 3 roots, supplement with obvious disjoint roots when possible
- if the user gives none, auto-select up to 3 disjoint roots
- prefer `$ROOT_DISCOVERY_SCRIPT` for the first pass instead of guessing by hand
- let the agent rank the discovered roots using current context such as cwd and project names mentioned by the user
- prefer roots that contain multiple child directories that look like projects or repos
- do not keep overlapping parent-child roots
- if no good roots are obvious, omit the install flag and let runtime fall back to scanning `HOME`

## 2. Decide

Choose exactly one mode before acting:

- `install`: bridge not installed
- `repair`: bridge installed but unhealthy and likely recoverable without changing source
- `update`: bridge installed, release is stale or broken, and a normal update path exists
- `rebind`: bridge installed and the user explicitly wants a different Telegram account, or authorization must be reset

Decision order:

1. explicit user request to rebind wins
2. no installed bridge means install
3. installed bridge with `ready` or `awaiting_authorization` means do not reinstall
4. installed bridge with targeted operational problems means repair first
5. use update only when repair points to stale installed code or the normal update path is the clean fix

Do not blend these modes into one vague "setup" action.

### Bridge not installed

- if Telegram token is missing: ask only for the token
- if token is available: recommend project roots, allow override, then run the bundled install script

Command:

```bash
bash "$INSTALL_SCRIPT" --telegram-token '<token>' --project-scan-roots '<path1:path2:path3>'
```

### Bridge installed

- trust `ctb status` and `ctb doctor`
- do not reinstall unless the release or config is actually broken
- if the user asks to "install" but the bridge already exists, translate that into repair, update, or rebind

## 2.5. Recommend Project Roots

When explicit roots are missing:

1. run `$ROOT_DISCOVERY_SCRIPT --format lines` when you want to show recommendations
2. run `$ROOT_DISCOVERY_SCRIPT` when you want the colon-joined default install value
3. build a short recommendation list from that output
4. include the default set you will use if the user does nothing
5. let the user override with explicit choices or paths
6. canonicalize, deduplicate, and remove overlaps before install

Recommended interaction shape:

- `我默认用中文；想切英文直接说。`
- `我先推荐这些项目目录：`
- `[1] /path/a`
- `[2] /path/b`
- `[3] /path/c`
- `默认我会用 1 和 2；如果你想改，直接回编号或路径。`

If the user does not choose, continue with the default set.

## 3. Handle readiness

### `ready`

- do not reinstall
- verify `/status`

### `awaiting_authorization`

1. get the exact bot handle locally
2. ask the user to message that bot once
3. run:

```bash
"$CTB" authorize pending
"$CTB" authorize pending --latest
```

Meaning:

- the user does not run shell commands
- the user only performs the Telegram-side contact step
- the skill resumes the local authorization commands after that message arrives

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
"$CTB" status
"$CTB" doctor
"$CTB" restart
```

If code is stale:

```bash
"$CTB" update
"$CTB" restart
```

If binding must be reset:

```bash
"$CTB" authorize clear
"$CTB" authorize pending
"$CTB" authorize pending --latest
```

## 5. User interaction rules

Only interrupt for:

- Telegram bot token
- Codex login
- one private message to the bot
- final Telegram smoke check

Do not ask the user to run shell commands you can run locally.
