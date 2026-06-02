import test from "node:test";
import assert from "node:assert/strict";

import { createConsoleProductApiModel } from "./console-product-api-model.js";
import { renderConsoleProductHomePage } from "./console-product-renderer.js";
import type { ConsoleBootstrap, ConsoleSessionDetail, ConsoleSessionSummary } from "./console-api-contract.js";

const bootstrap: ConsoleBootstrap = {
  apiVersion: "2026-05-01.phase3",
  generatedAt: "2026-05-01T00:00:00.000Z",
  viewer: { role: "owner", displayName: "Workspace owner" },
  capabilities: {
    archiveProject: { state: "disabled", reason: "Archive is not wired." },
    createSession: { state: "disabled", reason: "New sessions are not wired." },
    sendMessage: { state: "disabled", reason: "Text send is disabled." },
    answerApproval: { state: "disabled", reason: "Approvals are not wired." },
    uploadFiles: { state: "disabled", reason: "Uploads are disabled." },
    streamEvents: { state: "enabled" },
    fetchArtifacts: { state: "enabled" }
  },
  projects: [
    {
      projectId: "prj_aLiveProject1230",
      title: "Console Core",
      branch: "main",
      hint: "Pinned",
      archived: false,
      sessionCount: 1,
      activeSessionId: "ses_aLiveSession1230",
      lastActivityAt: "2026-04-30T12:00:00.000Z"
    }
  ],
  activeProjectId: "prj_aLiveProject1230",
  activeSessionId: "ses_aLiveSession1230",
  commands: [{ name: "/status", label: "Status", enabled: true }],
  models: [{ value: "gpt-5.5", label: "GPT-5.5", enabled: true }],
  modes: [{ value: "auto", label: "Auto", enabled: true }],
  degradedStates: []
};

const sessionSummary: ConsoleSessionSummary = {
  sessionId: "ses_aLiveSession1230",
  projectId: "prj_aLiveProject1230",
  title: "Implement live UI",
  status: "completed",
  archived: false,
  createdAt: "2026-04-30T11:00:00.000Z",
  lastActivityAt: "2026-04-30T12:00:00.000Z",
  lastMessagePreview: "Final answer available.",
  pendingApprovalCount: 0,
  artifactCount: 1
};

const detail: ConsoleSessionDetail = {
  ...sessionSummary,
  messages: [
    {
      messageId: "msg_aUserMessage1230",
      sessionId: "ses_aLiveSession1230",
      role: "user",
      text: "Please wire the product UI to live data.",
      format: "plain_text",
      status: "complete",
      createdAt: "2026-04-30T11:10:00.000Z"
    },
    {
      messageId: "msg_aAssistant1230",
      sessionId: "ses_aLiveSession1230",
      role: "assistant",
      text: "Live Console data is now visible.",
      format: "plain_text",
      status: "complete",
      createdAt: "2026-04-30T11:11:00.000Z"
    }
  ],
  diffs: [
    {
      sessionId: "ses_aLiveSession1230",
      title: "UI changes",
      status: "preview",
      totals: { changedFiles: 1, added: 2, removed: 1 },
      files: [{ displayName: "Console UI", status: "modified", added: 2, removed: 1 }]
    }
  ],
  approvals: [],
  artifacts: [
    {
      artifactId: "art_aSummary1230",
      sessionId: "ses_aLiveSession1230",
      kind: "run_summary",
      status: "ready",
      title: "Run summary",
      displayName: "Run summary",
      url: "/api/artifacts/art_aSummary1230",
      files: [{ displayName: "Run summary", status: "generated" }]
    }
  ],
  eventsUrl: "/api/sessions/ses_aLiveSession1230/events"
};

test("API product model renders live projects, sessions, disabled controls, and no raw Bridge ids", () => {
  const model = createConsoleProductApiModel({
    bootstrap,
    projectSessions: new Map([["prj_aLiveProject1230", [sessionSummary]]]),
    activeSessionDetail: detail
  });
  const html = renderConsoleProductHomePage(model);

  for (const copy of [
    "Console Core",
    "Implement live UI",
    "Please wire the product UI to live data.",
    "Live Console data is now visible.",
    "Archive",
    "+ New",
    "Review unavailable",
    "Message unavailable from Web"
  ]) {
    assert.match(html, new RegExp(escapeRegExp(copy)), `missing ${copy}: ${html}`);
  }
  for (const marker of [
    'data-console-api-root="/api"',
    'data-console-session-id="ses_aLiveSession1230"',
    'data-capability-send-message="disabled"',
    'data-capability-state="disabled"'
  ]) {
    assert.match(html, new RegExp(escapeRegExp(marker)), `missing marker ${marker}: ${html}`);
  }
  for (const forbidden of ["cv_1234567890abcdef", "wk_safe_1", "telegram", "callback_data", "token="]) {
    assert.equal(html.includes(forbidden), false, `leaked forbidden ${forbidden}: ${html}`);
  }
});

test("API product model enables text send form only when sendMessage and CSRF are available", () => {
  const enabledBootstrap: ConsoleBootstrap = {
    ...bootstrap,
    capabilities: {
      ...bootstrap.capabilities,
      sendMessage: { state: "enabled" }
    }
  };
  const model = createConsoleProductApiModel({
    bootstrap: enabledBootstrap,
    projectSessions: new Map([["prj_aLiveProject1230", [sessionSummary]]]),
    activeSessionDetail: detail,
    csrfToken: "csrf-safe-token"
  });
  const html = renderConsoleProductHomePage(model);

  assert.match(html, /<form class="console-composer"[^>]*data-console-send-form/);
  assert.match(html, /action="\/api\/sessions\/ses_aLiveSession1230\/messages"/);
  assert.match(html, /name="_csrf" value="csrf-safe-token"/);
  assert.match(html, /<textarea[^>]*name="text"[^>]*maxlength="8000"[^>]*required/);
  assert.match(html, /data-capability-send-message="enabled"/);
});

test("API product model keeps send disabled unless capability and CSRF are supplied", () => {
  const enabledBootstrap: ConsoleBootstrap = {
    ...bootstrap,
    capabilities: {
      ...bootstrap.capabilities,
      sendMessage: { state: "enabled" }
    }
  };

  const missingCsrfModel = createConsoleProductApiModel({
    bootstrap: enabledBootstrap,
    projectSessions: new Map([["prj_aLiveProject1230", [sessionSummary]]]),
    activeSessionDetail: detail
  });
  const missingCsrfHtml = renderConsoleProductHomePage(missingCsrfModel);
  assert.match(missingCsrfHtml, /data-capability-send-message="disabled"/);
  assert.match(missingCsrfHtml, /Console write capability requires CSRF protection\./);
  assert.doesNotMatch(missingCsrfHtml, /data-console-send-form/);
  assert.doesNotMatch(missingCsrfHtml, /action="\/api\/sessions\/ses_aLiveSession1230\/messages"/);

  const disabledModel = createConsoleProductApiModel({
    bootstrap,
    projectSessions: new Map([["prj_aLiveProject1230", [sessionSummary]]]),
    activeSessionDetail: detail,
    csrfToken: "csrf-safe-token"
  });
  const disabledHtml = renderConsoleProductHomePage(disabledModel);
  assert.match(disabledHtml, /data-capability-send-message="disabled"/);
  assert.match(disabledHtml, /Text send is disabled\./);
  assert.doesNotMatch(disabledHtml, /data-console-send-form/);
});

test("API product model accepts a narrow safe send capability override from server options", () => {
  const model = createConsoleProductApiModel({
    bootstrap,
    projectSessions: new Map([["prj_aLiveProject1230", [sessionSummary]]]),
    activeSessionDetail: detail,
    csrfToken: "csrf-safe-token",
    capabilityOverrides: {
      sendMessage: { state: "enabled" }
    }
  });
  const html = renderConsoleProductHomePage(model);

  assert.match(html, /data-capability-send-message="enabled"/);
  assert.match(html, /data-console-send-form/);
  assert.match(html, /action="\/api\/sessions\/ses_aLiveSession1230\/messages"/);
  assert.equal(html.includes("cv_1234567890abcdef"), false);
  assert.equal(html.includes("token="), false);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
