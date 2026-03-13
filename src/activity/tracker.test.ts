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
      status: "blocked",
      activeFlags: ["waitingOnApproval"]
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
