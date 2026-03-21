# skills/AGENTS.md

Router for bundled Codex skills.

Use this directory only when the task is about the bundled skills themselves, not the bridge runtime in `src/`.

## Skills

### `skills/telegram-codex-linker/`

Purpose: bundled setup and repair skill for installing, linking, and maintaining the Telegram bridge.

Read order:

1. `skills/telegram-codex-linker/SKILL.md`
2. then one narrow subtree only if needed:
   - `skills/telegram-codex-linker/agents/` for skill-local agent prompts or routers
   - `skills/telegram-codex-linker/references/` for reference material
   - `skills/telegram-codex-linker/scripts/` for script entrypoints

### `skills/web-markdown-fetch/`

Purpose: bundled helper skill for fetching web content into markdown form.

Read order:

1. `skills/web-markdown-fetch/SKILL.md`
2. then one narrow supporting file only if the task is implementation-specific

## Boundary Rule

Do not read this directory when the task is about current bridge behavior in Telegram, runtime state, or install/admin flows unless the question is explicitly about the bundled Codex skill path.
