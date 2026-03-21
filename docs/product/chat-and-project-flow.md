# Telegram Chat And Project Flow

This file is now the lightweight product router for Telegram UX docs.
It used to be the single large composite Telegram product spec.
The detailed contract is now split so coding agents and human readers can load less context for narrow tasks.

Use this file when you want the product-level map first.
Then jump to exactly one detailed doc below.

## Split Product Docs

### Auth, project picker, session flow, and browse
Read:
- `docs/product/auth-and-project-flow.md`

Use for:
- authorization and first-bind flow
- project discovery rules
- `/help`, `/start`, `/commands`, `/cancel`, `/language`
- `/new`, project picker callbacks, manual-path flow, and `/browse`
- `/sessions`, `/use`, `/archive`, `/unarchive`, `/rename`, and `/pin`

### Codex-backed Telegram commands and rich inputs
Read:
- `docs/product/codex-command-reference.md`

Use for:
- `/plan`, `/model`, `/skills`, `/skill`
- `/plugins`, `/plugin`, `/apps`, `/mcp`, `/account`
- `/review`, `/fork`, `/rollback`, `/compact`
- `/thread`, `/local_image`, and `/mention`

### Runtime surfaces, inspect, status, and final-answer delivery
Read:
- `docs/product/runtime-and-delivery.md`

Use for:
- `/where`, `/inspect`, `/interrupt`, `/status`, and `/runtime`
- runtime hubs, runtime cards, and error cards
- final-answer delivery and message-edit rules
- blocked-turn continuation and rich-input continuation while blocked

### Bridge-owned callback payloads
Read:
- `docs/product/callback-contract.md`

Use for:
- callback namespace families such as `v1` through `v6`
- compact callback encoding rules
- stale and duplicate callback behavior

## Interpretation Rule

These product docs describe intended current Telegram behavior.
If you need to confirm what the code actually does today, verify against the narrow owner under `src/service/`, `src/telegram/`, or `src/codex/` as appropriate.
