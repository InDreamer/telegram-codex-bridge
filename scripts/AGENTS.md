# scripts/AGENTS.md

Router for top-level GitHub install scripts.

This directory is intentionally small.
Read a script only when the task is about the hosted shell entrypoints themselves.

## Files

- `scripts/install-from-github.sh` — direct bridge install entrypoint
- `scripts/install-skill-from-github.sh` — bundled skill install entrypoint

## Read Order

For intended install/admin behavior, start with:

- `docs/operations/install-and-admin.md`

Then read one script only if you need to confirm:

- exact shell flags
- bootstrap sequence
- curl-pipe entry behavior
- GitHub raw URL wiring

## Stop Rule

Do not read both scripts unless the task explicitly compares direct install vs skill install.
