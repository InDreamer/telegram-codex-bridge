import { asRecord, getString, getBoolean, getArray, getNullableArray, getStringArray, getRequiredString } from "../util/untyped.js";

export const SKIP_QUESTION_OPTION_VALUE = "__skip__";

type ApprovalDecisionKind =
  | "accept"
  | "acceptForSession"
  | "acceptWithExecpolicyAmendment"
  | "applyNetworkPolicyAmendment"
  | "decline"
  | "cancel";

export type QuestionAnswerFormat = "string" | "number" | "integer" | "boolean" | "string_array";

export interface NormalizedInteractionBase {
  threadId: string;
  turnId: string;
  rawParams: unknown;
}

export interface NormalizedApprovalDecisionOption {
  key: string;
  kind: ApprovalDecisionKind;
  label: string;
  payload: {
    decision: unknown;
  };
}

export interface NormalizedApprovalInteraction extends NormalizedInteractionBase {
  kind: "approval";
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "applyPatchApproval"
    | "execCommandApproval";
  itemId: string;
  approvalId: string | null;
  decisionOptions: NormalizedApprovalDecisionOption[];
  title: string;
  subtitle: string;
  body: string | null;
  detail: string | null;
}

export interface NormalizedPermissionsInteraction extends NormalizedInteractionBase {
  kind: "permissions";
  method: "item/permissions/requestApproval";
  itemId: string;
  requestedPermissions: unknown;
  title: string;
  subtitle: string;
  detail: string | null;
}

export interface NormalizedQuestionOption {
  value: string;
  label: string;
  description: string;
}

export interface NormalizedQuestion {
  id: string;
  header: string;
  question: string;
  options: NormalizedQuestionOption[] | null;
  isOther: boolean;
  isSecret: boolean;
  required: boolean;
  answerFormat: QuestionAnswerFormat;
  allowedValues: string[] | null;
}

export interface NormalizedQuestionnaireInteraction extends NormalizedInteractionBase {
  kind: "questionnaire";
  method: "item/tool/requestUserInput" | "mcpServer/elicitation/request";
  itemId: string;
  title: string;
  questions: NormalizedQuestion[];
  submission: "tool_request_user_input" | "mcp_elicitation_form";
  serverName: string | null;
}

export interface NormalizedElicitationInteraction extends NormalizedInteractionBase {
  kind: "elicitation";
  method: "mcpServer/elicitation/request";
  serverName: string;
  title: string;
  message: string;
  mode: "url" | "unknown";
  detail: string | null;
}

export type NormalizedInteraction =
  | NormalizedApprovalInteraction
  | NormalizedPermissionsInteraction
  | NormalizedQuestionnaireInteraction
  | NormalizedElicitationInteraction;

export function normalizeServerRequest(method: string, params: unknown): NormalizedInteraction | null {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return normalizeCommandApproval(method, params);
    case "item/fileChange/requestApproval":
      return normalizeFileChangeApproval(method, params);
    case "applyPatchApproval":
      return normalizeLegacyPatchApproval(method, params);
    case "execCommandApproval":
      return normalizeLegacyExecApproval(method, params);
    case "item/permissions/requestApproval":
      return normalizePermissionsApproval(method, params);
    case "item/tool/requestUserInput":
      return normalizeQuestionnaire(method, params);
    case "mcpServer/elicitation/request":
      return normalizeElicitation(method, params);
    default:
      return null;
  }
}

function normalizeCommandApproval(
  method: NormalizedApprovalInteraction["method"],
  params: unknown
): NormalizedApprovalInteraction | null {
  const record = asRecord(params);
  const threadId = getRequiredString(record, "threadId");
  const turnId = getRequiredString(record, "turnId");
  const itemId = getRequiredString(record, "itemId");
  if (!threadId || !turnId || !itemId) {
    return null;
  }

  const command = getString(record, "command");
  const reason = getString(record, "reason");
  const cwd = getString(record, "cwd");
  const detail = [reason, cwd ? `Dir: ${cwd}` : null].filter((value): value is string => Boolean(value)).join("\n");
  return {
    kind: "approval",
    method,
    threadId,
    turnId,
    itemId,
    approvalId: getString(record, "approvalId"),
    decisionOptions: extractApprovalDecisionOptions(getArray(record, "availableDecisions")),
    title: "Codex needs command approval",
    subtitle: "Approve command",
    body: command,
    detail: detail || null,
    rawParams: params
  };
}

function normalizeFileChangeApproval(
  method: "item/fileChange/requestApproval",
  params: unknown
): NormalizedApprovalInteraction | null {
  const record = asRecord(params);
  const threadId = getRequiredString(record, "threadId");
  const turnId = getRequiredString(record, "turnId");
  const itemId = getRequiredString(record, "itemId");
  if (!threadId || !turnId || !itemId) {
    return null;
  }

  return {
    kind: "approval",
    method,
    threadId,
    turnId,
    itemId,
    approvalId: null,
    decisionOptions: buildSimpleApprovalDecisionOptions([
      "accept",
      "acceptForSession",
      "decline",
      "cancel"
    ]),
    title: "Codex needs file change approval",
    subtitle: "Approve changes",
    body: getString(record, "grantRoot"),
    detail: getString(record, "reason"),
    rawParams: params
  };
}

function normalizeLegacyPatchApproval(
  method: "applyPatchApproval",
  params: unknown
): NormalizedApprovalInteraction | null {
  const record = asRecord(params);
  const threadId = getRequiredString(record, "conversationId") ?? getRequiredString(record, "threadId");
  const turnId = getString(record, "turnId") ?? "";
  const itemId =
    getString(record, "itemId")
    ?? getString(record, "approvalId")
    ?? getString(record, "callId")
    ?? "legacy-apply-patch";
  if (!threadId) {
    return null;
  }

  const reason = getString(record, "reason");
  const grantRoot = getString(record, "grantRoot");
  return {
    kind: "approval",
    method,
    threadId,
    turnId,
    itemId,
    approvalId: getString(record, "approvalId"),
    decisionOptions: buildLegacyApprovalDecisionOptions(),
    title: "Codex needs patch approval",
    subtitle: "Approve patch",
    body: summarizeLegacyFileChanges(record),
    detail: [reason, grantRoot ? `授权根Dir: ${grantRoot}` : null]
      .filter((value): value is string => Boolean(value))
      .join("\n") || null,
    rawParams: params
  };
}

function normalizeLegacyExecApproval(
  method: "execCommandApproval",
  params: unknown
): NormalizedApprovalInteraction | null {
  const record = asRecord(params);
  const threadId = getRequiredString(record, "conversationId") ?? getRequiredString(record, "threadId");
  const turnId = getString(record, "turnId") ?? "";
  const itemId =
    getString(record, "itemId")
    ?? getString(record, "approvalId")
    ?? getString(record, "callId")
    ?? "legacy-exec-command";
  if (!threadId) {
    return null;
  }

  const command = getStringArray(record, "command");
  const reason = getString(record, "reason");
  const cwd = getString(record, "cwd");
  return {
    kind: "approval",
    method,
    threadId,
    turnId,
    itemId,
    approvalId: getString(record, "approvalId"),
    decisionOptions: buildLegacyApprovalDecisionOptions(),
    title: "Codex needs command approval",
    subtitle: "Approve command",
    body: command.length > 0 ? command.join(" ") : getString(record, "summary"),
    detail: [reason, cwd ? `Dir: ${cwd}` : null]
      .filter((value): value is string => Boolean(value))
      .join("\n") || null,
    rawParams: params
  };
}

function normalizePermissionsApproval(
  method: "item/permissions/requestApproval",
  params: unknown
): NormalizedPermissionsInteraction | null {
  const record = asRecord(params);
  const threadId = getRequiredString(record, "threadId");
  const turnId = getRequiredString(record, "turnId");
  const itemId = getRequiredString(record, "itemId");
  if (!threadId || !turnId || !itemId) {
    return null;
  }

  return {
    kind: "permissions",
    method,
    threadId,
    turnId,
    itemId,
    requestedPermissions: record?.permissions ?? null,
    title: "Codex needs permission approval",
    subtitle: "Approve permission",
    detail: getString(record, "reason"),
    rawParams: params
  };
}

function normalizeQuestionnaire(
  method: "item/tool/requestUserInput",
  params: unknown
): NormalizedQuestionnaireInteraction | null {
  const record = asRecord(params);
  const threadId = getRequiredString(record, "threadId");
  const turnId = getRequiredString(record, "turnId");
  const itemId = getRequiredString(record, "itemId");
  if (!threadId || !turnId || !itemId) {
    return null;
  }

  const questions = getArray(record, "questions")
    .map((question) => normalizeToolQuestion(question))
    .filter((question): question is NormalizedQuestion => question !== null);

  if (questions.length === 0) {
    return null;
  }

  return {
    kind: "questionnaire",
    method,
    threadId,
    turnId,
    itemId,
    title: "Codex needs more info",
    questions,
    submission: "tool_request_user_input",
    serverName: null,
    rawParams: params
  };
}

function normalizeToolQuestion(question: unknown): NormalizedQuestion | null {
  const record = asRecord(question);
  const id = getRequiredString(record, "id");
  const header = getRequiredString(record, "header");
  const prompt = getRequiredString(record, "question");
  if (!id || !header || !prompt) {
    return null;
  }

  const options = getNullableArray(record, "options")?.map((option) => {
    const optionRecord = asRecord(option);
    const label = getRequiredString(optionRecord, "label");
    const description = getRequiredString(optionRecord, "description");
    if (!label || !description) {
      return null;
    }
    return {
      value: label,
      label,
      description
    };
  }).filter((option): option is NormalizedQuestionOption => option !== null) ?? null;

  return {
    id,
    header,
    question: prompt,
    options,
    isOther: getBoolean(record, "isOther"),
    isSecret: getBoolean(record, "isSecret"),
    required: true,
    answerFormat: "string",
    allowedValues: options?.map((option) => option.value) ?? null
  };
}

function normalizeElicitation(
  method: "mcpServer/elicitation/request",
  params: unknown
): NormalizedInteraction | null {
  const record = asRecord(params);
  if (!record) {
    return null;
  }
  const threadId = getRequiredString(record, "threadId");
  const serverName = getRequiredString(record, "serverName");
  if (!threadId || !serverName) {
    return null;
  }

  if (getString(record, "mode") === "form") {
    return normalizeElicitationForm(method, record, params, threadId, serverName);
  }

  return {
    kind: "elicitation",
    method,
    threadId,
    turnId: getString(record, "turnId") ?? "",
    serverName,
    title: "MCP needs confirmation",
    message: getString(record, "message") ?? "MCP sent a request that needs confirmation.",
    mode: getString(record, "mode") === "url" ? "url" : "unknown",
    detail: getString(record, "url"),
    rawParams: params
  };
}

function normalizeElicitationForm(
  method: "mcpServer/elicitation/request",
  record: Record<string, unknown>,
  params: unknown,
  threadId: string,
  serverName: string
): NormalizedQuestionnaireInteraction | null {
  const schema = asRecord(record.requestedSchema);
  const properties = asRecord(schema?.properties);
  if (!properties) {
    return null;
  }

  const requiredFields = new Set(getStringArray(schema, "required"));
  const questions = Object.entries(properties)
    .map(([fieldName, fieldSchema]) => normalizeMcpFormQuestion(fieldName, fieldSchema, requiredFields.has(fieldName)))
    .filter((question): question is NormalizedQuestion => question !== null);

  if (questions.length === 0) {
    return null;
  }

  return {
    kind: "questionnaire",
    method,
    threadId,
    turnId: getString(record, "turnId") ?? "",
    itemId: getString(record, "elicitationId") ?? `mcp-${serverName}-form`,
    title: "MCP needs more info",
    questions,
    submission: "mcp_elicitation_form",
    serverName,
    rawParams: params
  };
}

function normalizeMcpFormQuestion(fieldName: string, schema: unknown, required: boolean): NormalizedQuestion | null {
  const record = asRecord(schema);
  if (!record) {
    return null;
  }

  const header = getString(record, "title") ?? fieldName;
  const description = getString(record, "description");

  const singleSelectOptions = extractSingleSelectOptions(record);
  if (singleSelectOptions) {
    const options = appendSkipOption(singleSelectOptions, required);
    return {
      id: fieldName,
      header,
      question: buildMcpQuestionPrompt(header, description, "Select an option below.", required),
      options,
      isOther: false,
      isSecret: false,
      required,
      answerFormat: "string",
      allowedValues: singleSelectOptions.map((option) => option.value)
    };
  }

  if (isMultiSelectSchema(record)) {
    const allowedValues = extractMultiSelectValues(record);
    return {
      id: fieldName,
      header,
      question: buildMcpQuestionPrompt(
        header,
        description,
        allowedValues.length > 0
          ? `Options: ${allowedValues.join(", ")}。Separate multiple values with commas.`
          : "Separate multiple values with commas.",
        required
      ),
      options: required ? null : [buildSkipQuestionOption()],
      isOther: true,
      isSecret: false,
      required,
      answerFormat: "string_array",
      allowedValues: allowedValues.length > 0 ? allowedValues : null
    };
  }

  const type = getString(record, "type");
  if (type === "boolean") {
    return {
      id: fieldName,
      header,
      question: buildMcpQuestionPrompt(header, description, "Yes or No?", required),
      options: appendSkipOption([
        { value: "true", label: "Yes", description: "Return true" },
        { value: "false", label: "No", description: "Return false" }
      ], required),
      isOther: false,
      isSecret: false,
      required,
      answerFormat: "boolean",
      allowedValues: ["true", "false"]
    };
  }

  if (type === "number" || type === "integer") {
    return {
      id: fieldName,
      header,
      question: buildMcpQuestionPrompt(
        header,
        description,
        type === "integer" ? "Send an integer." : "Send a number.",
        required
      ),
      options: required ? null : [buildSkipQuestionOption()],
      isOther: true,
      isSecret: false,
      required,
      answerFormat: type,
      allowedValues: null
    };
  }

  if (type === "string") {
    return {
      id: fieldName,
      header,
      question: buildMcpQuestionPrompt(header, description, "Send text.", required),
      options: required ? null : [buildSkipQuestionOption()],
      isOther: true,
      isSecret: false,
      required,
      answerFormat: "string",
      allowedValues: null
    };
  }

  return null;
}

function buildMcpQuestionPrompt(
  header: string,
  description: string | null,
  answerHint: string,
  required: boolean
): string {
  const parts = [
    description ?? `Provide: ${header}。`,
    answerHint,
    required ? "Required." : "Optional."
  ];
  return parts.join("\n");
}

function buildLegacyApprovalDecisionOptions(): NormalizedApprovalDecisionOption[] {
  return [
    {
      key: "accept",
      kind: "accept",
      label: "Approve",
      payload: { decision: "approved" }
    },
    {
      key: "acceptForSession",
      kind: "acceptForSession",
      label: "Always allow this session",
      payload: { decision: "approved_for_session" }
    },
    {
      key: "decline",
      kind: "decline",
      label: "Decline",
      payload: { decision: "denied" }
    },
    {
      key: "cancel",
      kind: "cancel",
      label: "Cancel",
      payload: { decision: "abort" }
    }
  ];
}

function buildSimpleApprovalDecisionOptions(
  kinds: Array<Extract<ApprovalDecisionKind, "accept" | "acceptForSession" | "decline" | "cancel">>
): NormalizedApprovalDecisionOption[] {
  return kinds.map((kind) => ({
    key: kind,
    kind,
    label: approvalDecisionLabel(kind),
    payload: { decision: kind }
  }));
}

function extractApprovalDecisionOptions(values: unknown[]): NormalizedApprovalDecisionOption[] {
  const seenKeys = new Map<string, number>();
  const decisionOptions = values
    .map((value) => normalizeApprovalDecisionOption(value))
    .filter((value): value is NormalizedApprovalDecisionOption => value !== null)
    .map((option) => {
      const seen = seenKeys.get(option.key) ?? 0;
      seenKeys.set(option.key, seen + 1);
      if (seen === 0) {
        return option;
      }

      return {
        ...option,
        key: `${option.key}_${seen}`
      };
    });

  return decisionOptions.length > 0
    ? decisionOptions
    : buildSimpleApprovalDecisionOptions(["accept", "acceptForSession", "decline", "cancel"]);
}

function normalizeApprovalDecisionOption(value: unknown): NormalizedApprovalDecisionOption | null {
  if (value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel") {
    return {
      key: value,
      kind: value,
      label: approvalDecisionLabel(value),
      payload: { decision: value }
    };
  }

  const record = asRecord(value);
  const execpolicy = asRecord(record?.acceptWithExecpolicyAmendment);
  if (execpolicy) {
    return {
      key: "acceptWithExecpolicyAmendment",
      kind: "acceptWithExecpolicyAmendment",
      label: "Allow & remember rule",
      payload: {
        decision: {
          acceptWithExecpolicyAmendment: execpolicy
        }
      }
    };
  }

  const network = asRecord(record?.applyNetworkPolicyAmendment);
  if (network) {
    const amendment = asRecord(network.network_policy_amendment);
    const host = getString(amendment, "host");
    return {
      key: "applyNetworkPolicyAmendment",
      kind: "applyNetworkPolicyAmendment",
      label: host ? `Allow & save rule (${host})` : "Allow & save rule",
      payload: {
        decision: {
          applyNetworkPolicyAmendment: network
        }
      }
    };
  }

  return null;
}

function approvalDecisionLabel(kind: Extract<ApprovalDecisionKind, "accept" | "acceptForSession" | "decline" | "cancel">): string {
  switch (kind) {
    case "accept":
      return "Approve";
    case "acceptForSession":
      return "Always allow this session";
    case "decline":
      return "Decline";
    case "cancel":
      return "Cancel";
  }
}

function appendSkipOption(options: NormalizedQuestionOption[], required: boolean): NormalizedQuestionOption[] {
  return required ? options : [...options, buildSkipQuestionOption()];
}

function buildSkipQuestionOption(): NormalizedQuestionOption {
  return {
    value: SKIP_QUESTION_OPTION_VALUE,
    label: "Skip",
    description: "Leave empty"
  };
}

function extractSingleSelectOptions(record: Record<string, unknown>): NormalizedQuestionOption[] | null {
  const titledOneOf = getArray(record, "oneOf")
    .map((entry) => {
      const option = asRecord(entry);
      const value = getRequiredString(option, "const");
      const title = getRequiredString(option, "title");
      if (!value || !title) {
        return null;
      }
      return {
        value,
        label: title,
        description: value
      };
    })
    .filter((option): option is NormalizedQuestionOption => option !== null);
  if (titledOneOf.length > 0) {
    return titledOneOf;
  }

  const enumValues = getStringArray(record, "enum");
  if (enumValues.length > 0) {
    return enumValues.map((value) => ({
      value,
      label: value,
      description: value
    }));
  }

  return null;
}

function isMultiSelectSchema(record: Record<string, unknown>): boolean {
  if (getString(record, "type") !== "array") {
    return false;
  }

  const items = asRecord(record.items);
  if (!items) {
    return false;
  }

  return getStringArray(items, "enum").length > 0 || getArray(items, "anyOf").length > 0;
}

function extractMultiSelectValues(record: Record<string, unknown>): string[] {
  const items = asRecord(record.items);
  if (!items) {
    return [];
  }

  const direct = getStringArray(items, "enum");
  if (direct.length > 0) {
    return direct;
  }

  return getArray(items, "anyOf")
    .map((entry) => getRequiredString(asRecord(entry), "const"))
    .filter((value): value is string => value !== null);
}

function summarizeLegacyFileChanges(record: Record<string, unknown> | null): string | null {
  const fileChanges = asRecord(record?.fileChanges);
  if (!fileChanges) {
    return getString(record, "patch") ?? getString(record, "summary");
  }

  const paths = Object.keys(fileChanges);
  if (paths.length === 0) {
    return getString(record, "patch") ?? getString(record, "summary");
  }

  const preview = paths.slice(0, 3).join("\n");
  if (paths.length <= 3) {
    return preview;
  }

  return `${preview}\nand ${paths.length - 3} more files`;
}
