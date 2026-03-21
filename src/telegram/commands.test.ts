import test from "node:test";
import assert from "node:assert/strict";

import { TELEGRAM_COMMANDS, buildHelpText, resolveTelegramCommandHandler, syncTelegramCommands } from "./commands.js";
import type { TelegramBotCommand, TelegramBotCommandScope } from "./api.js";

test("syncTelegramCommands syncs default and language-specific command scopes", async () => {
  const calls: CommandSyncCall[] = [];

  await syncTelegramCommands({
    setMyCommands: async (
      _commands: TelegramBotCommand[],
      scope?: TelegramBotCommandScope,
      languageCode?: string
    ) => {
      calls.push({ scope, languageCode });
      assert.equal(_commands.some((entry) => entry.command === "language"), true);
      assert.equal(_commands.find((entry) => entry.command === "help")?.description, "Show available commands");
    }
  } as any, "en");

  const expected: CommandSyncCall[] = [
    { scope: { type: "default" }, languageCode: undefined },
    { scope: { type: "default" }, languageCode: "zh" },
    { scope: { type: "default" }, languageCode: "en" },
    { scope: { type: "all_private_chats" }, languageCode: undefined },
    { scope: { type: "all_private_chats" }, languageCode: "zh" },
    { scope: { type: "all_private_chats" }, languageCode: "en" }
  ];

  assert.deepEqual(calls.sort(compareCalls), expected.sort(compareCalls));
});

test("buildHelpText stays aligned with the command registry", () => {
  const helpText = buildHelpText("zh");

  assert.ok(helpText.startsWith("可用指令\n/help 查看可用指令"));
  assert.ok(helpText.includes("/sessions 查看最近会话\n/sessions archived 查看已归档会话"));
  assert.ok(helpText.includes("/hub 重新查看运行卡片"));
  assert.ok(helpText.includes("/runtime 配置运行状态卡片顶部摘要行"));
  assert.ok(helpText.includes("/language 切换桥接界面语言"));
  assert.ok(helpText.endsWith("/cancel 取消当前输入并返回"));
});

test("buildHelpText renders the English command surface when requested", () => {
  const helpText = buildHelpText("en");

  assert.ok(helpText.startsWith("Available commands\n/help Show available commands"));
  assert.ok(helpText.includes("/sessions Show recent sessions\n/sessions archived Show archived sessions"));
  assert.ok(helpText.includes("/hub Bring back the runtime hub"));
  assert.ok(helpText.includes("/language Change bridge UI language"));
  assert.ok(helpText.endsWith("/cancel Cancel the current input and return"));
});

test("resolveTelegramCommandHandler keeps aliases and synced commands aligned", () => {
  assert.equal(resolveTelegramCommandHandler("start"), "sendHelp");
  assert.equal(resolveTelegramCommandHandler("commands"), "sendHelp");

  for (const entry of TELEGRAM_COMMANDS) {
    assert.notEqual(resolveTelegramCommandHandler(entry.command), null);
  }

  assert.equal(resolveTelegramCommandHandler("does_not_exist"), null);
});

interface CommandSyncCall {
  scope: TelegramBotCommandScope | undefined;
  languageCode: string | undefined;
}

function compareCalls(left: CommandSyncCall, right: CommandSyncCall): number {
  return `${left.scope?.type ?? ""}:${left.languageCode ?? ""}`
    .localeCompare(`${right.scope?.type ?? ""}:${right.languageCode ?? ""}`);
}
