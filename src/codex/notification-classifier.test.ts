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

test("classifies runtime parity notifications with structured summaries", () => {
  const tokenUsage = classifyNotification("thread/tokenUsage/updated", {
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: {
      last: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 18
      },
      total: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 50,
        reasoningOutputTokens: 10,
        totalTokens: 180
      },
      modelContextWindow: 272000
    }
  });
  assert.equal(tokenUsage.kind, "thread_token_usage_updated");
  if (tokenUsage.kind !== "thread_token_usage_updated") {
    throw new Error("expected token usage notification");
  }
  assert.equal(tokenUsage.tokenUsage?.lastTotalTokens, 18);
  assert.equal(tokenUsage.tokenUsage?.totalTokens, 180);

  const diff = classifyNotification("turn/diff/updated", {
    threadId: "thread-1",
    turnId: "turn-1",
    diff: "@@ -1 +1 @@\n-old\n+new\n"
  });
  assert.equal(diff.kind, "turn_diff_updated");
  if (diff.kind !== "turn_diff_updated") {
    throw new Error("expected diff notification");
  }
  assert.match(diff.diff ?? "", /@@/u);

  const hook = classifyNotification("hook/completed", {
    threadId: "thread-1",
    turnId: "turn-1",
    run: {
      id: "hook-1",
      eventName: "sessionStart",
      executionMode: "sync",
      handlerType: "command",
      scope: "thread",
      sourcePath: "/tmp/hook.sh",
      startedAt: 1,
      status: "completed",
      durationMs: 42,
      entries: [{ kind: "warning", text: "watch config" }]
    }
  });
  assert.equal(hook.kind, "hook_completed");
  if (hook.kind !== "hook_completed") {
    throw new Error("expected hook notification");
  }
  assert.equal(hook.run.durationMs, 42);
  assert.equal(hook.run.entries[0]?.kind, "warning");

  const terminal = classifyNotification("item/commandExecution/terminalInteraction", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "cmd-1",
    processId: "proc-1",
    stdin: "continue?"
  });
  assert.equal(terminal.kind, "terminal_interaction");
  if (terminal.kind !== "terminal_interaction") {
    throw new Error("expected terminal notification");
  }
  assert.equal(terminal.stdin, "continue?");

  const resolved = classifyNotification("serverRequest/resolved", {
    threadId: "thread-1",
    requestId: 7
  });
  assert.equal(resolved.kind, "server_request_resolved");
  if (resolved.kind !== "server_request_resolved") {
    throw new Error("expected server request resolved notification");
  }
  assert.equal(resolved.requestId, 7);

  const warning = classifyNotification("configWarning", {
    summary: "bad config",
    details: "line 4"
  });
  assert.equal(warning.kind, "config_warning");
  if (warning.kind !== "config_warning") {
    throw new Error("expected config warning");
  }
  assert.equal(warning.summary, "bad config");

  const reroute = classifyNotification("model/rerouted", {
    threadId: "thread-1",
    turnId: "turn-1",
    fromModel: "gpt-5.3-codex",
    toModel: "gpt-5.4",
    reason: "highRiskCyberActivity"
  });
  assert.equal(reroute.kind, "model_rerouted");
  if (reroute.kind !== "model_rerouted") {
    throw new Error("expected reroute notification");
  }
  assert.equal(reroute.toModel, "gpt-5.4");
});
