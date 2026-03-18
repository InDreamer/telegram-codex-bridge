import test from "node:test";
import assert from "node:assert/strict";

import type { BridgeStateStore } from "../state/store.js";
import { RuntimeNoticeBroadcaster } from "./runtime-notice-broadcaster.js";

test("RuntimeNoticeBroadcaster persists failed deliveries per chat binding", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const notices: Array<{ telegramChatId: string; type: string; message: string }> = [];
  const store = {
    listChatBindings: () => [{ telegramChatId: "chat-ok" }, { telegramChatId: "chat-fail" }],
    createRuntimeNotice: (notice: { telegramChatId: string; type: string; message: string }) => {
      notices.push(notice);
    }
  } as unknown as BridgeStateStore;

  const broadcaster = new RuntimeNoticeBroadcaster({
    getStore: () => store,
    safeSendMessage: async (chatId, text) => {
      sent.push({ chatId, text });
      return chatId !== "chat-fail";
    }
  });

  await broadcaster.broadcast({
    kind: "config_warning",
    summary: "bad config",
    detail: "line 4"
  } as never);

  assert.equal(sent.length, 2);
  assert.match(sent[0]?.text ?? "", /Codex 配置警告：bad config/u);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.telegramChatId, "chat-fail");
  assert.equal(notices[0]?.type, "app_server_notice");
  assert.match(notices[0]?.message ?? "", /line 4/u);
});

test("RuntimeNoticeBroadcaster skips notices that do not render a user-facing message", async () => {
  const sent: string[] = [];
  const notices: Array<{ telegramChatId: string; type: string; message: string }> = [];
  const store = {
    listChatBindings: () => [{ telegramChatId: "chat-1" }],
    createRuntimeNotice: (notice: { telegramChatId: string; type: string; message: string }) => {
      notices.push(notice);
    }
  } as unknown as BridgeStateStore;

  const broadcaster = new RuntimeNoticeBroadcaster({
    getStore: () => store,
    safeSendMessage: async (_chatId, text) => {
      sent.push(text);
      return true;
    }
  });

  await broadcaster.broadcast({
    kind: "model_rerouted",
    fromModel: null,
    toModel: "gpt-5",
    reason: "policy"
  } as never);

  assert.deepEqual(sent, []);
  assert.deepEqual(notices, []);
});
