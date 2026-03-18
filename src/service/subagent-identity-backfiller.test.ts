import test from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../logger.js";
import type { CollabAgentStateSnapshot } from "../activity/types.js";
import { SubagentIdentityBackfiller } from "./subagent-identity-backfiller.js";

function createCapturingLogger(): {
  logger: Logger;
  info: Array<{ message: string; meta: Record<string, unknown> | undefined }>;
  warn: Array<{ message: string; meta: Record<string, unknown> | undefined }>;
} {
  const info: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];
  const warn: Array<{ message: string; meta: Record<string, unknown> | undefined }> = [];

  return {
    logger: {
      info: async (message, meta) => {
        info.push({ message, meta });
      },
      warn: async (message, meta) => {
        warn.push({ message, meta });
      },
      error: async () => {}
    },
    info,
    warn
  };
}

function createActiveTurn(labelSource: "fallback" | "nickname" = "fallback") {
  let snapshot: CollabAgentStateSnapshot[] = [{
    threadId: "agent-1",
    label: labelSource === "nickname" ? "Worker 1" : "Agent 1",
    labelSource,
    status: "running",
    progress: null
  }];
  const drainedEvents: Array<{
    kind: "applied";
    threadId: string;
    label: string;
    labelSource: "nickname" | "threadName";
    origin: "backfill";
  }> = [];

  const activeTurn = {
    sessionId: "session-1",
    chatId: "chat-1",
    threadId: "root-thread",
    turnId: "turn-1",
    tracker: {
      applyResolvedSubagentIdentity: (_threadId: string, identity: { agentNickname?: string | null; threadName?: string | null }) => {
        const nextLabel = identity.agentNickname ?? identity.threadName ?? null;
        if (!nextLabel) {
          return false;
        }
        const nextLabelSource = identity.agentNickname ? "nickname" : "threadName";
        snapshot = [{
          ...snapshot[0]!,
          label: nextLabel,
          labelSource: nextLabelSource
        }];
        drainedEvents.push({
          kind: "applied",
          threadId: "agent-1",
          label: nextLabel,
          labelSource: nextLabelSource,
          origin: "backfill"
        });
        return true;
      },
      drainSubagentIdentityEvents: () => drainedEvents.splice(0, drainedEvents.length),
      getInspectSnapshot: () => ({
        agentSnapshot: snapshot
      })
    },
    subagentIdentityBackfillStates: new Map<string, "pending" | "resolved" | "exhausted">()
  };

  return {
    activeTurn,
    getSnapshot: () => snapshot
  };
}

test("SubagentIdentityBackfiller resolves missing labels from readThread metadata", async () => {
  const { logger, info, warn } = createCapturingLogger();
  let readThreadCalls = 0;
  const { activeTurn, getSnapshot } = createActiveTurn();
  const backfiller = new SubagentIdentityBackfiller({
    logger,
    getAppServer: () => ({
      readThread: async () => {
        readThreadCalls += 1;
        return {
          thread: {
            agentNickname: "Worker 1",
            agentRole: "worker",
            name: "Some thread"
          }
        };
      }
    }) as never
  });

  const changed = await backfiller.backfill(activeTurn as never, [{
    threadId: "agent-1",
    label: "Agent 1",
    labelSource: "fallback",
    status: "running",
    progress: null
  }]);

  assert.equal(changed, true);
  assert.equal(readThreadCalls, 1);
  assert.equal(activeTurn.subagentIdentityBackfillStates.get("agent-1"), "resolved");
  assert.equal(getSnapshot()[0]?.label, "Worker 1");
  assert.equal(getSnapshot()[0]?.labelSource, "nickname");
  assert.ok(info.some((entry) => entry.message === "subagent identity backfill requested"));
  assert.ok(info.some((entry) => entry.message === "subagent identity backfill resolved"));
  assert.equal(warn.length, 0);
});

test("SubagentIdentityBackfiller skips nickname-labeled or already-terminal entries", async () => {
  const { logger } = createCapturingLogger();
  let readThreadCalls = 0;
  const { activeTurn } = createActiveTurn("nickname");
  activeTurn.subagentIdentityBackfillStates.set("agent-2", "resolved");
  const backfiller = new SubagentIdentityBackfiller({
    logger,
    getAppServer: () => ({
      readThread: async () => {
        readThreadCalls += 1;
        return { thread: {} };
      }
    }) as never
  });

  const changed = await backfiller.backfill(activeTurn as never, [
    {
      threadId: "agent-1",
      label: "Worker 1",
      labelSource: "nickname",
      status: "running",
      progress: null
    },
    {
      threadId: "agent-2",
      label: "Agent 2",
      labelSource: "fallback",
      status: "running",
      progress: null
    }
  ]);

  assert.equal(changed, false);
  assert.equal(readThreadCalls, 0);
});

test("SubagentIdentityBackfiller exhausts failed backfill attempts", async () => {
  const { logger, warn } = createCapturingLogger();
  const { activeTurn } = createActiveTurn();
  const backfiller = new SubagentIdentityBackfiller({
    logger,
    getAppServer: () => ({
      readThread: async () => {
        throw new Error("read failed");
      }
    }) as never
  });

  const changed = await backfiller.backfill(activeTurn as never, [{
    threadId: "agent-1",
    label: "Agent 1",
    labelSource: "fallback",
    status: "running",
    progress: null
  }]);

  assert.equal(changed, false);
  assert.equal(activeTurn.subagentIdentityBackfillStates.get("agent-1"), "exhausted");
  assert.ok(warn.some((entry) => entry.message === "subagent identity backfill failed"));
});
