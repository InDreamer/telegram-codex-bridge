import test from "node:test";
import assert from "node:assert/strict";

import { ActivityTracker } from "./tracker.js";
import { classifyNotification } from "../codex/notification-classifier.js";

test("reduces a turn from start through progress to completion", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-1",
    turnId: "turn-1"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-1",
      turnId: "turn-1"
    }),
    "2026-03-10T10:00:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "cmd-1",
        type: "commandExecution",
        title: "pnpm test"
      }
    }),
    "2026-03-10T10:00:00.500Z"
  );

  tracker.apply(
    classifyNotification("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      delta: "$ pnpm test\n26/26 tests passed"
    }),
    "2026-03-10T10:00:00.700Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "item-1",
        type: "mcpToolCall"
      }
    }),
    "2026-03-10T10:00:01.000Z"
  );

  tracker.apply(
    classifyNotification("item/mcpToolCall/progress", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      message: "Searching docs"
    }),
    "2026-03-10T10:00:03.000Z"
  );

  const running = tracker.getStatus("2026-03-10T10:00:06.000Z");
  assert.equal(running.turnStatus, "running");
  assert.equal(running.activeItemType, "mcpToolCall");
  assert.equal(running.activeItemId, "item-1");
  assert.equal(running.latestProgress, "Searching docs");
  assert.equal(running.currentItemDurationSec, 5);
  assert.equal(running.inspectAvailable, true);
  assert.equal(running.debugAvailable, true);
  assert.equal(running.finalMessageAvailable, false);
  assert.equal(running.lastHighValueEventType, "found");
  assert.equal(running.lastHighValueTitle, "Found: Searching docs");
  assert.deepEqual(running.recentStatusUpdates, [
    "Starting command: pnpm test",
    "pnpm test -> 26/26 tests passed",
    "Searching docs"
  ]);

  tracker.apply(
    classifyNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      item: {
        id: "item-1",
        type: "mcpToolCall"
      }
    }),
    "2026-03-10T10:00:07.000Z"
  );

  tracker.apply(
    classifyNotification("codex/event/task_complete", {
      threadId: "thread-1",
      turnId: "turn-1",
      msg: {
        last_agent_message: "Done"
      }
    }),
    "2026-03-10T10:00:08.000Z"
  );

  tracker.apply(
    classifyNotification("turn/plan/updated", {
      threadId: "thread-1",
      turnId: "turn-1",
      plan: [
        { step: "Collect protocol evidence", status: "completed" },
        { step: "Wire inspect renderer", status: "inProgress" }
      ]
    }),
    "2026-03-10T10:00:08.200Z"
  );

  tracker.apply(
    classifyNotification("item/agentMessage/delta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "note-1",
      delta: "Checking event mapping against Telegram surface."
    }),
    "2026-03-10T10:00:08.400Z"
  );

  tracker.apply(
    classifyNotification("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "note-1",
        type: "agentMessage",
        phase: "commentary",
        text: "Checking event mapping against Telegram surface."
      }
    }),
    "2026-03-10T10:00:08.450Z"
  );

  tracker.apply(
    classifyNotification("item/reasoning/summaryTextDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reason-1",
      delta: "internal reasoning should stay private"
    }),
    "2026-03-10T10:00:08.500Z"
  );

  tracker.apply(
    classifyNotification("turn/completed", {
      threadId: "thread-1",
      turn: {
        id: "turn-1",
        status: "completed"
      }
    }),
    "2026-03-10T10:00:09.000Z"
  );

  const completed = tracker.getStatus("2026-03-10T10:00:10.000Z");
  assert.equal(completed.turnStatus, "completed");
  assert.equal(completed.activeItemType, null);
  assert.equal(completed.latestProgress, null);
  assert.equal(completed.finalMessageAvailable, true);
  assert.equal(completed.lastHighValueEventType, "done");
  assert.equal(completed.lastHighValueTitle, "Done: Done");

  const inspect = tracker.getInspectSnapshot("2026-03-10T10:00:10.000Z");
  assert.equal(inspect.turnStatus, "completed");
  assert.equal(inspect.recentCommandSummaries[0], "pnpm test -> 26/26 tests passed");
  assert.equal(inspect.recentMcpSummaries[0], "Searching docs");
  assert.deepEqual(inspect.planSnapshot, [
    "Collect protocol evidence (completed)",
    "Wire inspect renderer (inProgress)"
  ]);
  assert.equal(inspect.completedCommentary[0], "Checking event mapping against Telegram surface.");
  assert.equal(inspect.completedCommentary.includes("internal reasoning should stay private"), false);
  assert.equal(inspect.recentTransitions.length, 8);
  assert.match(inspect.recentTransitions.at(-1)?.summary ?? "", /completed/u);
});

test("accumulates fragmented command output before summarizing command progress", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-fragmented-cmd",
    turnId: "turn-fragmented-cmd"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-fragmented-cmd",
      turnId: "turn-fragmented-cmd"
    }),
    "2026-03-10T10:05:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-fragmented-cmd",
      turnId: "turn-fragmented-cmd",
      item: {
        id: "cmd-fragmented",
        type: "commandExecution",
        title: "pnpm test"
      }
    }),
    "2026-03-10T10:05:00.100Z"
  );

  tracker.apply(
    classifyNotification("item/commandExecution/outputDelta", {
      threadId: "thread-fragmented-cmd",
      turnId: "turn-fragmented-cmd",
      itemId: "cmd-fragmented",
      delta: "$ pnpm test\n"
    }),
    "2026-03-10T10:05:00.200Z"
  );

  tracker.apply(
    classifyNotification("item/commandExecution/outputDelta", {
      threadId: "thread-fragmented-cmd",
      turnId: "turn-fragmented-cmd",
      itemId: "cmd-fragmented",
      delta: "26/26 tests passed"
    }),
    "2026-03-10T10:05:00.300Z"
  );

  const status = tracker.getStatus("2026-03-10T10:05:01.000Z");
  assert.equal(status.latestProgress, "pnpm test -> 26/26 tests passed");
  assert.equal(status.recentStatusUpdates.at(-1), "pnpm test -> 26/26 tests passed");

  const inspect = tracker.getInspectSnapshot("2026-03-10T10:05:01.000Z");
  assert.equal(inspect.recentCommandSummaries.at(-1), "pnpm test -> 26/26 tests passed");
});

test("long-running command output keeps progress stable without retaining the full output body", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-buffer-cap",
    turnId: "turn-buffer-cap"
  });

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-buffer-cap",
      turnId: "turn-buffer-cap",
      item: {
        id: "cmd-buffer-cap",
        type: "commandExecution",
        title: "rg bridge.log"
      }
    }),
    "2026-03-10T10:06:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/commandExecution/outputDelta", {
      threadId: "thread-buffer-cap",
      turnId: "turn-buffer-cap",
      itemId: "cmd-buffer-cap",
      delta: `$ rg bridge.log\n${"x".repeat(40000)}`
    }),
    "2026-03-10T10:06:00.100Z"
  );

  const bufferedAfterFirstChunk = (tracker as any).commandOutputBuffers.get("thread-buffer-cap:cmd-buffer-cap");
  assert.equal(bufferedAfterFirstChunk.firstNonEmptyLine, "$ rg bridge.log");
  assert.equal(typeof bufferedAfterFirstChunk.lastNonEmptyLine, "string");
  assert.equal(typeof bufferedAfterFirstChunk.trailingFragment, "string");
  assert.ok(bufferedAfterFirstChunk.lastNonEmptyLine.length <= 1024);
  assert.ok(bufferedAfterFirstChunk.trailingFragment.length <= 1024);

  tracker.apply(
    classifyNotification("item/commandExecution/outputDelta", {
      threadId: "thread-buffer-cap",
      turnId: "turn-buffer-cap",
      itemId: "cmd-buffer-cap",
      delta: "\nfinal line"
    }),
    "2026-03-10T10:06:00.200Z"
  );

  const status = tracker.getStatus("2026-03-10T10:06:01.000Z");
  assert.equal(status.latestProgress, "rg bridge.log -> final line");
});

test("tracks token usage, diff, hook summaries, and runtime notices without leaking raw noise", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-runtime",
    turnId: "turn-runtime"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-runtime",
      turnId: "turn-runtime"
    }),
    "2026-03-10T10:10:00.000Z"
  );

  tracker.apply(
    classifyNotification("thread/tokenUsage/updated", {
      threadId: "thread-runtime",
      turnId: "turn-runtime",
      tokenUsage: {
        last: {
          inputTokens: 12,
          cachedInputTokens: 3,
          outputTokens: 7,
          reasoningOutputTokens: 2,
          totalTokens: 24
        },
        total: {
          inputTokens: 120,
          cachedInputTokens: 30,
          outputTokens: 70,
          reasoningOutputTokens: 20,
          totalTokens: 240
        },
        modelContextWindow: 272000
      }
    }),
    "2026-03-10T10:10:00.200Z"
  );

  tracker.apply(
    classifyNotification("turn/diff/updated", {
      threadId: "thread-runtime",
      turnId: "turn-runtime",
      diff: "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"
    }),
    "2026-03-10T10:10:00.300Z"
  );

  tracker.apply(
    classifyNotification("hook/completed", {
      threadId: "thread-runtime",
      turnId: "turn-runtime",
      run: {
        id: "hook-1",
        eventName: "sessionStart",
        executionMode: "sync",
        handlerType: "command",
        scope: "thread",
        sourcePath: "/tmp/hook.sh",
        startedAt: 1,
        status: "completed",
        durationMs: 12,
        entries: [{ kind: "warning", text: "refresh config" }]
      }
    }),
    "2026-03-10T10:10:00.400Z"
  );

  tracker.apply(
    classifyNotification("item/commandExecution/terminalInteraction", {
      threadId: "thread-runtime",
      turnId: "turn-runtime",
      itemId: "cmd-1",
      processId: "proc-1",
      stdin: "continue?"
    }),
    "2026-03-10T10:10:00.500Z"
  );

  tracker.apply(
    classifyNotification("configWarning", {
      summary: "config mismatch",
      details: "line 2"
    }),
    "2026-03-10T10:10:00.600Z"
  );

  tracker.apply(
    classifyNotification("model/rerouted", {
      threadId: "thread-runtime",
      turnId: "turn-runtime",
      fromModel: "gpt-5.3-codex",
      toModel: "gpt-5.4",
      reason: "highRiskCyberActivity"
    }),
    "2026-03-10T10:10:00.700Z"
  );

  const status = tracker.getStatus("2026-03-10T10:10:01.000Z");
  assert.equal(status.latestProgress, "终端输入请求未转发到 Telegram：continue?");

  const inspect = tracker.getInspectSnapshot("2026-03-10T10:10:01.000Z");
  assert.equal(inspect.tokenUsage?.lastTotalTokens, 24);
  assert.equal(inspect.tokenUsage?.totalTokens, 240);
  assert.equal(inspect.latestDiffSummary, "差异更新：1 个文件 / +1 / -1");
  assert.match(inspect.recentHookSummaries[0] ?? "", /hook sessionStart/u);
  assert.equal(inspect.terminalInteractionSummary, "终端输入请求未转发到 Telegram：continue?");
  assert.match(inspect.recentNoticeSummaries.join("\n"), /配置警告/u);
  assert.match(inspect.recentNoticeSummaries.join("\n"), /模型已改道/u);
});

test("tracks running subagents and their latest progress separately from the main thread", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-main",
    turnId: "turn-main"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-main",
      turnId: "turn-main"
    }),
    "2026-03-10T11:00:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-main",
      turnId: "turn-main",
      item: {
        id: "collab-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-1"],
        agentsStates: {
          "thread-sub-1": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    }),
    "2026-03-10T11:00:00.100Z"
  );

  tracker.apply(
    classifyNotification("thread/started", {
      thread: {
        id: "thread-sub-1",
        agentNickname: "Pauli",
        agentRole: "explorer",
        name: "Telegram Flow"
      }
    }),
    "2026-03-10T11:00:00.500Z"
  );

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-sub-1",
      turnId: "turn-sub-1"
    }),
    "2026-03-10T11:00:01.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-sub-1",
      turnId: "turn-sub-1",
      item: {
        id: "cmd-sub-1",
        type: "commandExecution",
        title: "rg plan"
      }
    }),
    "2026-03-10T11:00:01.200Z"
  );

  tracker.apply(
    classifyNotification("item/commandExecution/outputDelta", {
      threadId: "thread-sub-1",
      turnId: "turn-sub-1",
      itemId: "cmd-sub-1",
      delta: "$ rg plan\n2 matches"
    }),
    "2026-03-10T11:00:01.500Z"
  );

  const running = tracker.getInspectSnapshot("2026-03-10T11:00:02.000Z");
  assert.equal(running.agentSnapshot.length, 1);
  assert.equal(running.agentSnapshot[0]?.threadId, "thread-sub-1");
  assert.equal(running.agentSnapshot[0]?.label, "Pauli");
  assert.equal(running.agentSnapshot[0]?.labelSource, "nickname");
  assert.equal(running.agentSnapshot[0]?.status, "running");
  assert.equal(running.agentSnapshot[0]?.progress, "rg plan -> 2 matches");

  tracker.apply(
    classifyNotification("turn/completed", {
      threadId: "thread-sub-1",
      turn: {
        id: "turn-sub-1",
        status: "completed"
      }
    }),
    "2026-03-10T11:00:03.000Z"
  );

  const settled = tracker.getInspectSnapshot("2026-03-10T11:00:04.000Z");
  assert.equal(settled.agentSnapshot.length, 0);
});

test("prefers subagent nickname over thread title when both are present", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-main",
    turnId: "turn-main"
  });

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-main",
      turnId: "turn-main",
      item: {
        id: "collab-priority",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-priority"],
        agentsStates: {
          "thread-sub-priority": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    }),
    "2026-03-10T11:05:00.000Z"
  );

  tracker.apply(
    classifyNotification("thread/started", {
      thread: {
        id: "thread-sub-priority",
        agentNickname: "Fermat",
        agentRole: "explorer",
        name: "Runtime and State"
      }
    }),
    "2026-03-10T11:05:00.200Z"
  );

  tracker.apply(
    classifyNotification("thread/name/updated", {
      threadId: "thread-sub-priority",
      threadName: "Should Not Replace Nickname"
    }),
    "2026-03-10T11:05:00.300Z"
  );

  const inspect = tracker.getInspectSnapshot("2026-03-10T11:05:01.000Z");
  assert.equal(inspect.agentSnapshot[0]?.label, "Fermat");
  assert.equal(inspect.agentSnapshot[0]?.labelSource, "nickname");
  assert.equal(inspect.agentSnapshot[0]?.progress, "Booting");
});

test("replays cached subagent identity when the thread identity arrives before collab state", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-main",
    turnId: "turn-main"
  });

  tracker.apply(
    classifyNotification("thread/started", {
      thread: {
        id: "thread-sub-early",
        agentNickname: "Gauss",
        agentRole: "explorer",
        name: "Protocol Audit"
      }
    }),
    "2026-03-10T11:06:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-main",
      turnId: "turn-main",
      item: {
        id: "collab-early",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-early"],
        agentsStates: {
          "thread-sub-early": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    }),
    "2026-03-10T11:06:00.100Z"
  );

  const inspect = tracker.getInspectSnapshot("2026-03-10T11:06:01.000Z");
  assert.equal(inspect.agentSnapshot[0]?.label, "Gauss");
  assert.equal(inspect.agentSnapshot[0]?.labelSource, "nickname");
  assert.equal(inspect.agentSnapshot[0]?.progress, "Booting");
});

test("replays cached thread titles when the title update arrives before collab state", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-main",
    turnId: "turn-main"
  });

  tracker.apply(
    classifyNotification("thread/name/updated", {
      threadId: "thread-sub-title-early",
      threadName: "Delayed Title"
    }),
    "2026-03-10T11:06:30.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-main",
      turnId: "turn-main",
      item: {
        id: "collab-title-early",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-title-early"],
        agentsStates: {
          "thread-sub-title-early": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    }),
    "2026-03-10T11:06:30.100Z"
  );

  const inspect = tracker.getInspectSnapshot("2026-03-10T11:06:31.000Z");
  assert.equal(inspect.agentSnapshot[0]?.label, "Delayed Title");
  assert.equal(inspect.agentSnapshot[0]?.labelSource, "threadName");
  assert.equal(inspect.agentSnapshot[0]?.progress, "Booting");
});

test("backfill only fills missing subagent identity fields", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-main",
    turnId: "turn-main"
  });

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-main",
      turnId: "turn-main",
      item: {
        id: "collab-backfill-merge",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-backfill-merge"],
        agentsStates: {
          "thread-sub-backfill-merge": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    }),
    "2026-03-10T11:06:45.000Z"
  );

  tracker.apply(
    classifyNotification("thread/name/updated", {
      threadId: "thread-sub-backfill-merge",
      threadName: "Current Title"
    }),
    "2026-03-10T11:06:45.100Z"
  );

  const firstBackfill = tracker.applyResolvedSubagentIdentity(
    "thread-sub-backfill-merge",
    {
      agentNickname: "Gauss",
      agentRole: "explorer",
      threadName: "Stale Title"
    },
    "2026-03-10T11:06:45.200Z"
  );
  assert.equal(firstBackfill, true);

  const subagent = (tracker as any).subagents.get("thread-sub-backfill-merge");
  assert.equal(subagent?.agentNickname, "Gauss");
  assert.equal(subagent?.agentRole, "explorer");
  assert.equal(subagent?.threadName, "Current Title");

  const staleBackfill = tracker.applyResolvedSubagentIdentity(
    "thread-sub-backfill-merge",
    {
      agentNickname: null,
      agentRole: null,
      threadName: "Older Title"
    },
    "2026-03-10T11:06:45.300Z"
  );
  assert.equal(staleBackfill, false);
  assert.equal(subagent?.agentNickname, "Gauss");
  assert.equal(subagent?.agentRole, "explorer");
  assert.equal(subagent?.threadName, "Current Title");

  const inspect = tracker.getInspectSnapshot("2026-03-10T11:06:46.000Z");
  assert.equal(inspect.agentSnapshot[0]?.label, "Gauss");
  assert.equal(inspect.agentSnapshot[0]?.labelSource, "nickname");
  assert.equal(inspect.agentSnapshot[0]?.progress, "Booting");
});

test("truncates protocol-backed subagent labels before exposing snapshots", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-main",
    turnId: "turn-main"
  });
  const longNickname = "Protocol backed agent nickname repeated beyond limit";
  const longThreadTitle = "Thread title from protocol that keeps going past the card budget";

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-main",
      turnId: "turn-main",
      item: {
        id: "collab-truncate",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-nickname", "thread-sub-title"],
        agentsStates: {
          "thread-sub-nickname": {
            status: "pendingInit",
            message: "Booting"
          },
          "thread-sub-title": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    }),
    "2026-03-10T11:07:00.000Z"
  );

  tracker.apply(
    classifyNotification("thread/started", {
      thread: {
        id: "thread-sub-nickname",
        agentNickname: longNickname,
        agentRole: "explorer",
        name: "Short title"
      }
    }),
    "2026-03-10T11:07:00.200Z"
  );

  tracker.apply(
    classifyNotification("thread/started", {
      thread: {
        id: "thread-sub-title",
        agentNickname: null,
        agentRole: "explorer",
        name: longThreadTitle
      }
    }),
    "2026-03-10T11:07:00.300Z"
  );

  const inspect = tracker.getInspectSnapshot("2026-03-10T11:07:01.000Z");
  assert.equal(inspect.agentSnapshot[0]?.label, `${longNickname.slice(0, 48)}…`);
  assert.equal(inspect.agentSnapshot[0]?.labelSource, "nickname");
  assert.equal(inspect.agentSnapshot[1]?.label, `${longThreadTitle.slice(0, 48)}…`);
  assert.equal(inspect.agentSnapshot[1]?.labelSource, "threadName");
});

test("keeps subagent commentary visible until the next subagent turn starts", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-main",
    turnId: "turn-main"
  });

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-main",
      turnId: "turn-main",
      item: {
        id: "collab-commentary",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-commentary"],
        agentsStates: {
          "thread-sub-commentary": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    }),
    "2026-03-10T11:15:00.000Z"
  );

  tracker.apply(
    classifyNotification("thread/started", {
      thread: {
        id: "thread-sub-commentary",
        agentNickname: "Rawls",
        agentRole: "explorer",
        name: "Install and Ops"
      }
    }),
    "2026-03-10T11:15:00.100Z"
  );

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-sub-commentary",
      turnId: "turn-sub-commentary-1"
    }),
    "2026-03-10T11:15:00.200Z"
  );

  tracker.apply(
    classifyNotification("item/completed", {
      threadId: "thread-sub-commentary",
      turnId: "turn-sub-commentary-1",
      item: {
        id: "commentary-1",
        type: "agentMessage",
        phase: "commentary",
        text: "Comparing bridge behavior against runtime docs."
      }
    }),
    "2026-03-10T11:15:01.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-sub-commentary",
      turnId: "turn-sub-commentary-1",
      item: {
        id: "cmd-sub-commentary",
        type: "commandExecution",
        title: "rg runtime"
      }
    }),
    "2026-03-10T11:15:02.000Z"
  );

  tracker.apply(
    classifyNotification("item/commandExecution/outputDelta", {
      threadId: "thread-sub-commentary",
      turnId: "turn-sub-commentary-1",
      itemId: "cmd-sub-commentary",
      delta: "$ rg runtime\n2 matches"
    }),
    "2026-03-10T11:15:03.000Z"
  );

  let inspect = tracker.getInspectSnapshot("2026-03-10T11:15:03.100Z");
  assert.equal(inspect.agentSnapshot[0]?.label, "Rawls");
  assert.equal(inspect.agentSnapshot[0]?.labelSource, "nickname");
  assert.equal(inspect.agentSnapshot[0]?.progress, "Comparing bridge behavior against runtime docs.");

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-sub-commentary",
      turnId: "turn-sub-commentary-2"
    }),
    "2026-03-10T11:15:04.000Z"
  );

  inspect = tracker.getInspectSnapshot("2026-03-10T11:15:04.100Z");
  assert.equal(inspect.agentSnapshot[0]?.progress, null);

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-sub-commentary",
      turnId: "turn-sub-commentary-2",
      item: {
        id: "cmd-sub-commentary-2",
        type: "commandExecution",
        title: "rg resume"
      }
    }),
    "2026-03-10T11:15:05.000Z"
  );

  inspect = tracker.getInspectSnapshot("2026-03-10T11:15:05.100Z");
  assert.equal(inspect.agentSnapshot[0]?.progress, "rg resume");
});

test("shows subagent blockers ahead of stale commentary and restores commentary after unblock", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-main",
    turnId: "turn-main"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-main",
      turnId: "turn-main"
    }),
    "2026-03-10T11:10:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-main",
      turnId: "turn-main",
      item: {
        id: "collab-1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["thread-sub-resume"],
        agentsStates: {
          "thread-sub-resume": {
            status: "pendingInit",
            message: "Booting"
          }
        }
      }
    }),
    "2026-03-10T11:10:00.100Z"
  );

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-sub-resume",
      turnId: "turn-sub-resume"
    }),
    "2026-03-10T11:10:00.200Z"
  );

  tracker.apply(
    classifyNotification("item/completed", {
      threadId: "thread-sub-resume",
      turnId: "turn-sub-resume",
      item: {
        id: "commentary-resume",
        type: "agentMessage",
        phase: "commentary",
        text: "Comparing resume behavior against blocked states."
      }
    }),
    "2026-03-10T11:10:00.800Z"
  );

  let inspect = tracker.getInspectSnapshot("2026-03-10T11:10:00.900Z");
  assert.equal(inspect.agentSnapshot[0]?.progress, "Comparing resume behavior against blocked states.");

  tracker.apply(
    classifyNotification("thread/status/changed", {
      threadId: "thread-sub-resume",
      status: {
        type: "active",
        activeFlags: ["waitingOnApproval"]
      }
    }),
    "2026-03-10T11:10:01.000Z"
  );

  inspect = tracker.getInspectSnapshot("2026-03-10T11:10:01.100Z");
  assert.equal(inspect.agentSnapshot[0]?.progress, "Waiting for approval");

  tracker.apply(
    classifyNotification("thread/status/changed", {
      threadId: "thread-sub-resume",
      status: {
        type: "active",
        activeFlags: []
      }
    }),
    "2026-03-10T11:10:02.000Z"
  );

  inspect = tracker.getInspectSnapshot("2026-03-10T11:10:02.100Z");
  assert.equal(inspect.agentSnapshot[0]?.progress, "Comparing resume behavior against blocked states.");

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-sub-resume",
      turnId: "turn-sub-resume-2"
    }),
    "2026-03-10T11:10:03.000Z"
  );

  inspect = tracker.getInspectSnapshot("2026-03-10T11:10:03.100Z");
  assert.equal(inspect.agentSnapshot[0]?.progress, null);

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-sub-resume",
      turnId: "turn-sub-resume-2",
      item: {
        id: "cmd-sub-resume",
        type: "commandExecution",
        title: "rg resume"
      }
    }),
    "2026-03-10T11:10:04.000Z"
  );

  inspect = tracker.getInspectSnapshot("2026-03-10T11:10:04.100Z");
  assert.equal(inspect.agentSnapshot[0]?.progress, "rg resume");
});

test("plan snapshot reflects the latest plan update instead of append-only history", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-plan-current",
    turnId: "turn-plan-current"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-plan-current",
      turnId: "turn-plan-current"
    }),
    "2026-03-10T10:06:00.000Z"
  );

  tracker.apply(
    classifyNotification("turn/plan/updated", {
      threadId: "thread-plan-current",
      turnId: "turn-plan-current",
      plan: [
        { step: "Collect protocol evidence", status: "pending" },
        { step: "Wire inspect renderer", status: "pending" }
      ]
    }),
    "2026-03-10T10:06:01.000Z"
  );

  tracker.apply(
    classifyNotification("turn/plan/updated", {
      threadId: "thread-plan-current",
      turnId: "turn-plan-current",
      plan: [
        { step: "Collect protocol evidence", status: "completed" },
        { step: "Wire inspect renderer", status: "inProgress" }
      ]
    }),
    "2026-03-10T10:06:02.000Z"
  );

  const inspect = tracker.getInspectSnapshot("2026-03-10T10:06:03.000Z");
  assert.deepEqual(inspect.planSnapshot, [
    "Collect protocol evidence (completed)",
    "Wire inspect renderer (inProgress)"
  ]);
  assert.equal(inspect.planSnapshot.includes("Collect protocol evidence (pending)"), false);
});

test("plan progress prefers the in-progress step over earlier pending steps", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-plan-priority",
    turnId: "turn-plan-priority"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-plan-priority",
      turnId: "turn-plan-priority"
    }),
    "2026-03-10T10:07:00.000Z"
  );

  tracker.apply(
    classifyNotification("turn/plan/updated", {
      threadId: "thread-plan-priority",
      turnId: "turn-plan-priority",
      plan: [
        { step: "Collect protocol evidence", status: "pending" },
        { step: "Wire inspect renderer", status: "inProgress" }
      ]
    }),
    "2026-03-10T10:07:01.000Z"
  );

  const status = tracker.getStatus("2026-03-10T10:07:02.000Z");
  assert.equal(status.latestProgress, "Wire inspect renderer (inProgress)");
});

test("records completed commentary items and ignores agent-message deltas", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-agg",
    turnId: "turn-agg"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-agg",
      turnId: "turn-agg"
    }),
    "2026-03-10T12:00:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-agg",
      turnId: "turn-agg",
      item: {
        id: "msg-1",
        type: "agentMessage"
      }
    }),
    "2026-03-10T12:00:00.100Z"
  );

  for (const delta of ["Using", " superpower", " skill", " for preflight."]) {
    tracker.apply(
      classifyNotification("item/agentMessage/delta", {
        threadId: "thread-agg",
        turnId: "turn-agg",
        itemId: "msg-1",
        delta
      }),
      "2026-03-10T12:00:00.200Z"
    );
  }

  const status = tracker.getStatus("2026-03-10T12:00:01.000Z");
  assert.equal(status.recentStatusUpdates.at(-1), "Turn started");
  assert.equal(status.latestProgress, null);

  const partial = tracker.getInspectSnapshot("2026-03-10T12:00:01.000Z");
  assert.equal(partial.completedCommentary.length, 0);

  tracker.apply(
    classifyNotification("item/completed", {
      threadId: "thread-agg",
      turnId: "turn-agg",
      item: {
        id: "msg-1",
        type: "agentMessage",
        phase: "commentary",
        text: "Using superpower skill for preflight, then scanning the repo entrypoints."
      }
    }),
    "2026-03-10T12:00:01.100Z"
  );

  const inspect = tracker.getInspectSnapshot("2026-03-10T12:00:01.200Z");
  assert.equal(inspect.completedCommentary.at(-1), "Using superpower skill for preflight, then scanning the repo entrypoints.");

  const snapshot = tracker.getStreamSnapshot();
  assert.equal(snapshot.activeStatusLine, null);
});

test("ignores completed agent messages without commentary phase", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-colon",
    turnId: "turn-colon"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-colon",
      turnId: "turn-colon"
    }),
    "2026-03-10T12:30:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-colon",
      turnId: "turn-colon",
      item: {
        id: "msg-colon",
        type: "agentMessage"
      }
    }),
    "2026-03-10T12:30:00.050Z"
  );

  tracker.apply(
    classifyNotification("item/completed", {
      threadId: "thread-colon",
      turnId: "turn-colon",
      item: {
        id: "msg-colon",
        type: "agentMessage",
        text: "我把现在领域内核补齐：看命令决策器、事件投影器、快照查询和重放机制。"
      }
    }),
    "2026-03-10T12:30:00.100Z"
  );

  const partial = tracker.getInspectSnapshot("2026-03-10T12:30:00.200Z");
  assert.equal(partial.completedCommentary.length, 0);
  assert.notEqual(partial.recentStatusUpdates.at(-1), "我把现在领域内核补齐：看命令决策器、事件投影器、快照查询和重放机制。");

  tracker.apply(
    classifyNotification("item/completed", {
      threadId: "thread-colon",
      turnId: "turn-colon",
      item: {
        id: "msg-colon-2",
        type: "agentMessage",
        phase: "commentary",
        text: "我把现在领域内核补齐：看命令决策器、事件投影器、快照查询和重放机制。"
      }
    }),
    "2026-03-10T12:30:00.300Z"
  );

  const settled = tracker.getInspectSnapshot("2026-03-10T12:30:00.400Z");
  assert.equal(
    settled.completedCommentary.at(-1),
    "我把现在领域内核补齐：看命令决策器、事件投影器、快照查询和重放机制。"
  );
});

test("reduces blocked, interrupted, failed, and unknown item flows safely", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-2",
    turnId: "turn-2"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-2",
      turnId: "turn-2"
    }),
    "2026-03-10T11:00:00.000Z"
  );

  tracker.apply(
    classifyNotification("thread/status/changed", {
      threadId: "thread-2",
      turnId: "turn-2",
      status: {
        type: "active",
        activeFlags: ["waitingOnApproval"]
      }
    }),
    "2026-03-10T11:00:01.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-unknown",
      itemType: "brandNewThing"
    }),
    "2026-03-10T11:00:02.000Z"
  );

  const blocked = tracker.getStatus("2026-03-10T11:00:03.000Z");
  assert.equal(blocked.turnStatus, "blocked");
  assert.equal(blocked.threadBlockedReason, "waitingOnApproval");
  assert.equal(blocked.activeItemType, "other");
  assert.equal(blocked.lastHighValueEventType, "blocked");
  assert.equal(blocked.lastHighValueTitle, "Blocked: waitingOnApproval");

  tracker.apply(
    classifyNotification("codex/event/turn_aborted", {
      threadId: "thread-2",
      turnId: "turn-2"
    }),
    "2026-03-10T11:00:04.000Z"
  );

  const interrupted = tracker.getStatus("2026-03-10T11:00:05.000Z");
  assert.equal(interrupted.turnStatus, "interrupted");

  tracker.apply(
    classifyNotification("error", {
      threadId: "thread-2",
      turnId: "turn-2",
      message: "tool crashed"
    }),
    "2026-03-10T11:00:06.000Z"
  );

  const failed = tracker.getStatus("2026-03-10T11:00:07.000Z");
  assert.equal(failed.turnStatus, "failed");
  assert.equal(failed.errorState, "unknown");
  assert.equal(failed.activeItemType, null);
  assert.equal(failed.lastHighValueEventType, "blocked");
});

test("classifies unknown notifications as safe other events", () => {
  const classified = classifyNotification("item/unknownFutureThing", {
    threadId: "thread-3",
    turnId: "turn-3"
  });

  assert.equal(classified.kind, "other");
  assert.equal(classified.method, "item/unknownFutureThing");
});

test("classifies web search progress notifications as progress events", () => {
  const classified = classifyNotification("item/webSearch/progress", {
    threadId: "thread-web",
    turnId: "turn-web",
    itemId: "web-1",
    message: "Searching the web"
  });

  assert.equal(classified.kind, "progress");
  assert.equal(classified.itemId, "web-1");
  assert.equal(classified.message, "Searching the web");
});

test("classifies concrete item labels from structured item payloads when titles are missing", () => {
  const command = classifyNotification("item/started", {
    threadId: "thread-labels",
    turnId: "turn-labels",
    item: {
      id: "cmd-1",
      type: "commandExecution",
      command: "pnpm test"
    }
  });
  assert.equal(command.kind, "item_started");
  assert.equal(command.label, "pnpm test");

  const mcp = classifyNotification("item/started", {
    threadId: "thread-labels",
    turnId: "turn-labels",
    item: {
      id: "mcp-1",
      type: "mcpToolCall",
      server: "docs",
      tool: "search_docs"
    }
  });
  assert.equal(mcp.kind, "item_started");
  assert.equal(mcp.label, "docs / search_docs");

  const web = classifyNotification("item/started", {
    threadId: "thread-labels",
    turnId: "turn-labels",
    item: {
      id: "web-1",
      type: "webSearch",
      query: "telegram html inspect"
    }
  });
  assert.equal(web.kind, "item_started");
  assert.equal(web.label, "telegram html inspect");

  const fileChange = classifyNotification("item/started", {
    threadId: "thread-labels",
    turnId: "turn-labels",
    item: {
      id: "file-1",
      type: "fileChange",
      changes: [
        {
          path: "src/service.ts",
          kind: "modified",
          diff: "@@"
        }
      ]
    }
  });
  assert.equal(fileChange.kind, "item_started");
  assert.equal(fileChange.label, "src/service.ts");
});

test("classifies structured thread status notifications from the current app-server shape", () => {
  const classified = classifyNotification("thread/status/changed", {
    threadId: "thread-5",
    status: {
      type: "active",
      activeFlags: ["waitingOnUserInput"]
    }
  });

  assert.equal(classified.kind, "thread_status_changed");
  assert.equal(classified.status, "active");
  assert.deepEqual(classified.activeFlags, ["waitingOnUserInput"]);
});

test("classifies thread archive notifications explicitly", () => {
  const archived = classifyNotification("thread/archived", {
    threadId: "thread-archive"
  });
  assert.equal(archived.kind, "thread_archived");
  assert.equal(archived.threadId, "thread-archive");

  const unarchived = classifyNotification("thread/unarchived", {
    threadId: "thread-archive"
  });
  assert.equal(unarchived.kind, "thread_unarchived");
  assert.equal(unarchived.threadId, "thread-archive");
});

test("getStreamSnapshot keeps agent commentary out of the stream body", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-stream",
    turnId: "turn-stream"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-stream",
      turnId: "turn-stream"
    }),
    "2026-03-10T10:00:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-stream",
      turnId: "turn-stream",
      item: { id: "msg-1", type: "agentMessage" }
    }),
    "2026-03-10T10:00:00.100Z"
  );

  for (const delta of ["Looking at ", "the config files."]) {
    tracker.apply(
      classifyNotification("item/agentMessage/delta", {
        threadId: "thread-stream",
        turnId: "turn-stream",
        itemId: "msg-1",
        delta
      }),
      "2026-03-10T10:00:00.200Z"
    );
  }

  tracker.apply(
    classifyNotification("item/commandExecution/outputDelta", {
      threadId: "thread-stream",
      turnId: "turn-stream",
      itemId: "cmd-1",
      delta: "$ npm test\n5/5 passed"
    }),
    "2026-03-10T10:00:01.000Z"
  );

  tracker.apply(
    classifyNotification("item/fileChange/outputDelta", {
      threadId: "thread-stream",
      turnId: "turn-stream",
      itemId: "fc-1",
      delta: "Updated src/app.ts"
    }),
    "2026-03-10T10:00:02.000Z"
  );

  tracker.apply(
    classifyNotification("turn/completed", {
      threadId: "thread-stream",
      turn: { id: "turn-stream", status: "completed" }
    }),
    "2026-03-10T10:00:03.000Z"
  );

  const snapshot = tracker.getStreamSnapshot();
  assert.ok(snapshot.blocks.length >= 4, `expected at least 4 blocks, got ${snapshot.blocks.length}`);

  const kinds = snapshot.blocks.map((b) => b.kind);
  assert.equal(kinds[0], "status");
  assert.equal(kinds.includes("commentary"), false);
  assert.ok(kinds.includes("command"), "command block present");
  assert.ok(kinds.includes("file_change"), "file_change block present");
  assert.equal(kinds.at(-1), "completion");

  const completionBlock = snapshot.blocks.at(-1)!;
  assert.equal(completionBlock.kind, "completion");
  assert.equal(completionBlock.text, "Completed");
  assert.equal(completionBlock.durationSec, 3);

  assert.equal(snapshot.turnStartedAt, "2026-03-10T10:00:00.000Z");

  const inspect = tracker.getInspectSnapshot("2026-03-10T10:00:04.000Z");
  assert.equal(inspect.completedCommentary.length, 0);
});

test("getStreamSnapshot deduplicates consecutive tool summaries", () => {
  const tracker = new ActivityTracker({
    threadId: "thread-dedup",
    turnId: "turn-dedup"
  });

  tracker.apply(
    classifyNotification("turn/started", {
      threadId: "thread-dedup",
      turnId: "turn-dedup"
    }),
    "2026-03-10T10:00:00.000Z"
  );

  tracker.apply(
    classifyNotification("item/started", {
      threadId: "thread-dedup",
      turnId: "turn-dedup",
      item: { id: "mcp-1", type: "mcpToolCall" }
    }),
    "2026-03-10T10:00:00.100Z"
  );

  tracker.apply(
    classifyNotification("item/mcpToolCall/progress", {
      threadId: "thread-dedup",
      turnId: "turn-dedup",
      itemId: "mcp-1",
      message: "Searching docs"
    }),
    "2026-03-10T10:00:00.200Z"
  );

  tracker.apply(
    classifyNotification("item/mcpToolCall/progress", {
      threadId: "thread-dedup",
      turnId: "turn-dedup",
      itemId: "mcp-1",
      message: "Searching docs"
    }),
    "2026-03-10T10:00:00.300Z"
  );

  tracker.apply(
    classifyNotification("item/mcpToolCall/progress", {
      threadId: "thread-dedup",
      turnId: "turn-dedup",
      itemId: "mcp-1",
      message: "Reading results"
    }),
    "2026-03-10T10:00:00.400Z"
  );

  const snapshot = tracker.getStreamSnapshot();
  const toolSummaries = snapshot.blocks.filter((b) => b.kind === "tool_summary");
  assert.equal(toolSummaries.length, 2, "duplicate tool summary should be deduplicated");
  assert.equal(toolSummaries[0]?.text, "Searching docs");
  assert.equal(toolSummaries[1]?.text, "Reading results");
});
