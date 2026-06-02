import test from "node:test";
import assert from "node:assert/strict";

import {
  CONSOLE_API_VERSION,
  CONSOLE_EVENT_TYPES,
  assertConsoleOpaqueId,
  assertConsoleSafeString,
  isConsoleOpaqueId
} from "./console-api-contract.js";
import type {
  ConsoleApprovalAnswerRequest,
  ConsoleApprovalRequest,
  ConsoleArtifactSummary,
  ConsoleBootstrap,
  ConsoleCapabilities,
  ConsoleDiffSummary,
  ConsoleEvent,
  ConsoleMessage,
  ConsoleOpaqueIdKind,
  ConsoleRunState,
  ConsoleSendMessageRequest,
  ConsoleSendMessageResult,
  ConsoleSessionDetail,
  ConsoleSessionSummary
} from "./console-api-contract.js";

const enabledCapabilities: ConsoleCapabilities = {
  archiveProject: { state: "enabled" },
  createSession: { state: "enabled" },
  sendMessage: { state: "enabled" },
  answerApproval: { state: "enabled" },
  uploadFiles: { state: "enabled" },
  streamEvents: { state: "enabled" },
  fetchArtifacts: { state: "enabled" }
};

const disabledCapabilities: ConsoleCapabilities = {
  archiveProject: { state: "disabled", reason: "Project archive is temporarily unavailable" },
  createSession: { state: "disabled", reason: "Session creation is paused" },
  sendMessage: { state: "disabled", reason: "Bridge is reconnecting" },
  answerApproval: { state: "disabled", reason: "Approvals are read-only" },
  uploadFiles: { state: "disabled", reason: "Uploads are not enabled for this phase" },
  streamEvents: { state: "degraded", reason: "SSE reconnect is active" },
  fetchArtifacts: { state: "enabled" }
};

const run: ConsoleRunState = {
  runId: "run_6d2Vt8Wx4Dd",
  sessionId: "ses_8h4Lm2Np6Bb",
  title: "Refactoring auth middleware",
  status: "running",
  progressLabel: "2/5 steps",
  progressPercent: 42,
  steps: [
    { order: 1, label: "Analyze current middleware", state: "done" },
    { order: 2, label: "Refactor to async/await", state: "active" }
  ],
  updatedAt: "2026-05-01T00:00:00.000Z"
};

const message: ConsoleMessage = {
  messageId: "msg_3k9Pq1Rs7Cc",
  sessionId: "ses_8h4Lm2Np6Bb",
  role: "user",
  text: "Refactor auth middleware and keep behavior identical.",
  format: "plain_text",
  status: "complete",
  createdAt: "2026-05-01T00:00:00.000Z",
  runId: "run_6d2Vt8Wx4Dd"
};

const diff: ConsoleDiffSummary = {
  sessionId: "ses_8h4Lm2Np6Bb",
  runId: "run_6d2Vt8Wx4Dd",
  title: "Pending file changes",
  status: "preview",
  totals: { changedFiles: 1, added: 23, removed: 17 },
  files: [{ displayName: "src/web/App.tsx", status: "modified", added: 23, removed: 17 }]
};

const approval: ConsoleApprovalRequest = {
  approvalId: "apr_5n7Yb3Za8Ee",
  sessionId: "ses_8h4Lm2Np6Bb",
  runId: "run_6d2Vt8Wx4Dd",
  title: "Run tests",
  body: "Codex wants to run the targeted web test suite.",
  kind: "command",
  status: "pending",
  requestedAt: "2026-05-01T00:00:00.000Z",
  options: [
    { answer: "approve", label: "Approve", style: "primary" },
    { answer: "deny", label: "Deny", style: "secondary" }
  ]
};

const artifact: ConsoleArtifactSummary = {
  artifactId: "art_2m6Bc4De9Ff",
  sessionId: "ses_8h4Lm2Np6Bb",
  runId: "run_6d2Vt8Wx4Dd",
  kind: "run_summary",
  status: "ready",
  title: "Run summary",
  displayName: "run-summary.md",
  mediaType: "text/markdown",
  sizeBytes: 2048,
  url: "/api/artifacts/art_2m6Bc4De9Ff",
  files: [{ displayName: "src/web/App.tsx", status: "modified", added: 23, removed: 17 }]
};

const sessionSummary: ConsoleSessionSummary = {
  sessionId: "ses_8h4Lm2Np6Bb",
  projectId: "prj_7f3Kp9Qm2Aa",
  title: "Refactor auth middleware",
  status: "running",
  archived: false,
  createdAt: "2026-05-01T00:00:00.000Z",
  lastActivityAt: "2026-05-01T00:01:00.000Z",
  lastMessagePreview: "Refactor auth middleware and keep behavior identical.",
  activeRunId: "run_6d2Vt8Wx4Dd",
  pendingApprovalCount: 1,
  artifactCount: 1
};

const sessionDetail: ConsoleSessionDetail = {
  ...sessionSummary,
  messages: [message],
  activeRun: run,
  diffs: [diff],
  approvals: [approval],
  artifacts: [artifact],
  eventsUrl: "/api/sessions/ses_8h4Lm2Np6Bb/events"
};

const bootstrap: ConsoleBootstrap = {
  apiVersion: CONSOLE_API_VERSION,
  generatedAt: "2026-05-01T00:00:00.000Z",
  viewer: { role: "owner", displayName: "Workspace owner" },
  capabilities: enabledCapabilities,
  projects: [
    {
      projectId: "prj_7f3Kp9Qm2Aa",
      title: "acme/web",
      branch: "main",
      hint: "apps:web",
      archived: false,
      sessionCount: 3,
      activeSessionId: "ses_8h4Lm2Np6Bb",
      lastActivityAt: "2026-05-01T00:01:00.000Z"
    }
  ],
  activeProjectId: "prj_7f3Kp9Qm2Aa",
  activeSessionId: "ses_8h4Lm2Np6Bb",
  commands: [
    { name: "/code", label: "Code", enabled: true },
    { name: "/review", label: "Review", enabled: true }
  ],
  models: [{ value: "gpt-5.5-xhigh", label: "GPT-5.5 xhigh", enabled: true }],
  modes: [{ value: "auto", label: "Auto", enabled: true }],
  degradedStates: []
};

const sendMessageRequest: ConsoleSendMessageRequest = {
  text: "Please continue the refactor.",
  model: "gpt-5.5-xhigh",
  mode: "auto",
  attachmentArtifactIds: ["art_2m6Bc4De9Ff"]
};

const sendMessageResult: ConsoleSendMessageResult = {
  accepted: true,
  sessionId: "ses_8h4Lm2Np6Bb",
  message: {
    ...message,
    messageId: "msg_7c1Uv5Wx2Gg",
    text: sendMessageRequest.text
  },
  run
};

const approvalAnswerRequest: ConsoleApprovalAnswerRequest = {
  answer: "approve",
  scope: "single",
  reason: "Run the targeted tests."
};

test("sample valid contract objects use only opaque console ids and safe strings", () => {
  const validObjects = [
    bootstrap,
    sessionSummary,
    sessionDetail,
    message,
    run,
    diff,
    approval,
    approvalAnswerRequest,
    artifact,
    sendMessageRequest,
    sendMessageResult
  ];

  for (const value of validObjects) {
    assertOpaqueIdsInShape(value);
    assertSafeStringsInShape(value);
    assertNoPlatformSpecificKeys(value);
  }
});

test("invalid or raw ids are rejected by helper validators", () => {
  const invalidIds: Array<[ConsoleOpaqueIdKind, unknown]> = [
    ["project", "project-1"],
    ["project", "prj_/home/ubuntu/app"],
    ["session", "session-raw-1"],
    ["session", "1234567890123"],
    ["message", "telegram_message_123"],
    ["run", "pid=12345"],
    ["approval", "callback:approve:123"],
    ["artifact", "art_tmp/file"],
    ["artifact", null]
  ];

  for (const [kind, value] of invalidIds) {
    assert.equal(isConsoleOpaqueId(kind, value), false, `${String(value)} should not be a ${kind} id`);
  }

  assert.equal(isConsoleOpaqueId("project", "prj_7f3Kp9Qm2Aa"), true);
  assert.equal(assertConsoleOpaqueId("artifact", "art_2m6Bc4De9Ff"), "art_2m6Bc4De9Ff");
  assert.throws(() => assertConsoleOpaqueId("approval", "callback_data=approve", "approvalId"), /opaque approval/);

  for (const unsafe of [
    "telegram chat_id=123456789",
    "feishu open_id=ou_123",
    "callback_data=approve:123",
    "/home/ubuntu/secret-project",
    "token=abc123",
    "pid=4242",
    "\u001b[31mraw terminal\u001b[0m",
    "1234567890123"
  ]) {
    assert.throws(() => assertConsoleSafeString(unsafe), TypeError, `${unsafe} should be unsafe`);
  }
});

test("event types cover message, run, diff, approval, artifact, session, and error families", () => {
  const categories = new Set(CONSOLE_EVENT_TYPES.map((type) => (type === "error" ? "error" : type.split(".")[0])));

  assert.deepEqual([...categories].sort(), ["approval", "artifact", "diff", "error", "message", "run", "session"]);

  const events: ConsoleEvent[] = [
    { type: "message.created", sequence: 1, createdAt: "2026-05-01T00:00:00.000Z", sessionId: "ses_8h4Lm2Np6Bb", message },
    { type: "run.updated", sequence: 2, createdAt: "2026-05-01T00:00:01.000Z", sessionId: "ses_8h4Lm2Np6Bb", run },
    { type: "diff.updated", sequence: 3, createdAt: "2026-05-01T00:00:02.000Z", sessionId: "ses_8h4Lm2Np6Bb", diff },
    { type: "approval.requested", sequence: 4, createdAt: "2026-05-01T00:00:03.000Z", sessionId: "ses_8h4Lm2Np6Bb", approval },
    { type: "artifact.created", sequence: 5, createdAt: "2026-05-01T00:00:04.000Z", sessionId: "ses_8h4Lm2Np6Bb", artifact },
    { type: "session.updated", sequence: 6, createdAt: "2026-05-01T00:00:05.000Z", session: sessionSummary },
    {
      type: "error",
      sequence: 7,
      createdAt: "2026-05-01T00:00:06.000Z",
      sessionId: "ses_8h4Lm2Np6Bb",
      error: { code: "bridge_unavailable", message: "Live updates are reconnecting", retryable: true }
    }
  ];

  for (const event of events) {
    assertOpaqueIdsInShape(event);
    assertSafeStringsInShape(event);
  }
});

test("capabilities can disable archive, create, send, approve, and upload without changing contract shape", () => {
  assert.deepEqual(Object.keys(disabledCapabilities).sort(), Object.keys(enabledCapabilities).sort());

  for (const key of ["archiveProject", "createSession", "sendMessage", "answerApproval", "uploadFiles"] as const) {
    assert.equal(disabledCapabilities[key].state, "disabled");
    assert.equal(typeof disabledCapabilities[key].reason, "string");
  }

  const degradedBootstrap: ConsoleBootstrap = {
    ...bootstrap,
    capabilities: disabledCapabilities,
    degradedStates: [
      {
        code: "bridge_reconnecting",
        title: "Connection needs attention",
        body: "Live updates may be delayed.",
        ownerAction: "Check the bridge service before starting a long run."
      }
    ]
  };

  assert.equal(degradedBootstrap.capabilities.streamEvents.state, "degraded");
  assertSafeStringsInShape(degradedBootstrap);
});

test("contract samples do not require platform-specific or raw bridge identifier fields", () => {
  const allSamples = { bootstrap, sessionDetail, sendMessageRequest, sendMessageResult, approvalAnswerRequest };

  assertNoPlatformSpecificKeys(allSamples);
  assert.doesNotMatch(JSON.stringify(allSamples), /(?:chat_id|callback_data|open_id|union_id|telegram|feishu|processId|pid|token)/i);
});

const idFieldKinds = {
  projectId: "project",
  activeProjectId: "project",
  sessionId: "session",
  activeSessionId: "session",
  messageId: "message",
  runId: "run",
  activeRunId: "run",
  approvalId: "approval",
  artifactId: "artifact"
} as const satisfies Record<string, ConsoleOpaqueIdKind>;

const listIdFieldKinds = {
  approvalIds: "approval",
  artifactIds: "artifact",
  attachmentArtifactIds: "artifact"
} as const satisfies Record<string, ConsoleOpaqueIdKind>;

function assertOpaqueIdsInShape(value: unknown): void {
  visitShape(value, (node, key) => {
    if (!key) {
      return;
    }

    const idKind = idFieldKinds[key as keyof typeof idFieldKinds];
    if (idKind) {
      assert.equal(isConsoleOpaqueId(idKind, node), true, `${key} must be an opaque ${idKind} id`);
      return;
    }

    const listIdKind = listIdFieldKinds[key as keyof typeof listIdFieldKinds];
    if (listIdKind) {
      assert.ok(Array.isArray(node), `${key} must be an array`);
      for (const item of node) {
        assert.equal(isConsoleOpaqueId(listIdKind, item), true, `${key} item must be an opaque ${listIdKind} id`);
      }
    }
  });
}

function assertSafeStringsInShape(value: unknown): void {
  visitShape(value, (node, key) => {
    if (typeof node === "string") {
      assertConsoleSafeString(node, key ?? "value");
    }
  });
}

function assertNoPlatformSpecificKeys(value: unknown): void {
  visitShape(value, (_node, key) => {
    if (!key) {
      return;
    }
    assert.doesNotMatch(
      key,
      /(?:telegram|feishu|chat|callback|process|pid|token|filesystem|localPath|rawSession|persistedSession|stdout|stderr|terminalLog)/i,
      `platform-specific field leaked into contract: ${key}`
    );
  });
}

function visitShape(value: unknown, visitor: (node: unknown, key?: string) => void, key?: string): void {
  visitor(value, key);

  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      visitShape(item, visitor);
    }
    return;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    visitShape(childValue, visitor, childKey);
  }
}
