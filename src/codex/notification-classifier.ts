import type {
  AgentMessageDeltaNotification,
  CommandOutputNotification,
  ClassifiedNotification,
  CollabAgentStateUpdate,
  ErrorNotification,
  FileChangeOutputNotification,
  FinalMessageAvailableNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  OtherNotification,
  PlanDeltaNotification,
  PlanUpdatedNotification,
  ProgressNotification,
  ThreadArchivedNotification,
  ThreadStatusChangedNotification,
  ThreadUnarchivedNotification,
  TurnAbortedNotification,
  TurnCompletedNotification,
  TurnStartedNotification
} from "../activity/types.js";

export function classifyNotification(method: string, params: unknown): ClassifiedNotification {
  const context = extractContext(method, params);

  switch (method) {
    case "turn/started":
      return {
        kind: "turn_started",
        ...context
      } satisfies TurnStartedNotification;

    case "turn/completed":
      return {
        kind: "turn_completed",
        ...context,
        status: getString(getObject(params)?.turn, "status") ?? getString(params, "status") ?? "unknown"
      } satisfies TurnCompletedNotification;

    case "thread/status/changed":
      return {
        kind: "thread_status_changed",
        ...context,
        status: getThreadStatusType(params),
        activeFlags: getThreadStatusActiveFlags(params)
      } satisfies ThreadStatusChangedNotification;

    case "thread/archived":
      return {
        kind: "thread_archived",
        ...context
      } satisfies ThreadArchivedNotification;

    case "thread/unarchived":
      return {
        kind: "thread_unarchived",
        ...context
      } satisfies ThreadUnarchivedNotification;

    case "item/started":
      return {
        kind: "item_started",
        ...context,
        itemId: getItemId(params),
        itemType: getItemType(params),
        label: getItemLabel(params),
        collabTool: getCollabTool(params),
        collabAgentStates: getCollabAgentStates(params)
      } satisfies ItemStartedNotification;

    case "item/completed":
      return {
        kind: "item_completed",
        ...context,
        itemId: getItemId(params),
        itemType: getItemType(params),
        itemText: getString(getObject(params)?.item, "text"),
        itemPhase: getMessagePhase(params),
        collabTool: getCollabTool(params),
        collabAgentStates: getCollabAgentStates(params)
      } satisfies ItemCompletedNotification;

    case "item/mcpToolCall/progress":
    case "item/webSearch/progress":
      return {
        kind: "progress",
        ...context,
        itemId: getItemId(params),
        message: getString(params, "message") ?? getString(getObject(params)?.progress, "message") ?? null
      } satisfies ProgressNotification;

    case "codex/event/task_complete":
      return {
        kind: "final_message_available",
        ...context,
        message: getString(getObject(params)?.msg, "last_agent_message") ?? null
      } satisfies FinalMessageAvailableNotification;

    case "turn/plan/updated":
      return {
        kind: "plan_updated",
        ...context,
        entries: getPlanEntries(params)
      } satisfies PlanUpdatedNotification;

    case "item/plan/delta":
      return {
        kind: "plan_delta",
        ...context,
        message: getDeltaText(params)
      } satisfies PlanDeltaNotification;

    case "item/commandExecution/outputDelta":
      return {
        kind: "command_output",
        ...context,
        itemId: getItemId(params),
        text: getDeltaText(params)
      } satisfies CommandOutputNotification;

    case "item/fileChange/outputDelta":
      return {
        kind: "file_change_output",
        ...context,
        itemId: getItemId(params),
        text: getDeltaText(params)
      } satisfies FileChangeOutputNotification;

    case "item/agentMessage/delta":
      return {
        kind: "agent_message_delta",
        ...context,
        itemId: getItemId(params),
        text: getDeltaText(params)
      } satisfies AgentMessageDeltaNotification;

    case "codex/event/turn_aborted":
      return {
        kind: "turn_aborted",
        ...context
      } satisfies TurnAbortedNotification;

    case "error":
      return {
        kind: "error",
        ...context,
        code: getString(params, "code") ?? getNumberString(params, "code") ?? getString(getObject(params)?.error, "code"),
        message: getString(params, "message") ?? getString(getObject(params)?.error, "message") ?? null
      } satisfies ErrorNotification;

    default:
      return {
        kind: "other",
        ...context,
        params
      } satisfies OtherNotification;
  }
}

function extractContext(method: string, params: unknown): Omit<ClassifiedNotification, "kind"> & { method: string } {
  return {
    method,
    threadId:
      getString(params, "threadId") ??
      getString(getObject(params)?.thread, "id") ??
      null,
    turnId:
      getString(params, "turnId") ??
      getString(getObject(params)?.turn, "id") ??
      null
  } as Omit<ClassifiedNotification, "kind"> & { method: string };
}

function getItemId(params: unknown): string | null {
  return getString(params, "itemId") ?? getString(getObject(params)?.item, "id") ?? null;
}

function getItemType(params: unknown): string | null {
  return getString(params, "itemType") ?? getString(getObject(params)?.item, "type") ?? null;
}

function getItemLabel(params: unknown): string | null {
  const directLabel = (
    getString(params, "label") ??
    getString(params, "title") ??
    getString(getObject(params)?.item, "label") ??
    getString(getObject(params)?.item, "title")
  );
  if (directLabel) {
    return directLabel;
  }

  const item = getObject(params)?.item;
  const itemType = getString(item, "type");
  switch (itemType) {
    case "commandExecution":
      return getString(item, "command");
    case "mcpToolCall": {
      const server = getString(item, "server");
      const tool = getString(item, "tool");
      const labelParts = [server, tool].filter((value): value is string => Boolean(value));
      return labelParts.length > 0 ? labelParts.join(" / ") : null;
    }
    case "webSearch":
      return getString(item, "query")
        ?? getString(getObject(item)?.action, "query")
        ?? getString(getObject(item)?.action, "url");
    case "fileChange": {
      const changes = getObject(item)?.changes;
      if (!Array.isArray(changes)) {
        return null;
      }
      const firstChange = changes.find((change) => typeof getString(change, "path") === "string");
      return firstChange ? getString(firstChange, "path") : null;
    }
    case "plan":
      return getString(item, "text");
    case "collabAgentToolCall": {
      const tool = getString(item, "tool");
      return tool ? `agent ${tool}` : "agent task";
    }
    default:
      return null;
  }
}

function getDeltaText(params: unknown): string | null {
  return (
    getString(params, "delta") ??
    getString(params, "text") ??
    getString(params, "message") ??
    getString(getObject(params)?.output, "delta") ??
    getString(getObject(params)?.output, "text") ??
    null
  );
}

function getMessagePhase(params: unknown): "commentary" | "final_answer" | null {
  const phase = getString(getObject(params)?.item, "phase");
  if (phase === "commentary" || phase === "final_answer") {
    return phase;
  }

  return null;
}

function getPlanEntries(params: unknown): string[] {
  const directPlan = getObject(params)?.plan;
  const turnPlan = getObject(getObject(params)?.turn)?.plan;
  const plan = directPlan ?? turnPlan;

  if (Array.isArray(plan)) {
    return plan
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }

        const objectEntry = getObject(entry);
        if (!objectEntry) {
          return "";
        }

        const step = getString(objectEntry, "step") ?? getString(objectEntry, "title") ?? getString(objectEntry, "text");
        const status = getString(objectEntry, "status");
        if (!step) {
          return "";
        }

        return status ? `${step} (${status})` : step;
      })
      .filter((entry) => entry.length > 0);
  }

  const text = getString(plan, "text");
  return text ? [text] : [];
}

function getCollabTool(params: unknown): string | null {
  const item = getObject(params)?.item;
  if (getString(item, "type") !== "collabAgentToolCall") {
    return null;
  }

  return getString(item, "tool");
}

function getCollabAgentStates(params: unknown): CollabAgentStateUpdate[] {
  const item = getObject(params)?.item;
  if (getString(item, "type") !== "collabAgentToolCall") {
    return [];
  }

  const receiverThreadIds = getStringArray(getObject(item)?.receiverThreadIds);
  const agentsStates = getObject(item)?.agentsStates;
  const entries: CollabAgentStateUpdate[] = Object.entries(agentsStates ?? {})
    .flatMap(([threadId, value]) => {
      const state = getObject(value);
      const status = getString(state, "status");
      if (
        status !== "pendingInit" &&
        status !== "running" &&
        status !== "completed" &&
        status !== "errored" &&
        status !== "shutdown" &&
        status !== "notFound"
      ) {
        return [];
      }

      return [{
        threadId,
        status,
        message: getString(state, "message")
      } satisfies CollabAgentStateUpdate];
    });

  const knownThreadIds = new Set(entries.map((entry) => entry.threadId));
  for (const threadId of receiverThreadIds) {
    if (knownThreadIds.has(threadId)) {
      continue;
    }
    entries.push({
      threadId,
      status: "pendingInit",
      message: null
    });
  }

  return entries;
}

function getThreadStatusType(params: unknown): ThreadStatusChangedNotification["status"] {
  const directStatus = getObject(params)?.status;
  const threadStatus = getObject(getObject(params)?.thread)?.status;
  const statusType =
    getString(directStatus, "type") ??
    getString(threadStatus, "type") ??
    getString(params, "status") ??
    getString(getObject(params)?.thread, "status");

  switch (statusType) {
    case "notLoaded":
    case "idle":
    case "active":
    case "systemError":
      return statusType;
    default:
      return null;
  }
}

function getThreadStatusActiveFlags(params: unknown): string[] {
  const directStatus = getObject(params)?.status;
  const threadStatus = getObject(getObject(params)?.thread)?.status;

  return getStringArray(
    getObject(params)?.activeFlags ??
    getObject(getObject(params)?.thread)?.activeFlags ??
    getObject(directStatus)?.activeFlags ??
    getObject(threadStatus)?.activeFlags
  );
}

function getObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getString(value: unknown, key: string): string | null {
  const objectValue = getObject(value);
  const candidate = objectValue?.[key];
  return typeof candidate === "string" ? candidate : null;
}

function getNumberString(value: unknown, key: string): string | null {
  const objectValue = getObject(value);
  const candidate = objectValue?.[key];
  return typeof candidate === "number" ? `${candidate}` : null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
}
