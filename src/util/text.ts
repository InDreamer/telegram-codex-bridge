/**
 * Shared string helpers: whitespace normalisation and truncation.
 *
 * These tiny functions were duplicated 8+ times across tracker, service,
 * readiness, and UI.  Centralising them eliminates the copies.
 */

/**
 * Collapse all runs of whitespace to a single space and trim.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Truncate `text` to at most `limit` characters, appending an ellipsis when
 * the text is shortened.
 */
export function truncateText(text: string, limit: number, ellipsis = "\u2026"): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}${ellipsis}`;
}

/**
 * Normalize whitespace, then truncate.  Returns `null` for null / empty input.
 */
export function normalizeAndTruncate(
  text: string | null | undefined,
  limit: number,
  ellipsis = "\u2026"
): string | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeWhitespace(text);
  if (normalized.length === 0) {
    return null;
  }
  return truncateText(normalized, limit, ellipsis);
}

/**
 * Normalize whitespace of nullable text, returning null if empty.
 */
export function normalizeNullableText(text: string | null): string | null {
  if (!text) {
    return null;
  }
  const normalized = normalizeWhitespace(text);
  return normalized.length > 0 ? normalized : null;
}
