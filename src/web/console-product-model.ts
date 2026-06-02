export interface ConsoleProductAppModel {
  title: string;
  currentProject: string;
  currentSession: string;
  currentModel: string;
  currentMode: string;
  status: "online" | "running";
  source?: "demo" | "api";
  apiRoot?: string;
  activeProjectId?: string;
  activeSessionId?: string;
  capabilities?: ConsoleProductCapabilities;
  projects: ConsoleProductProject[];
  commands: string[];
  modelOptions: string[];
  modeOptions: string[];
  timeline: ConsoleProductTimelineItem[];
  runCard: ConsoleProductRunCard;
  diffCard: ConsoleProductDiffCard;
  approvalCard: ConsoleProductApprovalCard;
  contextCard: ConsoleProductContextCard;
  artifactCard: ConsoleProductArtifactCard;
  emptyState: ConsoleProductEmptyStateCard;
  degradedState: ConsoleProductDegradedStateCard;
  composer: ConsoleProductComposer;
}

export interface ConsoleProductCapabilities {
  archiveProject: ConsoleProductCapability;
  createSession: ConsoleProductCapability;
  sendMessage: ConsoleProductCapability;
  answerApproval: ConsoleProductCapability;
  uploadFiles?: ConsoleProductCapability;
  streamEvents?: ConsoleProductCapability;
  fetchArtifacts?: ConsoleProductCapability;
}

export interface ConsoleProductCapability {
  state: "enabled" | "disabled" | "degraded";
  reason?: string;
  ownerAction?: string;
}

export interface ConsoleProductProject {
  projectId?: string;
  name: string;
  branch: string;
  hint: string;
  expanded: boolean;
  sessions: ConsoleProductSession[];
  archiveCapability?: ConsoleProductCapability;
  createSessionCapability?: ConsoleProductCapability;
}

export interface ConsoleProductSession {
  sessionId?: string;
  title: string;
  age: string;
  status?: string;
  active?: boolean;
}

export interface ConsoleProductTimelineItem {
  role: "user" | "assistant" | "system";
  body: string;
  time: string;
}

export interface ConsoleProductRunCard {
  title: string;
  status: string;
  progressLabel: string;
  progressPercent: number;
  steps: ConsoleProductRunStep[];
  cancelLabel: string;
}

export interface ConsoleProductRunStep {
  label: string;
  state: "done" | "active" | "pending" | "failed" | "skipped";
}

export interface ConsoleProductDiffCard {
  filename: string;
  added: number;
  removed: number;
  lines: ConsoleProductDiffLine[];
  actions: string[];
}

export interface ConsoleProductDiffLine {
  number: string;
  kind: "add" | "remove" | "context";
  text: string;
}

export interface ConsoleProductApprovalCard {
  title: string;
  pendingCount: number;
  items: ConsoleProductApprovalItem[];
  actions: string[];
}

export interface ConsoleProductApprovalItem {
  title: string;
  detail: string;
}

export interface ConsoleProductContextCard {
  title: string;
  summary: string;
  chips: string[];
  actionLabel: string;
}

export interface ConsoleProductArtifactCard {
  title: string;
  summary: string;
  files: ConsoleProductArtifactFile[];
  actionLabel: string;
}

export interface ConsoleProductArtifactFile {
  name: string;
  status: string;
}

export interface ConsoleProductEmptyStateCard {
  title: string;
  body: string;
  ctaLabel: string;
}

export interface ConsoleProductDegradedStateCard {
  title: string;
  body: string;
  ownerAction: string;
}

export interface ConsoleProductComposer {
  placeholder: string;
  controls: string[];
  label?: string;
  sessionId?: string;
  sendEndpoint?: string;
  csrfToken?: string;
  sendCapability?: ConsoleProductCapability;
  unavailableCopy?: string;
}
