# Balanced Cleanup Design

## Goal

Tighten the new bridge codebase without turning a clean project into a pointless refactor.

## Scope

This cleanup only covers three places with clear payoff:

1. **Telegram poller hot path**
   - Keep the newest update offset in memory while processing a batch.
   - Persist the offset once after the batch instead of once per update.

2. **Logger hot path**
   - Stop re-running log-directory setup on every log line.
   - Reuse one directory-initialization result per log file.

3. **Service project-selection flow**
   - Collapse duplicated project-selection success logic into one helper.
   - Clear resolved picker state after selection so the service does not keep stale picker entries around.

## Non-goals

- No broad service/app-server protocol redesign.
- No config schema refactor.
- No authorization rewrite.
- No UI text rewrite.
- No speculative abstractions outside the three cleanup targets.

## Design choices

### Poller

The poller should keep current behavior from the user’s perspective: all updates are handled in order, and the final persisted offset still points at the newest processed update. The only change is when persistence happens.

### Logger

The logger should still write the same JSON lines to the same files and streams. The cleanup is purely internal: memoize directory readiness and reuse it instead of paying the same filesystem setup cost for every log event.

### Service

The service currently has two success paths that both validate picker state, block on running sessions, create a session, flip picker flags, and send the same success text. That should become one shared path. On success, the picker state should be removed instead of hanging around.

## Verification

Use TDD for each cleanup slice:

- add a poller test proving one persistence call per update batch
- add a logger test proving repeated logs reuse directory setup
- add service tests proving successful project selection clears picker state in both selection paths
- finish with `npm test` and `npm run check`
