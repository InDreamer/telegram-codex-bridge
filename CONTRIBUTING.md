# Contributing

This project moves fast, but random drive-by changes still need to be reviewable.

## Before You Open A PR

- check whether the change belongs to current shipped behavior, intended behavior, or future planning
- keep observed behavior and intended behavior separate in both code and docs
- if you change Telegram UX, verify the relevant product doc and the narrow implementation module
- if you change runtime or install behavior, update the matching operational or architecture doc

## Local Checks

Run the full set before you ask anyone to review your branch:

```bash
npm ci
npm run check
npm run test
npm run build
```

## Pull Request Rules

- keep the scope tight; mixed refactors plus feature work make review worse
- explain the user-visible change in plain language
- mention any doc updates required by the code change
- include screenshots or Telegram message examples when the change is UI-facing
- call out any behavior that is intentionally deferred instead of half-implemented

## Reporting Bugs

Useful reports include:

- what command or Telegram action triggered the issue
- what you expected
- what actually happened
- OS, Node version, and Codex version
- relevant `ctb doctor`, `/inspect`, or log output with secrets removed

## First-Time Readers

Start with the README, then jump to the smallest relevant doc in `docs/` or the routing guidance in `AGENTS.md`. Reading the whole repo before touching one file is wasted motion.
