import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { BridgeService } from "./service.js";
import type { SessionRow } from "./types.js";

const idSalt = "web-readonly-view-model:v1";

function conversationHandleForSessionId(sessionId: string): string {
  return `cv_${createHash("sha256").update(idSalt).update("\0").update(sessionId).digest("hex").slice(0, 16)}`;
}

function sessionFixture(patch: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "session-1",
    chatId: "chat-1",
    telegramChatId: "chat-1",
    threadId: "thread-1",
    selectedModel: null,
    selectedReasoningEffort: null,
    planMode: false,
    needsDefaultCollaborationModeReset: false,
    displayName: "Web submit fixture",
    displayNameSource: "manual",
    projectName: "project",
    projectAlias: null,
    projectPath: "/tmp/project",
    status: "idle",
    failureReason: null,
    archived: false,
    archivedAt: null,
    createdAt: "2026-04-26T00:00:00.000Z",
    lastUsedAt: "2026-04-26T00:00:00.000Z",
    lastTurnId: null,
    lastTurnStatus: null,
    ...patch
  };
}

function createHarness(sessions: SessionRow[], bindings = [{ chatId: "chat-1" }]) {
  const service = Object.create(BridgeService.prototype) as BridgeService;
  const rawService = service as any;
  const calls: unknown[] = [];
  rawService.config = { activePack: "feishu" };
  rawService.store = {
    listChatBindings: (platform?: string) => platform
      ? bindings.filter((binding) => !("platform" in binding) || binding.platform === platform)
      : bindings,
    listSessions: (chatId: string, options?: { archived?: boolean }) => {
      calls.push({ type: "listSessions", chatId, archived: options?.archived });
      return sessions.filter((session) => session.chatId === chatId && Boolean(session.archived) === Boolean(options?.archived));
    }
  };
  rawService.flushRuntimeNotices = async (chatId: string) => {
    calls.push({ type: "flush", chatId });
  };
  rawService.submitNormalTextToSession = async (chatId: string, session: SessionRow, text: string) => {
    calls.push({ type: "submit", chatId, sessionId: session.sessionId, text });
    return { status: "accepted" };
  };
  rawService.logger = { warn: async () => undefined };
  return { service, calls };
}

async function withListeningServer<T>(server: Server, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("submitWebTextMessage resolves one owner binding and opaque conversation handle before delegating", async () => {
  const session = sessionFixture();
  const { service, calls } = createHarness([session]);

  const result = await service.submitWebTextMessage({
    conversationHandle: conversationHandleForSessionId(session.sessionId),
    text: "  hello from web  "
  });

  assert.deepEqual(result, { status: "accepted" });
  assert.deepEqual(calls, [
    { type: "listSessions", chatId: "chat-1", archived: false },
    { type: "listSessions", chatId: "chat-1", archived: true },
    { type: "flush", chatId: "chat-1" },
    { type: "submit", chatId: "chat-1", sessionId: "session-1", text: "hello from web" }
  ]);
});

test("submitWebTextMessage rejects raw ids, archived sessions, mismatched chat, and ambiguous owner binding", async () => {
  const active = sessionFixture();
  const archived = sessionFixture({ sessionId: "archived-session", archived: true, archivedAt: "2026-04-26T00:00:00.000Z" });

  for (const { service, handle, chatId } of [
    { ...createHarness([active]), handle: "session-1" },
    { ...createHarness([archived]), handle: conversationHandleForSessionId(archived.sessionId) },
    { ...createHarness([active], [{ chatId: "chat-1" }, { chatId: "chat-2" }]), handle: conversationHandleForSessionId(active.sessionId) },
    { ...createHarness([active]), handle: conversationHandleForSessionId(active.sessionId), chatId: "chat-2" }
  ] as Array<ReturnType<typeof createHarness> & { handle: string; chatId?: string }>) {
    const result = await service.submitWebTextMessage({
      conversationHandle: handle,
      text: "hello",
      ...(chatId ? { chatId } : {})
    });
    assert.deepEqual(result, { status: "rejected" });
  }
});

test("live web chat server renders enabled composer and POST invokes BridgeService submit seam", async () => {
  const session = sessionFixture();
  const service = Object.create(BridgeService.prototype) as BridgeService;
  const rawService = service as any;
  const submitted: unknown[] = [];
  rawService.config = { activePack: "feishu" };
  rawService.snapshot = null;
  rawService.store = {
    listChatBindings: () => [{ chatId: "chat-1" }],
    listRecentProjects: () => [],
    listSessionProjectStats: () => [],
    listSessions: (chatId: string, options?: { archived?: boolean }) =>
      [session].filter((row) => row.chatId === chatId && Boolean(row.archived) === Boolean(options?.archived)),
    getSessionById: (sessionId: string) => sessionId === session.sessionId ? session : null,
    listFinalAnswerViews: () => [],
    getReadinessSnapshot: () => null,
    listPendingInteractionsByChat: () => []
  };
  rawService.listActiveTurns = () => [];
  rawService.submitWebTextMessage = async (request: unknown) => {
    submitted.push(request);
    return { status: "accepted" };
  };

  const csrfToken = "csrf-safe-token";
  const server = service.createWebChatHttpServer({ token: "owner-token", csrfToken });
  await withListeningServer(server, async (baseUrl) => {
    const handle = conversationHandleForSessionId(session.sessionId);
    const detail = await fetch(`${baseUrl}/conversations/${handle}`, {
      headers: { Authorization: "Bearer owner-token" }
    });
    const html = await detail.text();
    assert.equal(detail.status, 200);
    assert.match(html, new RegExp(`action="/conversations/${handle}/messages"`));
    assert.match(html, /<button type="submit">Send message<\/button>/);

    const response = await fetch(`${baseUrl}/conversations/${handle}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer owner-token",
        "Content-Type": "application/x-www-form-urlencoded",
        Host: "127.0.0.1"
      },
      body: `_csrf=${csrfToken}&message=%20live%20hello%20&nonce=n-1`,
      redirect: "manual"
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `/conversations/${handle}?send=accepted`);
    assert.deepEqual(submitted, [{
      conversationHandle: handle,
      text: "live hello",
      nonce: "n-1"
    }]);
  });
});

test("live web chat server wires Console API text send through BridgeService submit seam", async () => {
  const session = sessionFixture();
  const service = Object.create(BridgeService.prototype) as BridgeService;
  const rawService = service as any;
  const submitted: unknown[] = [];
  rawService.config = { activePack: "feishu" };
  rawService.snapshot = null;
  rawService.store = {
    listChatBindings: () => [{ chatId: "chat-1" }],
    listRecentProjects: () => [],
    listSessionProjectStats: () => [{ projectPath: session.projectPath, sessionCount: 1, lastUsedAt: session.lastUsedAt }],
    listSessions: (chatId: string, options?: { archived?: boolean }) =>
      [session].filter((row) => row.chatId === chatId && Boolean(row.archived) === Boolean(options?.archived)),
    getSessionById: (sessionId: string) => sessionId === session.sessionId ? session : null,
    listFinalAnswerViews: () => [],
    getReadinessSnapshot: () => null,
    listPendingInteractionsByChat: () => []
  };
  rawService.listActiveTurns = () => [];
  rawService.submitWebTextMessage = async (request: unknown) => {
    submitted.push(request);
    return { status: "accepted" };
  };

  const csrfToken = "csrf-safe-token";
  const server = service.createWebChatHttpServer({ token: "owner-token", csrfToken });
  await withListeningServer(server, async (baseUrl) => {
    const bootstrapResponse = await fetch(`${baseUrl}/api/console/bootstrap`, {
      headers: { Authorization: "Bearer owner-token" }
    });
    const bootstrap = await bootstrapResponse.json() as {
      activeSessionId?: string;
      capabilities: {
        sendMessage: { state: string };
        archiveProject: { state: string };
        createSession: { state: string };
        answerApproval: { state: string };
      };
    };
    assert.equal(bootstrapResponse.status, 200);
    assert.equal(bootstrap.capabilities.sendMessage.state, "enabled");
    assert.equal(bootstrap.capabilities.archiveProject.state, "disabled");
    assert.equal(bootstrap.capabilities.createSession.state, "disabled");
    assert.equal(bootstrap.capabilities.answerApproval.state, "disabled");
    assert.ok(bootstrap.activeSessionId);

    const response = await fetch(`${baseUrl}/api/sessions/${bootstrap.activeSessionId}/messages`, {
      method: "POST",
      headers: {
        Authorization: "Bearer owner-token",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
        Host: "127.0.0.1"
      },
      body: JSON.stringify({ text: " live Console hello " }),
      redirect: "manual"
    });
    const body = await response.json() as { accepted: true; sessionId: string; message: { text: string } };

    assert.equal(response.status, 202);
    assert.equal(body.accepted, true);
    assert.equal(body.sessionId, bootstrap.activeSessionId);
    assert.equal(body.message.text, "live Console hello");
    assert.deepEqual(submitted, [{
      conversationHandle: conversationHandleForSessionId(session.sessionId),
      text: "live Console hello",
      nonce: null
    }]);
    for (const forbidden of [session.sessionId, session.chatId, session.threadId, session.projectPath, conversationHandleForSessionId(session.sessionId)]) {
      assert.equal(JSON.stringify(body).includes(String(forbidden)), false, `Console API leaked ${forbidden}`);
    }
  });
});
