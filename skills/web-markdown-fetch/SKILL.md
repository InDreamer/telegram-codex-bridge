---
name: web-markdown-fetch
description: "Retrieve web page content in clean markdown/text for research and summarization. Use when pi needs to read a URL, bypass noisy HTML, or handle Cloudflare-prone pages. Always use this fallback chain in order: markdown.new, then defuddle.md, then r.jina.ai, then Scrapling. Persist markdown/image assets under a per-session agent asset directory, and when image understanding is needed in pi, use read on the downloaded local images first."
---

# Web Markdown Fetch

## Core Rule

When reading any target URL, apply these methods in strict order:

1. `https://markdown.new/<full-url>`
2. `https://defuddle.md/<full-url>`
3. `https://r.jina.ai/<full-url>`
4. Scrapling fallback (`scrapling extract ...`)

Do not jump to Scrapling before trying the three mirror prefixes.
For successful mirrors, keep evaluating in-order and select the best complete candidate; do not stop at the first partial success.

Treat asset handling as mandatory:

1. Persist fetched markdown and discovered images under a per-session agent asset directory.
2. Keep image assets enabled by default; `--no-save-assets` is allowed only if the user explicitly requests disabling image persistence.
3. For image-analysis requests in pi, use `read` on the downloaded local image files first before any external vision fallback.

## Pi Adaptation

This skill is adapted for pi package loading.

- When this repo is loaded as a pi package, the skill can be invoked as `/skill:web-markdown-fetch <url>`.
- Do not assume Codex-only session variables or Codex-only directories.
- The bundled helper auto-detects Pi/Codex/generic session ids when available, then falls back to a workspace-derived session id.
- Saved image files are meant to be opened locally with pi's `read` tool.

## Workflow

1. Normalize the input URL. If the scheme is missing, prepend `https://`.
2. Try `markdown.new` first.
3. If the output is empty, blocked, timed out, or clearly wrong, try `defuddle.md`.
4. If that still fails, try `r.jina.ai`.
5. For usable mirror outputs, score all candidates and pick the most complete one.
6. If all three fail, run Scrapling CLI fallback.
7. Save fetched markdown and discovered markdown-image assets to a temp directory keyed by the current agent session when detectable; otherwise use the workspace-derived fallback id.
8. Explicitly report the resolved asset directory path and the image save count (`images_saved/images_discovered`).
9. If the user asks for visual details such as a diagram, chart, or screenshot, inspect saved local image files first with `read`.
10. Do not call external vision services first for image interpretation; only use them as fallback when local image reading is unavailable or explicitly requested by the user.
11. After each successful fetch, report a completeness score (`0-100`) and whether it is full (`is_full=true/false`).
12. Return the extracted content and explicitly state which method succeeded.
13. If Scrapling reports SSL certificate verification errors, retry Scrapling with `--no-verify`.

## Quick Commands

Test mirrors directly:

```bash
curl -L "https://markdown.new/https://example.com"
curl -L "https://defuddle.md/https://example.com"
curl -L "https://r.jina.ai/https://example.com"
```

Run the bundled helper:

```bash
python3 scripts/fetch_markdown.py "https://example.com" --output content.md
```

Disable asset persistence only when explicitly needed:

```bash
python3 scripts/fetch_markdown.py "https://example.com" --output content.md --no-save-assets
```

## Failure Policy

If all methods fail:

1. Report each attempted method with the failure reason.
2. Suggest the next action: authenticated cookies, a proxy, or the site's API.
3. Do not fabricate content.

If image analysis is requested but local image files are unavailable or unreadable:

1. Report whether assets were saved and list the missing or unreadable files.
2. Re-fetch with asset saving enabled if needed.
3. Only then propose an external vision fallback.

## SSL Note

Some environments fail in Scrapling with `curl: (60) SSL certificate problem`.

- Manual Scrapling fallback should include `--no-verify` in that case.
- `scripts/fetch_markdown.py` already retries this automatically during Scrapling fallback.

## Session Asset Directory

- Default root: `/tmp/pi-web-markdown-fetch`
- Session id: auto-detected from Pi, Codex, or generic session env keys when available; otherwise derived from the current workspace
- Layout: `<assets-root>/<session-id>/<url-sha1-12>/`
- Files: `content.md`, `image_urls.txt`, `manifest.json`, downloaded images (`image_01.*`, ...)
- `manifest.json` includes completeness scoring: `score_percent`, `is_full`, `grade`, `missing_components`
- Override root: `--assets-root /path/to/root`
- Override session id: `--session-id <id>`

Default expectation for this skill:

1. Use the resolved agent session-id directory as the canonical place for fetched images.
2. Reuse those local files for image interpretation in the same pi session.

## Resources

- Use `scripts/fetch_markdown.py` for deterministic retries and structured fallback.
- Read `references/workflow.md` for mirror URL rules and troubleshooting.
