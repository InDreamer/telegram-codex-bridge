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
  assert.equal(inspect.commentarySnippets[0], "Checking event mapping against Telegram surface.");
  assert.equal(inspect.commentarySnippets.includes("internal reasoning should stay private"), false);
  assert.equal(inspect.recentTransitions.length, 7);
  assert.match(inspect.recentTransitions.at(-1)?.summary ?? "", /completed/u);
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
