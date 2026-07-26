import type { BridgeCommandActionView } from "../core/interaction-model/bridge-actions.js";
import type { UiLanguage } from "../types.js";
import type { TelegramInlineKeyboardMarkup } from "./api.js";
import { encodeCommandPanelOpenCallback, encodeCommandPanelRunCallback } from "./ui-callbacks.js";

const BRIDGE_COMMAND_ACTION_LABELS: Record<
  BridgeCommandActionView["command"],
  Record<UiLanguage, string>
> = {
  cancel: {
    zh: "Cancel",
    en: "Cancel"
  },
  hub: {
    zh: "Hub",
    en: "Hub"
  },
  status: {
    zh: "Status",
    en: "Status"
  },
  inspect: {
    zh: "Details",
    en: "Inspect"
  },
  interrupt: {
    zh: "中断操作",
    en: "Interrupt"
  },
  commands: {
    zh: "Commands",
    en: "Commands"
  }
};

export function buildBridgeCommandActionRows(
  actions: readonly BridgeCommandActionView[],
  language: UiLanguage,
  options?: {
    chunkSize?: number;
  }
): TelegramInlineKeyboardMarkup["inline_keyboard"] {
  const chunkSize = Math.max(1, options?.chunkSize ?? 3);
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [];
  let currentRow: TelegramInlineKeyboardMarkup["inline_keyboard"][number] = [];

  for (const action of actions) {
    currentRow.push({
      text: BRIDGE_COMMAND_ACTION_LABELS[action.command][language],
      callback_data: action.command === "commands"
        ? encodeCommandPanelOpenCallback()
        : encodeCommandPanelRunCallback(action.command),
      ...(action.style ? { style: action.style } : {})
    });
    if (currentRow.length >= chunkSize) {
      rows.push(currentRow);
      currentRow = [];
    }
  }

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

export function buildBridgeCommandReplyMarkup(
  actions: readonly BridgeCommandActionView[],
  language: UiLanguage,
  options?: {
    chunkSize?: number;
  }
): TelegramInlineKeyboardMarkup | undefined {
  const rows = buildBridgeCommandActionRows(actions, language, options);
  if (rows.length === 0) {
    return undefined;
  }

  return {
    inline_keyboard: rows
  };
}
