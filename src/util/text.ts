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

/**
 * Normalize, truncate with "..." ellipsis, and fall back to empty string.
 * Shared shorthand used across service, coordinator, and controller modules.
 */
export function summarizeTextPreview(text: string | null | undefined, limit = 160): string {
  return normalizeAndTruncate(text, limit, "...") ?? "";
}

/** True when the value is a non-blank string. */
export function hasMeaningfulText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Split a `"value :: prompt"` argument string on the first `::` separator. */
export function splitStructuredInputCommand(args: string): { value: string; prompt: string | null } {
  const separatorIndex = args.indexOf("::");
  if (separatorIndex === -1) {
    return { value: args.trim(), prompt: null };
  }
  return {
    value: args.slice(0, separatorIndex).trim(),
    prompt: args.slice(separatorIndex + 2).trim() || null
  };
}

/** Shared limit for history text previews across service modules. */
export const HISTORY_TEXT_LIMIT = 220;
