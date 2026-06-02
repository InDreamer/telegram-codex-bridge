import { createHash } from "node:crypto";

import type {
  WebReadonlyAnswerRow,
  WebReadonlyArtifactDescriptorRow,
  WebReadonlyAvailability,
  WebReadonlyConversationResultViewModel,
  WebReadonlyConversationRow,
  WebReadonlyPendingInteractionViewRow,
  WebReadonlyReadinessGuardrailViewModel,
  WebReadonlyRuntimeTurnRow,
  WebReadonlyViewModelProvider,
  WebReadonlyWorkspaceRow
} from "../service/web-readonly-view-model.js";
import {
  CONSOLE_API_VERSION,
  assertConsoleOpaqueId,
  assertConsoleSafeString,
  type ConsoleApiError,
  type ConsoleApprovalKind,
  type ConsoleApprovalRequest,
  type ConsoleArtifactKind,
  type ConsoleArtifactStatus,
  type ConsoleArtifactSummary,
  type ConsoleBootstrap,
  type ConsoleCapabilities,
  type ConsoleCapability,
  type ConsoleDegradedState,
  type ConsoleDiffFileSummary,
  type ConsoleDiffSummary,
  type ConsoleMessage,
  type ConsoleMessageStatus,
  type ConsoleProject,
  type ConsoleProjectId,
  type ConsoleRunState,
  type ConsoleRunStatus,
  type ConsoleRunStep,
  type ConsoleSessionDetail,
  type ConsoleSessionSummary,
  type ConsoleSessionId,
  type ConsoleSessionStatus
} from "./console-api-contract.js";

export interface ConsoleBridgeReadAdapter {
  getBootstrap(): ConsoleBootstrap;
  listProjects(): ConsoleProject[];
  listProjectSessions(projectId: ConsoleProjectId | string): ConsoleSessionSummaryResult;
  getSessionDetail(sessionId: ConsoleSessionId | string): ConsoleSessionDetail | ConsoleApiError;
  resolveConversationHandleForSession?(sessionId: ConsoleSessionId | string): string | null;
}

export type ConsoleSessionSummaryResult = ConsoleSessionSummary[] | ConsoleApiError;

export interface ConsoleBridgeReadAdapterOptions {
  provider: WebReadonlyViewModelProvider;
  now?: () => string;
  idSalt?: string;
}

interface AdapterIndexes {
  generatedAt: string;
  projects: ConsoleProject[];
  projectById: Map<ConsoleProjectId, ProjectIndexEntry>;
  sessionById: Map<ConsoleSessionId, SessionIndexEntry>;
  degradedStates: ConsoleDegradedState[];
  sourceUnavailable: boolean;
}

interface ProjectIndexEntry {
  project: ConsoleProject;
  conversations: WebReadonlyConversationRow[];
  state: WebReadonlyAvailability;
}

interface SessionIndexEntry {
  conversation: WebReadonlyConversationRow;
  summary: ConsoleSessionSummary;
}

interface DetailParts {
  messages: ConsoleMessage[];
  activeRun?: ConsoleRunState;
  diffs: ConsoleDiffSummary[];
  approvals: ConsoleApprovalRequest[];
  artifacts: ConsoleArtifactSummary[];
}

const DEFAULT_ADAPTER_ID_SALT = "console-bridge-read-adapter:v1";

const READ_ONLY_REASON = "Console Bridge read adapter is read-only in this phase.";

export function createConsoleBridgeReadAdapter(options: ConsoleBridgeReadAdapterOptions): ConsoleBridgeReadAdapter {
  const now = () => safeIso(options.now?.() ?? new Date().toISOString());
  const idSalt = options.idSalt ?? DEFAULT_ADAPTER_ID_SALT;

  const projectIdForWorkspace = (workspaceId: string): ConsoleProjectId => opaqueId("project", idSalt, workspaceId);
  const sessionIdForConversation = (conversationHandle: string): ConsoleSessionId => opaqueId("session", idSalt, conversationHandle);

  const buildIndexes = (): AdapterIndexes => {
    const generatedAt = now();
    const degradedStates: ConsoleDegradedState[] = [];
    const projectById = new Map<ConsoleProjectId, ProjectIndexEntry>();
    const sessionById = new Map<ConsoleSessionId, SessionIndexEntry>();

    const workspaceVm = callProvider(
      () => options.provider.listWorkspaceViewModels(),
      "bridge_unavailable",
      "Project list is temporarily unavailable."
    );
    if (!workspaceVm.ok) {
      degradedStates.push(readSourceUnavailableState("Project list is temporarily unavailable."));
      return { generatedAt, projects: [], projectById, sessionById, degradedStates, sourceUnavailable: true };
    }

    if (workspaceVm.value.state !== "available") {
      degradedStates.push(degradedStateFromAvailability("projects", workspaceVm.value.state, workspaceVm.value.warnings));
    }

    const runtimeVm = callProvider(
      () => options.provider.getRuntimeContextViewModel(),
      "bridge_unavailable",
      "Runtime state is temporarily unavailable."
    );
    if (runtimeVm.ok) {
      if (runtimeVm.value.state !== "available") {
        degradedStates.push(degradedStateFromAvailability("runtime", runtimeVm.value.state, runtimeVm.value.warnings));
      }
    } else {
      degradedStates.push(readSourceUnavailableState("Runtime state is temporarily unavailable."));
    }

    const pendingVm = callProvider(
      () => options.provider.getPendingInteractionsViewModel(),
      "bridge_unavailable",
      "Approval state is temporarily unavailable."
    );
    if (pendingVm.ok) {
      if (pendingVm.value.state !== "available") {
        degradedStates.push(degradedStateFromAvailability("approvals", pendingVm.value.state, pendingVm.value.warnings));
      }
    } else {
      degradedStates.push(readSourceUnavailableState("Approval state is temporarily unavailable."));
    }

    const projects: ConsoleProject[] = [];
    for (const workspace of workspaceVm.value.workspaces) {
      const projectId = projectIdForWorkspace(workspace.workspaceId);
      const conversationVm = callProvider(
        () => options.provider.listWorkspaceConversationViewModels(workspace.workspaceId),
        "bridge_unavailable",
        "Session list is temporarily unavailable."
      );
      const conversations = conversationVm.ok ? conversationVm.value.conversations : [];
      const conversationWarnings = conversationVm.ok ? safeWarningCodes(conversationVm.value.warnings) : [conversationVm.error.message];
      const state = conversationVm.ok ? conversationVm.value.state : "unavailable";
      if (state !== "available") {
        degradedStates.push(degradedStateFromAvailability("sessions", state, conversationWarnings));
      }

      const activeConversation = conversations[0] ?? null;
      const activeSessionId = activeConversation ? sessionIdForConversation(activeConversation.conversationHandle) : undefined;
      const project: ConsoleProject = scrubShape({
        projectId,
        title: safeDisplayString(workspace.label, "Workspace", "project.title"),
        ...(workspace.pinned ? { hint: "Pinned" } : {}),
        archived: false,
        sessionCount: Math.max(0, workspace.conversationCount || conversations.length),
        ...(activeSessionId ? { activeSessionId } : {}),
        ...(workspace.lastActivityAt ? { lastActivityAt: safeIso(workspace.lastActivityAt) } : {})
      });

      const entry: ProjectIndexEntry = {
        project,
        conversations,
        state
      };
      projects.push(project);
      projectById.set(projectId, entry);

      for (const conversation of conversations) {
        const sessionId = sessionIdForConversation(conversation.conversationHandle);
        const summary = toSessionSummary(conversation, projectId, sessionId, pendingVm.ok ? pendingVm.value.pendingInteractions : [], idSalt);
        sessionById.set(sessionId, {
          conversation,
          summary
        });
      }
    }

    return {
      generatedAt,
      projects,
      projectById,
      sessionById,
      degradedStates: uniqueDegradedStates(degradedStates),
      sourceUnavailable: false
    };
  };

  const adapter: ConsoleBridgeReadAdapter = {
    getBootstrap() {
      const indexes = buildIndexes();
      const readiness = callProvider(
        () => options.provider.getReadinessGuardrailViewModel(),
        "bridge_unavailable",
        "Readiness state is temporarily unavailable."
      );
      const degradedStates = [...indexes.degradedStates];
      if (readiness.ok) {
        const readinessValue = readiness.value;
        const readinessDegraded = readinessValue.state !== "ready" && readinessValue.state !== "available";
        if (readinessDegraded || readinessValue.warnings.length > 0 || readinessValue.missingGates.length > 0) {
          degradedStates.push(readinessDegradedState(readinessValue));
        }
      } else {
        degradedStates.push(readSourceUnavailableState(readiness.error.message));
      }

      const activeProject = indexes.projects[0];
      const activeSessionId = activeProject?.activeSessionId;
      return scrubShape({
        apiVersion: CONSOLE_API_VERSION,
        generatedAt: indexes.generatedAt,
        viewer: { role: "owner", displayName: "Workspace owner" },
        capabilities: capabilitiesFor(readiness.ok ? readiness.value : null, indexes.degradedStates.length > 0 || !readiness.ok),
        projects: indexes.projects,
        ...(activeProject ? { activeProjectId: activeProject.projectId } : {}),
        ...(activeSessionId ? { activeSessionId } : {}),
        commands: defaultCommands(),
        models: defaultModels(),
        modes: defaultModes(),
        degradedStates: uniqueDegradedStates(degradedStates)
      });
    },

    listProjects() {
      return buildIndexes().projects;
    },

    listProjectSessions(projectId) {
      const indexes = buildIndexes();
      const safeProjectId = parseConsoleId("project", projectId);
      if (!safeProjectId) {
        return apiError("bad_request", "Project id must be an opaque Console project id.", false);
      }
      if (indexes.sourceUnavailable) {
        return apiError("bridge_unavailable", "Session list is temporarily unavailable.", true);
      }
      const project = indexes.projectById.get(safeProjectId);
      if (!project) {
        return apiError("not_found", "Project was not found in the read-only Console view.", false);
      }
      if (project.state === "unavailable") {
        return apiError("bridge_unavailable", "Session list is temporarily unavailable for this project.", true);
      }
      return project.conversations.map((conversation) => {
        const sessionId = sessionIdForConversation(conversation.conversationHandle);
        return indexes.sessionById.get(sessionId)?.summary
          ?? toSessionSummary(conversation, safeProjectId, sessionId, [], idSalt);
      });
    },

    getSessionDetail(sessionId) {
      const indexes = buildIndexes();
      const safeSessionId = parseConsoleId("session", sessionId);
      if (!safeSessionId) {
        return apiError("bad_request", "Session id must be an opaque Console session id.", false);
      }
      if (indexes.sourceUnavailable) {
        return apiError("bridge_unavailable", "Session detail is temporarily unavailable.", true);
      }

      const session = indexes.sessionById.get(safeSessionId);
      if (!session) {
        return apiError("not_found", "Session was not found in the read-only Console view.", false);
      }

      const detailVm = callProvider(
        () => options.provider.getConversationResultViewModel(session.conversation.conversationHandle),
        "bridge_unavailable",
        "Session detail is temporarily unavailable."
      );
      if (!detailVm.ok) {
        return detailVm.error;
      }
      if (!detailVm.value.conversation || detailVm.value.state === "unavailable") {
        return apiError("bridge_unavailable", "Session detail is temporarily unavailable.", true);
      }

      const artifactsVm = callProvider(
        () => options.provider.getConversationArtifactCatalogViewModel(session.conversation.conversationHandle),
        "bridge_unavailable",
        "Artifact list is temporarily unavailable."
      );
      const artifacts = artifactsVm.ok
        ? artifactsVm.value.artifacts.map((artifact, index) => toArtifact(artifact, safeSessionId, idSalt, index))
        : [];
      const parts = detailParts(detailVm.value, safeSessionId, artifacts, idSalt);
      const status = parts.activeRun?.status === "waiting_for_approval"
        ? "waiting_for_approval"
        : parts.activeRun?.status === "running"
          ? "running"
          : session.summary.status;

      return scrubShape({
        ...session.summary,
        status,
        ...((parts.activeRun?.runId ?? session.summary.activeRunId)
          ? { activeRunId: parts.activeRun?.runId ?? session.summary.activeRunId }
          : {}),
        pendingApprovalCount: parts.approvals.filter((approval) => approval.status === "pending").length,
        artifactCount: parts.artifacts.length,
        messages: parts.messages,
        ...(parts.activeRun ? { activeRun: parts.activeRun } : {}),
        diffs: parts.diffs,
        approvals: parts.approvals,
        artifacts: parts.artifacts,
        eventsUrl: `/api/sessions/${safeSessionId}/events`
      });

    },

    resolveConversationHandleForSession(sessionId) {
      const indexes = buildIndexes();
      const safeSessionId = parseConsoleId("session", sessionId);
      if (!safeSessionId || indexes.sourceUnavailable) {
        return null;
      }
      return indexes.sessionById.get(safeSessionId)?.conversation.conversationHandle ?? null;
    }
  };

  return adapter;
}

function toSessionSummary(
  conversation: WebReadonlyConversationRow,
  projectId: ConsoleProjectId,
  sessionId: ConsoleSessionId,
  pendingInteractions: WebReadonlyPendingInteractionViewRow[],
  idSalt: string
): ConsoleSessionSummary {
  const pendingCount = pendingInteractions.filter((row) => row.conversationId === conversation.conversationHandle).length;
  const status = toSessionStatus(conversation.status, conversation.archived, pendingCount);
  const activeRunId = status === "running" || status === "waiting_for_approval"
    ? opaqueId("run", idSalt, `${sessionId}:active`)
    : undefined;
  return scrubShape({
    sessionId,
    projectId,
    title: safeDisplayString(conversation.title, "Untitled session", "session.title"),
    status,
    archived: Boolean(conversation.archived),
    createdAt: safeIso(conversation.createdAt),
    ...(conversation.lastActivityAt ? { lastActivityAt: safeIso(conversation.lastActivityAt) } : {}),
    ...(conversation.finalAnswerAvailable ? { lastMessagePreview: "Final answer available." } : {}),
    ...(activeRunId ? { activeRunId } : {}),
    pendingApprovalCount: pendingCount,
    artifactCount: conversation.finalAnswerAvailable ? 1 : 0
  });
}

function detailParts(
  vm: WebReadonlyConversationResultViewModel,
  sessionId: ConsoleSessionId,
  artifacts: ConsoleArtifactSummary[],
  idSalt: string
): DetailParts {
  const messages: ConsoleMessage[] = [];
  const approvals = vm.pendingInteractions.pendingInteractions.map((interaction, index) =>
    toApproval(interaction, sessionId, idSalt, index)
  );
  const run = toRun(vm, sessionId, idSalt, approvals.length);

  if (vm.conversation) {
    messages.push(scrubShape({
      messageId: opaqueId("message", idSalt, `${sessionId}:system:summary`),
      sessionId,
      role: "system",
      text: safeDisplayString(
        sessionSystemText(vm.conversation.status, vm.readiness.missingGates),
        "Session is visible in read-only mode.",
        "message.text"
      ),
      format: "plain_text",
      status: "complete",
      createdAt: safeIso(vm.conversation.createdAt),
      ...(run ? { runId: run.runId } : {})
    }));
  }

  for (const [index, answer] of vm.answers.entries()) {
    const message = answerToMessage(answer, sessionId, idSalt, index, run?.runId, artifacts.map((artifact) => artifact.artifactId));
    if (!message) {
      continue;
    }
    messages.push(message);
  }

  if (messages.length === 0 && vm.conversation) {
    messages.push(scrubShape({
      messageId: opaqueId("message", idSalt, `${sessionId}:empty`),
      sessionId,
      role: "system",
      text: "No Web-safe messages are available for this session yet.",
      format: "plain_text",
      status: "complete",
      createdAt: safeIso(vm.conversation.createdAt)
    }));
  }

  const diffs = artifacts.length > 0 ? [toDiff(sessionId, run?.runId, artifacts)] : [];
  return {
    messages,
    ...(run ? { activeRun: run } : {}),
    diffs,
    approvals,
    artifacts
  };
}

function answerToMessage(
  answer: WebReadonlyAnswerRow,
  sessionId: ConsoleSessionId,
  idSalt: string,
  index: number,
  runId: ConsoleRunState["runId"] | undefined,
  artifactIds: ConsoleArtifactSummary["artifactId"][]
): ConsoleMessage | null {
  const body = answer.body.state === "available" ? answer.body.text : answer.summary;
  const text = safeOptionalText(body, `message.${index}.text`);
  if (!text) {
    return null;
  }

  const status = answer.deliveryState === "failed" ? "failed" : "complete" satisfies ConsoleMessageStatus;
  return scrubShape({
    messageId: opaqueId("message", idSalt, `${sessionId}:answer:${answer.answerId}:${index}`),
    sessionId,
    role: "assistant",
    text,
    format: answer.body.state === "available" ? "markdown" : "plain_text",
    status,
    createdAt: safeIso(answer.createdAt),
    ...(runId ? { runId } : {}),
    ...(artifactIds.length > 0 ? { artifactIds } : {})
  });
}

function toRun(
  vm: WebReadonlyConversationResultViewModel,
  sessionId: ConsoleSessionId,
  idSalt: string,
  pendingApprovalCount: number
): ConsoleRunState | undefined {
  const activeTurn = vm.runtime.activeTurns[0];
  const conversation = vm.conversation;
  if (!activeTurn && !conversation) {
    return undefined;
  }

  const status = runStatus(activeTurn, conversation?.status, pendingApprovalCount);
  const updatedAt = safeIso(conversation?.lastActivityAt ?? new Date(0).toISOString());
  const steps = runSteps(activeTurn, vm.answers.length, pendingApprovalCount);
  return scrubShape({
    runId: opaqueId("run", idSalt, `${sessionId}:active`),
    sessionId,
    title: safeDisplayString(activeTurn?.summary ?? conversation?.title ?? "Session activity", "Session activity", "run.title"),
    status,
    progressLabel: progressLabel(status, steps),
    progressPercent: progressPercent(status, steps),
    steps,
    ...(conversation?.createdAt ? { startedAt: safeIso(conversation.createdAt) } : {}),
    updatedAt,
    ...(status === "completed" || status === "failed" || status === "cancelled" ? { completedAt: updatedAt } : {})
  });
}

function runSteps(activeTurn: WebReadonlyRuntimeTurnRow | undefined, answerCount: number, pendingApprovalCount: number): ConsoleRunStep[] {
  const steps: ConsoleRunStep[] = [
    { order: 1, label: "Session opened", state: "done" }
  ];
  if (activeTurn) {
    steps.push({
      order: 2,
      label: safeDisplayString(activeTurn.summary ?? "Codex is working", "Codex is working", "run.step"),
      state: activeTurn.blockedReason ? "done" : "active",
      ...(activeTurn.blockedReason ? { summary: safeDisplayString(activeTurn.blockedReason, "Waiting", "run.step.summary") } : {})
    });
  }
  if (pendingApprovalCount > 0) {
    steps.push({ order: steps.length + 1, label: "Awaiting owner approval", state: "active" });
  }
  if (answerCount > 0) {
    steps.push({ order: steps.length + 1, label: "Final answer available", state: "done" });
  }
  return steps.map((step, index) => ({ ...step, order: index + 1 }));
}

function toApproval(
  interaction: WebReadonlyPendingInteractionViewRow,
  sessionId: ConsoleSessionId,
  idSalt: string,
  index: number
): ConsoleApprovalRequest {
  const summaryText = interaction.summary.state === "available" ? interaction.summary.text : interaction.blockingReason;
  return scrubShape({
    approvalId: opaqueId("approval", idSalt, `${sessionId}:approval:${interaction.interactionId}:${index}`),
    sessionId,
    title: safeDisplayString(kindTitle(interaction.kind), "Approval required", "approval.title"),
    body: safeDisplayString(summaryText, "Awaiting owner input; details are hidden for this read-only surface.", "approval.body"),
    kind: approvalKind(interaction.kind),
    status: approvalStatus(interaction.status),
    requestedAt: safeIso(interaction.createdAt ?? new Date(0).toISOString()),
    options: [
      { answer: "approve", label: "Approve", style: "primary" },
      { answer: "deny", label: "Deny", style: "secondary" }
    ]
  });
}

function toArtifact(
  artifact: WebReadonlyArtifactDescriptorRow,
  sessionId: ConsoleSessionId,
  idSalt: string,
  index: number
): ConsoleArtifactSummary {
  const artifactId = opaqueId("artifact", idSalt, `${sessionId}:artifact:${artifact.artifactId}:${index}`);
  const title = safeDisplayString(artifact.label, "Artifact", "artifact.title");
  const mediaType = artifact.mediaType ? safeMediaType(artifact.mediaType) : undefined;
  return scrubShape({
    artifactId,
    sessionId,
    kind: artifactKind(artifact.kind, artifact.type),
    status: artifactStatus(artifact.availability),
    title,
    displayName: title,
    ...(mediaType ? { mediaType } : {}),
    ...(typeof artifact.sizeBytes === "number" ? { sizeBytes: artifact.sizeBytes } : {}),
    url: `/api/artifacts/${artifactId}`,
    files: [{
      displayName: title,
      status: artifactKind(artifact.kind, artifact.type) === "generated_file" ? "generated" : "modified"
    }]
  });
}

function toDiff(
  sessionId: ConsoleSessionId,
  runId: ConsoleRunState["runId"] | undefined,
  artifacts: ConsoleArtifactSummary[]
): ConsoleDiffSummary {
  const files: ConsoleDiffFileSummary[] = artifacts.flatMap((artifact) =>
    (artifact.files ?? []).map((file) => ({
      displayName: file.displayName,
      status: file.status === "created" || file.status === "generated" ? "created" : file.status,
      added: file.added ?? 0,
      removed: file.removed ?? 0
    }))
  );
  return scrubShape({
    sessionId,
    ...(runId ? { runId } : {}),
    title: "Artifacts available",
    status: "preview",
    totals: {
      changedFiles: files.length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0)
    },
    files
  });
}

function capabilitiesFor(readiness: WebReadonlyReadinessGuardrailViewModel | null, degraded: boolean): ConsoleCapabilities {
  const missing = new Set(readiness?.missingGates ?? []);
  const readState: ConsoleCapability = degraded || !readiness || readiness.state !== "ready"
    ? { state: "degraded", reason: "Read source is partially available." }
    : { state: "enabled" };
  if (missing.size > 0) {
    readState.reason = "Bridge readiness has missing gates.";
    readState.ownerAction = "Check the bridge service readiness before relying on live updates.";
  }

  const disabled = (reason = READ_ONLY_REASON): ConsoleCapability => ({ state: "disabled", reason });
  return {
    archiveProject: disabled(),
    createSession: disabled(),
    sendMessage: disabled(),
    answerApproval: disabled("Approval answers are not enabled in the read-only adapter."),
    uploadFiles: disabled("Uploads are not enabled in the read-only adapter."),
    streamEvents: readState,
    fetchArtifacts: readState
  };
}

function defaultCommands() {
  return [
    { name: "/help", label: "Help", enabled: true },
    { name: "/status", label: "Status", enabled: true },
    { name: "/where", label: "Where", enabled: true },
    { name: "/model", label: "Model", enabled: true },
    { name: "/review", label: "Review", enabled: false },
    { name: "/rollback", label: "Rollback", enabled: false }
  ];
}

function defaultModels() {
  return [
    { value: "gpt-5.5", label: "GPT-5.5", enabled: true },
    { value: "gpt-5.4", label: "GPT-5.4", enabled: true },
    { value: "gpt-5", label: "GPT-5", enabled: true }
  ];
}

function defaultModes() {
  return [
    { value: "auto", label: "Auto", enabled: true },
    { value: "plan", label: "Plan", enabled: true },
    { value: "review", label: "Review only", enabled: false }
  ];
}

function toSessionStatus(status: string, archived: boolean, pendingApprovalCount: number): ConsoleSessionStatus {
  if (archived) {
    return "archived";
  }
  if (pendingApprovalCount > 0) {
    return "waiting_for_approval";
  }
  const normalized = status.trim().toLowerCase();
  if (["running", "active", "streaming"].includes(normalized)) {
    return "running";
  }
  if (["completed", "complete", "succeeded", "success"].includes(normalized)) {
    return "completed";
  }
  if (["failed", "error"].includes(normalized)) {
    return "failed";
  }
  if (["empty", "new"].includes(normalized)) {
    return "empty";
  }
  return "idle";
}

function runStatus(
  activeTurn: WebReadonlyRuntimeTurnRow | undefined,
  conversationStatus: string | undefined,
  pendingApprovalCount: number
): ConsoleRunStatus {
  if (pendingApprovalCount > 0 || activeTurn?.blockedReason) {
    return "waiting_for_approval";
  }
  const status = (activeTurn?.status ?? conversationStatus ?? "idle").trim().toLowerCase();
  if (["running", "active", "streaming"].includes(status)) {
    return "running";
  }
  if (["failed", "error"].includes(status)) {
    return "failed";
  }
  if (["cancelled", "canceled", "interrupted"].includes(status)) {
    return "cancelled";
  }
  if (["completed", "complete", "succeeded", "success"].includes(status)) {
    return "completed";
  }
  return "queued";
}

function approvalStatus(status: string): ConsoleApprovalRequest["status"] {
  const normalized = status.trim().toLowerCase();
  if (["approved", "accepted", "allowed"].includes(normalized)) {
    return "approved";
  }
  if (["denied", "rejected", "declined"].includes(normalized)) {
    return "denied";
  }
  if (["expired", "timed_out", "timeout"].includes(normalized)) {
    return "expired";
  }
  return "pending";
}

function approvalKind(kind: string): ConsoleApprovalKind {
  const normalized = kind.trim().toLowerCase();
  if (normalized.includes("command") || normalized.includes("exec")) {
    return "command";
  }
  if (normalized.includes("file") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("network") || normalized.includes("web")) {
    return "network";
  }
  if (normalized.includes("external")) {
    return "external_action";
  }
  return "other";
}

function artifactKind(kind: string, type: string | null): ConsoleArtifactKind {
  const normalized = `${kind} ${type ?? ""}`.trim().toLowerCase();
  if (normalized.includes("diff")) {
    return "diff";
  }
  if (normalized.includes("summary") || normalized.includes("markdown")) {
    return "run_summary";
  }
  if (normalized.includes("generated")) {
    return "generated_file";
  }
  if (normalized.includes("file") || normalized.includes("document")) {
    return "changed_file";
  }
  return "attachment";
}

function artifactStatus(availability: WebReadonlyAvailability): ConsoleArtifactStatus {
  if (availability === "available") {
    return "ready";
  }
  if (availability === "degraded") {
    return "pending";
  }
  return "failed";
}

function kindTitle(kind: string): string {
  const normalized = kind.trim().replace(/[_-]+/g, " ");
  return normalized ? `Approval required: ${normalized}` : "Approval required";
}

function sessionSystemText(status: string, missingGates: string[]): string {
  if (missingGates.length > 0) {
    return `Session is visible in read-only mode. Missing readiness gates: ${missingGates.slice(0, 3).join(", ")}.`;
  }
  return `Session is visible in read-only mode with status ${status || "unknown"}.`;
}

function progressLabel(status: ConsoleRunStatus, steps: ConsoleRunStep[]): string {
  if (status === "completed") {
    return "Completed";
  }
  if (status === "waiting_for_approval") {
    return "Waiting for approval";
  }
  const done = steps.filter((step) => step.state === "done").length;
  return `${done}/${steps.length} steps`;
}

function progressPercent(status: ConsoleRunStatus, steps: ConsoleRunStep[]): number {
  if (status === "completed") {
    return 100;
  }
  if (status === "failed" || status === "cancelled") {
    return 100;
  }
  if (steps.length === 0) {
    return 0;
  }
  return Math.max(5, Math.min(95, Math.round((steps.filter((step) => step.state === "done").length / steps.length) * 100)));
}

function degradedStateFromAvailability(kind: string, state: WebReadonlyAvailability | "empty", warnings: string[]): ConsoleDegradedState {
  if (state === "unavailable") {
    return readSourceUnavailableState(`${titleCase(kind)} read source is unavailable.`);
  }
  return scrubShape({
    code: `${kind}_degraded`,
    title: `${titleCase(kind)} data is degraded`,
    body: safeDisplayString(warnings[0] ?? `${titleCase(kind)} data is partially available.`, "Read source is degraded.", "degraded.body"),
    ownerAction: "Refresh later or check bridge readiness."
  });
}

function readinessDegradedState(readiness: WebReadonlyReadinessGuardrailViewModel): ConsoleDegradedState {
  const body = readiness.missingGates[0] ?? readiness.warnings[0] ?? "Bridge readiness is not fully available.";
  return scrubShape({
    code: "readiness_degraded",
    title: "Bridge readiness needs attention",
    body: safeDisplayString(body, "Bridge readiness is not fully available.", "degraded.body"),
    ownerAction: "Check the bridge service readiness."
  });
}

function readSourceUnavailableState(message: string): ConsoleDegradedState {
  return scrubShape({
    code: "read_source_unavailable",
    title: "Read source unavailable",
    body: safeDisplayString(message, "Console read source is unavailable.", "degraded.body"),
    ownerAction: "Check the bridge service and retry."
  });
}

function apiError(code: ConsoleApiError["code"], message: string, retryable: boolean): ConsoleApiError {
  return scrubShape({
    code,
    message: safeDisplayString(message, "Console read request failed.", "error.message"),
    retryable
  });
}

function callProvider<T>(fn: () => T, code: ConsoleApiError["code"], message: string): { ok: true; value: T } | { ok: false; error: ConsoleApiError } {
  try {
    return { ok: true, value: fn() };
  } catch {
    return { ok: false, error: apiError(code, message, true) };
  }
}

function opaqueId<K extends Parameters<typeof assertConsoleOpaqueId>[0]>(
  kind: K,
  salt: string,
  value: string
): ReturnType<typeof assertConsoleOpaqueId<K>> {
  const digest = createHash("sha256").update(salt).update("\0").update(value).digest("base64url").slice(0, 18);
  return assertConsoleOpaqueId(kind, `${prefixFor(kind)}_a${digest}0`, `${kind}Id`) as ReturnType<typeof assertConsoleOpaqueId<K>>;
}

function prefixFor(kind: Parameters<typeof assertConsoleOpaqueId>[0]): string {
  switch (kind) {
    case "project": return "prj";
    case "session": return "ses";
    case "message": return "msg";
    case "run": return "run";
    case "approval": return "apr";
    case "artifact": return "art";
  }
}

function parseConsoleId<K extends Parameters<typeof assertConsoleOpaqueId>[0]>(kind: K, value: unknown): ReturnType<typeof assertConsoleOpaqueId<K>> | null {
  try {
    return assertConsoleOpaqueId(kind, value, `${kind}Id`) as ReturnType<typeof assertConsoleOpaqueId<K>>;
  } catch {
    return null;
  }
}

function scrubShape<T>(value: T): T {
  visitShape(value, (node, key) => {
    if (typeof node === "string") {
      assertConsoleSafeString(node, key ?? "value");
    }
  });
  return value;
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

function safeDisplayString(value: unknown, fallback: string, fieldName: string): string {
  const normalized = normalizeText(value);
  const candidates = [normalized, redactUnsafeText(normalized), fallback];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      continue;
    }
    try {
      return assertConsoleSafeString(trimmed, fieldName);
    } catch {
      // Try next candidate.
    }
  }
  return assertConsoleSafeString("Unavailable", fieldName);
}

function safeOptionalText(value: unknown, fieldName: string): string | null {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  try {
    return assertConsoleSafeString(text, fieldName);
  } catch {
    const redacted = redactUnsafeText(text);
    try {
      return assertConsoleSafeString(redacted, fieldName);
    } catch {
      return null;
    }
  }
}

function safeIso(value: string): string {
  const text = normalizeText(value);
  try {
    assertConsoleSafeString(text, "timestamp");
    return text;
  } catch {
    return new Date(0).toISOString();
  }
}

function safeWarningCodes(warnings: string[]): string[] {
  return warnings.map((warning) => safeDisplayString(warning, "read_source_warning", "warning"));
}

function safeMediaType(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function redactUnsafeText(value: string): string {
  return value
    .replace(/\b(?:https?|file):\/\/[^\s"'<>)]*/gi, "[redacted-url]")
    .replace(/(?:^|[\s"'(])(?:\/(?:home|tmp|var|etc|root|Users|usr)\/[^\s<>"']*|~\/[^\s<>"']*|[A-Za-z]:\\[^\s<>"']*)/g, " [redacted-path]")
    .replace(/\b(?:telegram|feishu)[_-]?(?:chat|message|user|open|union|tenant)?[_-]?id\b/gi, "platform-id")
    .replace(/\b(?:telegram|feishu|lark)\b/gi, "platform")
    .replace(/\b(?:chat|callback|open|union|tenant|message|user|thread)[_-]?id\b/gi, "platform-id")
    .replace(/\bcallback[_-]?data\b/gi, "callback-data")
    .replace(/\b(?:token|authorization|bearer|api[_-]?key|secret|password)\s*[:=]\s*\S+/gi, "[redacted-secret]")
    .replace(/\bsecret\b/gi, "redacted")
    .replace(/\b(?:sk|xox[baprs])-[A-Za-z0-9_-]{8,}/gi, "[redacted-secret]")
    .replace(/\b(?:pid|process[_-]?id)\s*[:=]?\s*\d{2,}\b/gi, "process-id")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueDegradedStates(states: ConsoleDegradedState[]): ConsoleDegradedState[] {
  const seen = new Set<string>();
  const result: ConsoleDegradedState[] = [];
  for (const state of states) {
    const key = `${state.code}:${state.body}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(state);
  }
  return result;
}

function titleCase(value: string): string {
  return value ? value[0]?.toUpperCase() + value.slice(1) : "Read source";
}
