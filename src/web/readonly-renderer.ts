import type {
  WebReadonlyArtifactDescriptorRow,
  WebReadonlyConversationArtifactCatalogViewModel,
  WebReadonlyConversationResultViewModel,
  WebReadonlyConversationRow,
  WebReadonlyHomeViewModel,
  WebReadonlyPendingInteractionViewRow,
  WebReadonlyPendingInteractionsViewModel,
  WebReadonlyReadinessGuardrailViewModel,
  WebReadonlyRuntimeContextViewModel,
  WebReadonlyRuntimeTurnRow,
  WebReadonlyWorkspaceConversationListViewModel,
  WebReadonlyWorkspaceListViewModel,
  WebReadonlyWorkspaceRow
} from "../service/web-readonly-view-model.js";
import { createConsoleProductApiModel } from "./console-product-api-model.js";
import { renderConsoleProductHomePage, CONSOLE_PRODUCT_CSS } from "./console-product-renderer.js";

import type { ConsoleBridgeReadAdapter } from "./console-bridge-read-adapter.js";
import type { ConsoleCapabilities, ConsoleProjectId, ConsoleSessionSummary } from "./console-api-contract.js";

interface SafeHtmlCell {
  __safeHtml: string;
}

type NavKey = "home" | "workspaces" | "pending" | "runtime" | "readiness" | "none";

export interface WebSendRenderCapability {
  csrfToken: string;
}

export interface WebReadonlyRenderOptions {
  send?: WebSendRenderCapability | null;
  flash?: {
    status: WebSendFlashStatus;
  } | null;
}

export interface WebProductHomeRenderOptions {
  adapter?: ConsoleBridgeReadAdapter;
  csrfToken?: string | null;
  capabilities?: Partial<Pick<ConsoleCapabilities, "sendMessage">>;
}

type WebSendFlashStatus = "accepted" | "blocked" | "rejected" | "unavailable" | "invalid" | "denied";

export function renderHomePage(_vm?: WebReadonlyHomeViewModel, options: WebProductHomeRenderOptions = {}): string {
  if (!options.adapter) {
    return renderConsoleProductHomePage(undefined, APP_CSS);
  }

  try {
    const bootstrap = options.adapter.getBootstrap();
    const projects = options.adapter.listProjects();
    const projectSessions = new Map<ConsoleProjectId, ConsoleSessionSummary[]>();
    for (const project of projects) {
      const sessions = options.adapter.listProjectSessions(project.projectId);
      projectSessions.set(project.projectId, Array.isArray(sessions) ? sessions : []);
    }
    const activeProjectId = projects.some((project) => project.projectId === bootstrap.activeProjectId)
      ? bootstrap.activeProjectId
      : projects[0]?.projectId;
    const activeSessionId = bootstrap.activeSessionId
      ?? projects.find((project) => project.projectId === activeProjectId)?.activeSessionId
      ?? Array.from(projectSessions.values()).flat().find((session) => !session.archived)?.sessionId;
    const detail = activeSessionId ? options.adapter.getSessionDetail(activeSessionId) : null;
    const activeSessionDetail = detail && !isConsoleApiErrorLike(detail) ? detail : null;
    const modelInput = {
      bootstrap: {
        ...bootstrap,
        projects,
        ...(activeProjectId ? { activeProjectId } : {}),
        ...(activeSessionId ? { activeSessionId } : {})
      },
      projectSessions,
      activeSessionDetail,
      csrfToken: options.csrfToken ?? null,
      ...(options.capabilities ? { capabilityOverrides: options.capabilities } : {})
    };
    return renderConsoleProductHomePage(createConsoleProductApiModel(modelInput), APP_CSS);
  } catch {
    return renderConsoleProductHomePage(undefined, APP_CSS);
  }
}

function isConsoleApiErrorLike(value: unknown): value is { code: string; message: string; retryable: boolean } {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string" &&
    typeof (value as { retryable?: unknown }).retryable === "boolean"
  );
}

export function renderWorkspaceListPage(vm: WebReadonlyWorkspaceListViewModel): string {
  return page("Workspaces", "workspaces", [
    hero("Projects / workspaces", "Browse projects with recent Codex conversations and open the work you want to review."),
    cardListSection(
      "workspace-list",
      "Projects / workspaces",
      vm.workspaces,
      (row) => workspaceCard(row),
      "Projects and workspaces will appear here once the bridge has recent workspace history."
    ),
    warnings(vm.warnings)
  ]);
}

export function renderWorkspaceConversationListPage(vm: WebReadonlyWorkspaceConversationListViewModel): string {
  return page("Workspace conversations", "workspaces", [
    hero("Workspace conversations", "Pick a task or recent result from this workspace."),
    conversationListSection(
      "workspace-conversations",
      "Conversations",
      vm.conversations,
      vm.emptyState === "no_conversations" ? "No conversations are visible for this workspace yet." : "Conversations will appear here when workspace history is available."
    ),
    warnings(vm.warnings)
  ]);
}

export function renderConversationResultPage(vm: WebReadonlyConversationResultViewModel, options: WebReadonlyRenderOptions = {}): string {
  const conversation = vm.conversation;
  const title = conversation?.title ?? "Conversation unavailable";
  const sendReady = Boolean(options.send?.csrfToken);
  const statusRows = conversation
    ? [
      field("Workspace", conversation.workspaceLabel),
      field("Status", statusLabel(conversation.status)),
      field("Last updated", conversation.lastActivityAt),
      field("Created", conversation.createdAt),
      field("Archive", conversation.archived ? "Archived" : "Active")
    ]
    : [field("Status", "Unavailable"), field("Note", "This task is not available in the Web preview yet.")];

  return page("Task page", "none", [
    hero(
      "Conversation thread",
      sendReady
        ? "Read and continue the selected Codex thread, then refresh for runtime, attention, and result updates."
        : "Read the selected Codex thread, latest result, attention state, and runtime summary. Sending from Web is landing next."
    ),
    `<section class="console-panel console-detail-heading" aria-labelledby="detail-heading"><p class="console-eyebrow">${sendReady ? "Live thread" : "Read-only thread"}</p><h2 id="detail-heading">${escapeHtml(title)}</h2><p><span class="console-badge">${escapeHtml(statusLabel(conversation?.status ?? vm.state))}</span> ${escapeHtml(statusCopy(conversation?.status ?? vm.state))}</p><div class="console-fields">${statusRows.join("")}</div></section>`,
    refreshPanel(conversation?.conversationHandle ?? null, conversation?.status ?? vm.state, options.flash?.status ?? null),
    composerPanel(
      vm.composer,
      conversation?.conversationHandle ?? null,
      options,
      conversation ? "This Web thread is read-only until sending is enabled." : "Choose an available conversation before sending from Web."
    ),
    statusPanel(conversation?.status ?? vm.state),
    resultPanel(vm.answers),
    detailPendingPanel(vm.pendingInteractions.state, vm.pendingInteractions.pendingInteractions),
    runtimePanel(vm.runtime.state, vm.runtime.activeTurns),
    readinessPanel(vm.readiness.state, vm.readiness.missingGates),
    warnings(vm.warnings)
  ]);
}

export function renderConversationArtifactCatalogPage(vm: WebReadonlyConversationArtifactCatalogViewModel): string {
  return page("Conversation artifacts", "none", [
    hero("Artifact descriptors", "Descriptor-only artifact availability. This preview does not expose file content."),
    summaryPanel("Artifact status", [field("State", vm.state), field("Empty state", vm.emptyState ?? "—")]),
    cardListSection(
      "artifact-descriptors",
      "Artifact descriptors",
      vm.artifacts,
      (artifact) => artifactCard(artifact),
      "No artifact descriptors are available."
    ),
    vm.selectedArtifact ? summaryPanel("Selected descriptor", [field("Label", vm.selectedArtifact.label), field("Availability", vm.selectedArtifact.availability)]) : "",
    warnings(vm.warnings)
  ]);
}

export function renderRuntimePage(vm: WebReadonlyRuntimeContextViewModel): string {
  return page("Runtime", "runtime", [
    hero("Runtime", "Read-only owner view of whether Codex is idle, running, blocked, degraded, or unavailable."),
    summaryPanel("Current operating state", [
      field("State", runtimeStateLabel(vm.state, vm.activeTurns.length)),
      field("Active turns", String(vm.activeTurns.length)),
      field("Owner guidance", runtimeCopy(vm.state, vm.activeTurns.length))
    ]),
    cardListSection(
      "runtime-active-turns",
      "Active conversation/task turns",
      vm.activeTurns,
      (row) => runtimeTurnCard(row),
      runtimeCopy(vm.state, vm.activeTurns.length)
    ),
    runtimeReadinessGuidancePanel(),
    accessPosturePanel("Settings / access posture"),
    warnings(vm.warnings)
  ]);
}

export function renderPendingInteractionsPage(vm: WebReadonlyPendingInteractionsViewModel): string {
  return page("Pending/Approvals", "pending", [
    hero("Pending/Approvals", "Read-only view of approvals, questions, and other owner attention states. Responses are not enabled in this preview."),
    summaryPanel("Pending status", [field("State", vm.state), field("Visible items", String(vm.pendingInteractions.length))]),
    pendingPanel(vm.state, vm.pendingInteractions),
    warnings(vm.warnings)
  ]);
}

export function renderReadinessPage(vm: WebReadonlyReadinessGuardrailViewModel): string {
  return page("Readiness", "readiness", [
    hero("Readiness", "Baseline capability/readiness matrix for this private Console preview. It is not a public support claim; public support is not claimed."),
    summaryPanel("Readiness status", [
      field("State", readinessStateLabel(vm.state)),
      field("Checked at", vm.checkedAt ?? "—"),
      field("Active pack", vm.activePack ?? "—")
    ]),
    accessPosturePanel("Setup / access posture"),
    cardListSection(
      "readiness-capabilities",
      "Baseline capability/readiness matrix",
      vm.capabilities,
      (row) => `<article class="console-card"><h3>${escapeHtml(row.label)}</h3><div class="console-fields">${[
        field("Declared", observedCopy(row.declared)),
        field("Configured", observedCopy(row.configured)),
        field("Observed", observedCopy(row.observed)),
        field("UX exposed", observedCopy(row.uxExposed))
      ].join("")}</div></article>`,
      "No capability rows are available."
    ),
    listPanel("Setup needed", vm.missingGates, "No setup gaps are visible."),
    supportClaimGuardrailPanel(),
    warnings(vm.warnings)
  ]);
}

export function renderGenericNotFoundPage(): string {
  return page("Not found", "none", [summaryPanel("Not found", ["The requested page is not available."])]);
}

export function renderGenericErrorPage(): string {
  return page("Temporarily unavailable", "none", [summaryPanel("Temporarily unavailable", ["The read-only Console preview could not render this page."])]);
}

export function escapeHtml(value: unknown): string {
  return scrubText(String(value ?? ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(title: string, active: NavKey, sections: string[]): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(title)} · Codex Console</title>`,
    `<style>\n${APP_CSS}\n</style>`,
    "</head>",
    "<body class=\"console-shell\">",
    "<header class=\"console-shell__header\">",
    "<div class=\"console-brand\"><p class=\"console-eyebrow\">Web Chat</p><h1>Codex Console</h1><p class=\"console-posture\">Chat-first owner preview for Codex Bridge work.</p></div>",
    "<nav class=\"console-shell__nav\" aria-label=\"Console navigation\">",
    navLink("/", "Chat", active === "home"),
    navLink("/workspaces", "Workspaces", active === "workspaces"),
    navLink("/interactions", "Pending", active === "pending"),
    navLink("/runtime", "Runtime", active === "runtime"),
    navLink("/readiness", "Readiness", active === "readiness"),
    "</nav>",
    "</header>",
    "<main class=\"console-shell__main\">",
    ...sections.filter(Boolean),
    "</main>",
    "</body>",
    "</html>"
  ].join("\n");
}

export const APP_CSS = `${CONSOLE_PRODUCT_CSS}

:root {
  color-scheme: light;
  --console-bg: #f4f7fb;
  --console-surface: #ffffff;
  --console-surface-soft: #eef4ff;
  --console-border: #d9e3f0;
  --console-text: #162033;
  --console-muted: #62708a;
  --console-primary: #2457d6;
  --console-primary-soft: #e8efff;
  --console-shadow: 0 18px 50px rgba(22, 32, 51, 0.10);
}
* {
  box-sizing: border-box;
}
html {
  background: var(--console-bg);
}
body.console-shell {
  margin: 0;
  min-width: 0;
  overflow-x: hidden;
  color: var(--console-text);
  background: linear-gradient(135deg, rgba(36, 87, 214, 0.12), rgba(244, 247, 251, 0) 32rem), var(--console-bg);
  font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  overflow-wrap: anywhere;
}
a {
  color: var(--console-primary);
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.16em;
}
.console-shell__header,
.console-shell__main {
  width: 100%;
  max-width: min(1120px, calc(100% - 32px));
  margin: 0 auto;
}
.console-shell__header {
  display: grid;
  gap: 1rem;
  padding: 28px 0 16px;
}
.console-brand,
.console-hero,
.console-panel,
.console-section {
  border: 1px solid var(--console-border);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: var(--console-shadow);
}
.console-brand,
.console-hero,
.console-panel,
.console-section {
  padding: 1.25rem;
}
.console-brand h1,
.console-hero h2,
.console-section h2,
.console-panel h2,
.console-card h3 {
  margin: 0;
  line-height: 1.18;
}
.console-brand h1 {
  font-size: clamp(2rem, 7vw, 4.25rem);
  letter-spacing: -0.06em;
}
.console-posture,
.console-hero p,
.console-card p,
.console-empty,
.console-muted {
  color: var(--console-muted);
}
.console-eyebrow {
  margin: 0 0 0.35rem;
  color: var(--console-primary);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.console-shell__nav {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}
.console-nav-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  padding: 0.65rem 0.95rem;
  border: 1px solid var(--console-border);
  border-radius: 999px;
  background: var(--console-surface);
  color: var(--console-text);
  font-weight: 700;
  text-decoration: none;
}
.console-nav-link[aria-current="page"] {
  border-color: rgba(36, 87, 214, 0.35);
  background: var(--console-primary-soft);
  color: var(--console-primary);
}
.console-shell__main {
  display: grid;
  gap: 1rem;
  padding: 0 0 40px;
}
.console-hero {
  padding: clamp(1.25rem, 4vw, 2rem);
  background: linear-gradient(135deg, #ffffff, #eef4ff);
}
.console-hero h2 {
  font-size: clamp(1.8rem, 5vw, 3.3rem);
  letter-spacing: -0.04em;
}
.console-section,
.console-panel {
  display: grid;
  gap: 1rem;
}
.console-chat-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(min(100%, 320px), 0.85fr);
  gap: 1rem;
  align-items: start;
}
.console-thread-preview {
  position: sticky;
  top: 1rem;
}
.console-card-list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 0.85rem;
  min-width: 0;
}
.console-card-group {
  display: grid;
  gap: 0.75rem;
  min-width: 0;
}
.console-card-group h3 {
  margin: 0;
  color: var(--console-muted);
  font-size: 0.95rem;
}
.console-card {
  min-width: 0;
  padding: 1rem;
  border: 1px solid var(--console-border);
  border-radius: 18px;
  background: var(--console-surface);
}
.console-card h3 a,
.console-field a {
  overflow-wrap: anywhere;
}
.console-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  min-width: 0;
}
.console-field,
.console-badge {
  display: inline-flex;
  max-width: 100%;
  border-radius: 999px;
  overflow-wrap: anywhere;
}
.console-field {
  padding: 0.4rem 0.65rem;
  background: #f6f8fc;
  color: var(--console-muted);
}
.console-field strong {
  margin-right: 0.25rem;
  color: var(--console-text);
}
.console-badge {
  align-items: center;
  padding: 0.22rem 0.55rem;
  background: var(--console-primary-soft);
  color: var(--console-primary);
  font-weight: 800;
  font-size: 0.82rem;
}
.console-result-body {
  max-width: 100%;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  padding: 1rem;
  border-radius: 16px;
  background: #101827;
  color: #eef4ff;
}
.console-composer {
  display: grid;
  gap: 0.65rem;
  padding: 0.85rem;
  border: 1px dashed rgba(36, 87, 214, 0.35);
  border-radius: 18px;
  background: var(--console-surface-soft);
}
.console-composer__box {
  min-height: 4.25rem;
  display: flex;
  align-items: center;
  padding: 0.85rem 1rem;
  border: 1px solid var(--console-border);
  border-radius: 16px;
  background: #ffffff;
  color: var(--console-muted);
}
.console-composer p {
  margin: 0;
}
.console-composer form {
  display: grid;
  gap: 0.65rem;
}
.console-composer__label {
  font-weight: 800;
}
.console-composer textarea {
  min-height: 6rem;
  resize: vertical;
  padding: 0.85rem 1rem;
  border: 1px solid var(--console-border);
  border-radius: 16px;
  background: #ffffff;
  color: var(--console-text);
  font: inherit;
}
.console-composer button {
  min-height: 44px;
  justify-self: start;
  padding: 0.65rem 1rem;
  border: 0;
  border-radius: 999px;
  background: var(--console-primary);
  color: #ffffff;
  font: inherit;
  font-weight: 800;
}
.console-list {
  margin: 0;
  padding-left: 1.25rem;
}
@media (max-width: 640px) {
  .console-shell__header,
  .console-shell__main {
    max-width: min(100% - 20px, 1120px);
  }
  .console-brand,
  .console-hero,
  .console-panel,
  .console-section {
    border-radius: 18px;
    padding: 1rem;
  }
  .console-nav-link {
    flex: 1 1 auto;
    justify-content: center;
  }
  .console-chat-layout {
    grid-template-columns: 1fr;
  }
  .console-thread-preview {
    position: static;
  }
}
`.trim();

function navLink(href: string, label: string, active: boolean): string {
  const current = active ? " aria-current=\"page\"" : "";
  return `<a class="console-nav-link" href="${href}"${current}>${escapeHtml(label)}</a>`;
}

function hero(label: string, body: string): string {
  return `<section class="console-hero" aria-labelledby="page-heading"><p class="console-eyebrow">${escapeHtml(label)}</p><h2 id="page-heading">${escapeHtml(label)}</h2><p>${escapeHtml(body)}</p></section>`;
}

function summaryPanel(title: string, rows: string[]): string {
  return `<section class="console-panel" aria-labelledby="${slug(title)}"><h2 id="${slug(title)}">${escapeHtml(title)}</h2><div class="console-fields">${rows.map((row) => `<p>${row}</p>`).join("")}</div></section>`;
}

function cardListSection<T>(id: string, title: string, rows: T[], render: (row: T) => string, emptyCopy: string): string {
  const body = rows.length > 0
    ? `<div class="console-card-list">${rows.map((row) => render(row)).join("")}</div>`
    : `<p class="console-empty">${escapeHtml(emptyCopy)}</p>`;
  return `<section class="console-section" aria-labelledby="${id}"><h2 id="${id}">${escapeHtml(title)}</h2>${body}</section>`;
}

function chatHomeSection(vm: WebReadonlyHomeViewModel, options: WebReadonlyRenderOptions): string {
  const selected = vm.recentConversations[0] ?? null;
  const queue = vm.recentConversations.length > 0
    ? conversationListSection(
      "chat-work-queue-list",
      "Conversation work queue",
      vm.recentConversations,
      "No conversation threads are visible yet."
    )
    : `<section class="console-section" aria-labelledby="chat-work-queue-list"><h2 id="chat-work-queue-list">Conversation work queue</h2><p class="console-empty">No conversation threads are visible yet.</p></section>`;
  const selectedPanel = selected
    ? `<section class="console-panel console-thread-preview" aria-labelledby="selected-thread"><p class="console-eyebrow">Thread</p><h2 id="selected-thread">Selected thread preview</h2><article class="console-card"><h3>${cellHtml(conversationLink(selected.conversationHandle, selected.title))}</h3><p><span class="console-badge">${escapeHtml(statusLabel(selected.status))}</span> ${escapeHtml(conversationCopy(selected.status, selected.finalAnswerAvailable))}</p><div class="console-fields">${[
      field("Last updated", selected.lastActivityAt),
      field("Result", selected.finalAnswerAvailable ? "Available" : "Not ready yet"),
      fieldHtml("Thread", cellHtml(conversationLink(selected.conversationHandle, "Open durable thread")))
    ].join("")}</div></article>${composerPanel(vm.composer, selected.conversationHandle, options, "Open a thread to review more result, pending, and runtime details.")}</section>`
    : `<section class="console-panel console-thread-preview" aria-labelledby="selected-thread"><p class="console-eyebrow">Thread</p><h2 id="selected-thread">Selected thread preview</h2><p class="console-empty">No thread selected. Conversation threads will appear here as Codex work is captured.</p>${composerPanel(vm.composer, null, options, "Choose a conversation when one is available.")}</section>`;

  return `<section class="console-chat-layout" aria-label="Web Chat work queue">${queue}${selectedPanel}</section>`;
}

function composerPanel(
  composer: WebReadonlyHomeViewModel["composer"],
  conversationHandle: string | null,
  options: WebReadonlyRenderOptions,
  note: string
): string {
  if (conversationHandle && isSafeConversationHandle(conversationHandle) && options.send?.csrfToken) {
    const action = `/conversations/${conversationHandle}/messages`;
    return `<section class="console-composer" aria-label="${escapeHtml(composer.label)}"><form method="post" action="${escapeHtml(action)}"><input type="hidden" name="_csrf" value="${escapeHtml(options.send.csrfToken)}"><label class="console-composer__label" for="web-message-${escapeHtml(conversationHandle)}">${escapeHtml(composer.label)}</label><textarea id="web-message-${escapeHtml(conversationHandle)}" name="message" maxlength="8000" required placeholder="${escapeHtml(composer.placeholder)}"></textarea><button type="submit">Send message</button></form><p><span class="console-badge">Text only</span> Send a short text message to Codex for this conversation.</p></section>`;
  }
  return `<section class="console-composer" aria-label="${escapeHtml(composer.label)}" aria-disabled="true"><div class="console-composer__box" role="textbox" aria-readonly="true" aria-disabled="true"><span>${escapeHtml(composer.placeholder)}</span></div><p><span class="console-badge">Read-only</span> ${escapeHtml(composer.disabledReason)} ${escapeHtml(note)}</p></section>`;
}

function refreshPanel(conversationHandle: string | null, status: string, flashStatus: WebSendFlashStatus | null): string {
  if (!conversationHandle || !isSafeConversationHandle(conversationHandle)) {
    return "";
  }
  const refreshHref = `/conversations/${conversationHandle}`;
  const flashCopy = flashStatus ? sendStatusCopy(flashStatus) : null;
  const statusCopyText = conversationGroup(status) === "running"
    ? "Codex is running. Refresh this thread to check for new runtime or result state."
    : "Refresh this thread to check for updated runtime, attention, or result state.";
  const fields = [
    flashCopy ? field("Last send", flashCopy) : "",
    fieldHtml("Refresh", `<a href="${escapeHtml(refreshHref)}">Refresh thread</a>`),
    field("Note", statusCopyText)
  ].filter(Boolean);
  return `<section class="console-panel console-refresh" aria-labelledby="refresh-heading"><h2 id="refresh-heading">Thread refresh</h2><div class="console-fields">${fields.join("")}</div></section>`;
}

function sendStatusCopy(status: WebSendFlashStatus): string {
  switch (status) {
    case "accepted":
      return "Message accepted. Refresh to watch running or final result state.";
    case "blocked":
      return "Message was blocked by current conversation state. Refresh and check pending attention.";
    case "unavailable":
      return "Message could not be submitted right now. Refresh before retrying.";
    case "denied":
      return "Message was denied by owner safety checks.";
    case "invalid":
      return "Message was not sent because the request was invalid.";
    case "rejected":
      return "Message was not accepted for this conversation.";
  }
}

function isSafeConversationHandle(value: string): boolean {
  return /^cv_[a-f0-9]{16}$/.test(value);
}

function utilityLinksPanel(): string {
  return summaryPanel("Secondary utilities", [
    fieldHtml("Runtime", '<a href="/runtime">Open runtime</a>'),
    fieldHtml("Readiness", '<a href="/readiness">Open readiness</a>'),
    fieldHtml("Pending", '<a href="/interactions">Open pending</a>')
  ]);
}

function homeOwnerAttentionSection(state: string, rows: WebReadonlyPendingInteractionViewRow[]): string {
  const attentionRows = rows.filter((row) => pendingGroup(row) === "attention").slice(0, 3);
  if (attentionRows.length === 0) {
    return "";
  }

  const count = attentionRows.length;
  const summary = `${count} item${count === 1 ? "" : "s"} need owner attention`;
  const cards = attentionRows.map((row) => homePendingAttentionCard(row)).join("");
  const stateCopy = /degraded/i.test(state) ? "Pending state may be partial or stale." : "Safe read-only summary from pending interactions.";
  return `<section class="console-section console-owner-attention" aria-labelledby="home-owner-attention"><p class="console-eyebrow">Owner attention</p><h2 id="home-owner-attention">Owner attention</h2><p><span class="console-badge">${escapeHtml(summary)}</span> ${escapeHtml(stateCopy)}</p><div class="console-card-list">${cards}</div></section>`;
}

function homePendingAttentionCard(row: WebReadonlyPendingInteractionViewRow): string {
  const label = pendingInteractionLabel(row);
  const summary = row.summary.state === "available" ? row.summary.text : pendingInteractionCopy(row);
  const source = row.conversationId && /^cv_[a-f0-9]{16}$/.test(row.conversationId)
    ? fieldHtml("Source", cellHtml(conversationLink(row.conversationId, "Open conversation/task")))
    : field("Source", "Conversation/task unavailable");
  return `<article class="console-card"><h3><span class="console-badge">${escapeHtml(label)}</span></h3><p>${escapeHtml(summary)}</p><div class="console-fields">${[
    field("Kind", pendingKindLabel(row.kind)),
    source,
    field("Note", "Responses are not enabled in this preview.")
  ].join("")}</div></article>`;
}

function conversationListSection(id: string, title: string, rows: WebReadonlyConversationRow[], emptyCopy: string): string {
  if (rows.length === 0) {
    return `<section class="console-section" aria-labelledby="${id}"><h2 id="${id}">${escapeHtml(title)}</h2><p class="console-empty">${escapeHtml(emptyCopy)}</p></section>`;
  }

  const groups = [
    { key: "attention", title: "Needs attention" },
    { key: "running", title: "Running now" },
    { key: "completed", title: "Recently completed" },
    { key: "other", title: "Other/Older" }
  ] as const;
  const cards = groups.map((group) => {
    const groupRows = rows.filter((row) => conversationGroup(row.status) === group.key);
    if (groupRows.length === 0) {
      return "";
    }
    return `<section class="console-card-group" aria-label="${escapeHtml(group.title)}"><h3>${escapeHtml(group.title)}</h3><div class="console-card-list">${groupRows.map((row) => conversationCard(row)).join("")}</div></section>`;
  }).join("");

  return `<section class="console-section" aria-labelledby="${id}"><h2 id="${id}">${escapeHtml(title)}</h2>${cards}</section>`;
}

function statusPanel(status: string): string {
  return `<section class="console-panel" aria-labelledby="status-heading"><h2 id="status-heading">Status</h2><p><span class="console-badge">${escapeHtml(statusLabel(status))}</span> ${escapeHtml(statusCopy(status))}</p></section>`;
}

function resultPanel(answers: WebReadonlyConversationResultViewModel["answers"]): string {
  if (answers.length === 0) {
    return `<section class="console-panel console-result" aria-labelledby="result-heading"><h2 id="result-heading">Result</h2><p class="console-empty">No Web-ready final answer has been captured yet. When Codex finishes with a shareable result, it will appear in this panel.</p></section>`;
  }

  const cards = answers.map((answer) => {
    const body = answer.body.state === "available"
      ? `<pre class="console-result-body">${escapeHtml(answer.body.text)}</pre>`
      : `<p class="console-empty">${escapeHtml(finalAnswerUnavailableCopy(answer.body.reason))}</p>`;
    return `<article class="console-card console-result-card"><h3>${escapeHtml(answerKindLabel(answer.kind))}</h3><div class="console-fields">${[
      field("Delivery", deliveryLabel(answer.deliveryState)),
      field("Created", answer.createdAt),
      field("Summary", resultSummary(answer))
    ].join("")}</div>${body}</article>`;
  }).join("");

  return `<section class="console-panel console-result" aria-labelledby="result-heading"><h2 id="result-heading">Result</h2><div class="console-card-list">${cards}</div></section>`;
}

function finalAnswerUnavailableCopy(reason: string): string {
  if (reason === "unsafe_final_answer_body") {
    return "This result is available in the bridge conversation, but it is not shown in the Web preview yet.";
  }
  return "Result metadata is available, but the answer text has not been captured for this Web preview yet.";
}

function answerKindLabel(kind: string): string {
  const normalized = kind.toLowerCase();
  if (normalized.includes("final")) return "Final answer";
  if (normalized.includes("summary")) return "Summary";
  return "Result";
}

function deliveryLabel(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized.includes("deliver")) return "Delivered";
  if (normalized.includes("pending")) return "Pending";
  if (normalized.includes("fail")) return "Not delivered";
  return statusLabel(state);
}

function resultSummary(answer: WebReadonlyConversationResultViewModel["answers"][number]): string {
  if (answer.body.state === "unavailable") {
    return "Result metadata was captured, but the answer text is only available outside this Web preview.";
  }
  return answer.summary;
}

function runtimePanel(state: string, rows: WebReadonlyRuntimeTurnRow[]): string {
  return cardListSection(
    "runtime-heading",
    "Runtime",
    rows,
    (row) => runtimeTurnCard(row),
    runtimeCopy(state, rows.length)
  );
}

function pendingPanel(state: string, rows: WebReadonlyPendingInteractionViewRow[]): string {
  return pendingInteractionListSection("pending-heading", "Pending interactions", state, rows);
}

function detailPendingPanel(state: string, rows: WebReadonlyPendingInteractionViewRow[]): string {
  return pendingInteractionListSection("attention-heading", "Needs attention", state, rows);
}

function readinessPanel(state: string, missingGates: string[]): string {
  return `<section class="console-panel" aria-labelledby="readiness-heading"><h2 id="readiness-heading">Readiness</h2><p><span class="console-badge">${escapeHtml(state)}</span> ${escapeHtml(readinessCopy(state, missingGates.length))}</p>${listItems(missingGates, "No missing gates are visible.")}</section>`;
}

function runtimeReadinessGuidancePanel(): string {
  return summaryPanel("Degraded / unavailable guidance", [
    field("Degraded", "State is partial, stale, or missing a safe source."),
    field("Unavailable", "The safe reader cannot show current runtime state yet."),
    field("Setup needed", "Use existing bridge setup and diagnostics outside this Web preview if a required source is missing.")
  ]);
}

function accessPosturePanel(title: string): string {
  return summaryPanel(title, [
    field("Access", "Owner/private"),
    field("Mode", "Read-only preview"),
    field("Default", "Denied by default"),
    field("Controls", "Actions are not enabled"),
    field("Rollback posture", "Kill-switch and rollback readiness are status-only here; no destructive controls are exposed.")
  ]);
}

function supportClaimGuardrailPanel(): string {
  return summaryPanel("Support-claim guardrail", [
    "This readiness view is not a public support claim.",
    "Private owner preview only; public support is not claimed from this page."
  ]);
}

function listPanel(title: string, items: string[], emptyCopy: string): string {
  return `<section class="console-panel" aria-labelledby="${slug(title)}"><h2 id="${slug(title)}">${escapeHtml(title)}</h2>${listItems(items, emptyCopy)}</section>`;
}

function listItems(items: string[], emptyCopy: string): string {
  if (items.length === 0) {
    return `<p class="console-empty">${escapeHtml(emptyCopy)}</p>`;
  }
  return `<ul class="console-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function workspaceCard(row: WebReadonlyWorkspaceRow): string {
  return `<article class="console-card"><h3>${cellHtml(workspaceLink(row.workspaceId, row.label))}</h3><div class="console-fields">${[
    field("Status", availabilityLabel(row.availability)),
    field("Conversations", String(row.conversationCount)),
    field("Pinned", yesNo(row.pinned)),
    field("Last updated", row.lastActivityAt ?? "—"),
    fieldHtml("Open", cellHtml(workspaceLink(row.workspaceId, "Open")))
  ].join("")}</div></article>`;
}

function availabilityLabel(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized.includes("available") || normalized === "present") return "Available";
  if (normalized.includes("degraded") || normalized.includes("partial")) return "Partial";
  if (normalized.includes("empty")) return "No recent work";
  return "Unavailable";
}

function conversationCard(row: WebReadonlyConversationRow): string {
  return `<article class="console-card"><h3>${cellHtml(conversationLink(row.conversationHandle, row.title))}</h3><p><span class="console-badge">${escapeHtml(statusLabel(row.status))}</span> ${escapeHtml(conversationCopy(row.status, row.finalAnswerAvailable))}</p><div class="console-fields">${[
    field("Last updated", row.lastActivityAt),
    field("Result", row.finalAnswerAvailable ? "Available" : "Not ready yet"),
    field("Archive", row.archived ? "Archived" : "Active"),
    fieldHtml("Open", cellHtml(conversationLink(row.conversationHandle, "Open")))
  ].join("")}</div></article>`;
}

function pendingInteractionListSection(
  id: string,
  title: string,
  state: string,
  rows: WebReadonlyPendingInteractionViewRow[]
): string {
  if (rows.length === 0) {
    return `<section class="console-section" aria-labelledby="${id}"><h2 id="${id}">${escapeHtml(title)}</h2><p class="console-empty">${escapeHtml(pendingCopy(state))}</p></section>`;
  }

  const groups = [
    { key: "attention", title: "Needs owner attention" },
    { key: "resolved", title: "Resolved or duplicate" },
    { key: "stale", title: "Stale or expired" },
    { key: "failed", title: "Unavailable or failed" }
  ] as const;
  const cards = groups.map((group) => {
    const groupRows = rows.filter((row) => pendingGroup(row) === group.key);
    if (groupRows.length === 0) {
      return "";
    }
    return `<section class="console-card-group" aria-label="${escapeHtml(group.title)}"><h3>${escapeHtml(group.title)}</h3><div class="console-card-list">${groupRows.map((row) => pendingInteractionCard(row)).join("")}</div></section>`;
  }).join("");

  return `<section class="console-section" aria-labelledby="${id}"><h2 id="${id}">${escapeHtml(title)}</h2>${cards}</section>`;
}

function runtimeTurnCard(row: WebReadonlyRuntimeTurnRow): string {
  return `<article class="console-card"><h3>${escapeHtml(statusLabel(row.status))}</h3><p>${escapeHtml(row.summary ?? statusCopy(row.status))}</p><div class="console-fields">${[
    field("Blocked", row.blockedReason ?? "—")
  ].join("")}</div></article>`;
}

function pendingInteractionCard(row: WebReadonlyPendingInteractionViewRow): string {
  const label = pendingInteractionLabel(row);
  const summary = row.summary.state === "available" ? row.summary.text : "Summary is unavailable from the safe read model.";
  const source = row.conversationId && /^cv_[a-f0-9]{16}$/.test(row.conversationId)
    ? fieldHtml("Source", cellHtml(conversationLink(row.conversationId, "Open conversation/task")))
    : field("Source", "Conversation/task unavailable");
  return `<article class="console-card"><h3><span class="console-badge">${escapeHtml(label)}</span></h3><p>${escapeHtml(summary)}</p><div class="console-fields">${[
    field("State", label),
    field("State note", pendingInteractionCopy(row)),
    field("Kind", pendingKindLabel(row.kind)),
    source,
    field("Reason", row.blockingReason),
    field("Created", row.createdAt ?? "—"),
    field("Availability", row.availability)
  ].join("")}</div><p class="console-muted">Read-only preview: Responses are not enabled in this preview.</p></article>`;
}

function artifactCard(artifact: WebReadonlyArtifactDescriptorRow): string {
  return `<article class="console-card"><h3>${escapeHtml(artifact.label)}</h3><div class="console-fields">${[
    field("Kind", artifact.kind),
    field("Type", artifact.type ?? artifact.mediaType ?? "—"),
    field("Size", artifact.sizeBytes === null ? "—" : String(artifact.sizeBytes)),
    field("Availability", artifact.availability),
    field("Created", artifact.createdAt ?? "—")
  ].join("")}</div></article>`;
}

function field(label: string, value: unknown): string {
  return `<span class="console-field"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</span>`;
}

function fieldHtml(label: string, valueHtml: string): string {
  return `<span class="console-field"><strong>${escapeHtml(label)}:</strong> ${valueHtml}</span>`;
}

function cellHtml(value: unknown | SafeHtmlCell): string {
  if (isSafeHtmlCell(value)) {
    return value.__safeHtml;
  }
  return escapeHtml(value);
}

function isSafeHtmlCell(value: unknown): value is SafeHtmlCell {
  return typeof value === "object" && value !== null && typeof (value as SafeHtmlCell).__safeHtml === "string";
}

function conversationLink(handle: string, label: string): SafeHtmlCell {
  if (!/^cv_[a-f0-9]{16}$/.test(handle)) {
    return { __safeHtml: escapeHtml(label) };
  }
  return { __safeHtml: `<a href="/conversations/${handle}">${escapeHtml(label)}</a>` };
}

function workspaceLink(workspaceId: string, label: string): SafeHtmlCell {
  if (!/^wk_[A-Za-z0-9_-]{1,80}$/.test(workspaceId)) {
    return { __safeHtml: escapeHtml(label) };
  }
  return { __safeHtml: `<a href="/workspaces/${workspaceId}/conversations">${escapeHtml(label)}</a>` };
}

function warnings(items: string[]): string {
  return listPanel("Warnings", items, "No warnings are visible.");
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function conversationGroup(status: string): "attention" | "running" | "completed" | "other" {
  const normalized = status.toLowerCase();
  if (normalized.includes("unknown")) return "other";
  if (/question|approval|pending|blocked|fail|degraded|unavailable|needs/.test(normalized)) return "attention";
  if (/running|queued/.test(normalized)) return "running";
  if (/complete|done/.test(normalized)) return "completed";
  return "other";
}

function statusLabel(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized.includes("running")) return "Running";
  if (normalized.includes("queued")) return "Queued";
  if (normalized.includes("question")) return "Needs answer";
  if (normalized.includes("approval")) return "Approval needed";
  if (normalized.includes("pending")) return "Needs attention";
  if (normalized.includes("blocked")) return "Blocked";
  if (normalized.includes("complete") || normalized.includes("done")) return "Done";
  if (normalized.includes("fail")) return "Failed";
  if (normalized.includes("degraded")) return "Degraded";
  if (normalized.includes("unavailable")) return "Unavailable";
  if (normalized.includes("unknown")) return "Unavailable";
  if (normalized.includes("recover")) return "Recovered";
  if (normalized.includes("idle")) return "Idle";
  return "Unavailable";
}

function runtimeStateLabel(state: string, activeCount: number): string {
  if (activeCount > 0) {
    return statusLabel(state);
  }
  const normalized = state.toLowerCase();
  if (normalized === "available" || normalized.includes("idle")) {
    return "Idle";
  }
  return statusLabel(state);
}

function readinessStateLabel(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized.includes("ready") || normalized === "available") return "Ready";
  if (normalized.includes("degraded")) return "Degraded";
  if (normalized.includes("unavailable") || normalized.includes("unknown")) return "Unavailable";
  return statusLabel(state);
}

function statusCopy(status: string): string {
  const label = statusLabel(status);
  switch (label) {
    case "Running":
      return "Codex is working; result will appear here when complete.";
    case "Queued":
      return "A task is waiting to start.";
    case "Needs answer":
      return "Codex asked a question; the answer lane is read-only until enabled.";
    case "Approval needed":
      return "Codex requested an approval; the approval lane is read-only until enabled.";
    case "Needs attention":
      return "Owner attention may be needed, but responses are not enabled in this preview.";
    case "Blocked":
      return "Progress is stopped until required owner interaction is resolved.";
    case "Done":
      return "Completion metadata or a final result is available.";
    case "Failed":
      return "The task ended without a usable final result in this preview.";
    case "Degraded":
      return "State is partial, stale, or missing a safe source.";
    case "Unavailable":
      return "The current state is unavailable or unknown from the safe reader.";
    case "Recovered":
      return "Runtime restarted or state was restored with caveats.";
    default:
      return "Read-only state is shown exactly as exposed by the safe view model.";
  }
}

function runtimeCopy(state: string, activeCount: number): string {
  if (activeCount > 0) {
    return `${activeCount} active turn${activeCount === 1 ? "" : "s"} visible in the safe read model.`;
  }
  const label = statusLabel(state);
  if (label === "Degraded" || label === "Unavailable") {
    return "Runtime data is partial or unavailable in this preview.";
  }
  return "No active task is known.";
}

function readinessCopy(state: string, missingCount: number): string {
  if (missingCount > 0) {
    return `${missingCount} readiness gate${missingCount === 1 ? "" : "s"} need attention before broader support claims.`;
  }
  if (/degraded|unavailable/i.test(state)) {
    return "Readiness data is partial or unavailable.";
  }
  return "No missing readiness gates are visible.";
}

function observedCopy(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized === "present") return "Present";
  if (normalized === "missing") return "Missing";
  return "Unknown";
}

function pendingCopy(state: string): string {
  if (/unavailable/i.test(state)) {
    return "Pending interaction data is unavailable in this preview.";
  }
  if (/degraded/i.test(state)) {
    return "Pending interaction data is partial or stale.";
  }
  return "No pending owner interaction is visible.";
}

function conversationCopy(status: string, finalAnswerAvailable: boolean): string {
  if (finalAnswerAvailable && statusLabel(status) !== "Done") {
    return "Result metadata is available.";
  }
  return statusCopy(status);
}

function pendingLabel(kind: string, status: string): string {
  const loweredKind = kind.toLowerCase();
  if (loweredKind.includes("question")) return "Needs answer";
  if (loweredKind.includes("approval")) return "Approval needed";
  return statusLabel(status);
}

function pendingInteractionLabel(row: WebReadonlyPendingInteractionViewRow): string {
  const normalizedStatus = row.status.toLowerCase();
  if (/resolved|complete|done/.test(normalizedStatus)) return "Resolved";
  if (/expired|timed?_?out/.test(normalizedStatus)) return "Expired";
  if (/stale/.test(normalizedStatus)) return "Stale";
  if (/duplicate/.test(normalizedStatus)) return "Duplicate";
  if (/fail|error/.test(normalizedStatus)) return "Failed";
  if (/unavailable|unknown|missing|source/.test(normalizedStatus) || row.availability === "unavailable") return "Unavailable";
  return pendingLabel(row.kind, row.status);
}

function pendingInteractionCopy(row: WebReadonlyPendingInteractionViewRow): string {
  switch (pendingInteractionLabel(row)) {
    case "Needs answer":
      return "Codex asked a question; responses are not enabled in this preview.";
    case "Approval needed":
      return "Codex requested an approval; responses are not enabled in this preview.";
    case "Resolved":
      return "This owner interaction is already resolved; no Web action is available.";
    case "Expired":
      return "This owner interaction expired or is no longer current; refresh or use the current bridge chat if needed.";
    case "Stale":
      return "This owner interaction may be stale; refresh before relying on it.";
    case "Duplicate":
      return "This owner interaction appears to duplicate another item; use the current item in the bridge chat if needed.";
    case "Failed":
      return "This owner interaction could not be read safely; use the current bridge chat if needed.";
    case "Unavailable":
      return "Pending interaction data is unavailable from the safe reader.";
    default:
      return "Owner attention may be needed, but responses are not enabled in this preview.";
  }
}

function pendingKindLabel(kind: string): string {
  const loweredKind = kind.toLowerCase();
  if (loweredKind.includes("question")) return "Question";
  if (loweredKind.includes("approval")) return "Approval";
  return "Owner interaction";
}

function pendingGroup(row: WebReadonlyPendingInteractionViewRow): "attention" | "resolved" | "stale" | "failed" {
  switch (pendingInteractionLabel(row)) {
    case "Resolved":
    case "Duplicate":
      return "resolved";
    case "Expired":
    case "Stale":
      return "stale";
    case "Failed":
    case "Unavailable":
      return "failed";
    default:
      return "attention";
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
}

function scrubText(value: string): string {
  return value
    .replace(/\b(submit|approve|interrupt|upload|switch|resume)\b/gi, "[redacted]")
    .replace(/\b(callback(?:_data)?|messageId|deliveryMessageId|telegramChatId|feishuChatId|chatId|threadId|token)\s*[:=]\s*[^\s<>"']+/gi, "[redacted]")
    .replace(/\b[A-Z][A-Z0-9_]{2,}=\S+/g, "[redacted-env]")
    .replace(/\/sessions\/[A-Za-z0-9._/-]+/g, "[redacted-session]")
    .replace(/\bsession-[A-Za-z0-9._-]+\b/g, "[redacted-session]")
    .replace(/(?:^|\s)(\/(?:home|tmp|var|etc|root|Users|usr)\/[^\s<>"']*)/g, (match, path: string) => match.replace(path, "[redacted-path]"));
}
