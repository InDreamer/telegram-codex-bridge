import type { ActivityStatus } from "../activity/types.js";
import { classifyNotification } from "../codex/notification-classifier.js";
import type { TelegramInlineKeyboardMarkup } from "../telegram/api.js";
import { normalizeAndTruncate } from "../util/text.js";

const RUNTIME_CARD_THROTTLE_MS = 2000;

export type TelegramEditResult =
  | { outcome: "edited" }
  | { outcome: "unchanged" }
  | { outcome: "rate_limited"; retryAfterMs: number }
  | { outcome: "failed" };

export type TelegramDeleteResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "rate_limited"; retryAfterMs: number }
  | { outcome: "failed" };

export function isTelegramEditCommitted(result: TelegramEditResult): boolean {
  return result.outcome === "edited" || result.outcome === "unchanged";
}

export function isTelegramDeleteCommitted(result: TelegramDeleteResult): boolean {
  return result.outcome === "deleted" || result.outcome === "not_found";
}

export interface RuntimeCardMessageState {
  surface: "status" | "plan" | "error";
  key: string;
  parseMode: "HTML" | null;
  messageId: number;
  lastRenderedText: string;
  lastRenderedReplyMarkupKey: string | null;
  lastRenderedAtMs: number | null;
  rateLimitUntilAtMs: number | null;
  pendingText: string | null;
  pendingReplyMarkup: TelegramInlineKeyboardMarkup | null;
  pendingReason: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RuntimeCommandState {
  itemId: string;
  commandText: string;
  latestSummary: string | null;
  outputBuffer: string;
  status: "running" | "completed" | "failed" | "interrupted";
}

export interface StatusCardState extends RuntimeCardMessageState {
  surface: "status";
  parseMode: "HTML";
  commandItems: Map<string, RuntimeCommandState>;
  commandOrder: RuntimeCommandState[];
  planExpanded: boolean;
  agentsExpanded: boolean;
  needsReanchorOnActive: boolean;
}

export interface ErrorCardState extends RuntimeCardMessageState {
  title: string;
  detail: string | null;
}

export function summarizeRuntimeCommands(commands: RuntimeCommandState[]): Array<Record<string, unknown>> {
  return commands.map((command) => ({
    itemId: command.itemId,
    commandText: command.commandText,
    latestSummary: command.latestSummary,
    status: command.status
  }));
}

export function summarizeRuntimeCardSurface(surface: RuntimeCardMessageState): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    surface: surface.surface,
    key: surface.key,
    parseMode: surface.parseMode,
    messageId: surface.messageId === 0 ? null : surface.messageId,
    lastRenderedText: surface.lastRenderedText || null,
    lastRenderedReplyMarkupKey: surface.lastRenderedReplyMarkupKey,
    lastRenderedAtMs: surface.lastRenderedAtMs,
    rateLimitUntilAtMs: surface.rateLimitUntilAtMs,
    pendingText: surface.pendingText,
    pendingReplyMarkupKey: serializeReplyMarkup(surface.pendingReplyMarkup),
    pendingReason: surface.pendingReason
  };

  if (surface.surface === "status") {
    const statusSurface = surface as StatusCardState;
    summary.commandCount = statusSurface.commandOrder.length;
    summary.commands = summarizeRuntimeCommands(statusSurface.commandOrder);
    summary.planExpanded = statusSurface.planExpanded;
    summary.agentsExpanded = statusSurface.agentsExpanded;
    return summary;
  }

  if (surface.surface === "error") {
    const errorSurface = surface as ErrorCardState;
    summary.title = errorSurface.title;
    summary.detail = errorSurface.detail;
  }

  return summary;
}

export function createRuntimeCardMessageState(
  surface: RuntimeCardMessageState["surface"],
  key: string,
  parseMode: "HTML" | null = null
): RuntimeCardMessageState {
  return {
    surface,
    key,
    parseMode,
    messageId: 0,
    lastRenderedText: "",
    lastRenderedReplyMarkupKey: null,
    lastRenderedAtMs: null,
    rateLimitUntilAtMs: null,
    pendingText: null,
    pendingReplyMarkup: null,
    pendingReason: null,
    timer: null
  };
}

export function createStatusCardMessageState(): StatusCardState {
  return {
    ...createRuntimeCardMessageState("status", "status", "HTML"),
    surface: "status",
    parseMode: "HTML",
    commandItems: new Map(),
    commandOrder: [],
    planExpanded: false,
    agentsExpanded: false,
    needsReanchorOnActive: false
  };
}

export function createErrorCardMessageState(key: string): ErrorCardState {
  return {
    ...createRuntimeCardMessageState("error", key, "HTML"),
    surface: "error",
    title: "",
    detail: null
  };
}

export function serializeReplyMarkup(replyMarkup: TelegramInlineKeyboardMarkup | null | undefined): string | null {
  return replyMarkup ? JSON.stringify(replyMarkup) : null;
}

export function getRuntimeCardThrottleMs(_surface: RuntimeCardMessageState["surface"]): number {
  return RUNTIME_CARD_THROTTLE_MS;
}

export function formatVisibleRuntimeState(status: ActivityStatus): string {
  if (status.latestProgress && /^Reconnecting/i.test(status.latestProgress)) {
    return "Reconnecting";
  }

  switch (status.turnStatus) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
    default:
      break;
  }

  if (status.threadBlockedReason || status.turnStatus === "blocked") {
    return "Blocked";
  }

  if (status.threadRuntimeState === "systemError") {
    return "Failed";
  }

  if (status.threadRuntimeState === "active") {
    return "Running";
  }

  switch (status.turnStatus) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "idle":
      return "Idle";
    default:
      return "Unknown";
  }
}

export function formatRuntimeBlockedReason(reason: ActivityStatus["threadBlockedReason"]): string | null {
  switch (reason) {
    case "waitingOnApproval":
      return "approval";
    case "waitingOnUserInput":
      return "user input";
    default:
      return null;
  }
}

export function selectStatusProgressText(status: ActivityStatus, latestProgressUnit: string | null): string | null {
  if (latestProgressUnit) {
    return latestProgressUnit;
  }

  if (status.latestProgress && /^Reconnecting/i.test(status.latestProgress)) {
    return status.latestProgress;
  }

  if (status.turnStatus === "failed") {
    return null;
  }

  if (status.latestProgress) {
    return status.latestProgress;
  }

  if (status.lastHighValueEventType === "found" && status.lastHighValueDetail) {
    return status.lastHighValueDetail;
  }

  return null;
}

export function applyRuntimeCommandDelta(
  statusCard: StatusCardState,
  classified: ReturnType<typeof classifyNotification> | null,
  nextStatus: ActivityStatus
): boolean {
  if (!classified) {
    return false;
  }

  let changed = false;
  if (classified.kind === "item_started" && classified.itemType === "commandExecution" && classified.itemId) {
    const commandResult = getOrCreateRuntimeCommand(statusCard, classified.itemId, classified.label);
    const command = commandResult.command;
    changed = commandResult.created || changed;
    const nextCommandText = normalizeCommandName(classified.label ?? command.commandText);
    if (command.commandText !== nextCommandText) {
      command.commandText = nextCommandText;
      changed = true;
    }
    if (command.status !== "running") {
      command.status = "running";
      changed = true;
    }
  }

  if (classified.kind === "command_output" && classified.itemId) {
    const commandResult = getOrCreateRuntimeCommand(statusCard, classified.itemId, "command");
    const command = commandResult.command;
    changed = commandResult.created || changed;
    const nextOutputBuffer = `${command.outputBuffer}${classified.text ?? ""}`;
    if (command.outputBuffer !== nextOutputBuffer) {
      command.outputBuffer = nextOutputBuffer;
    }
    const parsed = summarizeRuntimeCommandOutput(command.outputBuffer);
    if (parsed.command && (isGenericCommandName(command.commandText) || command.commandText !== parsed.command)) {
      command.commandText = parsed.command;
      changed = true;
    }
    if (command.latestSummary !== parsed.detail) {
      command.latestSummary = parsed.detail;
      changed = true;
    }
  }

  if (classified.kind === "item_completed" && classified.itemType === "commandExecution" && classified.itemId) {
    const command = statusCard.commandItems.get(classified.itemId);
    if (command && command.status !== "completed") {
      command.status = nextStatus.turnStatus === "interrupted" ? "interrupted" : "completed";
      changed = true;
    }
  }

  if (classified.kind === "turn_aborted" || classified.kind === "error" || classified.kind === "turn_completed") {
    const finalCommandStatus = classified.kind === "turn_aborted"
      ? "interrupted"
      : classified.kind === "error"
        ? "failed"
        : classified.status === "completed"
          ? "completed"
          : classified.status === "interrupted"
            ? "interrupted"
            : "failed";
    for (const command of statusCard.commandOrder) {
      if (command.status === finalCommandStatus || command.status !== "running") {
        continue;
      }
      command.status = finalCommandStatus;
      changed = true;
    }
  }

  return changed;
}

export function cleanRuntimeErrorMessage(message: string | null | undefined): string {
  return normalizeAndTruncate(`${message ?? "unknown error"}`, 240) ?? "unknown error";
}

function normalizeCommandName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "command";
}

function isGenericCommandName(value: string | null | undefined): boolean {
  return normalizeCommandName(value ?? "") === "command";
}

function summarizeRuntimeCommandOutput(text: string | null): { command: string | null; detail: string | null } {
  if (!text) {
    return {
      command: null,
      detail: null
    };
  }

  const rawLines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (rawLines.length === 0) {
    return {
      command: null,
      detail: null
    };
  }

  const firstLine = rawLines[0]!;
  const command = /^[>$#]\s*/u.test(firstLine)
    ? normalizeCommandName(firstLine.replace(/^[>$#]\s*/u, ""))
    : null;
  const detailCandidate = rawLines.at(-1) ?? null;
  const detail = detailCandidate && detailCandidate !== firstLine
    ? cleanRuntimeErrorMessage(detailCandidate)
    : null;

  return {
    command,
    detail
  };
}

function getOrCreateRuntimeCommand(
  statusCard: StatusCardState,
  itemId: string,
  label: string | null
): { command: RuntimeCommandState; created: boolean } {
  const existing = statusCard.commandItems.get(itemId);
  if (existing) {
    return {
      command: existing,
      created: false
    };
  }

  const created: RuntimeCommandState = {
    itemId,
    commandText: normalizeCommandName(label ?? "command"),
    latestSummary: null,
    outputBuffer: "",
    status: "running"
  };
  statusCard.commandItems.set(itemId, created);
  statusCard.commandOrder.push(created);
  return {
    command: created,
    created: true
  };
}
