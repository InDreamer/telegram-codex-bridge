import test from "node:test";
import assert from "node:assert/strict";

import type { AddressInfo } from "node:net";

import { createReadonlyAccessGate } from "./readonly-access.js";
import { createReadonlyHttpServer } from "./readonly-http-server.js";
import type {
  WebReadonlyConversationRow,
  WebReadonlyConversationResultViewModel,
  WebReadonlyPendingInteractionViewRow,
  WebReadonlyReadinessGuardrailViewModel,
  WebReadonlyRuntimeContextViewModel,
  WebReadonlyViewModelProvider
} from "../service/web-readonly-view-model.js";

const token = "local-test-token";

function makeProvider(
  calls: string[],
  options: {
    throwOnHome?: boolean;
    homeWorkspaces?: ReturnType<WebReadonlyViewModelProvider["getHomeViewModel"]>["workspaces"];
    homeConversations?: WebReadonlyConversationRow[];
    workspaceConversations?: WebReadonlyConversationRow[];
    detailAnswers?: WebReadonlyConversationResultViewModel["answers"];
    detailStatus?: string;
    pendingInteractions?: WebReadonlyPendingInteractionViewRow[];
    homePendingInteractions?: WebReadonlyPendingInteractionViewRow[];
    detailPendingInteractions?: WebReadonlyPendingInteractionViewRow[];
    runtime?: WebReadonlyRuntimeContextViewModel;
    readiness?: WebReadonlyReadinessGuardrailViewModel;
  } = {}
): WebReadonlyViewModelProvider {
  return {
    getHomeViewModel() {
      calls.push("home");
      if (options.throwOnHome) {
        throw new Error("boom stack secret /tmp/secret-store messageId=123");
      }
      return {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_home",
        state: "available",
        operator: { binding: "available" },
        workspaces: options.homeWorkspaces ?? [
          {
            workspaceId: "wk_safe_1",
            label: "<script>alert('x')</script> Console /home/ubuntu/secret token=abc callback_data=approve messageId=5",
            availability: "available",
            conversationCount: 1,
            pinned: true,
            lastActivityAt: "2026-04-25T12:00:00.000Z",
            lastSuccessAt: null,
            source: "recent"
          }
        ],
        recentConversations: options.homeConversations ?? [
          {
            conversationId: "cv_1234567890abcdef",
            conversationHandle: "cv_1234567890abcdef",
            workspaceId: "wk_safe_1",
            title: "Need <b>escape</b> & no submit approve interrupt upload switch resume",
            status: "running",
            failureReason: null,
            archived: false,
            createdAt: "2026-04-25T10:00:00.000Z",
            lastActivityAt: "2026-04-25T12:00:00.000Z",
            lastTurnStatus: "running",
            finalAnswerAvailable: true
          }
        ],
        runtime: options.runtime
          ? { state: options.runtime.state, activeTurns: options.runtime.activeTurns }
          : {
          state: "available",
          activeTurns: [
            {
              sessionId: "session-1",
              status: "running",
              summary: "safe <img src=x onerror=alert(1)>",
              blockedReason: null
            }
          ]
        },
        pendingInteractions: {
          state: options.homePendingInteractions ? "available" : "unavailable",
          pendingInteractions: options.homePendingInteractions ?? []
        },
        readiness: { state: "ready", missingGates: [] },
        composer: disabledComposerFixture(),
        warnings: []
      };
    },
    listWorkspaceViewModels() {
      calls.push("workspaces");
      return {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_workspaces",
        state: "available",
        workspaces: options.homeWorkspaces ?? [
          {
            workspaceId: "wk_safe_1",
            label: "Console Core",
            availability: "available",
            conversationCount: 1,
            pinned: true,
            lastActivityAt: "2026-04-25T12:00:00.000Z",
            lastSuccessAt: null,
            source: "recent"
          }
        ],
        warnings: []
      };
    },
    listWorkspaceConversationViewModels(workspaceId: string) {
      calls.push(`workspace:${workspaceId}`);
      return {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_workspace_conversations",
        state: "available",
        workspaceId,
        conversations: options.workspaceConversations ?? [
          {
            conversationId: "cv_1234567890abcdef",
            conversationHandle: "cv_1234567890abcdef",
            workspaceId,
            title: "Readonly detail",
            status: "completed",
            failureReason: null,
            archived: false,
            createdAt: "2026-04-25T10:00:00.000Z",
            lastActivityAt: "2026-04-25T12:00:00.000Z",
            lastTurnStatus: "completed",
            finalAnswerAvailable: true
          }
        ],
        emptyState: null,
        warnings: []
      };
    },
    getConversationResultViewModel(conversationHandle: string) {
      calls.push(`conversation:${conversationHandle}`);
      return {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_conversation_result",
        state: "available",
        conversation: {
          conversationId: conversationHandle,
          conversationHandle,
          workspaceId: "wk_safe_1",
          title: "Readonly detail",
          workspaceLabel: "Console Core",
          status: options.detailStatus ?? "completed",
          failureReason: null,
          archived: false,
          createdAt: "2026-04-25T10:00:00.000Z",
          lastActivityAt: "2026-04-25T12:00:00.000Z"
        },
        answers: options.detailAnswers ?? [],
        runtime: { state: "degraded", activeTurns: [] },
        pendingInteractions: {
          state: options.detailPendingInteractions ? "available" : "unavailable",
          pendingInteractions: options.detailPendingInteractions ?? []
        },
        readiness: { state: "ready", missingGates: [] },
        composer: disabledComposerFixture(),
        warnings: []
      };
    },
    getConversationArtifactCatalogViewModel(sessionId: string) {
      calls.push(`artifacts:${sessionId}`);
      return {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_conversation_artifacts",
        state: "empty",
        conversationId: sessionId,
        artifacts: [],
        selectedArtifact: null,
        emptyState: "no_artifacts",
        warnings: []
      };
    },
    getRuntimeContextViewModel() {
      calls.push("runtime");
      return options.runtime ?? {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_runtime_context",
        state: "available",
        activeTurns: [],
        warnings: []
      };
    },
    getPendingInteractionsViewModel() {
      calls.push("interactions");
      return {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_pending_interactions",
        state: "available",
        pendingInteractions: options.pendingInteractions ?? [],
        warnings: []
      };
    },
    getReadinessGuardrailViewModel() {
      calls.push("readiness");
      return options.readiness ?? {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_readiness_guardrails",
        state: "ready",
        checkedAt: "2026-04-26T00:00:00.000Z",
        activePack: null,
        capabilities: [],
        missingGates: [],
        warnings: []
      };
    }
  };
}

async function withServer<T>(
  options: Parameters<typeof createReadonlyHttpServer>[0],
  run: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = createReadonlyHttpServer(options);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function get(url: string, bearer?: string): Promise<{ status: number; text: string; headers: Headers }> {
  const init: RequestInit = bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {};
  const response = await fetch(url, init);
  return { status: response.status, text: await response.text(), headers: response.headers };
}

async function post(
  url: string,
  bearer: string | undefined,
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(url, {
    method: "POST",
    body,
    redirect: "manual",
    headers: {
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      ...headers
    }
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

test("disabled or missing token denies generically and does not invoke provider", async () => {
  for (const access of [
    createReadonlyAccessGate({ enabled: false, token }),
    createReadonlyAccessGate({ enabled: true })
  ]) {
    const calls: string[] = [];
    await withServer({ provider: makeProvider(calls), access }, async (baseUrl) => {
      const result = await get(`${baseUrl}/`);
      assert.equal(result.status, 404);
      assert.match(result.text, /Not found/);
      assert.equal(result.text.includes("token"), false);
      assert.deepEqual(calls, []);
    });
  }
});

test("wrong or missing bearer denies generically and does not invoke provider", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    for (const bearer of [undefined, "wrong-token"]) {
      const result = await get(`${baseUrl}/`, bearer);
      assert.equal(result.status, 404);
      assert.match(result.text, /Not found/);
      assert.equal(result.text.includes("Bearer"), false);
      assert.deepEqual(calls, []);
    }

    const urlToken = await get(`${baseUrl}/?token=${token}`);
    assert.equal(urlToken.status, 404);
    assert.match(urlToken.text, /Not found/);
    assert.deepEqual(calls, []);
  });
});

test("authenticated state route invokes only expected provider method", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    const result = await get(`${baseUrl}/runtime`, token);
    assert.equal(result.status, 200);
    assert.match(result.text, /Runtime/);
    assert.deepEqual(calls, ["runtime"]);
  });
});

test("chat alias renders the same API-backed product console home", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    const root = await get(`${baseUrl}/`, token);
    const alias = await get(`${baseUrl}/chat`, token);
    assert.equal(root.status, 200);
    assert.equal(alias.status, 200);
    assert.ok(calls.includes("workspaces"));
    assert.ok(calls.includes("workspace:wk_safe_1"));
    assert.ok(calls.includes("conversation:cv_1234567890abcdef"));
    for (const copy of ["Codex Console", "Console Core", "Readonly detail", "GPT-5.5", "Message unavailable from Web"]) {
      assert.match(alias.text, new RegExp(escapeRegExp(copy)), `missing alias copy ${copy}: ${alias.text}`);
    }
    assert.match(alias.text, /data-console-api-root="\/api"/);
    assert.equal(alias.text, root.text);
  });
});

test("runtime page renders owner-language runtime settings panels without action controls or internals", async () => {
  const calls: string[] = [];
  await withServer({
    provider: makeProvider(calls, {
      runtime: {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_runtime_context",
        state: "degraded",
        activeTurns: [
          {
            sessionId: "session-secret-1",
            status: "running",
            summary: "Codex is working from /tmp/private token=abc callback_data=raw messageId=55",
            blockedReason: null
          },
          {
            sessionId: "session-secret-2",
            status: "blocked",
            summary: null,
            blockedReason: "Waiting on safe owner context from /home/ubuntu/private"
          }
        ],
        warnings: ["runtime source unavailable at /sessions/session-secret-1", "telegramChatId=999 messageId=55"]
      }
    }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/runtime`, token);
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["runtime"]);
    for (const copy of [
      "Current operating state",
      "Active conversation/task turns",
      "Settings / access posture",
      "Owner/private",
      "Read-only preview",
      "Denied by default",
      "Actions are not enabled",
      "Degraded",
      "Unavailable",
      "Setup needed"
    ]) {
      assert.match(result.text, new RegExp(escapeRegExp(copy)), `missing runtime owner copy ${copy}: ${result.text}`);
    }
    assert.match(result.text, /Codex is working/);
    assert.match(result.text, /Progress is stopped until required owner interaction is resolved\./);
    assertWebPanelHasNoActionsOrInternals(result.text);
  });
});

test("readiness page renders owner-language capability and access posture without unsafe support claims", async () => {
  const calls: string[] = [];
  await withServer({
    provider: makeProvider(calls, {
      readiness: {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_readiness_guardrails",
        state: "degraded",
        checkedAt: "2026-04-26T00:00:00.000Z",
        activePack: "feishu token=abc /tmp/pack callback_data=raw",
        capabilities: [
          { key: "codex_installed", label: "Codex installed", declared: "present", configured: "present", observed: "present", uxExposed: "missing" },
          { key: "codex_authenticated", label: "Codex authenticated", declared: "present", configured: "missing", observed: "missing", uxExposed: "missing" },
          { key: "app_server", label: "App server", declared: "present", configured: "unknown", observed: "unknown", uxExposed: "missing" },
          { key: "operator_binding", label: "Owner binding", declared: "present", configured: "present", observed: "present", uxExposed: "missing" }
        ],
        missingGates: [
          "setup needed at /home/ubuntu/.codex",
          "messageId=12 callback_data=approve token=secret"
        ],
        warnings: ["telegramChatId=999 /sessions/session-secret-1"]
      }
    }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/readiness`, token);
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["readiness"]);
    for (const copy of [
      "Baseline capability/readiness matrix",
      "Declared",
      "Configured",
      "Observed",
      "UX exposed",
      "Setup / access posture",
      "Owner/private",
      "Denied by default",
      "Read-only preview",
      "Setup needed",
      "not a public support claim",
      "public support is not claimed"
    ]) {
      assert.match(result.text, new RegExp(escapeRegExp(copy)), `missing readiness owner copy ${copy}: ${result.text}`);
    }
    for (const label of ["Codex installed", "Codex authenticated", "App server", "Owner binding"]) {
      assert.match(result.text, new RegExp(escapeRegExp(label)), `missing readiness capability ${label}: ${result.text}`);
    }
    assertWebPanelHasNoActionsOrInternals(result.text);
    assert.equal(result.text.includes("activePack"), false);
    assert.equal(result.text.includes("codex_installed"), false);
  });
});

test("authenticated product home emits safe API-backed shell without raw provider internals", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    const result = await get(`${baseUrl}/`, token);
    assert.equal(result.status, 200);
    assert.ok(calls.includes("workspaces"));
    assert.ok(calls.includes("workspace:wk_safe_1"));
    assert.ok(calls.includes("conversation:cv_1234567890abcdef"));
    assert.match(result.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    for (const marker of [
      "console-mobile-shell",
      "console-project-drawer",
      "console-project-row",
      "console-project-action-archive",
      "console-project-action-new-session",
      "console-session-child",
      "console-chat-timeline",
      "console-command-bar",
      "console-model-selector",
      "console-mode-selector",
      "console-run-card",
      "console-diff-card",
      "console-approval-card",
      "console-composer",
      "data-console-api-root",
      "data-capability-send-message"
    ]) {
      assert.match(result.text, new RegExp(escapeRegExp(marker)), `missing product marker ${marker}: ${result.text}`);
    }
    assert.equal(result.text.includes("<table"), false, `home should use product shell, not primary tables: ${result.text}`);
    assert.equal(result.text.includes("<img"), false);
    for (const forbidden of ["/home/ubuntu/secret", "token=abc", "callback_data", "messageId", "cv_1234567890abcdef", "wk_safe_1", "onclick", "download=", "?token", "href=\"#"]) {
      assert.equal(result.text.includes(forbidden), false, `rendered forbidden raw value ${forbidden}: ${result.text}`);
    }
  });
});

test("home renders chat-first API-backed product shell with drawer and composer", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    const result = await get(`${baseUrl}/`, token);
    assert.equal(result.status, 200);
    assert.ok(calls.length > 0);
    for (const copy of [
      "Codex Console",
      "Console Core",
      "Readonly detail",
      "GPT-5.5",
      "Auto",
      "Online",
      "Message unavailable from Web"
    ]) {
      assert.match(result.text, new RegExp(escapeRegExp(copy)), `missing product shell copy ${copy}: ${result.text}`);
    }
    assert.match(result.text, /role="textbox"[^>]*aria-readonly="true"/);
    assert.match(result.text, /data-console-source="api"/);
    assert.equal(result.text.includes("Current state"), false, `home should not be centered on status metrics: ${result.text}`);
    assert.equal(result.text.includes("Settings / access posture"), false, `home should keep access posture off the landing chat: ${result.text}`);
  });
});

test("home attempts API-backed data and uses explicit empty/degraded state instead of fake prototype", async () => {
  const calls: string[] = [];
  await withServer({
    provider: makeProvider(calls, {
      homeWorkspaces: [],
      homeConversations: [],
      runtime: {
        generatedAt: "2026-04-26T00:00:00.000Z",
        prototypeOnly: true,
        readonly: true,
        pageId: "web_runtime_context",
        state: "available",
        activeTurns: [],
        warnings: []
      }
    }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/`, token);
    assert.equal(result.status, 200);
    assert.ok(calls.includes("workspaces"));
    assert.match(result.text, /data-console-source="api"/);
    for (const copy of ["No live projects yet", "No sessions available", "Message unavailable from Web"]) {
      assert.match(result.text, new RegExp(escapeRegExp(copy)), `missing empty API copy ${copy}: ${result.text}`);
    }
    assert.equal(result.text.includes("acme/web"), false, `empty home should not use demo project: ${result.text}`);
    assert.equal(result.text.includes("Refactor auth middleware"), false, `empty home should not use demo session: ${result.text}`);
  });
});

test("authenticated HTML includes CSP-compatible product shell stylesheet", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    const result = await get(`${baseUrl}/`, token);
    assert.equal(result.status, 200);
    assert.ok(calls.includes("workspaces"));
    assert.match(result.headers.get("content-security-policy") ?? "", /style-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(result.headers.get("content-security-policy") ?? "", /script-src 'sha256-[A-Za-z0-9+/=]+'/);
    assert.match(result.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.equal(result.headers.get("content-security-policy")?.includes("unsafe-inline"), false);
    assert.match(result.text, /<style>\n:root \{/);
    assert.match(result.text, /console-mobile-shell/);
    assert.match(result.text, /grid-template-columns: minmax\(320px, 400px\) minmax\(0, 1fr\)/);
    assert.match(result.text, /min-height: 44px/);
    assert.match(result.text, /@media \(max-width: 720px\)/);
    assert.match(result.text, /\.console-project-drawer \{[\s\S]*?position: fixed;[\s\S]*?transform: translateX/);
    assert.equal(result.text.includes("<link"), false);
    assert.equal(result.text.includes('style="'), false);
  });
});

test("home keeps pending provider internals out of API-backed product surface", async () => {
  const calls: string[] = [];
  const rows: WebReadonlyPendingInteractionViewRow[] = [
    pendingInteractionFixture("pi_home_question", "cv_aaaaaaaaaaaaaaaa", "awaiting_user_input", "question", "Codex needs a product decision."),
    pendingInteractionFixture("pi_home_approval", "cv_bbbbbbbbbbbbbbbb", "pending_approval", "codex_approval", "A safe change needs owner review.")
  ];

  await withServer({
    provider: makeProvider(calls, { homePendingInteractions: rows }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/`, token);
    assert.equal(result.status, 200);
    assert.ok(calls.includes("interactions"));
    assert.match(result.text, /data-console-source="api"/);
    for (const raw of ["pi_home_question", "pi_home_approval", "awaiting_user_input", "pending_approval", "codex_approval", "Codex needs a product decision.", "A safe change needs owner review."]) {
      assert.equal(result.text.includes(raw), false, `home leaked raw pending value ${raw}: ${result.text}`);
    }
  });
});

test("authenticated conversation detail route uses only opaque handles and keeps security headers", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    const result = await get(`${baseUrl}/conversations/cv_1234567890abcdef`, token);
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["conversation:cv_1234567890abcdef"]);
    assert.match(result.text, /Conversation thread/);
    assert.match(result.text, /<h2 id="detail-heading">Readonly detail<\/h2>/);
    assert.match(result.text, /Last updated/);
    assert.match(result.text, /Read-only thread/);
    assert.match(result.text, /Sending from Web is landing next/);
    assert.match(result.text, /role="textbox" aria-readonly="true" aria-disabled="true"/);
    assert.match(result.text, /<section class="console-panel console-result" aria-labelledby="result-heading">/);
    assert.match(result.text, /Result/);
    assert.match(result.text, /No Web-ready final answer has been captured yet\. When Codex finishes with a shareable result, it will appear in this panel\./);
    assert.match(result.text, /Needs attention/);
    assert.match(result.text, /Runtime/);
    assert.match(result.text, /Readiness/);
    assert.match(result.text, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(result.text, /Readonly detail/);
    assert.equal(result.text.includes("/sessions/"), false);
    assert.equal(result.text.includes("session-1"), false);
    for (const forbidden of [token, "/home/ubuntu/secret", "callback_data", "messageId", "<form", "<button", "<input", "<textarea", "method=\"post\"", "action=", "onclick", "download=", "?token", "href=\"#"]) {
      assert.equal(result.text.includes(forbidden), false, `detail leaked ${forbidden}: ${result.text}`);
    }
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.match(result.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.match(result.headers.get("content-type") ?? "", /^text\/html; charset=utf-8/);
  });
});

test("authenticated conversation detail renders available final-answer body escaped and readable", async () => {
  const calls: string[] = [];
  await withServer({
    provider: makeProvider(calls, {
      detailAnswers: [
        {
          answerId: "answer-safe",
          kind: "final_answer",
          deliveryState: "delivered",
          createdAt: "2026-04-25T12:10:00.000Z",
          body: {
            state: "available",
            text: "Useful result:\n- Render <result> & \"details\" safely."
          },
          summary: "Final answer body was provided by a Web-safe source."
        }
      ]
    }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/conversations/cv_1234567890abcdef`, token);
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["conversation:cv_1234567890abcdef"]);
    assert.match(result.text, /<pre class="console-result-body">Useful result:/);
    assert.match(result.text, /Render &lt;result&gt; &amp; &quot;details&quot; safely\./);
    assert.equal(result.text.includes("<result>"), false);
    assert.equal(result.text.includes("Final answer body unavailable"), false);
  });
});

test("authenticated conversation detail explains rejected final-answer body source", async () => {
  const calls: string[] = [];
  await withServer({
    provider: makeProvider(calls, {
      detailAnswers: [
        {
          answerId: "answer-unsafe",
          kind: "final_answer",
          deliveryState: "delivered",
          createdAt: "2026-04-25T12:10:00.000Z",
          body: { state: "unavailable", reason: "unsafe_final_answer_body" },
          summary: "Final answer body was rejected by the Web safety filter."
        }
      ]
    }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/conversations/cv_1234567890abcdef`, token);
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["conversation:cv_1234567890abcdef"]);
    assert.match(result.text, /This result is available in the bridge conversation, but it is not shown in the Web preview yet\./);
    assert.equal(result.text.includes("Web safety filter"), false);
    assert.equal(result.text.includes("<table"), false);
  });
});

test("authenticated pending interactions route renders read-only owner attention cards by status without action controls", async () => {
  const calls: string[] = [];
  const rows: WebReadonlyPendingInteractionViewRow[] = [
    pendingInteractionFixture("pi_pending_question", "cv_aaaaaaaaaaaaaaaa", "awaiting_user_input", "question", "Codex needs a product decision."),
    pendingInteractionFixture("pi_pending_approval", "cv_bbbbbbbbbbbbbbbb", "pending_approval", "codex_approval", "A safe change needs owner review."),
    pendingInteractionFixture("pi_resolved", "cv_cccccccccccccccc", "resolved", "question", "The owner interaction was resolved."),
    pendingInteractionFixture("pi_expired", "cv_dddddddddddddddd", "expired", "question", "This prompt is no longer current."),
    pendingInteractionFixture("pi_stale", "cv_eeeeeeeeeeeeeeee", "stale", "approval", "The visible state may be stale."),
    pendingInteractionFixture("pi_duplicate", "cv_ffffffffffffffff", "duplicate", "question", "A newer owner prompt replaced this one."),
    pendingInteractionFixture("pi_failed", "cv_1111111111111111", "failed", "interaction", "The pending item could not be read safely."),
    pendingInteractionFixture("pi_unavailable", "cv_2222222222222222", "source_unavailable", "interaction", null, "unavailable")
  ];

  await withServer({
    provider: makeProvider(calls, { pendingInteractions: rows }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/interactions`, token);
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["interactions"]);
    assert.match(result.text, /Pending\/Approvals/);
    assert.match(result.text, /Responses are not enabled in this preview\./);
    for (const heading of ["Needs owner attention", "Resolved or duplicate", "Stale or expired", "Unavailable or failed"]) {
      assert.match(result.text, new RegExp(`<h3>${escapeRegExp(heading)}</h3>`), `missing pending group ${heading}: ${result.text}`);
    }
    for (const label of ["Needs answer", "Approval needed", "Resolved", "Expired", "Stale", "Duplicate", "Failed", "Unavailable"]) {
      assert.match(result.text, new RegExp(`class="console-badge">${escapeRegExp(label)}</span>`), `missing pending label ${label}: ${result.text}`);
    }
    for (const copy of [
      "Codex asked a question; responses are not enabled in this preview.",
      "Codex requested an approval; responses are not enabled in this preview.",
      "This owner interaction is already resolved; no Web action is available.",
      "This owner interaction expired or is no longer current; refresh or use the current bridge chat if needed.",
      "This owner interaction may be stale; refresh before relying on it.",
      "This owner interaction appears to duplicate another item; use the current item in the bridge chat if needed.",
      "This owner interaction could not be read safely; use the current bridge chat if needed.",
      "Pending interaction data is unavailable from the safe reader."
    ]) {
      assert.match(result.text, new RegExp(escapeRegExp(copy)), `missing pending copy ${copy}: ${result.text}`);
    }
    assert.match(result.text, /href="\/conversations\/cv_aaaaaaaaaaaaaaaa"/);
    assert.match(result.text, /href="\/conversations\/cv_bbbbbbbbbbbbbbbb"/);
    assertPendingSurfaceHasNoActionsOrInternals(result.text);
    for (const raw of ["awaiting_user_input", "pending_approval", "source_unavailable", "codex_approval", "pi_pending_question", "pi_pending_approval"]) {
      assert.equal(result.text.includes(raw), false, `raw pending value leaked ${raw}: ${result.text}`);
    }
  });
});

test("conversation detail pending panel shares read-only pending cards and action-disabled copy", async () => {
  const calls: string[] = [];
  const rows: WebReadonlyPendingInteractionViewRow[] = [
    pendingInteractionFixture("pi_detail_question", "cv_1234567890abcdef", "awaiting_user_input", "question", "Codex needs a sizing answer.")
  ];

  await withServer({
    provider: makeProvider(calls, { detailPendingInteractions: rows }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/conversations/cv_1234567890abcdef`, token);
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["conversation:cv_1234567890abcdef"]);
    assert.match(result.text, /Needs attention/);
    assert.match(result.text, /Needs owner attention/);
    assert.match(result.text, /Codex needs a sizing answer\./);
    assert.match(result.text, /Codex asked a question; responses are not enabled in this preview\./);
    assert.match(result.text, /Responses are not enabled in this preview\./);
    assertPendingSurfaceHasNoActionsOrInternals(result.text);
    assert.equal(result.text.includes("pi_detail_question"), false, `raw pending id leaked: ${result.text}`);
  });
});

test("home and detail expose composer enabled only when write capability is available", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    for (const path of ["/", "/chat", "/conversations/cv_1234567890abcdef"]) {
      const result = await get(`${baseUrl}${path}`, token);
      assert.equal(result.status, 200, path);
      assert.match(result.text, /aria-readonly="true"/);
      if (path.startsWith("/conversations/")) {
        assert.match(result.text, /Sending from Web is landing next/);
        assert.match(result.text, /aria-disabled="true"/);
        assert.equal(result.text.toLowerCase().includes("/api/sessions/"), false, `${path} exposed API send without capability`);
      } else {
        assert.match(result.text, /Message unavailable from Web/);
        assert.match(result.text, /data-capability-send-message="disabled"/);
        assert.match(result.text, /console-composer/);
        assert.equal(result.text.toLowerCase().includes("data-console-send-form"), false, `${path} exposed enabled send form`);
      }
    }
  });
});

test("send capability enables only the safe text composer with opaque conversation action and csrf", async () => {
  const calls: string[] = [];
  const submitted: unknown[] = [];
  await withServer({
    provider: makeProvider(calls),
    access: createReadonlyAccessGate({ enabled: true, token }),
    send: {
      csrfToken: "csrf-safe-token",
      submitTextMessage: (request) => {
        submitted.push(request);
        return { status: "accepted" };
      }
    }
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/conversations/cv_1234567890abcdef`, token);
    assert.equal(result.status, 200);
    assert.match(result.text, /<form method="post" action="\/conversations\/cv_1234567890abcdef\/messages">/);
    assert.match(result.text, /name="_csrf" value="csrf-safe-token"/);
    assert.match(result.text, /<textarea[^>]*name="message"[^>]*maxlength="8000"[^>]*required/);
    assert.match(result.text, /<button type="submit">Send message<\/button>/);
    assert.equal(result.text.includes("session-1"), false);
    assert.equal(result.text.includes("chat-secret"), false);
    assert.equal(result.headers.get("content-security-policy")?.includes("form-action 'self'"), true);
    assert.deepEqual(submitted, []);
  });
});

test("accepted and running conversation states expose safe refresh affordance", async () => {
  const calls: string[] = [];
  await withServer({
    provider: makeProvider(calls, { detailStatus: "running" }),
    access: createReadonlyAccessGate({ enabled: true, token }),
    send: {
      csrfToken: "csrf-safe-token",
      submitTextMessage: () => ({ status: "accepted" })
    }
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/conversations/cv_1234567890abcdef?send=accepted`, token);
    assert.equal(result.status, 200);
    assert.match(result.text, /Message accepted/);
    assert.match(result.text, /Codex is running/);
    assert.match(result.text, /href="\/conversations\/cv_1234567890abcdef"/);
    assert.match(result.text, /Refresh thread/);
    for (const forbidden of [token, "session-1", "chat-secret", "/tmp/", "/home/", "thread-1", "turn-1", "stack"]) {
      assert.equal(result.text.includes(forbidden), false, `refresh affordance leaked ${forbidden}`);
    }
  });
});

test("Console API send wiring is disabled without Web submit dependency and live when submit exists", async () => {
  const calls: string[] = [];
  const provider = makeProvider(calls, {
    homeWorkspaces: [
      {
        workspaceId: "wk_safe_1",
        label: "Console Core",
        availability: "available",
        conversationCount: 1,
        pinned: true,
        lastActivityAt: "2026-04-25T12:00:00.000Z",
        lastSuccessAt: null,
        source: "recent"
      }
    ],
    workspaceConversations: [
      {
        conversationId: "cv_1234567890abcdef",
        conversationHandle: "cv_1234567890abcdef",
        workspaceId: "wk_safe_1",
        title: "Readonly detail",
        status: "completed",
        failureReason: null,
        archived: false,
        createdAt: "2026-04-25T10:00:00.000Z",
        lastActivityAt: "2026-04-25T12:00:00.000Z",
        lastTurnStatus: "completed",
        finalAnswerAvailable: true
      }
    ]
  });

  await withServer({
    provider,
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const bootstrap = JSON.parse((await get(`${baseUrl}/api/console/bootstrap`, token)).text);
    assert.equal(bootstrap.capabilities.sendMessage.state, "disabled");

    const sessionId = bootstrap.activeSessionId;
    assert.ok(sessionId);
    const disabled = await post(`${baseUrl}/api/sessions/${sessionId}/messages`, token, JSON.stringify({ text: "hello" }), {
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-safe-token",
      Accept: "application/json"
    });
    assert.equal(disabled.status, 409);
    assert.equal(JSON.parse(disabled.text).capability, "sendMessage");
  });

  const submitted: unknown[] = [];
  await withServer({
    provider: makeProvider([], {
      homeWorkspaces: [
        {
          workspaceId: "wk_safe_1",
          label: "Console Core",
          availability: "available",
          conversationCount: 1,
          pinned: true,
          lastActivityAt: "2026-04-25T12:00:00.000Z",
          lastSuccessAt: null,
          source: "recent"
        }
      ]
    }),
    access: createReadonlyAccessGate({ enabled: true, token }),
    send: {
      csrfToken: "csrf-safe-token",
      submitTextMessage: (request) => {
        submitted.push(request);
        return { status: "accepted" };
      }
    }
  }, async (baseUrl) => {
    const bootstrap = JSON.parse((await get(`${baseUrl}/api/console/bootstrap`, token)).text);
    assert.equal(bootstrap.capabilities.sendMessage.state, "enabled");
    assert.equal(bootstrap.capabilities.archiveProject.state, "disabled");
    assert.equal(bootstrap.capabilities.createSession.state, "disabled");
    assert.equal(bootstrap.capabilities.answerApproval.state, "disabled");

    const sessionId = bootstrap.activeSessionId;
    assert.ok(sessionId);
    const result = await post(`${baseUrl}/api/sessions/${sessionId}/messages`, token, JSON.stringify({ text: " hello from Console " }), {
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-safe-token",
      Accept: "application/json"
    });
    const body = JSON.parse(result.text);

    assert.equal(result.status, 202);
    assert.equal(body.accepted, true);
    assert.equal(body.sessionId, sessionId);
    assert.equal(body.message.text, "hello from Console");
    assert.equal(body.message.status, "pending");
    assert.deepEqual(submitted, [{
      conversationHandle: "cv_1234567890abcdef",
      text: "hello from Console",
      nonce: null
    }]);
    for (const forbidden of ["cv_1234567890abcdef", "session-1", "chat-secret", "thread-1", "token="]) {
      assert.equal(result.text.includes(forbidden), false, `Console send leaked ${forbidden}: ${result.text}`);
    }
  });
});

test("authenticated API product home enables composer only when live Console send route is available", async () => {
  const disabledCalls: string[] = [];
  await withServer({
    provider: makeProvider(disabledCalls),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/`, token);
    assert.equal(result.status, 200);
    assert.match(result.text, /data-console-source="api"/);
    assert.match(result.text, /data-capability-send-message="disabled"/);
    assert.match(result.text, /Message unavailable from Web/);
    assert.match(result.text, /Console Bridge read adapter is read-only in this phase\./);
    assert.doesNotMatch(result.text, /data-console-send-form/);
    assert.doesNotMatch(result.text, /\/api\/sessions\/[^"]+\/messages/);
  });

  const submitted: unknown[] = [];
  await withServer({
    provider: makeProvider([]),
    access: createReadonlyAccessGate({ enabled: true, token }),
    send: {
      csrfToken: "csrf-safe-token",
      submitTextMessage: (request) => {
        submitted.push(request);
        return { status: "accepted" };
      }
    }
  }, async (baseUrl) => {
    const home = await get(`${baseUrl}/`, token);
    assert.equal(home.status, 200);
    assert.match(home.text, /data-console-source="api"/);
    assert.match(home.text, /<form class="console-composer"[^>]*data-console-send-form/);
    assert.match(home.text, /data-capability-send-message="enabled"/);
    assert.match(home.text, /name="_csrf" value="csrf-safe-token"/);
    const action = /action="(\/api\/sessions\/(ses_[A-Za-z0-9_-]{6,128})\/messages)"/.exec(home.text);
    assert.ok(action, `missing opaque API send action: ${home.text}`);
    assert.doesNotMatch(home.text, /Message unavailable from Web/);
    for (const disabledControl of [
      'class="console-project-action-archive"[^>]*data-capability-state="disabled"',
      'class="console-project-action-new-session"[^>]*data-capability-state="disabled"',
      'Review unavailable',
      'Open files unavailable'
    ]) {
      assert.match(home.text, new RegExp(disabledControl), `missing disabled control ${disabledControl}: ${home.text}`);
    }
    for (const forbidden of ["cv_1234567890abcdef", "wk_safe_1", token, "token=", "callback_data", "messageId", "/tmp/", "/home/", "telegram", "http://127.0.0.1"]) {
      assert.equal(home.text.includes(forbidden), false, `home leaked ${forbidden}: ${home.text}`);
    }

    const posted = await post(`${baseUrl}${action[1]}`, token, JSON.stringify({ text: " hello from home " }), {
      "Content-Type": "application/json",
      "X-CSRF-Token": "csrf-safe-token",
      Accept: "application/json"
    });
    assert.equal(posted.status, 202);
    const body = JSON.parse(posted.text);
    assert.equal(body.accepted, true);
    assert.equal(body.sessionId, action[2]);
    assert.equal(body.message.text, "hello from home");
    assert.deepEqual(submitted, [{
      conversationHandle: "cv_1234567890abcdef",
      text: "hello from home",
      nonce: null
    }]);
    for (const forbidden of ["cv_1234567890abcdef", "wk_safe_1", token, "token=", "callback_data", "/tmp/", "/home/", "telegram"]) {
      assert.equal(posted.text.includes(forbidden), false, `send response leaked ${forbidden}: ${posted.text}`);
    }
  });
});

test("POST message denies unauthorized, CSRF-denied, invalid handle, blank, and oversize without submit", async () => {
  const calls: string[] = [];
  const submitted: unknown[] = [];
  await withServer({
    provider: makeProvider(calls),
    access: createReadonlyAccessGate({ enabled: true, token }),
    send: {
      csrfToken: "csrf-safe-token",
      submitTextMessage: (request) => {
        submitted.push(request);
        return { status: "accepted" };
      }
    }
  }, async (baseUrl) => {
    const validPath = `${baseUrl}/conversations/cv_1234567890abcdef/messages`;
    const unauthorized = await post(validPath, undefined, "_csrf=csrf-safe-token&message=hello", {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    });
    assert.equal(unauthorized.status, 404);
    const wrongBearer = await post(validPath, "wrong-token", "_csrf=csrf-safe-token&message=hello", {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    });
    assert.equal(wrongBearer.status, 404);
    const missingCsrf = await post(validPath, token, "message=hello", {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    });
    assert.equal(missingCsrf.status, 400);
    assert.deepEqual(JSON.parse(missingCsrf.text), { status: "invalid" });
    const wrongCsrfHeader = await post(validPath, token, "_csrf=csrf-safe-token&message=hello", {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": "wrong-token",
      Accept: "application/json"
    });
    assert.equal(wrongCsrfHeader.status, 403);
    assert.deepEqual(JSON.parse(wrongCsrfHeader.text), { status: "denied" });
    const wrongOrigin = await post(validPath, token, "_csrf=csrf-safe-token&message=hello", {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://evil.example.test",
      Host: "owner.example.test",
      Accept: "application/json"
    });
    assert.equal(wrongOrigin.status, 403);
    assert.deepEqual(JSON.parse(wrongOrigin.text), { status: "denied" });
    const invalidHandle = await post(`${baseUrl}/conversations/session-1/messages`, token, "_csrf=csrf-safe-token&message=hello", {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    });
    assert.equal(invalidHandle.status, 404);
    assert.equal(invalidHandle.text.includes("session-1"), false);
    const blank = await post(validPath, token, "_csrf=csrf-safe-token&message=%20%20", {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    });
    assert.equal(blank.status, 400);
    const oversize = await post(validPath, token, `_csrf=csrf-safe-token&message=${"a".repeat(8001)}`, {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    });
    assert.equal(oversize.status, 400);
    const attachment = await post(validPath, token, JSON.stringify({ _csrf: "csrf-safe-token", message: "hello", attachments: [] }), {
      "Content-Type": "application/json",
      Accept: "application/json"
    });
    assert.equal(attachment.status, 400);
    assert.deepEqual(submitted, []);
  });
});

test("POST message invokes submit dependency once and returns safe redirect or JSON outcome", async () => {
  const calls: string[] = [];
  const submitted: unknown[] = [];
  await withServer({
    provider: makeProvider(calls),
    access: createReadonlyAccessGate({ enabled: true, token }),
    send: {
      csrfToken: "csrf-safe-token",
      submitTextMessage: (request) => {
        submitted.push(request);
        return { status: "accepted" };
      }
    }
  }, async (baseUrl) => {
    const html = await post(`${baseUrl}/conversations/cv_1234567890abcdef/messages`, token, "_csrf=csrf-safe-token&message=%20hello%20&nonce=nonce-1", {
      "Content-Type": "application/x-www-form-urlencoded"
    });
    assert.equal(html.status, 303);
    assert.equal(html.headers.get("location"), "/conversations/cv_1234567890abcdef?send=accepted");
    assert.equal(html.text, "");
    assert.deepEqual(submitted, [{
      conversationHandle: "cv_1234567890abcdef",
      text: "hello",
      nonce: "nonce-1"
    }]);
    assert.equal(JSON.stringify({ headers: Object.fromEntries(html.headers), body: html.text }).includes("session-1"), false);

    const json = await post(`${baseUrl}/conversations/cv_1234567890abcdef/messages`, token, JSON.stringify({ _csrf: "csrf-safe-token", text: "from json" }), {
      "Content-Type": "application/json",
      Accept: "application/json"
    });
    assert.equal(json.status, 202);
    assert.deepEqual(JSON.parse(json.text), { status: "accepted" });
    assert.deepEqual(submitted.at(-1), {
      conversationHandle: "cv_1234567890abcdef",
      text: "from json",
      nonce: null
    });
  });
});

test("POST message maps blocked, missing, archived, or unavailable submit outcomes safely", async () => {
  const calls: string[] = [];
  const statuses = ["blocked", "rejected", "unavailable"] as const;
  for (const status of statuses) {
    await withServer({
      provider: makeProvider(calls),
      access: createReadonlyAccessGate({ enabled: true, token }),
      send: {
        csrfToken: "csrf-safe-token",
        submitTextMessage: () => ({ status })
      }
    }, async (baseUrl) => {
      const result = await post(`${baseUrl}/conversations/cv_1234567890abcdef/messages`, token, "_csrf=csrf-safe-token&message=hello", {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      });
      assert.equal(result.status, status === "blocked" ? 409 : status === "unavailable" ? 503 : 400);
      assert.deepEqual(JSON.parse(result.text), { status });
      for (const forbidden of [token, "session-1", "chat-secret", "/home/", "/tmp/", "thread", "turn", "stack"]) {
        assert.equal(result.text.includes(forbidden), false, `${status} leaked ${forbidden}: ${result.text}`);
      }
    });
  }
});

test("home recent live conversations render through API model without raw state enums or handles", async () => {
  const calls: string[] = [];
  const rows: WebReadonlyConversationRow[] = [
    conversationFixture("cv_aaaaaaaaaaaaaaaa", "Answer product question", "pending_question", false),
    conversationFixture("cv_bbbbbbbbbbbbbbbb", "Approve safe change", "pending_approval", false),
    conversationFixture("cv_cccccccccccccccc", "Blocked on owner input", "blocked", false),
    conversationFixture("cv_dddddddddddddddd", "Run implementation", "running", false),
    conversationFixture("cv_eeeeeeeeeeeeeeee", "Finished slice", "completed", true),
    conversationFixture("cv_ffffffffffffffff", "Failed check", "failed", false),
    conversationFixture("cv_1111111111111111", "Partial state", "degraded", false),
    conversationFixture("cv_2222222222222222", "Unknown state", "source_unknown", false)
  ];

  await withServer({
    provider: makeProvider(calls, { workspaceConversations: rows }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/`, token);
    assert.equal(result.status, 200);
    assert.ok(calls.includes("workspace:wk_safe_1"));
    assert.match(result.text, /Answer product question/);
    assert.match(result.text, /data-console-api-root="\/api"/);
    for (const raw of ["pending_question", "pending_approval", "source_unknown", "cv_aaaaaaaaaaaaaaaa"]) {
      assert.equal(result.text.includes(raw), false, `live conversation value leaked ${raw}: ${result.text}`);
    }
  });
});

test("workspace conversation list groups mixed states without exposing raw state enums", async () => {
  const calls: string[] = [];
  const rows: WebReadonlyConversationRow[] = [
    conversationFixture("cv_aaaaaaaaaaaaaaaa", "Needs approval", "pending_approval", false),
    conversationFixture("cv_bbbbbbbbbbbbbbbb", "Running task", "running", false),
    conversationFixture("cv_cccccccccccccccc", "Completed task", "done", true),
    conversationFixture("cv_dddddddddddddddd", "Unknown task", "state_unknown", false)
  ];

  await withServer({
    provider: makeProvider(calls, { workspaceConversations: rows }),
    access: createReadonlyAccessGate({ enabled: true, token })
  }, async (baseUrl) => {
    const result = await get(`${baseUrl}/workspaces/wk_safe_1/conversations`, token);
    assert.equal(result.status, 200);
    assert.deepEqual(calls, ["workspace:wk_safe_1"]);
    for (const heading of ["Needs attention", "Running now", "Recently completed", "Other/Older"]) {
      assert.match(result.text, new RegExp(`<h3>${heading}</h3>`), `missing grouped heading ${heading}: ${result.text}`);
    }
    assert.match(result.text, /Running/);
    assert.match(result.text, /Done/);
    assert.match(result.text, /Unavailable/);
    assert.match(result.text, /The current state is unavailable or unknown from the safe reader\./);
    for (const raw of ["pending_approval", "state_unknown"]) {
      assert.equal(result.text.includes(raw), false, `raw state leaked ${raw}: ${result.text}`);
    }
  });
});

test("raw session and unsafe conversation route parts are generic 404s", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    for (const path of [
      "/sessions/session-1",
      "/sessions/session-1/artifacts",
      "/conversations/session-1",
      "/conversations/cv_1234567890abcdeg",
      "/conversations/%2Ftmp%2Fsecret",
      "/workspaces/%2Ftmp%2Fsecret/conversations"
    ]) {
      const result = await get(`${baseUrl}${path}`, token);
      assert.equal(result.status, 404, path);
      assert.match(result.text, /Not found/);
      assert.equal(result.text.includes("session-1"), false);
      assert.equal(result.text.includes("/tmp/secret"), false);
    }
    assert.deepEqual(calls, []);
  });
});

function conversationFixture(
  handle: string,
  title: string,
  status: string,
  finalAnswerAvailable: boolean
): WebReadonlyConversationRow {
  return {
    conversationId: handle,
    conversationHandle: handle,
    workspaceId: "wk_safe_1",
    title,
    status,
    failureReason: null,
    archived: false,
    createdAt: "2026-04-25T10:00:00.000Z",
    lastActivityAt: "2026-04-25T12:00:00.000Z",
    lastTurnStatus: status,
    finalAnswerAvailable
  };
}

function pendingInteractionFixture(
  interactionId: string,
  conversationId: string,
  status: string,
  kind: string,
  summaryText: string | null,
  availability: "available" | "unavailable" | "degraded" = "available"
): WebReadonlyPendingInteractionViewRow {
  return {
    interactionId,
    conversationId,
    sessionId: null,
    status,
    kind,
    createdAt: "2026-04-25T10:00:00.000Z",
    updatedAt: "2026-04-25T10:05:00.000Z",
    blockingReason: "Safe owner attention state.",
    summary: summaryText
      ? { state: "available", text: summaryText }
      : { state: "unavailable", reason: "pending_interaction_summary_not_provided" },
    availability,
    warnings: []
  };
}

function disabledComposerFixture() {
  return {
    state: "disabled" as const,
    label: "Message Codex",
    placeholder: "Type a message to Codex",
    disabledReason: "Sending from Web is landing next.",
    capability: "web_send_landing_next" as const
  };
}

function assertPendingSurfaceHasNoActionsOrInternals(html: string): void {
  const lower = html.toLowerCase();
  for (const forbidden of [
    "<form",
    "<button",
    "<input",
    "<textarea",
    "method=\"post\"",
    "action=",
    "form-action",
    "onclick",
    "callback_data",
    "callback:",
    "messageid",
    "platformmessageid",
    "telegramchatid",
    "feishuchatid",
    "token=",
    "?token",
    "/tmp/",
    "/home/",
    "/sessions/",
    "/approval-answer",
    "/question-answer",
    "/submit",
    "/interrupt"
  ]) {
    assert.equal(lower.includes(forbidden), false, `pending surface leaked forbidden content ${forbidden}: ${html}`);
  }
}

function assertWebPanelHasNoActionsOrInternals(html: string): void {
  const lower = html.toLowerCase();
  for (const forbidden of [
    token,
    "<form",
    "<button",
    "<input",
    "<textarea",
    "method=\"post\"",
    "action=",
    "onclick",
    "download=",
    "?token",
    "/tmp",
    "/home",
    "/sessions/",
    "callback_data",
    "callback:",
    "messageid",
    "platformmessageid",
    "telegramchatid",
    "feishuchatid",
    "chatid",
    "threadid",
    "session-secret",
    "raw platform",
    "/approval-answer",
    "/question-answer",
    "/submit",
    "/interrupt",
    " submit ",
    " approve ",
    " answer ",
    " interrupt "
  ]) {
    assert.equal(lower.includes(forbidden), false, `surface leaked forbidden content ${forbidden}: ${html}`);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("state responses include no-store, CSP, nosniff, and HTML charset headers", async () => {
  const calls: string[] = [];
  await withServer({ provider: makeProvider(calls), access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    const result = await get(`${baseUrl}/workspaces`, token);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.match(result.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
    assert.match(result.headers.get("content-type") ?? "", /^text\/html; charset=utf-8/);
  });
});

test("unknown route and provider error are generic without stack traces", async () => {
  const calls: string[] = [];
  const provider = {
    ...makeProvider(calls),
    getRuntimeContextViewModel() {
      calls.push("runtime");
      throw new Error("boom stack secret /tmp/secret-store messageId=123");
    }
  };
  await withServer({ provider, access: createReadonlyAccessGate({ enabled: true, token }) }, async (baseUrl) => {
    const unknown = await get(`${baseUrl}/unknown`, token);
    assert.equal(unknown.status, 404);
    assert.match(unknown.text, /Not found/);
    assert.deepEqual(calls, []);

    const errored = await get(`${baseUrl}/runtime`, token);
    assert.equal(errored.status, 500);
    assert.deepEqual(calls, ["runtime"]);
    assert.match(errored.text, /Temporarily unavailable/);
    for (const forbidden of ["boom", "secret", "/tmp/secret-store", "messageId", "Error:"]) {
      assert.equal(errored.text.includes(forbidden), false, `error leaked ${forbidden}: ${errored.text}`);
    }
  });
});
