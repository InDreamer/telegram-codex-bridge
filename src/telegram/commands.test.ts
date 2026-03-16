import test from "node:test";
import assert from "node:assert/strict";

import { TELEGRAM_COMMANDS, buildHelpText, syncTelegramCommands } from "./commands.js";
import type { TelegramBotCommand, TelegramBotCommandScope } from "./api.js";

test("syncTelegramCommands syncs default and language-specific command scopes", async () => {
  const calls: CommandSyncCall[] = [];

  await syncTelegramCommands({
    setMyCommands: async (
      _commands: TelegramBotCommand[],
      scope?: TelegramBotCommandScope,
      languageCode?: string
    ) => {
      assert.deepEqual(_commands, TELEGRAM_COMMANDS);
      calls.push({ scope, languageCode });
    }
  } as any);

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
  const helpText = buildHelpText();

  assert.ok(helpText.startsWith("可用指令\n/help 查看可用指令"));
  assert.ok(helpText.includes("/sessions 查看最近会话\n/sessions archived 查看已归档会话"));
  assert.ok(helpText.includes("/runtime 配置运行状态卡片顶部摘要行"));
  assert.ok(helpText.endsWith("/cancel 取消当前输入并返回"));
});

interface CommandSyncCall {
  scope: TelegramBotCommandScope | undefined;
  languageCode: string | undefined;
}

function compareCalls(left: CommandSyncCall, right: CommandSyncCall): number {
  return `${left.scope?.type ?? ""}:${left.languageCode ?? ""}`
    .localeCompare(`${right.scope?.type ?? ""}:${right.languageCode ?? ""}`);
}
