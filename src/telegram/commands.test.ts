import test from "node:test";
import assert from "node:assert/strict";

import { TELEGRAM_COMMANDS, syncTelegramCommands } from "./commands.js";
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

interface CommandSyncCall {
  scope: TelegramBotCommandScope | undefined;
  languageCode: string | undefined;
}

function compareCalls(left: CommandSyncCall, right: CommandSyncCall): number {
  return `${left.scope?.type ?? ""}:${left.languageCode ?? ""}`
    .localeCompare(`${right.scope?.type ?? ""}:${right.languageCode ?? ""}`);
}
