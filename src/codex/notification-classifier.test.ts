import test from "node:test";
import assert from "node:assert/strict";

import { classifyNotification } from "./notification-classifier.js";

test("classifies thread started notifications with subagent identity", () => {
  const notification = classifyNotification("thread/started", {
    thread: {
      id: "thread-sub-1",
      agentNickname: "Pauli",
      agentRole: "explorer",
      name: "Telegram Flow"
    }
  });

  assert.equal(notification.kind, "thread_started");
  if (notification.kind !== "thread_started") {
    throw new Error("expected thread_started notification");
  }
  assert.equal(notification.threadId, "thread-sub-1");
  assert.equal(notification.turnId, null);
  assert.equal(notification.agentNickname, "Pauli");
  assert.equal(notification.agentRole, "explorer");
  assert.equal(notification.threadName, "Telegram Flow");
});

test("classifies thread name updated notifications", () => {
  const notification = classifyNotification("thread/name/updated", {
    threadId: "thread-sub-1",
    threadName: "Fermat"
  });

  assert.equal(notification.kind, "thread_name_updated");
  if (notification.kind !== "thread_name_updated") {
    throw new Error("expected thread_name_updated notification");
  }
  assert.equal(notification.threadId, "thread-sub-1");
  assert.equal(notification.turnId, null);
  assert.equal(notification.threadName, "Fermat");
});
