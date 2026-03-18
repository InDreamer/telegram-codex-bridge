import test from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../logger.js";
import type { BridgeStateStore } from "../state/store.js";
import { ThreadArchiveReconciler } from "./thread-archive-reconciler.js";

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

test("ThreadArchiveReconciler confirms notifications observed before local commit once persistence lands", async () => {
  const { logger, info, warn } = createCapturingLogger();
  const reconciler = new ThreadArchiveReconciler({
    logger,
    getStore: () => null
  });

  const opId = reconciler.registerPendingOp("thread-1", "session-1", "archived", "telegram_archive");
  await reconciler.handleNotification({
    kind: "thread_archived",
    threadId: "thread-1",
    method: "thread/archived"
  } as never);

  assert.equal(reconciler.pendingOps.size, 1);
  assert.ok(info.some((entry) => entry.message === "thread archive op observed before local commit"));

  await reconciler.markLocalCommit("thread-1", opId);

  assert.equal(reconciler.pendingOps.size, 0);
  assert.equal(warn.length, 0);
  assert.ok(info.some((entry) => entry.message === "thread archive op confirmed"));
});

test("ThreadArchiveReconciler clears conflicting notifications and keeps only diagnostics", async () => {
  const { logger, warn } = createCapturingLogger();
  const reconciler = new ThreadArchiveReconciler({
    logger,
    getStore: () => null
  });

  reconciler.registerPendingOp("thread-2", "session-2", "archived", "telegram_archive");
  await reconciler.handleNotification({
    kind: "thread_unarchived",
    threadId: "thread-2",
    method: "thread/unarchived"
  } as never);

  assert.equal(reconciler.pendingOps.size, 0);
  assert.ok(warn.some((entry) => entry.message === "thread archive op conflicted"));
});

test("ThreadArchiveReconciler logs unsolicited archive drift without mutating local state", async () => {
  const { logger, warn } = createCapturingLogger();
  const store = {
    getSessionByThreadId: (_threadId: string) => ({
      sessionId: "session-3",
      archived: false
    })
  } as unknown as BridgeStateStore;
  const reconciler = new ThreadArchiveReconciler({
    logger,
    getStore: () => store
  });

  await reconciler.handleNotification({
    kind: "thread_archived",
    threadId: "thread-3",
    method: "thread/archived"
  } as never);

  assert.equal(reconciler.pendingOps.size, 0);
  assert.ok(warn.some((entry) => entry.message === "thread archive drift observed"));
});

test("ThreadArchiveReconciler clears pending ops on app-server exit", async () => {
  const { logger, warn } = createCapturingLogger();
  const reconciler = new ThreadArchiveReconciler({
    logger,
    getStore: () => null
  });

  reconciler.registerPendingOp("thread-4", "session-4", "archived", "telegram_archive");
  reconciler.registerPendingOp("thread-5", "session-5", "unarchived", "telegram_unarchive");

  await reconciler.clearOnAppServerExit();

  assert.equal(reconciler.pendingOps.size, 0);
  assert.ok(warn.some((entry) => entry.message === "clearing pending thread archive ops after app-server exit"));
});
