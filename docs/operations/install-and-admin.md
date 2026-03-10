# Install And Admin Operations

## Default Paths

Install root:
- `~/.local/share/codex-telegram-bridge`

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

Installer must place:
- `~/.local/share/codex-telegram-bridge/bin/ctb`

Supported subcommands:
- `ctb install`
- `ctb status`
- `ctb restart`
- `ctb stop`
- `ctb start`
- `ctb update`
- `ctb uninstall`
- `ctb doctor`
- `ctb authorize pending`
- `ctb authorize clear`

Authorization intent:
- `ctb authorize pending` lists and confirms pending Telegram candidates
- `ctb authorize clear` clears the active binding and returns the bridge to `awaiting_authorization`

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

## Update Behavior

`ctb update` must:
1. fetch or install the new bridge release
2. preserve the database and logs
3. restart the service
4. run readiness checks
5. print a post-update status summary

## Uninstall Behavior

`ctb uninstall` must:
1. stop and disable the service
2. remove installed bridge files
3. keep the state directory by default
4. support `--purge-state` for full removal

## Operational Failure Notes

`telegram_token_invalid`:
- installer should fail fast
- readiness becomes `telegram_token_invalid`
- the service must not enter the normal run loop

`codex_not_authenticated`:
- installer or doctor output should guide the local admin to complete Codex login or initialization on the host machine
