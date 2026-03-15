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

test("handleMessage routes method-plus-id frames to server request handlers", () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  const requests: unknown[] = [];

  client.onServerRequest((request) => {
    requests.push(request);
  });

  (client as any).handleMessage(JSON.stringify({
    id: "server-1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: []
    }
  }));

  assert.deepEqual(requests, [{
    id: "server-1",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      questions: []
    }
  }]);
});

test("handleMessage keeps response resolution intact alongside server requests", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let resolved: unknown = null;
  let rejected: unknown = null;
  const timer = setTimeout(() => {}, 10_000);

  (client as any).pending.set(7, {
    resolve: (value: unknown) => {
      resolved = value;
    },
    reject: (error: unknown) => {
      rejected = error;
    },
    timer
  });

  (client as any).handleMessage(JSON.stringify({
    id: 7,
    result: {
      ok: true
    }
  }));

  clearTimeout(timer);
  assert.deepEqual(resolved, { ok: true });
  assert.equal(rejected, null);
});

test("respondToServerRequest writes a JSON-RPC result frame", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  const writes: string[] = [];

  (client as any).child = {
    stdin: {
      write: (chunk: string, _encoding: string, callback?: (error?: Error | null) => void) => {
        writes.push(chunk);
        callback?.(null);
      }
    }
  };

  await client.respondToServerRequest("server-2", { decision: "accept" });

  assert.deepEqual(writes, [
    `${JSON.stringify({
      id: "server-2",
      result: { decision: "accept" }
    })}\n`
  ]);
});

test("steerTurn sends expectedTurnId and structured input", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  let captured: { method: string; params: unknown } | null = null;

  (client as any).request = async (method: string, params: unknown) => {
    captured = { method, params };
    return {};
  };

  await client.steerTurn({
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "continue" }]
  });

  assert.deepEqual(captured, {
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-1",
      input: [{ type: "text", text: "continue" }]
    }
  });
});
