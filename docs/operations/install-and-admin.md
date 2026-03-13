## Runtime And Tooling Floor

Package manager and build scripts:
- `npm run build`
- `npm run dev`
- `npm run check`
- `npm run test`

Actual admin and runtime surface:
- `ctb ...` is the operator command surface
- `ctb service run` is the long-lived service entrypoint used by `systemd --user`, `launchd`, or another supervisor

Node requirement:
- Node `>=25.0.0`

## Config Keys

Supported config keys in `bridge.env`:
- `TELEGRAM_BOT_TOKEN`
- `CODEX_BIN`
- `TELEGRAM_API_BASE_URL`
- `TELEGRAM_POLL_TIMEOUT_SECONDS`
- `TELEGRAM_POLL_INTERVAL_MS`

macOS note:
- `bridge.env` stays the source of truth for bridge config after install
- the LaunchAgent plist only carries passthrough shell values like `PATH` and proxy env so `ctb start` and `ctb restart` pick up edited `bridge.env` values

# Install And Admin Operations

## Default Paths

Install root:
- `~/.local/share/codex-telegram-bridge`

Installed command:
- `~/.local/share/codex-telegram-bridge/bin/ctb`

State directory:
- `~/.local/state/codex-telegram-bridge`

State contents:
- `bridge.db`
- `runtime/`
- `cache/`

Structured activity debug path:
- `~/.local/state/codex-telegram-bridge/runtime/debug/<threadId>/<turnId>.jsonl`

Log directory:
- `~/.local/state/codex-telegram-bridge/logs`

Log files:
- `bridge.log`
- `bootstrap.log`
- `app-server.log`

Config directory:
- `~/.config/codex-telegram-bridge`

Config file:
- `bridge.env`

Install manifest:
- `~/.local/share/codex-telegram-bridge/install-manifest.json`

## Service Ownership Model

Use:
- `systemd --user`
- service name `codex-telegram-bridge.service`
- or on macOS, `launchd`
- LaunchAgent label `com.codex.telegram-bridge`

Selected v1 ownership model:
- `systemd --user` manages only `codex-telegram-bridge.service` on Linux
- `launchd` manages only `com.codex.telegram-bridge` on macOS
- the bridge process starts, monitors, restarts, and reconnects its own local `codex app-server` child process

Reason:
- one outer supervisor
- simpler restart semantics
- no cross-service coordination
- readiness and failure attribution stay in one place

## Local Management Commands

Supported subcommands:
- `ctb install --telegram-token <token> [--codex-bin <bin>]`
- `ctb status`
- `ctb restart`
- `ctb stop`
- `ctb start`
- `ctb update`
- `ctb uninstall [--purge-state]`
- `ctb doctor`
- `ctb authorize pending [--latest | --select <index> | --user-id <id> | --show-expired]`
- `ctb authorize clear`
- `ctb service run`

Platform note:
- `ctb start`, `ctb stop`, and `ctb restart` use `systemd --user` on Linux
- `ctb start`, `ctb stop`, and `ctb restart` use `launchctl` and a per-user LaunchAgent on macOS
- when neither `systemctl` nor `launchctl` is available, install still writes release files and validates readiness, but does not enable a long-lived service
- on those hosts, the operator must run `ctb service run` under another supervisor or in a persistent shell

Authorization intent:
- `ctb authorize pending` lists pending Telegram candidates by default
- `ctb authorize pending --latest`, `--select <index>`, or `--user-id <id>` confirms one pending candidate
- `--show-expired` includes expired candidates in the listing, but expired rows still need fresh Telegram contact before confirmation
- `ctb authorize clear` clears the active binding and returns the bridge to `awaiting_authorization`

Operational note:
- `ctb service run` is the service entrypoint and is not the normal admin command surface

## Runtime Ownership Behavior

Bridge start:
- start the local app-server child
- run initialize handshake
- run a non-destructive readiness probe
- mark readiness

App-server child exit:
- log exit
- attempt one automatic child restart
- reconnect on success
- mark readiness degraded on failure

Bridge exit:
- let the active service manager restart the bridge
- recreate the app-server child on the next boot

## Diagnostics

Primary operator diagnostics:
- `ctb status`
- `ctb doctor`
- `journalctl --user -u codex-telegram-bridge.service -n 200`
- `launchctl print gui/$(id -u)/com.codex.telegram-bridge`
- `sqlite3 ~/.local/state/codex-telegram-bridge/bridge.db`
- inspect the per-turn JSONL files under `~/.local/state/codex-telegram-bridge/runtime/debug/`
- inspect Telegram session-surface trace logs under `~/.local/state/codex-telegram-bridge/logs/telegram-session-flow/`

`ctb status` reports:
- install and state roots
- config and service presence
- detected service manager and active state
- installed version and timestamp
- active session summary
- readiness snapshot

`ctb doctor` behavior:
- reruns the readiness probe
- persists the latest readiness snapshot
- resyncs Telegram commands when the configured bot token is valid

Structured activity visibility:
- the Telegram chat keeps one bridge-owned status card per running turn
- the bridge exposes current plan state through an inline expand/collapse button on the status card
- the bridge keeps per-command detail out of the main chat flow and still creates separate error cards when needed
- the bridge updates cards only when visible state changes or when a complete progress unit is available
- the status card renders bold labels plus a Markdown-aware `Progress` body through Telegram HTML
- raw agent-message deltas and reasoning deltas stay out of the default Telegram flow
- completed `agentMessage` items with `phase = commentary` are the authoritative commentary source for user-visible progress
- if Telegram refuses an edit or rate-limits it, the bridge retries the same card later instead of sending replacement-message spam
- `/inspect` shows the latest structured snapshot for the active session
- raw native notifications stay on disk in the runtime debug journal instead of being streamed to Telegram
- dedicated Telegram session-surface trace logs record per-card state transitions and render lifecycle events in JSONL files for `status` and `error`

## Update Behavior

`ctb update` currently:
1. reads the retained `sourceRoot` from `install-manifest.json`
2. fails if the install did not keep a usable source checkout
3. runs `npm install` in that source checkout
4. runs `npm run build`
5. reruns `dist/cli.js install` with the saved bridge config

Operational effect:
- state, database, and logs remain in place
- the reinstall path rewrites the local release files and the active service definition
- the reinstall path reruns readiness checks and Telegram command sync
- on hosts with an already-running long-lived service, follow `ctb update` with `ctb restart` to guarantee the live process picks up the rewritten release files
- the CLI prints `update complete`, not a full status summary

## Uninstall Behavior

`ctb uninstall` currently:
1. stop and disable the service
2. remove installed bridge files
3. remove the config directory
4. keep the state directory by default
5. support `--purge-state` for full removal

## Operational Failure Notes

`telegram_token_invalid`:
- installer should fail fast
- readiness becomes `telegram_token_invalid`
- the service must not enter the normal run loop

`codex_not_authenticated`:
- installer or doctor output should guide the local admin to complete Codex login or initialization on the host machine
