import test from "node:test";
import assert from "node:assert/strict";

import { createConsoleProductMock } from "./console-product-mock.js";
import { renderConsoleProductHomePage } from "./console-product-renderer.js";

test("product renderer emits required fake-data mobile console shell", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

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
    "console-context-card",
    "console-mobile-artifact-card",
    "console-empty-state-card",
    "console-service-state-card",
    "console-composer"
  ]) {
    assert.match(html, new RegExp(escapeRegExp(marker)), `missing marker ${marker}: ${html}`);
  }
});

test("product renderer shows required projects, sessions, controls, and cards", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  for (const copy of [
    "acme/web",
    "acme/api",
    "acme/infra",
    "Refactor auth middleware",
    "Fix CI flaky test",
    "Add UI prototype",
    "GPT-5.5 xhigh",
    "Auto",
    "Ask",
    "Current model",
    "Work mode",
    "/code",
    "/review",
    "/test",
    "/deploy",
    "/explain",
    "Online",
    "Running",
    "Message Codex or type /",
    "src/web/App.tsx",
    "Approval required",
    "2 pending",
    "Run tests",
    "Modify config",
    "Review diff",
    "Open files",
    "Approve",
    "Approve all",
    "Cancel"
  ]) {
    assert.match(html, new RegExp(escapeRegExp(copy)), `missing required content ${copy}: ${html}`);
  }

  assert.match(html, /class="console-project-row"[\s\S]*?acme\/web[\s\S]*?class="console-project-action-archive"[\s\S]*?Archive[\s\S]*?class="console-project-action-new-session"[\s\S]*?\+ New/);
  assert.match(html, /class="console-project-row"[\s\S]*?acme\/api[\s\S]*?class="console-project-action-archive"[\s\S]*?Archive[\s\S]*?class="console-project-action-new-session"[\s\S]*?\+ New/);
  assert.match(html, /class="console-project-row"[\s\S]*?acme\/infra[\s\S]*?class="console-project-action-archive"[\s\S]*?Archive[\s\S]*?class="console-project-action-new-session"[\s\S]*?\+ New/);
  assert.match(html, /class="console-project-action-archive"[^>]*aria-label="Archive acme\/web"[^>]*>Archive<\/button>/);
  assert.match(html, /class="console-project-action-new-session"[^>]*aria-label="Create new session in acme\/web"[^>]*>\+ New<\/button>/);
  assert.match(html, /[-+]\s+(const|if)/, `missing diff-like lines: ${html}`);
});

test("product renderer emits desktop three-pane markers and inspector sections", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  for (const marker of [
    "desktop-console-shell",
    "desktop-sidebar",
    "desktop-main",
    "desktop-inspector",
    "desktop-task-card",
    "desktop-diff-panel",
    "desktop-run-summary"
  ]) {
    assert.match(html, new RegExp(escapeRegExp(marker)), `missing desktop marker ${marker}: ${html}`);
  }

  assert.match(html, /@media \(min-width: 960px\)[\s\S]*?\.desktop-console-shell \.console-app-frame \{[\s\S]*?grid-template-columns: minmax\(260px, 320px\) minmax\(0, 1fr\) minmax\(270px, 340px\);/);
  for (const copy of ["Task", "Files &amp; artifacts", "Activity", "Approvals", "3 changed files", "run-summary.md"]) {
    assert.match(html, new RegExp(escapeRegExp(copy)), `missing inspector copy ${copy}: ${html}`);
  }
});

test("product renderer includes UX completeness copy for static flows and states", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  for (const copy of [
    "New session under acme/web",
    "Creates an empty chat in the selected project",
    "Archive selected project",
    "Archives the selected project",
    "Project context",
    "Change context",
    "Start a new session",
    "New session will be created under acme/web",
    "Connection needs attention",
    "Workspace owner: check the bridge service"
  ]) {
    assert.match(html, new RegExp(escapeRegExp(copy)), `missing UX state copy ${copy}: ${html}`);
  }
});

test("product renderer does not render old bottom tab navigation labels", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  assert.doesNotMatch(html, /bottom[^<]{0,40}tab/i);
  for (const label of ["Chat", "Files", "Status"]) {
    assert.doesNotMatch(html, new RegExp(`>${label}<`), `rendered bottom-tab-like label ${label}: ${html}`);
  }
  assert.doesNotMatch(html, /class="[^"]*bottom[^"]*"/i);
  assert.doesNotMatch(html, /class="[^"]*tab[^"]*"/i);
});

test("product renderer CSS makes the project drawer a mobile overlay", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-app-frame \{[\s\S]*?grid-template-columns: 1fr;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-project-drawer \{[\s\S]*?position: fixed;[\s\S]*?top: calc\(8px \+ env\(safe-area-inset-top\)\);[\s\S]*?right: 8px;[\s\S]*?bottom: calc\(8px \+ env\(safe-area-inset-bottom\)\);[\s\S]*?left: 8px;[\s\S]*?width: auto;[\s\S]*?max-width: none;[\s\S]*?overflow-x: hidden;[\s\S]*?overflow-y: auto;[\s\S]*?transform: translateX\(calc\(-100% - 16px\)\);/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?#console-drawer-toggle:checked ~ \.console-app-frame \.console-project-drawer \{[\s\S]*?transform: translateX\(0\);/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-drawer-scrim \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;/);
});

test("product renderer CSS stacks mobile header context and controls without clipping", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-topbar \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 44px minmax\(0, 1fr\) max-content;[\s\S]*?align-items: start;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-context \{[\s\S]*?grid-column: 2;[\s\S]*?grid-row: 1;[\s\S]*?min-width: 0;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-context h1 \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-status-pill \{[\s\S]*?grid-column: 3;[\s\S]*?grid-row: 1;[\s\S]*?min-height: 36px;[\s\S]*?white-space: nowrap;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-select-pill \{[\s\S]*?width: 100%;[\s\S]*?flex-direction: row;[\s\S]*?justify-content: space-between;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-select-pill span \{[\s\S]*?flex: 0 0 auto;[\s\S]*?white-space: nowrap;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-select-pill select \{[\s\S]*?max-width: 58%;[\s\S]*?text-align: right;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-model-selector \{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?grid-row: 2;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-mode-selector \{[\s\S]*?grid-column: 1 \/ -1;[\s\S]*?grid-row: 3;/);
});

test("product renderer CSS keeps mobile drawer project actions readable and tappable", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  assert.match(html, /\.console-project-title-block \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-width: 0;/);
  assert.match(html, /\.console-project-copy \{[\s\S]*?flex: 1 1 auto;[\s\S]*?min-width: 0;/);
  assert.match(html, /\.console-project-actions button \{[\s\S]*?white-space: nowrap;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-project-row \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) max-content;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-project-actions \{[\s\S]*?min-width: max-content;[\s\S]*?flex-wrap: nowrap;[\s\S]*?justify-content: flex-end;/);
});

test("product renderer CSS lets the mobile command row scroll inside the viewport", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  assert.match(html, /\.console-command-bar \{[\s\S]*?display: flex;[\s\S]*?overflow-x: auto;[\s\S]*?scroll-padding-inline: 8px;/);
  assert.match(html, /\.console-command-bar::after \{[\s\S]*?content: "";[\s\S]*?flex: 0 0 1px;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-command-bar \{[\s\S]*?width: calc\(100% \+ 20px\);[\s\S]*?max-width: 100vw;[\s\S]*?margin: 0 -10px;[\s\S]*?overflow-x: auto;[\s\S]*?overscroll-behavior-inline: contain;[\s\S]*?padding: 0 10px 8px;[\s\S]*?scroll-padding-inline: 10px;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-command-bar::after \{[\s\S]*?flex-basis: 2px;/);
});

test("product renderer CSS keeps the mobile composer in flow below scrollable content", () => {
  const html = renderConsoleProductHomePage(createConsoleProductMock());

  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-mobile-shell \{[\s\S]*?min-height: 100dvh;[\s\S]*?display: block;[\s\S]*?overflow: visible;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-app-frame \{[\s\S]*?min-height: auto;[\s\S]*?overflow: visible;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-workspace \{[\s\S]*?display: grid;[\s\S]*?grid-template-rows: none;[\s\S]*?overflow: visible;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-chat-timeline \{[\s\S]*?min-height: auto;[\s\S]*?overflow: visible;/);
  assert.match(html, /@media \(max-width: 720px\)[\s\S]*?\.console-composer \{[\s\S]*?position: static;[\s\S]*?border-radius: 22px;/);
});

test("product renderer enables send form only with enabled capability, session endpoint, and CSRF", () => {
  const base = createConsoleProductMock();
  const enabledHtml = renderConsoleProductHomePage({
    ...base,
    source: "api",
    apiRoot: "/api",
    activeSessionId: "ses_RenderSend1230",
    composer: {
      ...base.composer,
      sessionId: "ses_RenderSend1230",
      sendEndpoint: "/api/sessions/ses_RenderSend1230/messages",
      csrfToken: "csrf-render-token",
      sendCapability: { state: "enabled" },
      controls: ["Attach", "Command", "Mic", "Send"]
    }
  });
  assert.match(enabledHtml, /<form class="console-composer"[^>]*data-console-send-form/);
  assert.match(enabledHtml, /data-capability-send-message="enabled"/);
  assert.match(enabledHtml, /action="\/api\/sessions\/ses_RenderSend1230\/messages"/);
  assert.match(enabledHtml, /name="_csrf" value="csrf-render-token"/);

  const missingCsrfHtml = renderConsoleProductHomePage({
    ...base,
    composer: {
      ...base.composer,
      sessionId: "ses_RenderSend1230",
      sendEndpoint: "/api/sessions/ses_RenderSend1230/messages",
      sendCapability: { state: "enabled" },
      controls: ["Attach", "Command", "Mic", "Send"]
    }
  });
  assert.doesNotMatch(missingCsrfHtml, /data-console-send-form/);
  assert.match(missingCsrfHtml, /data-capability-send-message="enabled"/);
  assert.match(missingCsrfHtml, /Send unavailable/);

  const disabledHtml = renderConsoleProductHomePage({
    ...base,
    composer: {
      ...base.composer,
      sessionId: "ses_RenderSend1230",
      sendEndpoint: "/api/sessions/ses_RenderSend1230/messages",
      csrfToken: "csrf-render-token",
      sendCapability: { state: "disabled", reason: "Server send seam is unavailable." },
      controls: ["Attach", "Command", "Mic"]
    }
  });
  assert.doesNotMatch(disabledHtml, /data-console-send-form/);
  assert.match(disabledHtml, /data-capability-send-message="disabled"/);
  assert.match(disabledHtml, /Server send seam is unavailable\./);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
