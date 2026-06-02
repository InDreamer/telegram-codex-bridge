import type {
  ConsoleArtifactSummary,
  ConsoleBootstrap,
  ConsoleCapabilities,
  ConsoleCapability,
  ConsoleDiffSummary,
  ConsoleMessage,
  ConsoleProject,
  ConsoleProjectId,
  ConsoleRunState,
  ConsoleRunStepState,
  ConsoleSessionDetail,
  ConsoleSessionId,
  ConsoleSessionStatus,
  ConsoleSessionSummary
} from "./console-api-contract.js";
import type {
  ConsoleProductAppModel,
  ConsoleProductArtifactFile,
  ConsoleProductDiffLine,
  ConsoleProductProject,
  ConsoleProductRunStep,
  ConsoleProductSession,
  ConsoleProductTimelineItem
} from "./console-product-model.js";
import { createConsoleProductMock } from "./console-product-mock.js";

export interface ConsoleProductApiModelInput {
  bootstrap: ConsoleBootstrap;
  projectSessions: Map<ConsoleProjectId, ConsoleSessionSummary[]>;
  activeSessionDetail?: ConsoleSessionDetail | null;
  csrfToken?: string | null;
  capabilityOverrides?: Partial<Pick<ConsoleCapabilities, "sendMessage">>;
}

const disabledCapability: ConsoleCapability = { state: "disabled", reason: "This action is not available from Web yet." };

export function createConsoleProductApiModel(input: ConsoleProductApiModelInput): ConsoleProductAppModel {
  const bootstrap = input.bootstrap;
  const activeProject = findActiveProject(bootstrap.projects, bootstrap.activeProjectId);
  const activeSession = input.activeSessionDetail ?? findActiveSession(input.projectSessions, bootstrap.activeSessionId);
  const activeSessionId = activeSession?.sessionId ?? bootstrap.activeSessionId;
  const bootstrapCapabilities: ConsoleCapabilities = {
    ...bootstrap.capabilities,
    ...(input.capabilityOverrides?.sendMessage ? { sendMessage: input.capabilityOverrides.sendMessage } : {})
  };
  const sendCapability = effectiveComposerSendCapability(bootstrapCapabilities.sendMessage, activeSessionId, input.csrfToken);
  const capabilities: ConsoleCapabilities = { ...bootstrapCapabilities, sendMessage: sendCapability };
  const canSend = sendCapability.state === "enabled" && Boolean(activeSessionId && input.csrfToken);
  const fallback = createConsoleProductMock();
  const degradedState = bootstrap.degradedStates[0];
  const projects = bootstrap.projects.length > 0
    ? bootstrap.projects.map((project) => toProductProject(project, input.projectSessions.get(project.projectId) ?? [], activeSessionId, capabilities))
    : [emptyProject()];
  const title = "Codex Console";
  const projectName = activeProject?.title ?? projects[0]?.name ?? "No project selected";
  const sessionTitle = activeSession?.title ?? "No session selected";
  const activeRun = input.activeSessionDetail?.activeRun;
  const diffs = input.activeSessionDetail?.diffs ?? [];
  const artifacts = input.activeSessionDetail?.artifacts ?? [];
  const approvals = input.activeSessionDetail?.approvals ?? [];
  const messages = input.activeSessionDetail?.messages ?? [];
  const status = activeRun?.status === "running" || activeRun?.status === "queued" || activeSession?.status === "running"
    ? "running"
    : "online";

  return {
    title,
    currentProject: projectName,
    currentSession: sessionTitle,
    currentModel: selectedOption(bootstrap.models, fallback.currentModel),
    currentMode: selectedOption(bootstrap.modes, fallback.currentMode),
    status,
    source: "api",
    apiRoot: "/api",
    ...(activeProject ? { activeProjectId: activeProject.projectId } : {}),
    ...(activeSessionId ? { activeSessionId } : {}),
    capabilities,
    commands: bootstrap.commands.length > 0 ? bootstrap.commands.map((command) => command.name || command.label).slice(0, 8) : fallback.commands,
    modelOptions: optionLabels(bootstrap.models, fallback.modelOptions),
    modeOptions: optionLabels(bootstrap.modes, fallback.modeOptions),
    projects,
    timeline: toTimeline(messages, activeSession?.createdAt),
    runCard: activeRun ? toRunCard(activeRun) : idleRunCard(activeSession?.status),
    diffCard: toDiffCard(diffs[0], artifacts),
    approvalCard: toApprovalCard(approvals, capabilities.answerApproval),
    contextCard: {
      title: "Project context",
      summary: contextSummary(projectName, sessionTitle, bootstrap.degradedStates.length),
      chips: contextChips(activeProject, activeSession, capabilities),
      actionLabel: "Change context unavailable"
    },
    artifactCard: toArtifactCard(artifacts),
    emptyState: {
      title: activeSession ? "Session ready" : "Start a new session",
      body: activeSession
        ? "This chat is loaded from the Console API. Use the composer when live text send is enabled."
        : `New sessions stay unavailable until the API reports ${capabilityAvailableCopy(capabilities.createSession)}.`,
      ctaLabel: capabilities.createSession.state === "enabled" ? "+ New session" : "+ New unavailable"
    },
    degradedState: {
      title: degradedState?.title ?? "Live Console data loaded",
      body: degradedState?.body ?? "Home is using the Console API read model for projects, sessions, and the selected chat.",
      ownerAction: degradedState?.ownerAction ?? "Archive, new session, approvals, uploads, and streams stay gated by reported capabilities."
    },
    composer: {
      placeholder: canSend ? "Message Codex or type /" : disabledComposerPlaceholder(sendCapability),
      label: "Message Codex",
      controls: ["Attach", "Command", "Mic", ...(canSend ? ["Send"] : [])],
      ...(activeSessionId ? { sessionId: activeSessionId, sendEndpoint: `/api/sessions/${activeSessionId}/messages` } : {}),
      ...(input.csrfToken ? { csrfToken: input.csrfToken } : {}),
      sendCapability,
      ...(!canSend ? { unavailableCopy: capabilityDisabledCopy(sendCapability, "Text send is unavailable from Web right now.") } : {})
    }
  };
}

function findActiveProject(projects: ConsoleProject[], activeProjectId: ConsoleProjectId | undefined): ConsoleProject | null {
  return projects.find((project) => project.projectId === activeProjectId) ?? projects[0] ?? null;
}

function findActiveSession(
  sessionsByProject: Map<ConsoleProjectId, ConsoleSessionSummary[]>,
  activeSessionId: ConsoleSessionId | undefined
): ConsoleSessionSummary | null {
  for (const sessions of sessionsByProject.values()) {
    const selected = activeSessionId ? sessions.find((session) => session.sessionId === activeSessionId) : sessions[0];
    if (selected) {
      return selected;
    }
  }
  return null;
}

function toProductProject(
  project: ConsoleProject,
  sessions: ConsoleSessionSummary[],
  activeSessionId: ConsoleSessionId | undefined,
  capabilities: ConsoleCapabilities
): ConsoleProductProject {
  const expanded = sessions.some((session) => session.sessionId === activeSessionId) || project.projectId === sessions[0]?.projectId;
  return {
    projectId: project.projectId,
    name: project.title,
    branch: project.branch ?? (project.archived ? "archived" : "active"),
    hint: project.hint ?? `${project.sessionCount} session${project.sessionCount === 1 ? "" : "s"}`,
    expanded,
    archiveCapability: capabilities.archiveProject,
    createSessionCapability: capabilities.createSession,
    sessions: sessions.length > 0 ? sessions.map((session) => toProductSession(session, activeSessionId)) : [emptySession(project.projectId)]
  };
}

function toProductSession(session: ConsoleSessionSummary, activeSessionId: ConsoleSessionId | undefined): ConsoleProductSession {
  return {
    sessionId: session.sessionId,
    title: session.title,
    age: sessionAge(session),
    status: sessionStatusLabel(session.status),
    active: session.sessionId === activeSessionId
  };
}

function emptyProject(): ConsoleProductProject {
  return {
    name: "No live projects yet",
    branch: "empty",
    hint: "API connected",
    expanded: true,
    archiveCapability: disabledCapability,
    createSessionCapability: disabledCapability,
    sessions: [{ title: "No sessions available", age: "Waiting for Console data", status: "Empty", active: true }]
  };
}

function emptySession(_projectId: ConsoleProjectId): ConsoleProductSession {
  return {
    title: "No sessions available",
    age: "No recent work",
    status: "Empty",
    active: false
  } satisfies ConsoleProductSession;
}

function sessionAge(session: ConsoleSessionSummary): string {
  return relativeTime(session.lastActivityAt ?? session.createdAt) ?? sessionStatusLabel(session.status);
}

function relativeTime(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return null;
  }
  const now = Date.now();
  const diff = Math.max(0, now - time);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "Just now";
  if (diff < hour) return `${Math.max(1, Math.round(diff / minute))}m ago`;
  if (diff < day) return `${Math.max(1, Math.round(diff / hour))}h ago`;
  if (diff < 7 * day) return `${Math.max(1, Math.round(diff / day))}d ago`;
  return new Date(time).toLocaleDateString("en", { month: "short", day: "numeric" });
}

function sessionStatusLabel(status: ConsoleSessionStatus | string | undefined): string {
  switch (status) {
    case "running": return "Running";
    case "waiting_for_approval": return "Approval needed";
    case "completed": return "Done";
    case "failed": return "Failed";
    case "archived": return "Archived";
    case "empty": return "Empty";
    case "idle": return "Idle";
    default: return "Available";
  }
}

function selectedOption(options: Array<{ label: string; enabled: boolean }>, fallback: string): string {
  return options.find((option) => option.enabled)?.label ?? options[0]?.label ?? fallback;
}

function optionLabels(options: Array<{ label: string }>, fallback: string[]): string[] {
  return options.length > 0 ? options.map((option) => option.label) : fallback;
}

function toTimeline(messages: ConsoleMessage[], createdAt: string | undefined): ConsoleProductTimelineItem[] {
  const visibleMessages = messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-12);
  if (visibleMessages.length === 0) {
    return [{
      role: "assistant",
      body: "This session is loaded from the Console API. No Web-safe chat messages are available yet.",
      time: timeLabel(createdAt)
    }];
  }
  return visibleMessages.map((message) => ({
    role: message.role,
    body: message.text,
    time: timeLabel(message.createdAt)
  }));
}

function timeLabel(value: string | undefined): string {
  if (!value) {
    return "Now";
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    return "Now";
  }
  return new Date(time).toLocaleTimeString("en", { hour: "numeric", minute: "2-digit" });
}

function toRunCard(run: ConsoleRunState) {
  return {
    title: run.title,
    status: runStatusLabel(run.status),
    progressLabel: run.progressLabel ?? runStatusLabel(run.status),
    progressPercent: run.progressPercent ?? 0,
    steps: run.steps.length > 0 ? run.steps.map(toRunStep) : [{ label: runStatusLabel(run.status), state: "active" as const }],
    cancelLabel: "Interrupt unavailable"
  };
}

function idleRunCard(status: ConsoleSessionStatus | undefined) {
  return {
    title: status === "empty" || !status ? "No active run" : "Session activity",
    status: sessionStatusLabel(status),
    progressLabel: status === "completed" ? "Completed" : "Idle",
    progressPercent: status === "completed" ? 100 : 0,
    steps: [
      { label: "Console API loaded", state: "done" as const },
      { label: "Waiting for next message", state: status === "running" ? "active" as const : "pending" as const }
    ],
    cancelLabel: "Interrupt unavailable"
  };
}

function toRunStep(step: { label: string; state: ConsoleRunStepState }): ConsoleProductRunStep {
  return {
    label: step.label,
    state: step.state === "done"
      ? "done"
      : step.state === "active"
        ? "active"
        : step.state === "failed"
          ? "failed"
          : step.state === "skipped"
            ? "skipped"
            : "pending"
  };
}

function runStatusLabel(status: ConsoleRunState["status"]): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "waiting_for_approval": return "Approval needed";
    case "completed": return "Completed";
    case "failed": return "Failed";
    case "cancelled": return "Cancelled";
  }
}

function toDiffCard(diff: ConsoleDiffSummary | undefined, artifacts: ConsoleArtifactSummary[]) {
  if (diff) {
    const files = diff.files.slice(0, 4);
    const lines: ConsoleProductDiffLine[] = files.length > 0
      ? files.map((file, index) => ({
        number: String(index + 1),
        kind: file.status === "deleted" ? "remove" : file.status === "created" ? "add" : "context",
        text: `${diffLinePrefix(file.status)} ${file.displayName} (+${file.added} −${file.removed})`
      }))
      : [{ number: "1", kind: "context", text: diff.title }];
    return {
      filename: diff.title,
      added: diff.totals.added,
      removed: diff.totals.removed,
      lines,
      actions: ["Review diff unavailable", "Open files unavailable"]
    };
  }
  const firstArtifact = artifacts[0];
  return {
    filename: firstArtifact?.displayName ?? "No diff preview",
    added: 0,
    removed: 0,
    lines: [{ number: "—", kind: "context" as const, text: firstArtifact ? "Artifact metadata is available." : "No file changes are visible from the Console API yet." }],
    actions: ["Review diff unavailable", "Open files unavailable"]
  };
}

function diffLinePrefix(status: string): string {
  switch (status) {
    case "created": return "+";
    case "deleted": return "−";
    case "renamed": return "↔";
    default: return "•";
  }
}

function toApprovalCard(approvals: ConsoleSessionDetail["approvals"], capability: ConsoleCapability) {
  const pending = approvals.filter((approval) => approval.status === "pending");
  return {
    title: pending.length > 0 ? "Approval required" : "Approvals unavailable",
    pendingCount: pending.length,
    items: pending.length > 0
      ? pending.slice(0, 3).map((approval) => ({ title: approval.title, detail: approval.body }))
      : [{
        title: "No pending approvals",
        detail: capabilityDisabledCopy(capability, "Approval answers are unavailable from Web right now.")
      }],
    actions: capability.state === "enabled" ? ["Review"] : ["Review unavailable", "Approve unavailable"]
  };
}

function toArtifactCard(artifacts: ConsoleArtifactSummary[]) {
  const files: ConsoleProductArtifactFile[] = artifacts.flatMap((artifact): ConsoleProductArtifactFile[] => {
    const artifactFiles: ConsoleProductArtifactFile[] = artifact.files?.map((file) => ({ name: file.displayName, status: file.status })) ?? [];
    return artifactFiles.length > 0 ? artifactFiles : [{ name: artifact.displayName, status: artifact.status }];
  });
  return {
    title: "Files & artifacts",
    summary: artifacts.length > 0
      ? `${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} available as safe metadata.`
      : "No artifacts are visible from the Console API yet.",
    files: files.slice(0, 4),
    actionLabel: "Open files unavailable"
  };
}

function contextSummary(projectName: string, sessionTitle: string, degradedCount: number): string {
  if (degradedCount > 0) {
    return `${projectName} / ${sessionTitle} loaded with ${degradedCount} degraded Console API state${degradedCount === 1 ? "" : "s"}.`;
  }
  return `${projectName} / ${sessionTitle} loaded from the Console API.`;
}

function contextChips(project: ConsoleProject | null, session: ConsoleSessionSummary | null, capabilities: ConsoleCapabilities): string[] {
  return [
    project?.archived ? "Archived project" : "Active project",
    session ? sessionStatusLabel(session.status) : "No session",
    capabilities.sendMessage.state === "enabled" ? "Text send enabled" : "Text send disabled",
    capabilities.createSession.state === "enabled" ? "New session enabled" : "New session disabled"
  ];
}

function disabledComposerPlaceholder(capability: ConsoleCapability): string {
  return capability.state === "degraded" ? "Message unavailable while Console send is degraded" : "Message unavailable from Web";
}

function effectiveComposerSendCapability(
  capability: ConsoleCapability,
  activeSessionId: ConsoleSessionId | undefined,
  csrfToken: string | null | undefined
): ConsoleCapability {
  if (capability.state !== "enabled") {
    return capability;
  }
  if (!activeSessionId) {
    return { state: "disabled", reason: "Choose an available session before sending from Web." };
  }
  if (!csrfToken) {
    return { state: "disabled", reason: "Console write capability requires CSRF protection." };
  }
  return capability;
}

function capabilityAvailableCopy(capability: ConsoleCapability): string {
  return capability.state === "enabled" ? "the action is enabled" : "the capability is enabled";
}

function capabilityDisabledCopy(capability: ConsoleCapability, fallback: string): string {
  if (capability.state === "enabled") {
    return "Available.";
  }
  return capability.reason || capability.ownerAction || fallback;
}
