/**
 * Sentinel strings used as progress text when a turn/subagent is blocked.
 *
 * Multiple modules compare against these exact strings, so they live in one
 * place to prevent silent drift.
 */

export const BLOCKED_PROGRESS_APPROVAL = "Waiting for approval";
export const BLOCKED_PROGRESS_USER_INPUT = "Waiting for user input";

export function isBlockedProgress(progress: string | null): boolean {
  return progress === BLOCKED_PROGRESS_APPROVAL || progress === BLOCKED_PROGRESS_USER_INPUT;
}
