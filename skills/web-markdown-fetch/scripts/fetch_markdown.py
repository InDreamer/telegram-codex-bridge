#!/usr/bin/env python3
"""Fetch a URL through markdown mirror services with ordered fallback."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, unquote, urlencode, urlparse, urlunparse
from urllib.request import Request, urlopen

MIRRORS = (
    ("markdown.new", "https://markdown.new/{url}"),
    ("defuddle.md", "https://defuddle.md/{url}"),
    ("r.jina.ai", "https://r.jina.ai/{url}"),
)

BLOCK_PATTERNS = (
    "attention required",
    "just a moment",
    "captcha",
    "access denied",
    "something went wrong",
    "try again",
    "some privacy related extensions may cause issues on x.com",
    "don’t miss what’s happening",
    "don't miss what's happening",
    "people on x are the first to know",
)

SESSION_ENV_KEYS = (
    "PI_SESSION_ID",
    "PI_SESSION_NAME",
    "PI_SESSION_FILE",
    "AGENT_SESSION_ID",
    "CLAUDE_SESSION_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "OPENAI_SESSION_ID",
    "SESSION_ID",
)

IMAGE_PATTERN = re.compile(r"!\[[^\]]*]\((https?://[^)\s]+)\)")

ASSET_ROOT_DEFAULT = "/tmp/pi-web-markdown-fetch"


def unique_ordered(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def normalize_url(raw_url: str) -> str:
    value = raw_url.strip()
    if not value:
        raise ValueError("URL is empty.")
    # Reject malformed scheme-like inputs such as "http:/example.com".
    if "://" not in value and re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", value):
        raise ValueError(f"Invalid URL: {raw_url}")
    if "://" not in value:
        value = f"https://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"Invalid URL: {raw_url}")
    return value


def looks_usable(text: str, min_chars: int) -> bool:
    body = text.strip()
    if len(body) < min_chars:
        return False
    sample = body[:2000].lower()
    return not any(token in sample for token in BLOCK_PATTERNS)


def fetch_text(url: str, timeout: int) -> str:
    req = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
            ),
            "Accept": "text/markdown,text/plain,text/html;q=0.9,*/*;q=0.8",
        },
    )
    with urlopen(req, timeout=timeout) as resp:
        status = getattr(resp, "status", 200)
        if status >= 400:
            raise RuntimeError(f"HTTP {status}")
        return resp.read().decode("utf-8", errors="replace")


def fetch_binary(url: str, timeout: int) -> tuple[bytes, str]:
    req = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
            ),
            "Accept": "image/*,*/*;q=0.8",
        },
    )
    with urlopen(req, timeout=timeout) as resp:
        status = getattr(resp, "status", 200)
        if status >= 400:
            raise RuntimeError(f"HTTP {status}")
        body = resp.read()
        content_type = resp.headers.get("Content-Type", "")
        return body, content_type


def build_binary_fetch_candidates(url: str) -> list[str]:
    candidates = [url]
    try:
        parsed = urlparse(url)
    except Exception:  # noqa: BLE001
        return candidates

    host = parsed.netloc.lower()
    if host != "pbs.twimg.com":
        return candidates

    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    image_format = query.get("format", "").strip()
    if not image_format:
        return candidates

    for size in ("orig", "large", "medium", "small"):
        next_query = dict(query)
        next_query["format"] = image_format
        next_query["name"] = size
        next_url = urlunparse(parsed._replace(query=urlencode(next_query)))
        candidates.append(next_url)
    return unique_ordered(candidates)


def fetch_binary_with_retries(url: str, timeout: int) -> tuple[bytes, str, str]:
    attempts_per_url = 2
    errors: list[str] = []
    for candidate in build_binary_fetch_candidates(url):
        for attempt in range(1, attempts_per_url + 1):
            try:
                body, content_type = fetch_binary(candidate, timeout=timeout)
                return body, content_type, candidate
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{candidate} (attempt {attempt}/{attempts_per_url}): {exc}")
    trimmed = errors[-4:]
    raise RuntimeError(" | ".join(trimmed) if trimmed else "binary fetch failed")


def sanitize_path_component(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    cleaned = cleaned.strip("-")
    return cleaned or "unknown-session"


def find_git_root(path: Path) -> Path | None:
    current = path
    while True:
        if (current / ".git").exists():
            return current
        if current.parent == current:
            return None
        current = current.parent


def derive_workspace_session_id() -> tuple[str, str]:
    try:
        cwd = Path.cwd().resolve()
    except Exception:  # noqa: BLE001
        cwd = Path.cwd()

    repo_root = find_git_root(cwd)
    anchor = repo_root or cwd
    label = sanitize_path_component(anchor.name or "workspace")
    digest = hashlib.sha1(str(cwd).encode("utf-8")).hexdigest()[:8]
    source = "cwd_git_root" if repo_root else "cwd"
    return f"{label}-{digest}", source


def detect_session_id() -> tuple[str, str]:
    for key in SESSION_ENV_KEYS:
        value = os.getenv(key, "").strip()
        if not value:
            continue
        if key.endswith("_FILE"):
            stem = Path(value).stem.strip()
            if stem:
                return stem, key
            continue
        return value, key
    return derive_workspace_session_id()


def extract_image_urls(markdown: str) -> list[str]:
    seen: set[str] = set()
    ordered: list[str] = []
    for url in IMAGE_PATTERN.findall(markdown):
        if url in seen:
            continue
        seen.add(url)
        ordered.append(url)
    return ordered


def is_x_host(host: str) -> bool:
    normalized = host.lower()
    return normalized.endswith("x.com") or normalized.endswith("twitter.com")


def count_x_media_images(image_urls: list[str]) -> int:
    total = 0
    for image_url in image_urls:
        try:
            parsed = urlparse(image_url)
        except Exception:  # noqa: BLE001
            continue
        host = parsed.netloc.lower()
        path = parsed.path.lower()
        if host == "pbs.twimg.com" and "/media/" in path:
            total += 1
    return total


def score_candidate(
    *,
    source: str,
    markdown: str,
    target_url: str,
    min_chars: int,
) -> dict[str, object]:
    image_urls = extract_image_urls(markdown)
    completeness = score_fetch_completeness(
        markdown=markdown,
        target_url=target_url,
        min_chars=min_chars,
        images_discovered=len(image_urls),
        images_saved=0,
        image_errors=[],
        save_assets_enabled=False,
    )
    return {
        "source": source,
        "markdown": markdown,
        "completeness": completeness,
        "body_len": len(markdown.strip()),
        "images_discovered": len(image_urls),
        "x_media_images": count_x_media_images(image_urls),
    }


def pick_best_candidate(
    candidates: list[dict[str, object]],
    target_url: str,
) -> dict[str, object]:
    if not candidates:
        raise ValueError("No candidates available.")

    host = urlparse(target_url).netloc.lower()
    if is_x_host(host):
        # On X/Twitter links, prioritize post media coverage first,
        # then overall completeness and text quality.
        return max(
            candidates,
            key=lambda c: (
                int(c.get("x_media_images", 0)),
                int(c.get("images_discovered", 0)),
                int((c.get("completeness") or {}).get("score_percent", 0)),
                int(c.get("body_len", 0)),
            ),
        )

    return max(
        candidates,
        key=lambda c: (
            int((c.get("completeness") or {}).get("score_percent", 0)),
            int(c.get("images_discovered", 0)),
            int(c.get("body_len", 0)),
        ),
    )


def guess_file_extension(url: str, content_type: str) -> str:
    parsed = urlparse(url)
    path = unquote(parsed.path or "")
    suffix = Path(path).suffix.lower()
    if suffix and 1 <= len(suffix) <= 8:
        return suffix

    if content_type:
        mime = content_type.split(";", 1)[0].strip().lower()
        guessed = mimetypes.guess_extension(mime) or ""
        if guessed:
            return guessed
    return ".jpg"


def build_asset_dir(assets_root: str, session_id: str, target_url: str) -> Path:
    session_component = sanitize_path_component(session_id)
    url_digest = hashlib.sha1(target_url.encode("utf-8")).hexdigest()[:12]
    return Path(assets_root) / session_component / url_digest


def score_fetch_completeness(
    *,
    markdown: str,
    target_url: str,
    min_chars: int,
    images_discovered: int,
    images_saved: int,
    image_errors: list[dict[str, str]],
    save_assets_enabled: bool,
) -> dict[str, object]:
    score = 0
    missing: list[str] = []
    notes: list[str] = []

    if looks_usable(markdown, min_chars):
        score += 55
    else:
        missing.append("main_text_unusable")

    body_len = len(markdown.strip())
    if body_len >= 2000:
        score += 15
    elif body_len >= 800:
        score += 12
    elif body_len >= 300:
        score += 8
    elif body_len >= min_chars:
        score += 5
    else:
        missing.append("main_text_too_short")

    if re.search(r"(?mi)^title\s*:", markdown) or re.search(r"(?m)^#\s+\S", markdown):
        score += 5
    else:
        missing.append("title")

    if re.search(r"(?mi)^author\s*:", markdown):
        score += 5
    else:
        missing.append("author")

    if target_url in markdown or re.search(r"(?mi)^source\s*:", markdown):
        score += 5
    else:
        missing.append("source_url")

    if images_discovered == 0:
        score += 15
        notes.append("no_markdown_images_discovered")
    elif save_assets_enabled:
        ratio = images_saved / images_discovered
        score += round(15 * ratio)
        if images_saved < images_discovered:
            missing.append("some_images_not_saved")
    else:
        score += 6
        missing.append("images_not_saved_assets_disabled")
        notes.append("save_assets_disabled")

    if image_errors:
        missing.append("image_download_errors")

    host = urlparse(target_url).netloc.lower()
    if host.endswith("x.com") or host.endswith("twitter.com"):
        penalties = 0
        has_numeric_engagement = bool(
            re.search(
                r"(?i)(\b\d[\d,\.kKmM]*\s*(likes?|reposts?|retweets?|views?|bookmarks?)\b)"
                r"|(\b(likes?|reposts?|retweets?|views?|bookmarks?)\s*\d[\d,\.kKmM]*\b)",
                markdown,
            )
        )
        has_numeric_replies = bool(
            re.search(
                r"(?i)(\b\d[\d,\.kKmM]*\s*(repl(?:y|ies)|comments?)\b)"
                r"|(\b(repl(?:y|ies)|comments?)\s*\d[\d,\.kKmM]*\b)",
                markdown,
            )
        )
        if not has_numeric_engagement:
            penalties += 6
            missing.append("engagement_metrics")
        if not has_numeric_replies:
            penalties += 6
            missing.append("comments_replies")
        if not re.search(r"https?://(?:x|twitter)\.com/[^\s)]+/status/\d+", markdown):
            penalties += 3
            missing.append("thread_links")
        if penalties:
            notes.append("x_platform_surfaces_are_often_partial_without_authenticated_api")
        score -= penalties

    score = max(0, min(100, int(round(score))))
    if score >= 95:
        grade = "excellent"
    elif score >= 80:
        grade = "good"
    elif score >= 60:
        grade = "partial"
    else:
        grade = "poor"

    missing = unique_ordered(missing)
    notes = unique_ordered(notes)
    is_full = score >= 95 and not missing
    return {
        "score_percent": score,
        "is_full": is_full,
        "grade": grade,
        "missing_components": missing,
        "notes": notes,
        "scoring_version": "v1",
    }


def persist_assets(
    *,
    markdown: str,
    target_url: str,
    fetch_source: str,
    timeout: int,
    assets_root: str,
    session_id: str,
    session_source: str,
    output_target: str,
    min_chars: int,
    quiet: bool,
) -> dict[str, object]:
    asset_dir = build_asset_dir(assets_root=assets_root, session_id=session_id, target_url=target_url)
    if asset_dir.exists():
        shutil.rmtree(asset_dir)
    asset_dir.mkdir(parents=True, exist_ok=True)

    content_path = asset_dir / "content.md"
    content_path.write_text(markdown, encoding="utf-8")

    image_urls = extract_image_urls(markdown)
    image_rows: list[dict[str, str | int]] = []
    errors: list[dict[str, str]] = []
    for idx, image_url in enumerate(image_urls, start=1):
        try:
            body, content_type, download_url = fetch_binary_with_retries(image_url, timeout=timeout)
            ext = guess_file_extension(download_url, content_type)
            filename = f"image_{idx:02d}{ext}"
            file_path = asset_dir / filename
            file_path.write_bytes(body)
            image_rows.append(
                {
                    "url": image_url,
                    "download_url": download_url,
                    "file": filename,
                    "bytes": len(body),
                    "content_type": content_type,
                }
            )
        except Exception as exc:  # noqa: BLE001
            errors.append({"url": image_url, "error": str(exc)})

    image_urls_text = "\n".join(image_urls)
    if image_urls_text:
        image_urls_text += "\n"
    (asset_dir / "image_urls.txt").write_text(image_urls_text, encoding="utf-8")

    manifest = {
        "target_url": target_url,
        "fetch_source": fetch_source,
        "saved_at": datetime.now(timezone.utc).isoformat(),
        "session_id": session_id,
        "session_id_source": session_source,
        "assets_root": assets_root,
        "asset_dir": str(asset_dir),
        "output_target": output_target,
        "images_discovered": len(image_urls),
        "images_saved": len(image_rows),
        "images": image_rows,
        "image_errors": errors,
    }
    manifest["completeness"] = score_fetch_completeness(
        markdown=markdown,
        target_url=target_url,
        min_chars=min_chars,
        images_discovered=len(image_urls),
        images_saved=len(image_rows),
        image_errors=errors,
        save_assets_enabled=True,
    )
    (asset_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if not quiet:
        print(
            (
                f"[assets] session={sanitize_path_component(session_id)} "
                f"source={session_source} dir={asset_dir} "
                f"images={len(image_rows)}/{len(image_urls)}"
            ),
            file=sys.stderr,
        )
    return manifest


def run_scrapling(target_url: str, timeout: int, min_chars: int) -> tuple[str | None, str]:
    binary = shutil.which("scrapling")
    if not binary:
        return None, "scrapling CLI not found in PATH"

    tmp = tempfile.NamedTemporaryFile(prefix="scrapling-", suffix=".md", delete=False)
    tmp.close()
    output_path = Path(tmp.name)
    commands = (
        [binary, "extract", "get", target_url, str(output_path)],
        [binary, "extract", "get", target_url, str(output_path), "--no-verify"],
        [binary, "extract", "fetch", target_url, str(output_path), "--no-headless"],
    )

    try:
        last_error = "scrapling extraction failed"
        for command in commands:
            try:
                proc = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=timeout + 20,
                    check=False,
                )
            except subprocess.TimeoutExpired:
                last_error = "scrapling timed out"
                continue

            if proc.returncode != 0:
                stderr = (proc.stderr or "").strip().splitlines()
                if stderr:
                    last_error = stderr[-1]
                continue

            if not output_path.exists():
                continue

            content = output_path.read_text(encoding="utf-8", errors="replace")
            if looks_usable(content, min_chars):
                return content, "scrapling"
            last_error = "scrapling returned unusable response"
        return None, last_error
    finally:
        try:
            os.remove(output_path)
        except OSError:
            pass


def write_output(content: str, output: str) -> None:
    if output == "-":
        sys.stdout.write(content)
        if not content.endswith("\n"):
            sys.stdout.write("\n")
        return
    path = Path(output)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def finalize_success(content: str, source: str, target_url: str, args: argparse.Namespace) -> int:
    try:
        write_output(content, args.output)
    except Exception as exc:  # noqa: BLE001
        print(f"[error] failed to write output '{args.output}': {exc}", file=sys.stderr)
        return 1
    completeness: dict[str, object] | None = None
    if args.save_assets:
        if args.session_id:
            session_id, session_source = args.session_id, "arg"
        else:
            session_id, session_source = detect_session_id()
        try:
            manifest = persist_assets(
                markdown=content,
                target_url=target_url,
                fetch_source=source,
                timeout=args.timeout,
                assets_root=args.assets_root,
                session_id=session_id,
                session_source=session_source,
                output_target=args.output,
                min_chars=args.min_chars,
                quiet=args.quiet,
            )
            completeness = manifest.get("completeness")  # type: ignore[assignment]
        except Exception as exc:  # noqa: BLE001
            if not args.quiet:
                print(f"[warn] asset persistence failed: {exc}", file=sys.stderr)
    if completeness is None:
        completeness = score_fetch_completeness(
            markdown=content,
            target_url=target_url,
            min_chars=args.min_chars,
            images_discovered=len(extract_image_urls(content)),
            images_saved=0,
            image_errors=[],
            save_assets_enabled=False,
        )
    if not args.quiet:
        missing_list = completeness.get("missing_components", []) if completeness else []
        missing_text = ",".join(missing_list[:6]) if isinstance(missing_list, list) and missing_list else "none"
        score = completeness.get("score_percent", 0) if completeness else 0
        is_full = "yes" if completeness and completeness.get("is_full") else "no"
        print(f"[score] completeness={score}/100 full={is_full} missing={missing_text}", file=sys.stderr)
        print(f"[ok] source={source}", file=sys.stderr)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Try markdown.new -> defuddle.md -> r.jina.ai; "
            "fallback to Scrapling if all fail."
        )
    )
    parser.add_argument("url", help="Target URL (with or without scheme)")
    parser.add_argument("--output", default="-", help="Output file path; '-' prints to stdout")
    parser.add_argument("--timeout", type=int, default=20, help="Network timeout in seconds")
    parser.add_argument(
        "--min-chars",
        type=int,
        default=80,
        help="Minimum output length to treat as success",
    )
    parser.add_argument("--quiet", action="store_true", help="Suppress progress logs")
    parser.add_argument(
        "--save-assets",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "Persist markdown + image assets to a per-session temp directory "
            "(use --no-save-assets to disable)"
        ),
    )
    parser.add_argument(
        "--assets-root",
        default=ASSET_ROOT_DEFAULT,
        help=f"Root directory for saved assets (default: {ASSET_ROOT_DEFAULT})",
    )
    parser.add_argument(
        "--session-id",
        default=None,
        help=(
            "Override session id for assets directory naming. "
            "Default auto-detects from Pi/Codex/session envs and then falls back to a workspace-derived id."
        ),
    )
    args = parser.parse_args()

    try:
        target_url = normalize_url(args.url)
    except ValueError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 2

    failures: list[str] = []
    candidates: list[dict[str, object]] = []
    for source, template in MIRRORS:
        candidate = template.format(url=target_url)
        if not args.quiet:
            print(f"[try] {source}: {candidate}", file=sys.stderr)
        try:
            content = fetch_text(candidate, args.timeout)
        except HTTPError as exc:
            failures.append(f"{source}: HTTP {exc.code}")
            continue
        except URLError as exc:
            failures.append(f"{source}: {exc.reason}")
            continue
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{source}: {exc}")
            continue

        if not looks_usable(content, args.min_chars):
            failures.append(f"{source}: unusable response")
            continue

        scored = score_candidate(
            source=source,
            markdown=content,
            target_url=target_url,
            min_chars=args.min_chars,
        )
        candidates.append(scored)
        if not args.quiet:
            completeness = scored.get("completeness", {})
            print(
                (
                    f"[candidate] {source}: score="
                    f"{completeness.get('score_percent', 0)} "
                    f"images={scored.get('images_discovered', 0)} "
                    f"x_media={scored.get('x_media_images', 0)}"
                ),
                file=sys.stderr,
            )

    if candidates:
        best = pick_best_candidate(candidates, target_url)
        if not args.quiet:
            print(
                (
                    "[pick] source="
                    f"{best.get('source')} score="
                    f"{(best.get('completeness') or {}).get('score_percent', 0)} "
                    f"images={best.get('images_discovered', 0)} "
                    f"x_media={best.get('x_media_images', 0)}"
                ),
                file=sys.stderr,
            )
        return finalize_success(
            content=str(best.get("markdown", "")),
            source=str(best.get("source", "unknown")),
            target_url=target_url,
            args=args,
        )

    if not args.quiet:
        print("[try] scrapling fallback", file=sys.stderr)
    content, source = run_scrapling(target_url, args.timeout, args.min_chars)
    if content:
        return finalize_success(content=content, source=source, target_url=target_url, args=args)

    print("[error] all methods failed", file=sys.stderr)
    for failure in failures:
        print(f" - {failure}", file=sys.stderr)
    print(f" - scrapling: {source}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
