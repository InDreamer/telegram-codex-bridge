/**
 * Shared helpers for safely accessing fields on untyped (unknown / Record) values.
 *
 * Every module that parses raw JSON-RPC payloads or untyped notification params
 * needs these casts.  Having them in one place avoids the four-way duplication
 * across notification-classifier, normalize, and service.
 */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** Alias kept for call sites that read better as `getObject(value)?.field`. */
export const getObject = asRecord;

export function getString(
  value: Record<string, unknown> | unknown,
  key: string
): string | null {
  const record = asRecord(value);
  const candidate = record?.[key];
  return typeof candidate === "string" ? candidate : null;
}

export function getNumber(
  value: Record<string, unknown> | unknown,
  key: string
): number | null {
  const record = asRecord(value);
  const candidate = record?.[key];
  return typeof candidate === "number" ? candidate : null;
}

export function getNumberString(
  value: Record<string, unknown> | unknown,
  key: string
): string | null {
  const record = asRecord(value);
  const candidate = record?.[key];
  return typeof candidate === "number" ? `${candidate}` : null;
}

export function getBoolean(
  record: Record<string, unknown> | null,
  key: string
): boolean {
  return record?.[key] === true;
}

export function getArray(
  record: Record<string, unknown> | unknown,
  key: string
): unknown[];
export function getArray(value: unknown): unknown[];
export function getArray(
  valueOrRecord: unknown,
  key?: string
): unknown[] {
  if (key !== undefined) {
    const record = asRecord(valueOrRecord);
    const value = record?.[key];
    return Array.isArray(value) ? value : [];
  }
  return Array.isArray(valueOrRecord) ? valueOrRecord : [];
}

export function getNullableArray(
  record: Record<string, unknown> | null,
  key: string
): unknown[] | null {
  const value = record?.[key];
  if (value === null || value === undefined) {
    return null;
  }
  return Array.isArray(value) ? value : null;
}

export function getStringArray(
  value: Record<string, unknown> | unknown,
  key?: string
): string[] {
  let arr: unknown;
  if (key !== undefined) {
    const record = asRecord(value);
    arr = record?.[key];
  } else {
    arr = value;
  }
  if (!Array.isArray(arr)) {
    return [];
  }
  return arr.filter((entry): entry is string => typeof entry === "string");
}

export function getRequiredString(
  record: Record<string, unknown> | null,
  key: string
): string | null {
  const value = getString(record, key);
  return value && value.trim().length > 0 ? value : null;
}
