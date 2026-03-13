import test from "node:test";
import assert from "node:assert/strict";

import type { Logger } from "../logger.js";
import { CodexAppServerClient, buildThreadStartParams, buildTurnStartParams } from "./app-server.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

test("buildThreadStartParams requests full-access sandbox", () => {
  assert.deepEqual(buildThreadStartParams("/tmp/project"), {
    cwd: "/tmp/project",
    approvalPolicy: "never",
    sandbox: "danger-full-access"
  });
});

test("buildTurnStartParams uses turn-level sandbox overrides", () => {
  assert.deepEqual(
    buildTurnStartParams({
      threadId: "thread-1",
      cwd: "/tmp/project",
      text: "edit files"
    }),
    {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "edit files" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    }
  );
});

test("listThreads sends archived filters through the JSON-RPC client", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let captured: { method: string; params: unknown } | null = null;

  (client as any).request = async (method: string, params: unknown) => {
    captured = { method, params };
    return { data: [], nextCursor: null };
  };

  await client.listThreads({
    archived: true,
    limit: 20,
    sortKey: "updated_at"
  });

  assert.deepEqual(captured, {
    method: "thread/list",
    params: {
      archived: true,
      limit: 20,
      sortKey: "updated_at"
    }
  });
});

test("readThread sends includeTurns when requested", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let captured: { method: string; params: unknown } | null = null;

  (client as any).request = async (method: string, params: unknown) => {
    captured = { method, params };
    return { thread: { id: "thread-1", turns: [] } };
  };

  await client.readThread("thread-1", true);

  assert.deepEqual(captured, {
    method: "thread/read",
    params: {
      threadId: "thread-1",
      includeTurns: true
    }
  });
});
