import test from "node:test";
import assert from "node:assert/strict";

import { collectArchiveDriftDiagnostics } from "./archive-drift.js";

test("collectArchiveDriftDiagnostics reports remote archived threads that are still visible locally", async () => {
  const summary = await collectArchiveDriftDiagnostics({
    store: {
      listSessionsWithThreads: () => [{
        sessionId: "session-1",
        telegramChatId: "chat-1",
        threadId: "thread-1",
        displayName: "Session One",
        projectName: "Project One",
        projectPath: "/tmp/project-one",
        status: "idle",
        failureReason: null,
        archived: false,
        archivedAt: null,
        createdAt: "2026-03-14T10:00:00.000Z",
        lastUsedAt: "2026-03-14T10:00:00.000Z",
        lastTurnId: null,
        lastTurnStatus: null
      }]
    } as any,
    listThreads: async (options?: { archived?: boolean; cursor?: string }) => {
      const archived = options?.archived;
      const cursor = options?.cursor;
      assert.equal(cursor, undefined);
      if (archived) {
        return {
          data: [{
            id: "thread-1",
            cwd: "/tmp/project-one",
            preview: "",
            updatedAt: 0,
            createdAt: 0,
            status: {}
          }],
          nextCursor: null
        };
      }

      return {
        data: [],
        nextCursor: null
      };
    }
  });

  assert.equal(summary.issues.length, 1);
  assert.equal(summary.issues[0]?.kind, "remote_archived_local_visible");
  assert.equal(summary.issues[0]?.threadId, "thread-1");
});

test("collectArchiveDriftDiagnostics reports missing remote threads for local sessions with thread ids", async () => {
  const summary = await collectArchiveDriftDiagnostics({
    store: {
      listSessionsWithThreads: () => [{
        sessionId: "session-2",
        telegramChatId: "chat-1",
        threadId: "thread-missing",
        displayName: "Session Missing",
        projectName: "Project Missing",
        projectPath: "/tmp/project-missing",
        status: "failed",
        failureReason: "unknown",
        archived: true,
        archivedAt: "2026-03-14T10:00:00.000Z",
        createdAt: "2026-03-14T10:00:00.000Z",
        lastUsedAt: "2026-03-14T10:00:00.000Z",
        lastTurnId: null,
        lastTurnStatus: null
      }]
    } as any,
    listThreads: async () => ({
      data: [],
      nextCursor: null
    })
  });

  assert.equal(summary.issues.length, 1);
  assert.equal(summary.issues[0]?.kind, "local_thread_missing_remote");
  assert.equal(summary.issues[0]?.threadId, "thread-missing");
});
