import type {
  AgentMessageDeltaNotification,
  CommandOutputNotification,
  ClassifiedNotification,
  ErrorNotification,
  FileChangeOutputNotification,
  FinalMessageAvailableNotification,
  ItemCompletedNotification,
  ItemStartedNotification,
  OtherNotification,
  PlanDeltaNotification,
  PlanUpdatedNotification,
  ProgressNotification,
  ThreadStatusChangedNotification,
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
        status: getString(params, "status") ?? getString(getObject(params)?.thread, "status") ?? null,
        activeFlags: getStringArray(getObject(params)?.activeFlags ?? getObject(getObject(params)?.thread)?.activeFlags)
      } satisfies ThreadStatusChangedNotification;

    case "item/started":
      return {
        kind: "item_started",
        ...context,
        itemId: getItemId(params),
        itemType: getItemType(params),
        label: getItemLabel(params)
      } satisfies ItemStartedNotification;

    case "item/completed":
      return {
        kind: "item_completed",
        ...context,
        itemId: getItemId(params),
        itemType: getItemType(params)
      } satisfies ItemCompletedNotification;

    case "item/mcpToolCall/progress":
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
  return (
    getString(params, "label") ??
    getString(params, "title") ??
    getString(getObject(params)?.item, "label") ??
    getString(getObject(params)?.item, "title") ??
    null
  );
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
