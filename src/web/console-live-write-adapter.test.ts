import test from "node:test";
import assert from "node:assert/strict";

import type { ConsoleBridgeReadAdapter } from "./console-bridge-read-adapter.js";
import { createConsoleLiveWriteAdapter } from "./console-live-write-adapter.js";
import type { ConsoleApiError, ConsoleSendMessageResult, ConsoleSessionDetail } from "./console-api-contract.js";

const fixedNow = "2026-05-01T00:00:00.000Z";
const sessionId = "ses_8h4Lm2Np6Bb";
const conversationHandle = "cv_1234567890abcdef";

function makeReadAdapter(
  detail: ConsoleSessionDetail | { code: "not_found"; message: string; retryable: false },
  handle: string | null = conversationHandle
): ConsoleBridgeReadAdapter {
  return {
    getBootstrap() {
      throw new Error("not used");
    },
    listProjects() {
      throw new Error("not used");
    },
    listProjectSessions() {
      throw new Error("not used");
    },
    getSessionDetail(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      return detail;
    },
    resolveConversationHandleForSession(requestedSessionId) {
      assert.equal(requestedSessionId, sessionId);
      return handle;
    }
  };
}

function sessionDetail(patch: Partial<ConsoleSessionDetail> = {}): ConsoleSessionDetail {
  return {
    sessionId,
    projectId: "prj_7f3Kp9Qm2Aa",
    title: "Safe live send",
    status: "idle",
    archived: false,
    createdAt: fixedNow,
    lastActivityAt: fixedNow,
    pendingApprovalCount: 0,
    artifactCount: 0,
    messages: [
      {
        messageId: "msg_3k9Pq1Rs7Cc",
        sessionId,
        role: "system",
        text: "Session is visible in read-only mode.",
        format: "plain_text",
        status: "complete",
        createdAt: fixedNow
      }
    ],
    diffs: [],
    approvals: [],
    artifacts: [],
    eventsUrl: `/api/sessions/${sessionId}/events`,
    ...patch
  };
}

function sendMessage(adapter: ReturnType<typeof createConsoleLiveWriteAdapter>) {
  assert.ok(adapter.sendMessage);
  return adapter.sendMessage;
}

function assertSendResult(value: ConsoleSendMessageResult | ConsoleApiError): asserts value is ConsoleSendMessageResult {
  assert.equal("accepted" in value && value.accepted, true);
}

test("live write adapter resolves Console session through read adapter and submits text once", async () => {
  const submitted: unknown[] = [];
  const adapter = createConsoleLiveWriteAdapter({
    readAdapter: makeReadAdapter(sessionDetail()),
    now: () => fixedNow,
    submitTextMessage(request) {
      submitted.push(request);
      return { status: "accepted" };
    }
  });

  const result = await sendMessage(adapter)(sessionId, { text: "  Continue safely.  ", model: "gpt-5.5", mode: "auto" });
  assertSendResult(result);

  assert.equal(result.accepted, true);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.message.sessionId, sessionId);
  assert.equal(result.message.role, "user");
  assert.equal(result.message.text, "Continue safely.");
  assert.equal(result.message.status, "pending");
  assert.equal(result.message.createdAt, fixedNow);
  assert.match(result.message.messageId, /^msg_[A-Za-z0-9_-]{6,128}$/);
  assert.deepEqual(submitted, [{ conversationHandle, text: "Continue safely.", nonce: null }]);
});

test("live write adapter keeps unsupported actions disabled", () => {
  const adapter = createConsoleLiveWriteAdapter({
    readAdapter: makeReadAdapter(sessionDetail()),
    submitTextMessage: () => ({ status: "accepted" })
  });
  const unresolved = createConsoleLiveWriteAdapter({
    readAdapter: {
      getBootstrap() { throw new Error("not used"); },
      listProjects() { return []; },
      listProjectSessions() { return []; },
      getSessionDetail() { return sessionDetail(); }
    },
    submitTextMessage: () => ({ status: "accepted" })
  });

  assert.equal(adapter.capabilities?.sendMessage?.state, "enabled");
  assert.equal(unresolved.capabilities?.sendMessage?.state, "disabled");
  assert.equal(adapter.capabilities?.archiveProject?.state, "disabled");
  assert.equal(adapter.capabilities?.createSession?.state, "disabled");
  assert.equal(adapter.capabilities?.answerApproval?.state, "disabled");
  assert.equal(adapter.archiveProject, undefined);
  assert.equal(adapter.createSession, undefined);
  assert.equal(adapter.answerApproval, undefined);
});

test("live write adapter maps missing session, unsupported payload, and submit failures safely", async () => {
  const missing = createConsoleLiveWriteAdapter({
    readAdapter: makeReadAdapter({ code: "not_found", message: "Session not found.", retryable: false }),
    submitTextMessage: () => ({ status: "accepted" })
  });
  assert.deepEqual(await sendMessage(missing)(sessionId, { text: "hello" }), {
    code: "not_found",
    message: "Session is not available for live Web send.",
    retryable: false
  });

  const archived = createConsoleLiveWriteAdapter({
    readAdapter: makeReadAdapter(sessionDetail({ archived: true, status: "archived" })),
    submitTextMessage: () => ({ status: "accepted" })
  });
  assert.deepEqual(await sendMessage(archived)(sessionId, { text: "hello" }), {
    code: "conflict",
    message: "Archived sessions cannot receive live Web messages.",
    retryable: false
  });

  const withAttachment = createConsoleLiveWriteAdapter({
    readAdapter: makeReadAdapter(sessionDetail()),
    submitTextMessage: () => ({ status: "accepted" })
  });
  assert.deepEqual(await sendMessage(withAttachment)(sessionId, {
    text: "hello",
    attachmentArtifactIds: ["art_2m6Bc4De9Ff"]
  }), {
    code: "capability_disabled",
    message: "Attachments are not enabled for live Web send.",
    retryable: false,
    capability: "uploadFiles"
  });

  const unavailable = createConsoleLiveWriteAdapter({
    readAdapter: makeReadAdapter(sessionDetail()),
    submitTextMessage: () => ({ status: "unavailable" })
  });
  assert.deepEqual(await sendMessage(unavailable)(sessionId, { text: "hello" }), {
    code: "bridge_unavailable",
    message: "Live Web send is temporarily unavailable.",
    retryable: true
  });

  const blocked = createConsoleLiveWriteAdapter({
    readAdapter: makeReadAdapter(sessionDetail()),
    submitTextMessage: () => ({ status: "blocked" })
  });
  assert.deepEqual(await sendMessage(blocked)(sessionId, { text: "hello" }), {
    code: "conflict",
    message: "Codex is busy or waiting for owner input in this session.",
    retryable: false
  });

  const rejected = createConsoleLiveWriteAdapter({
    readAdapter: makeReadAdapter(sessionDetail()),
    submitTextMessage: () => ({ status: "rejected" })
  });
  assert.deepEqual(await sendMessage(rejected)(sessionId, { text: "hello" }), {
    code: "not_found",
    message: "Session is not available for live Web send.",
    retryable: false
  });
});
