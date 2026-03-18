# Install And Admin Operations

## Runtime And Tooling Floor

Package manager and build scripts:
- `npm run build`
- `npm run dev`
- `npm run check`
- `npm run test`

Actual admin and runtime surface:
- `ctb ...` is the operator command surface
- `ctb service run` is the long-lived service entrypoint used by `systemd --user`, `launchd`, or another supervisor
- `ctb install-skill` installs the bundled Codex skill into `${CODEX_HOME:-~/.codex}/skills/telegram-codex-linker`

Node requirement:
- Node `>=25.0.0`

Voice-input backend rule:
- when voice input is enabled, the bridge tries OpenAI audio transcription first if `VOICE_OPENAI_API_KEY` is configured
- if OpenAI transcription is unavailable or fails, the bridge falls back to app-server realtime audio transcription when the current Codex runtime and local `ffmpeg` support it

## Config Keys

Supported config keys in `bridge.env`:
- `TELEGRAM_BOT_TOKEN`
- `CODEX_BIN`
- `TELEGRAM_API_BASE_URL`
- `TELEGRAM_POLL_TIMEOUT_SECONDS`
- `TELEGRAM_POLL_INTERVAL_MS`
- `PROJECT_SCAN_ROOTS`
- `VOICE_INPUT_ENABLED`
- `VOICE_OPENAI_API_KEY`
- `VOICE_OPENAI_TRANSCRIBE_MODEL`
- `VOICE_FFMPEG_BIN`

`PROJECT_SCAN_ROOTS` rules:
- path-delimited root list written into `bridge.env`
- on Linux and macOS, use `:`
- when set, project discovery scans only those roots
- when empty or unset, runtime falls back to scanning the user's `HOME` as one bounded root
- runtime fallback does not rewrite config; persistence belongs to install or repair flow
- if both `bridge.env` and the caller environment provide the same bridge setting, `bridge.env` is the persisted source of truth for bridge admin flows

macOS note:
- `bridge.env` stays the source of truth for bridge config after install
- the LaunchAgent plist only carries passthrough shell values like `PATH` and proxy env so `ctb start` and `ctb restart` pick up edited `bridge.env` values

## Default Paths

Install root:
- `~/.local/share/codex-telegram-bridge`

Installed command:
- `~/.local/share/codex-telegram-bridge/bin/ctb`

Service definition paths:
- `~/.config/systemd/user/codex-telegram-bridge.service` on Linux
- `~/Library/LaunchAgents/com.codex.telegram-bridge.plist` on macOS

State directory:
- `~/.local/state/codex-telegram-bridge`

State contents:
- `bridge.db`
- `state-store-open-failure.json`
- `runtime/`
- `runtime/telegram-offset.json`
- `cache/`

Structured activity debug path:
- `~/.local/state/codex-telegram-bridge/runtime/debug/<threadId>/<turnId>.jsonl`

State-store failure marker:
- `~/.local/state/codex-telegram-bridge/state-store-open-failure.json`
- written only when the bridge cannot safely open the SQLite state store
- removed automatically after a successful state-store open

Log directory:
- `~/.local/state/codex-telegram-bridge/logs`

Log files:
- `bridge.log`
- `bootstrap.log`
- `app-server.log`
- `launchd.stdout.log` on macOS when managed by LaunchAgent
- `launchd.stderr.log` on macOS when managed by LaunchAgent
- `telegram-session-flow/status-card.log`
- `telegram-session-flow/plan-card.log`
- `telegram-session-flow/error-card.log`

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
- `ctb install --telegram-token <token> [--codex-bin <bin>] [--project-scan-roots <path1:path2:...>] [--voice-input <true|false>] [--voice-openai-api-key <key>] [--voice-openai-model <model>] [--voice-ffmpeg-bin <bin>]`
- `ctb install-skill`
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

## GitHub Install Shortcuts

Recommended public entry:

```bash
curl -fsSL https://raw.githubusercontent.com/InDreamer/telegram-codex-bridge/master/scripts/install-skill-from-github.sh | bash
```

Then in Codex:

```text
Use $telegram-codex-linker to set up my Telegram bridge.
```

Reason:
- install the skill once
- let the skill take over bridge install, repair, token collection, authorization, and verification
- interrupt the user only for unavoidable external actions such as providing a Telegram bot token or messaging the bot once

Bridge install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/InDreamer/telegram-codex-bridge/master/scripts/install-from-github.sh | bash -s -- --telegram-token "<BOT_TOKEN>" --project-scan-roots "$HOME/projects:$HOME/work"
```

Bundled Codex skill install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/InDreamer/telegram-codex-bridge/master/scripts/install-skill-from-github.sh | bash
```

Notes:
- the bridge install shortcut downloads a repository archive, runs `npm install`, runs `npm run build`, and then runs `node dist/cli.js install`
- the skill install shortcut copies `skills/telegram-codex-linker` into `${CODEX_HOME:-~/.codex}/skills/`
- both scripts accept `--ref <name>` plus `--ref-type branch|tag`; default is `master`
- the bridge install shortcut also accepts `--project-scan-roots <path1:path2:...>` and forwards it into `ctb install`
- after skill install, restart Codex so the new skill is discovered

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

`/where` operator note:
- `Bridge 会话 ID` maps to `session.session_id` in SQLite
- `Codex 线程 ID` maps to `session.thread_id` and the per-turn debug directory name
- `最近 Turn ID` maps to `session.last_turn_id` and the `<turnId>.jsonl` debug file name
- before the first real task, `/where` may show that the Codex thread has not been created yet

`ctb status` reports:
- install and state roots
- config and service presence
- detected service manager and active state
- installed version and timestamp
- whether the SQLite state store opened successfully
- active session summary
- pending runtime notice count
- readiness snapshot
- Node version and whether it satisfies the declared engine floor
- Codex version and whether it satisfies the bridge's minimum supported floor
- service-manager health summary
- path writability summary for install/config/state roots
- voice-input enablement plus backend availability summary
- capability-check summary for the required V2 app-server surface

`ctb doctor` behavior:
- reruns the readiness probe
- persists the latest readiness snapshot
- resyncs Telegram commands when the configured bot token is valid
- uses the same centralized readiness/preflight matrix as install and service startup
- hard-fails for unsupported Node or Codex capability floors instead of entering a degraded run loop
- includes doctor-only archive drift diagnostics based on local sessions versus remote `thread/list` membership
- local `ctb` output remains plain text for terminal and script compatibility; bold field labels are a Telegram-only presentation rule

Readiness / preflight behavior:
- the bridge reads the Node requirement from `package.json` and treats an unsupported runtime as `bridge_unhealthy`
- the bridge requires `codex-cli >= 0.114.0` and checks the current schema surface against the V2 request/notification floor
- the required notification floor includes `thread/started` and `thread/name/updated`; if those subagent naming notifications are missing, startup fails instead of silently degrading to fake agent labels
- current capability-check results are cached under `~/.local/state/codex-telegram-bridge/cache/`
- missing `systemctl` or `launchctl` is reported as a warning, not a hard blocker, because `ctb service run` may still be supervised externally
- non-writable state or config roots are treated as hard failures
- if voice input is enabled but neither OpenAI transcription nor realtime audio transcription is usable, readiness is treated as `bridge_unhealthy`

Structured activity visibility:
- the Telegram chat keeps one bridge-owned status card per running turn
- the bridge exposes current plan state through an inline expand/collapse button on the status card
- the bridge keeps per-command detail out of the main chat flow and still creates separate error cards when needed
- the bridge updates cards only when visible state changes or when a complete progress unit is available
- the status-card `State` line is reduced from app-server runtime state, while `Progress` remains commentary-aware user-facing phase text
- the status card renders bold labels plus a Markdown-aware `Progress` body through Telegram HTML
- raw agent-message deltas and reasoning deltas stay out of the default Telegram flow
- completed `agentMessage` items with `phase = commentary` are the authoritative commentary source for user-visible progress
- expanded subagent rows use protocol thread identity for display names, preferring agent nickname over thread title and falling back only when the runtime provides neither
- expanded subagent rows keep commentary as the visible progress text until a new subagent turn starts, instead of replacing it with later command noise
- if Telegram refuses an edit or rate-limits it, the bridge retries the same card later instead of sending replacement-message spam
- `/inspect` shows a compact Chinese activity snapshot for the active session, hides empty sections, and does not expose local debug file paths
- when live inspect state is unavailable for a completed session, `/inspect` can recover best-effort detail from Codex thread history
- raw native notifications stay on disk in the runtime debug journal instead of being streamed to Telegram
- dedicated Telegram session-surface trace logs record per-card state transitions and render lifecycle events in JSONL files for `status` and `error`

State-store safety rule:
- the bridge now fails closed if the SQLite state store cannot be opened safely
- it must not rotate the database away or create a fresh empty state database for transient or uncertain startup errors
- operator diagnostics should come from the bootstrap log plus `state-store-open-failure.json`

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
- when `systemd --user` or `launchd` is managing the bridge, the reinstall path reloads or restarts that managed service automatically
- when no supported local service manager exists, the operator must restart the external supervisor or rerun `ctb service run`
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

`state_store_open_failed`:
- the bridge should stop before entering the normal run loop
- `ctb status` and `ctb doctor` should still surface the failure marker fields
- operator should inspect the bootstrap log, read `state-store-open-failure.json`, and preserve the existing `bridge.db` for offline inspection
