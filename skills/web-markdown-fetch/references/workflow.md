# Web Markdown Fetch Workflow

## URL Prefix Order

Always try in this order:

1. `https://markdown.new/<full-url>`
2. `https://defuddle.md/<full-url>`
3. `https://r.jina.ai/<full-url>`

Example:

- Target: `https://example.com/news`
- Mirror URL: `https://markdown.new/https://example.com/news`

## Retry Criteria

Treat a result as failure and move to the next method when:

- HTTP or network error
- timeout
- empty response
- obvious block page (`captcha`, `access denied`, Cloudflare interstitial)
- clearly wrong or unrelated content

For usable mirror responses, keep evaluating in order and pick the best candidate by completeness.
For X/Twitter links, prioritize richer post-media coverage before plain body length.

## Scrapling Fallback

Use this only after all three prefixes fail.

Install:

```bash
python3 -m pip install -U scrapling
```

CLI examples:

```bash
scrapling extract get "https://example.com" content.md
scrapling extract get "https://example.com" content.md --no-verify
scrapling extract fetch "https://example.com" content.md --no-headless
```

`content.md` produces markdown output. Use `.txt` or `.html` output filenames when those formats are preferred.

If you see `curl: (60) SSL certificate problem`, use `--no-verify`.

## Helper Script

Use the bundled script for deterministic behavior:

```bash
python3 scripts/fetch_markdown.py "https://example.com" --output content.md
```

The script enforces order and prints which method succeeded.
It also retries Scrapling with `--no-verify` automatically when needed.
It evaluates all usable mirror candidates and picks the best one instead of stopping at the first success.
For markdown images, it retries transient download failures and applies `pbs.twimg.com` size fallbacks (`orig/large/medium/small`) when needed.
It prints a final completeness line in stderr, for example:

```text
[score] completeness=86/100 full=no missing=engagement_metrics,comments_replies
```

By default it also persists assets automatically:

- Session id auto-detected from Pi, Codex, or generic session env keys when available
- Falls back to a workspace-derived id when no explicit session id exists
- Path layout: `/tmp/pi-web-markdown-fetch/<session-id>/<url-sha1-12>/`
- Saved files: `content.md`, `image_urls.txt`, `manifest.json`, downloaded markdown images
- `manifest.json` includes completeness scoring fields (`score_percent`, `is_full`, `grade`, `missing_components`)

Disable only if explicitly required:

```bash
python3 scripts/fetch_markdown.py "https://example.com" --output content.md --no-save-assets
```

## Pi-Specific Usage

After a successful fetch in pi:

1. Read `manifest.json` to confirm `asset_dir`, `images_saved`, and `images_discovered`.
2. If image interpretation is needed, use pi's `read` tool on files inside that `asset_dir`.
3. Only fall back to external vision if the local files are missing, unreadable, or the user explicitly asks for it.
