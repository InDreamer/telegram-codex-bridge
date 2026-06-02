import test from "node:test";
import assert from "node:assert/strict";

import { createConsoleBridgeReadAdapter } from "./console-bridge-read-adapter.js";
import { assertConsoleSafeString, isConsoleOpaqueId } from "./console-api-contract.js";
import type { ConsoleApiError, ConsoleOpaqueIdKind } from "./console-api-contract.js";
import type {
  WebReadonlyConversationResultViewModel,
  WebReadonlyPendingInteractionViewRow,
  WebReadonlyReadinessGuardrailViewModel,
  WebReadonlyRuntimeContextViewModel,
  WebReadonlyViewModelProvider
} from "../service/web-readonly-view-model.js";

const fixedNow = "2026-05-01T00:00:00.000Z";

const pendingInteraction: WebReadonlyPendingInteractionViewRow = {
  interactionId: "pi_safe_1",
  conversationId: "cv_1111222233334444",
  sessionId: null,
  status: "awaiting_user_input",
  kind: "command",
  createdAt: "2026-04-30T12:02:00.000Z",
  updatedAt: null,
  blockingReason: "Codex wants permission to run tests.",
  summary: { state: "available", text: "Run the targeted web tests." },
  availability: "available",
  warnings: []
};

function makeProvider(options: {
  throwWorkspaces?: boolean;
  workspaceLabel?: string;
  conversationTitle?: string;
  conversationHandle?: string;
  answerText?: string;
  includePending?: boolean;
  readiness?: Partial<WebReadonlyReadinessGuardrailViewModel>;
  runtime?: Partial<WebReadonlyRuntimeContextViewModel>;
  detailState?: WebReadonlyConversationResultViewModel["state"];
} = {}): WebReadonlyViewModelProvider {
  const conversationHandle = options.conversationHandle ?? "cv_1111222233334444";
  const runtime: WebReadonlyRuntimeContextViewModel = {
    generatedAt: fixedNow,
    prototypeOnly: true,
    readonly: true,
    pageId: "web_runtime_context",
    state: options.runtime?.state ?? "available",
    activeTurns: options.runtime?.activeTurns ?? [
      {
        sessionId: conversationHandle,
        status: "running",
        summary: "Running tests without terminal logs.",
        blockedReason: null
      }
    ],
    warnings: options.runtime?.warnings ?? []
  };
  const readiness: WebReadonlyReadinessGuardrailViewModel = {
    generatedAt: fixedNow,
    prototypeOnly: true,
    readonly: true,
    pageId: "web_readiness_guardrails",
    state: options.readiness?.state ?? "ready",
    checkedAt: fixedNow,
    activePack: null,
    capabilities: [],
    missingGates: options.readiness?.missingGates ?? [],
    warnings: options.readiness?.warnings ?? []
  };

  return {
    getHomeViewModel() {
      throw new Error("not used by adapter");
    },
    listWorkspaceViewModels() {
      if (options.throwWorkspaces) {
        throw new Error("store exploded /tmp/raw token=abc telegramChatId=123");
      }
      return {
        generatedAt: fixedNow,
        prototypeOnly: true,
        readonly: true,
        pageId: "web_workspaces",
        state: "available",
        workspaces: [
          {
            workspaceId: "wk_aaaabbbbccccdddd",
            label: options.workspaceLabel ?? "Console Core",
            availability: "available",
            conversationCount: 1,
            pinned: true,
            lastActivityAt: "2026-04-30T12:00:00.000Z",
            lastSuccessAt: null,
            source: "sessions"
          }
        ],
        warnings: []
      };
    },
    listWorkspaceConversationViewModels(workspaceId: string) {
      return {
        generatedAt: fixedNow,
        prototypeOnly: true,
        readonly: true,
        pageId: "web_workspace_conversations",
        state: "available",
        workspaceId,
        conversations: [
          {
            conversationId: conversationHandle,
            conversationHandle,
            workspaceId,
            title: options.conversationTitle ?? "Implement Bridge adapter",
            status: "running",
            failureReason: null,
            archived: false,
            createdAt: "2026-04-30T11:00:00.000Z",
            lastActivityAt: "2026-04-30T12:01:00.000Z",
            lastTurnStatus: "running",
            finalAnswerAvailable: true
          }
        ],
        emptyState: null,
        warnings: []
      };
    },
    getConversationResultViewModel(conversationHandle: string) {
      return {
        generatedAt: fixedNow,
        prototypeOnly: true,
        readonly: true,
        pageId: "web_conversation_result",
        state: options.detailState ?? "available",
        conversation: {
          conversationId: conversationHandle,
          conversationHandle,
          workspaceId: "wk_aaaabbbbccccdddd",
          title: options.conversationTitle ?? "Implement Bridge adapter",
          workspaceLabel: options.workspaceLabel ?? "Console Core",
          status: "running",
          failureReason: null,
          archived: false,
          createdAt: "2026-04-30T11:00:00.000Z",
          lastActivityAt: "2026-04-30T12:01:00.000Z"
        },
        answers: [
          {
            answerId: "answer-safe-1",
            kind: "final_answer",
            deliveryState: "delivered",
            createdAt: "2026-04-30T12:03:00.000Z",
            body: { state: "available", text: options.answerText ?? "Mapped a read-only adapter over the safe Web view models." },
            summary: "Final answer body was provided by an injected Web-safe sanitizer."
          }
        ],
        runtime: { state: runtime.state, activeTurns: runtime.activeTurns },
        pendingInteractions: {
          state: options.includePending === false ? "unavailable" : "available",
          pendingInteractions: options.includePending === false ? [] : [pendingInteraction]
        },
        readiness: { state: readiness.state, missingGates: readiness.missingGates },
        composer: {
          state: "disabled",
          label: "Message Codex",
          placeholder: "Type a message to Codex",
          disabledReason: "Sending from Web is landing next.",
          capability: "web_send_landing_next"
        },
        warnings: []
      };
    },
    getConversationArtifactCatalogViewModel(sessionId: string) {
      assert.match(sessionId, /^cv_[a-f0-9]{16}$/);
      return {
        generatedAt: fixedNow,
        prototypeOnly: true,
        readonly: true,
        pageId: "web_conversation_artifacts",
        state: "available",
        conversationId: sessionId,
        artifacts: [
          {
            artifactId: "art_safe_descriptor_1",
            label: "Run summary",
            kind: "document",
            type: "text/markdown",
            mediaType: "text/markdown",
            sizeBytes: 512,
            createdAt: "2026-04-30T12:03:00.000Z",
            updatedAt: null,
            availability: "available",
            previewEligible: false,
            previewLabel: "Preview unavailable",
            downloadEligible: false,
            downloadLabel: "Download unavailable",
            warnings: []
          }
        ],
        selectedArtifact: null,
        emptyState: null,
        warnings: []
      };
    },
    getRuntimeContextViewModel() {
      return runtime;
    },
    getPendingInteractionsViewModel() {
      return {
        generatedAt: fixedNow,
        prototypeOnly: true,
        readonly: true,
        pageId: "web_pending_interactions",
        state: options.includePending === false ? "unavailable" : "available",
        pendingInteractions: options.includePending === false ? [] : [pendingInteraction],
        warnings: []
      };
    },
    getReadinessGuardrailViewModel() {
      return readiness;
    }
  };
}

test("bootstrap has safe defaults, read-only capabilities, models, and commands", () => {
  const adapter = createConsoleBridgeReadAdapter({ provider: makeProvider(), now: () => fixedNow, idSalt: "test-salt" });

  const bootstrap = adapter.getBootstrap();

  assert.equal(bootstrap.apiVersion, "2026-05-01.phase3");
  assert.equal(bootstrap.generatedAt, fixedNow);
  assert.equal(bootstrap.viewer.role, "owner");
  assert.equal(bootstrap.capabilities.sendMessage.state, "disabled");
  assert.equal(bootstrap.capabilities.createSession.state, "disabled");
  assert.equal(bootstrap.capabilities.archiveProject.state, "disabled");
  assert.equal(bootstrap.capabilities.answerApproval.state, "disabled");
  assert.equal(bootstrap.capabilities.streamEvents.state, "enabled");
  assert.equal(bootstrap.capabilities.fetchArtifacts.state, "enabled");
  assert.ok(bootstrap.commands.some((command) => command.name === "/status" && command.enabled));
  assert.ok(bootstrap.models.some((model) => model.value === "gpt-5.5"));
  assert.ok(bootstrap.modes.some((mode) => mode.value === "auto"));
  assert.equal(bootstrap.projects.length, 1);
  assertNoForbiddenConsoleData(bootstrap);
  assertConsoleShape(bootstrap);
});

test("projects and sessions use deterministic opaque Console IDs", () => {
  const first = createConsoleBridgeReadAdapter({ provider: makeProvider(), now: () => fixedNow, idSalt: "stable" });
  const second = createConsoleBridgeReadAdapter({ provider: makeProvider(), now: () => fixedNow, idSalt: "stable" });

  const project = first.listProjects()[0];
  const projectAgain = second.listProjects()[0];
  assert.ok(project);
  assert.ok(projectAgain);
  assert.equal(project.projectId, projectAgain.projectId);
  assert.equal(isConsoleOpaqueId("project", project.projectId), true);
  assert.equal(isConsoleOpaqueId("session", project.activeSessionId), true);

  const sessions = first.listProjectSessions(project.projectId);
  assert.ok(Array.isArray(sessions));
  assert.equal(sessions.length, 1);
  assert.equal(isConsoleOpaqueId("session", sessions[0]?.sessionId), true);
  assert.equal(sessions[0]?.projectId, project.projectId);
  assert.equal(sessions[0]?.status, "waiting_for_approval");
  assertNoForbiddenConsoleData({ project, sessions });
  assertConsoleShape({ project, sessions });
});

test("session detail maps messages, run, diff, approvals, and artifacts", () => {
  const adapter = createConsoleBridgeReadAdapter({ provider: makeProvider(), now: () => fixedNow, idSalt: "detail" });
  const project = adapter.listProjects()[0];
  assert.ok(project?.activeSessionId);

  const detail = adapter.getSessionDetail(project.activeSessionId);

  assert.ok(!isConsoleApiError(detail));
  assert.equal(detail.status, "waiting_for_approval");
  assert.ok(detail.messages.some((message) => message.role === "assistant" && message.format === "markdown"));
  assert.equal(detail.activeRun?.status, "waiting_for_approval");
  assert.equal(detail.activeRunId, detail.activeRun?.runId);
  assert.equal(detail.approvals.length, 1);
  assert.equal(detail.approvals[0]?.kind, "command");
  assert.equal(detail.artifacts.length, 1);
  assert.equal(detail.artifacts[0]?.kind, "run_summary");
  assert.equal(detail.diffs.length, 1);
  assert.equal(detail.eventsUrl, `/api/sessions/${detail.sessionId}/events`);
  assertNoForbiddenConsoleData(detail);
  assertConsoleShape(detail);
});

test("unavailable and degraded read sources return safe API errors or degraded capability states", () => {
  const unavailable = createConsoleBridgeReadAdapter({ provider: makeProvider({ throwWorkspaces: true }), now: () => fixedNow });
  const bootstrap = unavailable.getBootstrap();

  assert.equal(bootstrap.projects.length, 0);
  assert.equal(bootstrap.capabilities.streamEvents.state, "degraded");
  assert.ok(bootstrap.degradedStates.some((state) => state.code === "read_source_unavailable"));
  assertNoForbiddenConsoleData(bootstrap);

  const missing = unavailable.getSessionDetail("ses_missing123A");
  assert.ok(isConsoleApiError(missing));
  assert.equal(missing.code, "bridge_unavailable");
  assertNoForbiddenConsoleData(missing);

  const degraded = createConsoleBridgeReadAdapter({
    provider: makeProvider({ readiness: { state: "app_server_unavailable", missingGates: ["App server unavailable"] } }),
    now: () => fixedNow
  }).getBootstrap();
  assert.equal(degraded.capabilities.streamEvents.state, "degraded");
  assert.ok(degraded.degradedStates.some((state) => state.code === "readiness_degraded"));
  assertNoForbiddenConsoleData(degraded);
});

test("raw IDs, paths, and platform markers from source are redacted or rejected", () => {
  const adapter = createConsoleBridgeReadAdapter({
    provider: makeProvider({
      workspaceLabel: "Telegram /home/ubuntu/secret token=abc callback_data=approve",
      conversationTitle: "feishu open_id=ou_secret /tmp/session pid=4242",
      answerText: "Done in /home/ubuntu/secret with telegramChatId=123 token=abc"
    }),
    now: () => fixedNow,
    idSalt: "unsafe"
  });

  const bootstrap = adapter.getBootstrap();
  assertNoForbiddenConsoleData(bootstrap);
  assertConsoleShape(bootstrap);
  assert.equal(bootstrap.projects[0]?.title, "Workspace");

  const sessionId = bootstrap.activeSessionId;
  assert.ok(sessionId);
  const detail = adapter.getSessionDetail(sessionId);
  assert.ok(!isConsoleApiError(detail));
  assertNoForbiddenConsoleData(detail);
  assertConsoleShape(detail);
  assert.ok(detail.messages.every((message) => !message.text.includes("secret")));
});

test("session resolver returns current opaque handle only without leaking it in Console payloads", () => {
  const adapter = createConsoleBridgeReadAdapter({
    provider: makeProvider({ conversationHandle: "cv_aaaaaaaaaaaaaaaa" }),
    now: () => fixedNow,
    idSalt: "resolver"
  });
  const project = adapter.listProjects()[0];
  assert.ok(project?.activeSessionId);

  assert.equal(adapter.resolveConversationHandleForSession?.(project.activeSessionId), "cv_aaaaaaaaaaaaaaaa");
  assert.equal(adapter.resolveConversationHandleForSession?.("ses_missing1"), null);
  assert.equal(JSON.stringify(project).includes("cv_aaaaaaaaaaaaaaaa"), false);
});

test("adapter exposes no write methods and only a narrow internal session resolver", () => {
  const adapter = createConsoleBridgeReadAdapter({ provider: makeProvider(), now: () => fixedNow });
  const bootstrap = adapter.getBootstrap();
  const sessionId = bootstrap.activeSessionId;
  assert.ok(sessionId);

  assert.deepEqual(Object.keys(adapter).sort(), [
    "getBootstrap",
    "getSessionDetail",
    "listProjectSessions",
    "listProjects",
    "resolveConversationHandleForSession"
  ]);
  assert.equal(adapter.resolveConversationHandleForSession?.(sessionId), "cv_1111222233334444");
  assert.equal(adapter.resolveConversationHandleForSession?.("session-1"), null);
  assert.equal(JSON.stringify(bootstrap).includes("cv_1111222233334444"), false);
  for (const key of Object.keys(adapter)) {
    assert.doesNotMatch(key, /send|create|archive|answer|upload|post|write/i);
  }
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
  artifactIds: "artifact"
} as const satisfies Record<string, ConsoleOpaqueIdKind>;

function assertConsoleShape(value: unknown): void {
  visitShape(value, (node, key) => {
    if (typeof node === "string") {
      assertConsoleSafeString(node, key ?? "value");
    }
    if (!key) {
      return;
    }
    const kind = idFieldKinds[key as keyof typeof idFieldKinds];
    if (kind) {
      assert.equal(isConsoleOpaqueId(kind, node), true, `${key} must be opaque`);
    }
    const listKind = listIdFieldKinds[key as keyof typeof listIdFieldKinds];
    if (listKind) {
      assert.ok(Array.isArray(node), `${key} must be an array`);
      for (const item of node) {
        assert.equal(isConsoleOpaqueId(listKind, item), true, `${key} item must be opaque`);
      }
    }
  });
}

function assertNoForbiddenConsoleData(value: unknown): void {
  const text = JSON.stringify(value);
  for (const forbidden of [
    "/home/ubuntu",
    "/tmp/",
    "telegram",
    "Telegram",
    "feishu",
    "open_id",
    "union_id",
    "chatId",
    "telegramChatId",
    "callback_data",
    "token=",
    "pid=",
    "processId",
    "rawTerminal",
    "stdout",
    "stderr",
    "cv_1111222233334444",
    "wk_aaaabbbbccccdddd",
    "answer-safe-1",
    "pi_safe_1"
  ]) {
    assert.equal(text.includes(forbidden), false, `leaked forbidden marker ${forbidden}: ${text}`);
  }
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

function isConsoleApiError(value: unknown): value is ConsoleApiError {
  return Boolean(value && typeof value === "object" && "code" in value && "message" in value && "retryable" in value);
}
