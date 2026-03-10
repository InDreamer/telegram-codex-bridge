# Phase 1 Delivery

## Definition Of Done

### Installation Success

Done when:
- one-line install completes without manual code edits
- bridge files are installed in the target directory
- the user service is written
- `ctb status` reports installed state

### Telegram Bot Available

Done when:
- bot token validation passes
- the bridge receives Telegram updates from the authorized user
- unauthorized users are rejected

### Readiness And Self-Check

Done when:
- `ctb doctor` returns an explicit readiness state
- `/status` returns the current bridge and Codex readiness summary
- install or startup fails with actionable remediation when Codex is not ready

### Project Picker Works

Done when:
- `/new` never silently enters a project
- `/new` always shows either recommendations or fallback actions
- the top recommendation is visible and explicit

### Real Codex Turn Starts After Project Selection

Done when:
- the user chooses a project
- the bridge creates a session and thread
- the next normal message starts a real Codex turn against that selected project

### Final Answer Returns To Telegram

Done when:
- the bridge waits for turn completion
- only the final assistant message is sent back
- intermediate tool and reasoning events are hidden
- long answers are chunked safely

### Session Controls Work

Done when:
- `/sessions` lists recent sessions
- `/use` switches the active session when the current one is idle
- `/use` is blocked while the current session is running
- `/interrupt` interrupts the active running session when supported

### Restart Recovery Works

Done when:
- sessions remain persisted across bridge restart
- the active session pointer is restored
- running turns become failed with a concrete `failure_reason`
- the user is told to retry instead of being left in silent ambiguity

### Unauthorized User Is Blocked

Done when:
- any Telegram user other than the configured authorized user is rejected
- rejected users do not create sessions or Codex turns
- rejections are logged locally

## Recommended Delivery Order

1. app-server protocol verification
2. installer scaffold
3. authorization bootstrap
4. readiness probe
5. SQLite state store
6. app-server adapter
7. Telegram bot skeleton
8. project discovery engine
9. project picker flow
10. session management
11. turn execution and final-answer extraction
12. interrupt and concurrency guardrails
13. restart recovery
14. logging and diagnostics
15. acceptance test matrix

## Future Or Out Of Scope

- approval relay
- Telegram approval cards
- approve or reject callback handling
- approval timeout handling
- pending approval persistence
