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

Selected v1 ownership model:
- `systemd --user` manages only `codex-telegram-bridge.service`
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

Authorization intent:
- `ctb authorize pending` lists pending Telegram candidates by default
- `ctb authorize pending --latest`, `--select <index>`, or `--user-id <id>` confirms one pending candidate
- `--show-expired` includes expired candidates in the listing, but expired rows still need fresh Telegram contact before confirmation
- `ctb authorize clear` clears the active binding and returns the bridge to `awaiting_authorization`

Operational note:
- `ctb service run` is the systemd entrypoint and is not the normal admin command surface

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
- let `systemd --user` restart the bridge
- recreate the app-server child on the next boot

## Diagnostics

Primary operator diagnostics:
- `ctb status`
- `ctb doctor`
- `journalctl --user -u codex-telegram-bridge.service -n 200`
- `sqlite3 ~/.local/state/codex-telegram-bridge/bridge.db`

`ctb status` reports:
- install and state roots
- config and service presence
- systemd active state
- installed version and timestamp
- active session summary
- readiness snapshot

`ctb doctor` behavior:
- reruns the readiness probe
- persists the latest readiness snapshot
- resyncs Telegram commands when the configured bot token is valid

## Update Behavior

`ctb update` currently:
1. reads the retained `sourceRoot` from `install-manifest.json`
2. fails if the install did not keep a usable source checkout
3. runs `npm install` in that source checkout
4. runs `npm run build`
5. reruns `dist/cli.js install` with the saved bridge config

Operational effect:
- state, database, and logs remain in place
- the reinstall path rewrites the local release files and systemd unit
- the reinstall path reruns readiness checks and Telegram command sync
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
