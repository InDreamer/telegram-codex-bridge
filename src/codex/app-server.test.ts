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
  assert.deepEqual(buildThreadStartParams({ cwd: "/tmp/project" }), {
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

test("buildTurnStartParams includes collaboration mode when requested", () => {
  assert.deepEqual(
    buildTurnStartParams({
      threadId: "thread-1",
      cwd: "/tmp/project",
      text: "plan the work",
      model: "gpt-5",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5",
          developerInstructions: null,
          reasoningEffort: "medium"
        }
      }
    } as any),
    {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "plan the work" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model: "gpt-5",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5",
          developer_instructions: null,
          reasoning_effort: "medium"
        }
      }
    }
  );
});

test("buildTurnStartParams supports explicit default collaboration mode", () => {
  assert.deepEqual(
    buildTurnStartParams({
      threadId: "thread-1",
      cwd: "/tmp/project",
      text: "implement the work",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5",
          developerInstructions: null,
          reasoningEffort: null
        }
      }
    }),
    {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "implement the work" }],
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5",
          developer_instructions: null,
          reasoning_effort: null
        }
      }
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

test("phase6 plugin and app requests send the current schema-backed params", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  const captured: Array<{ method: string; params: unknown }> = [];

  (client as any).request = async (method: string, params: unknown) => {
    captured.push({ method, params });
    if (method === "plugin/list") {
      return { marketplaces: [] };
    }
    if (method === "plugin/install") {
      return { appsNeedingAuth: [] };
    }
    if (method === "app/list") {
      return { data: [], nextCursor: null };
    }
    return {};
  };

  await client.listPlugins({ cwds: ["/tmp/project-one"] });
  await client.installPlugin({
    marketplacePath: "/marketplaces/repo",
    pluginName: "deploy"
  });
  await client.listApps({
    threadId: "thread-1",
    forceRefetch: true,
    limit: 10
  });

  assert.deepEqual(captured, [
    {
      method: "plugin/list",
      params: {
        cwds: ["/tmp/project-one"]
      }
    },
    {
      method: "plugin/install",
      params: {
        marketplacePath: "/marketplaces/repo",
        pluginName: "deploy"
      }
    },
    {
      method: "app/list",
      params: {
        threadId: "thread-1",
        forceRefetch: true,
        limit: 10
      }
    }
  ]);
});

test("phase6 mcp account and background-terminal requests use the expected methods", async () => {
  const client = new CodexAppServerClient("codex", "/tmp/app-server.log", testLogger);
  const captured: Array<{ method: string; params: unknown }> = [];

  (client as any).request = async (method: string, params: unknown) => {
    captured.push({ method, params });
    if (method === "mcpServerStatus/list") {
      return { data: [], nextCursor: null };
    }
    if (method === "mcpServer/oauth/login") {
      return { authorizationUrl: "https://auth.example/mcp" };
    }
    if (method === "account/read") {
      return {
        account: { type: "chatgpt", email: "me@example.com", planType: "plus" },
        requiresOpenaiAuth: false
      };
    }
    if (method === "account/rateLimits/read") {
      return {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: null,
          secondary: null,
          credits: null,
          planType: "plus"
        },
        rateLimitsByLimitId: null
      };
    }
    return {};
  };

  await client.listMcpServerStatuses({ limit: 20 });
  await client.reloadMcpServers();
  await client.loginToMcpServer({ name: "github" });
  await client.readAccount(false);
  await client.readAccountRateLimits();
  await client.cleanBackgroundTerminals("thread-1");

  assert.deepEqual(captured, [
    {
      method: "mcpServerStatus/list",
      params: {
        limit: 20
      }
    },
    {
      method: "config/mcpServer/reload",
      params: undefined
    },
    {
      method: "mcpServer/oauth/login",
      params: {
        name: "github"
      }
    },
    {
      method: "account/read",
      params: {
        refreshToken: false
      }
    },
    {
      method: "account/rateLimits/read",
      params: undefined
    },
    {
      method: "thread/backgroundTerminals/clean",
      params: {
        threadId: "thread-1"
      }
    }
  ]);
});
