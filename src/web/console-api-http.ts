import type { IncomingMessage, ServerResponse } from "node:http";

import type { WebReadonlyViewModelProvider } from "../service/web-readonly-view-model.js";
import {
  createConsoleBridgeReadAdapter,
  type ConsoleBridgeReadAdapter,
  type ConsoleSessionSummaryResult
} from "./console-bridge-read-adapter.js";
import {
  assertConsoleSafeString,
  isConsoleOpaqueId,
  type ConsoleApiError,
  type ConsoleApprovalAnswerRequest,
  type ConsoleApprovalAnswerResult,
  type ConsoleApprovalId,
  type ConsoleArchiveProjectRequest,
  type ConsoleCapabilities,
  type ConsoleCreateSessionRequest,
  type ConsoleOpaqueIdKind,
  type ConsoleProject,
  type ConsoleProjectId,
  type ConsoleSendMessageRequest,
  type ConsoleSendMessageResult,
  type ConsoleSessionDetail,
  type ConsoleSessionId
} from "./console-api-contract.js";

export interface ConsoleApiHttpOptions {
  provider: WebReadonlyViewModelProvider;
  adapter?: ConsoleBridgeReadAdapter;
  writeAdapter?: ConsoleApiWriteAdapter;
  csrfToken?: string | (() => string | null | undefined);
}

export interface ConsoleApiWriteAdapter {
  capabilities?: Partial<Pick<ConsoleCapabilities, "archiveProject" | "createSession" | "sendMessage" | "answerApproval">>;
  archiveProject?: (request: ConsoleArchiveProjectRequest) => Promise<ConsoleProject | ConsoleApiError> | ConsoleProject | ConsoleApiError;
  createSession?: (request: ConsoleCreateSessionRequest) => Promise<ConsoleSessionDetail | ConsoleApiError> | ConsoleSessionDetail | ConsoleApiError;
  sendMessage?: (sessionId: ConsoleSessionId, request: ConsoleSendMessageRequest) => Promise<ConsoleSendMessageResult | ConsoleApiError> | ConsoleSendMessageResult | ConsoleApiError;
  answerApproval?: (approvalId: ConsoleApprovalId, request: ConsoleApprovalAnswerRequest) => Promise<ConsoleApprovalAnswerResult | ConsoleApiError> | ConsoleApprovalAnswerResult | ConsoleApiError;
}

type JsonRouteResult = { status: number; body: unknown };

type ParsedJsonBody =
  | { ok: true; value: unknown }
  | { ok: false; result: JsonRouteResult };

type SendMessageBody =
  | { ok: true; value: ConsoleSendMessageRequest }
  | { ok: false; result: JsonRouteResult };

type CreateSessionBody =
  | { ok: true; value: Omit<ConsoleCreateSessionRequest, "projectId"> }
  | { ok: false; result: JsonRouteResult };

type ApprovalAnswerBody =
  | { ok: true; value: ConsoleApprovalAnswerRequest }
  | { ok: false; result: JsonRouteResult };

type ConsoleWriteCapability = keyof NonNullable<ConsoleApiWriteAdapter["capabilities"]>;
type ConsoleWriteCapabilityValue = ConsoleCapabilities["sendMessage"];

const JSON_SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
} as const;

const MAX_JSON_BODY_BYTES = 32 * 1024;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_OPTION_CHARS = 128;
const MAX_REASON_CHARS = 1_000;
const MAX_TITLE_CHARS = 200;
const MAX_ATTACHMENT_IDS = 10;

const idFieldKinds = {
  projectId: "project",
  activeProjectId: "project",
  sessionId: "session",
  activeSessionId: "session",
  messageId: "message",
  runId: "run",
  activeRunId: "run",
  approvalId: "approval",
  artifactId: "artifact"
} as const satisfies Record<string, ConsoleOpaqueIdKind>;

const listIdFieldKinds = {
  approvalIds: "approval",
  artifactIds: "artifact",
  attachmentArtifactIds: "artifact"
} as const satisfies Record<string, ConsoleOpaqueIdKind>;

const rawBridgeStringPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "raw conversation identifier", pattern: /\bcv_[a-f0-9]{16}\b/i },
  { label: "raw workspace identifier", pattern: /\bwk_[A-Za-z0-9_-]{2,}\b/ },
  { label: "raw interaction identifier", pattern: /\bpi_[A-Za-z0-9_-]{2,}\b/i },
  { label: "raw answer identifier", pattern: /\banswer[-_][A-Za-z0-9_-]{2,}\b/i },
  { label: "platform marker", pattern: /(?:telegram|feishu|open_id|union_id|tenant|callback_data)/i },
  { label: "chat identifier", pattern: /\b(?:chatId|telegramChatId|feishuChatId|platformMessageId|messageId|threadId)\b/ },
  { label: "secret marker", pattern: /\b(?:token|authorization|bearer|api[_-]?key|secret|password)\s*[:=]/i },
  { label: "process marker", pattern: /\b(?:pid|processId|process[_-]?id)\s*[:=]?\s*\d{2,}\b/i },
  { label: "raw terminal marker", pattern: /\b(?:rawTerminal|stdout|stderr)\b/i }
];

const rawBridgeKeyPattern =
  /(?:telegram|feishu|open[_-]?id|union[_-]?id|tenant[_-]?key|callback[_-]?data|rawTerminal|stdout|stderr|token|secret|authorization|bearer|api[_-]?key|password|chatId|threadId|platformMessageId|conversationHandle|conversationId|workspaceId|answerId|interactionId|processId|pid)/;

export function isConsoleApiPath(urlValue: string): boolean {
  const pathname = safePathname(urlValue);
  return Boolean(pathname && isApiPathname(pathname));
}

export function sendConsoleApiDenied(response: ServerResponse, headOnly = false): void {
  sendJson(response, 404, notFoundError(), headOnly);
}

export function handleConsoleApiHttpRequest(
  options: ConsoleApiHttpOptions,
  request: IncomingMessage,
  response: ServerResponse
): boolean {
  const pathname = safePathname(request.url ?? "/");
  if (!pathname || !isApiPathname(pathname)) {
    return false;
  }

  const method = request.method ?? "GET";
  const headOnly = method === "HEAD";
  if (method === "GET" || method === "HEAD") {
    sendRouteResult(response, resolveConsoleApiRoute(pathname, options), headOnly);
    return true;
  }

  if (method === "POST") {
    void handleConsoleApiPostRoute(pathname, options, request, response);
    return true;
  }

  sendJson(response, 404, notFoundError(), false);
  return true;
}

function resolveConsoleApiRoute(pathname: string, options: ConsoleApiHttpOptions): JsonRouteResult {
  try {
    if (pathname === "/api/console/bootstrap") {
      return adapterPayload(() => bootstrapFor(options));
    }

    if (pathname === "/api/projects") {
      return adapterPayload(() => adapterFor(options).listProjects());
    }

    const projectSessionsMatch = /^\/api\/projects\/([^/]+)\/sessions$/.exec(pathname);
    if (projectSessionsMatch?.[1]) {
      const projectId = projectSessionsMatch[1];
      if (!isSafeRouteOpaqueId("project", projectId)) {
        return safeError(400, badRequestError("Project id must be an opaque Console project id."));
      }
      return adapterPayload((): ConsoleSessionSummaryResult => adapterFor(options).listProjectSessions(projectId));
    }

    const sessionEventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(pathname);
    if (sessionEventsMatch?.[1]) {
      const sessionId = sessionEventsMatch[1];
      if (!isSafeRouteOpaqueId("session", sessionId)) {
        return safeError(400, badRequestError("Session id must be an opaque Console session id."));
      }
      return safeError(409, {
        code: "capability_disabled",
        message: "Session event streams are unavailable in this read-only HTTP harness.",
        retryable: false,
        capability: "streamEvents"
      });
    }

    const sessionDetailMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
    if (sessionDetailMatch?.[1]) {
      const sessionId = sessionDetailMatch[1];
      if (!isSafeRouteOpaqueId("session", sessionId)) {
        return safeError(400, badRequestError("Session id must be an opaque Console session id."));
      }
      return adapterPayload(() => adapterFor(options).getSessionDetail(sessionId));
    }

    return safeError(404, notFoundError());
  } catch {
    return safeError(500, internalError());
  }
}

async function handleConsoleApiPostRoute(
  pathname: string,
  options: ConsoleApiHttpOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  let result: JsonRouteResult;
  try {
    result = await resolveConsoleApiPostRoute(pathname, options, request);
  } catch {
    result = safeError(500, internalError());
  }
  sendRouteResult(response, result, false);
}

async function resolveConsoleApiPostRoute(
  pathname: string,
  options: ConsoleApiHttpOptions,
  request: IncomingMessage
): Promise<JsonRouteResult> {
  try {
    const archiveMatch = /^\/api\/projects\/([^/]+)\/archive$/.exec(pathname);
    if (archiveMatch?.[1]) {
      const projectId = archiveMatch[1];
      if (!isSafeRouteOpaqueId("project", projectId)) {
        drain(request);
        return safeError(400, badRequestError("Project id must be an opaque Console project id."));
      }
      return await withWriteGuards(request, options, "archiveProject", options.writeAdapter?.archiveProject, async () => {
        const parsed = await readJsonBody(request, { allowEmpty: true });
        if (!parsed.ok) {
          return parsed.result;
        }
        const object = asPlainObject(parsed.value);
        if (!object || hasUnknownKeys(object, [])) {
          return safeError(400, badRequestError("Archive project request body must be an empty JSON object."));
        }
        const safeProjectId = projectId as ConsoleProjectId;
        return writePayload(() => options.writeAdapter!.archiveProject!({ projectId: safeProjectId }), 200);
      });
    }

    const createSessionMatch = /^\/api\/projects\/([^/]+)\/sessions$/.exec(pathname);
    if (createSessionMatch?.[1]) {
      const projectId = createSessionMatch[1];
      if (!isSafeRouteOpaqueId("project", projectId)) {
        drain(request);
        return safeError(400, badRequestError("Project id must be an opaque Console project id."));
      }
      return await withWriteGuards(request, options, "createSession", options.writeAdapter?.createSession, async () => {
        const parsed = parseCreateSessionBody(await readJsonBody(request, { allowEmpty: true }));
        if (!parsed.ok) {
          return parsed.result;
        }
        const safeProjectId = projectId as ConsoleProjectId;
        return writePayload(
          () => options.writeAdapter!.createSession!({ projectId: safeProjectId, ...parsed.value }),
          201
        );
      });
    }

    const sendMessageMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(pathname);
    if (sendMessageMatch?.[1]) {
      const sessionId = sendMessageMatch[1];
      if (!isSafeRouteOpaqueId("session", sessionId)) {
        drain(request);
        return safeError(400, badRequestError("Session id must be an opaque Console session id."));
      }
      return await withWriteGuards(request, options, "sendMessage", options.writeAdapter?.sendMessage, async () => {
        const parsed = parseSendMessageBody(await readJsonBody(request, { allowEmpty: false }));
        if (!parsed.ok) {
          return parsed.result;
        }
        const safeSessionId = sessionId as ConsoleSessionId;
        return writePayload(() => options.writeAdapter!.sendMessage!(safeSessionId, parsed.value), 202);
      });
    }

    const approvalMatch = /^\/api\/approvals\/([^/]+)\/answer$/.exec(pathname);
    if (approvalMatch?.[1]) {
      const approvalId = approvalMatch[1];
      if (!isSafeRouteOpaqueId("approval", approvalId)) {
        drain(request);
        return safeError(400, badRequestError("Approval id must be an opaque Console approval id."));
      }
      return await withWriteGuards(request, options, "answerApproval", options.writeAdapter?.answerApproval, async () => {
        const parsed = parseApprovalAnswerBody(await readJsonBody(request, { allowEmpty: false }));
        if (!parsed.ok) {
          return parsed.result;
        }
        const safeApprovalId = approvalId as ConsoleApprovalId;
        return writePayload(() => options.writeAdapter!.answerApproval!(safeApprovalId, parsed.value), 200);
      });
    }

    drain(request);
    return safeError(404, notFoundError());
  } catch {
    return safeError(500, internalError());
  }
}

function bootstrapFor(options: ConsoleApiHttpOptions): unknown {
  const bootstrap = adapterFor(options).getBootstrap();
  return {
    ...bootstrap,
    capabilities: mergeWriteCapabilities(bootstrap.capabilities, options)
  };
}

function mergeWriteCapabilities(capabilities: ConsoleCapabilities, options: ConsoleApiHttpOptions): ConsoleCapabilities {
  return {
    ...capabilities,
    archiveProject: writeCapabilityFor(capabilities.archiveProject, options, "archiveProject", options.writeAdapter?.archiveProject),
    createSession: writeCapabilityFor(capabilities.createSession, options, "createSession", options.writeAdapter?.createSession),
    sendMessage: writeCapabilityFor(capabilities.sendMessage, options, "sendMessage", options.writeAdapter?.sendMessage),
    answerApproval: writeCapabilityFor(capabilities.answerApproval, options, "answerApproval", options.writeAdapter?.answerApproval)
  };
}

function writeCapabilityFor(
  fallback: ConsoleWriteCapabilityValue,
  options: ConsoleApiHttpOptions,
  capability: ConsoleWriteCapability,
  handler: unknown
): ConsoleWriteCapabilityValue {
  const advertised = options.writeAdapter?.capabilities?.[capability];
  if (!handler) {
    return fallback;
  }
  if (advertised?.state === "disabled") {
    return advertised;
  }
  if (!currentCsrfToken(options)) {
    return { state: "disabled", reason: "Console write capability requires CSRF protection." };
  }
  return advertised ?? { state: "enabled" };
}

function adapterFor(options: ConsoleApiHttpOptions): ConsoleBridgeReadAdapter {
  return options.adapter ?? createConsoleBridgeReadAdapter({ provider: options.provider });
}

function adapterPayload(read: () => unknown): JsonRouteResult {
  let payload: unknown;
  try {
    payload = read();
  } catch {
    return safeError(500, internalError());
  }

  if (isConsoleApiError(payload)) {
    return safeError(statusForConsoleApiError(payload), payload);
  }
  return safeBody(200, payload);
}

async function withWriteGuards(
  request: IncomingMessage,
  options: ConsoleApiHttpOptions,
  capability: ConsoleWriteCapability,
  handler: unknown,
  run: () => Promise<JsonRouteResult>
): Promise<JsonRouteResult> {
  if (!handler || options.writeAdapter?.capabilities?.[capability]?.state === "disabled") {
    drain(request);
    return capabilityDisabled(capability);
  }
  if (!sameOriginAllowed(request) || !csrfAllowed(request, options)) {
    drain(request);
    return safeError(403, { code: "forbidden", message: "Write request was denied.", retryable: false });
  }
  return run();
}

async function writePayload(write: () => unknown | Promise<unknown>, successStatus: number): Promise<JsonRouteResult> {
  let payload: unknown;
  try {
    payload = await write();
  } catch {
    return safeError(500, internalError());
  }

  if (isConsoleApiError(payload)) {
    return safeError(statusForConsoleApiError(payload), payload);
  }
  return safeBody(successStatus, payload);
}

function sendRouteResult(response: ServerResponse, result: JsonRouteResult, headOnly: boolean): void {
  sendJson(response, result.status, result.body, headOnly);
}

function sendJson(response: ServerResponse, status: number, body: unknown, headOnly: boolean): void {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    ...JSON_SECURITY_HEADERS,
    "Content-Length": Buffer.byteLength(headOnly ? "" : text)
  });
  response.end(headOnly ? undefined : text);
}

function safeBody(status: number, body: unknown): JsonRouteResult {
  try {
    assertConsoleApiPayloadSafe(body);
    JSON.stringify(body);
    return { status, body };
  } catch {
    return { status: 500, body: internalError() };
  }
}

function safeError(status: number, error: ConsoleApiError): JsonRouteResult {
  return safeBody(status, error);
}

function badRequestError(message: string): ConsoleApiError {
  return { code: "bad_request", message, retryable: false };
}

function capabilityDisabled(capability: NonNullable<ConsoleApiError["capability"]>): JsonRouteResult {
  return safeError(409, {
    code: "capability_disabled",
    message: "Console write capability is disabled.",
    retryable: false,
    capability
  });
}

function notFoundError(): ConsoleApiError {
  return { code: "not_found", message: "Not found.", retryable: false };
}

function internalError(): ConsoleApiError {
  return {
    code: "internal_error",
    message: "Console API response is temporarily unavailable.",
    retryable: true
  };
}

function statusForConsoleApiError(error: ConsoleApiError): number {
  switch (error.code) {
    case "bad_request":
      return 400;
    case "unauthorized":
    case "forbidden":
    case "not_found":
      return 404;
    case "capability_disabled":
    case "conflict":
      return 409;
    case "rate_limited":
      return 429;
    case "bridge_unavailable":
      return 503;
    case "internal_error":
      return 500;
  }
}

function isSafeRouteOpaqueId(kind: ConsoleOpaqueIdKind, value: string): boolean {
  if (!isConsoleOpaqueId(kind, value)) {
    return false;
  }
  try {
    assertNoRawBridgeMarkers(value, `${kind}Id`);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(
  request: IncomingMessage,
  options: { allowEmpty: boolean }
): Promise<ParsedJsonBody> {
  const contentType = firstHeader(request.headers["content-type"])?.toLowerCase() ?? "";
  if (contentType && !contentType.includes("application/json")) {
    drain(request);
    return { ok: false, result: safeError(400, badRequestError("Request body must be JSON.")) };
  }

  const raw = await readBody(request);
  if (!raw) {
    return { ok: false, result: safeError(400, badRequestError("Request body is too large.")) };
  }
  if (raw.length === 0) {
    return options.allowEmpty
      ? { ok: true, value: {} }
      : { ok: false, result: safeError(400, badRequestError("Request body must be a JSON object.")) };
  }

  try {
    const value = JSON.parse(raw.toString("utf-8")) as unknown;
    assertConsoleApiPayloadSafe(value);
    return { ok: true, value };
  } catch {
    return { ok: false, result: safeError(400, badRequestError("Request body must be safe, well-formed JSON.")) };
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const declaredLength = Number.parseInt(firstHeader(request.headers["content-length"]) ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    drain(request);
    return null;
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) {
      drain(request);
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseSendMessageBody(parsed: ParsedJsonBody): SendMessageBody {
  if (!parsed.ok) {
    return parsed;
  }
  const object = asPlainObject(parsed.value);
  if (!object || hasUnknownKeys(object, ["text", "model", "mode", "attachmentArtifactIds"])) {
    return { ok: false, result: safeError(400, badRequestError("Message request body has invalid fields.")) };
  }

  const text = safeTrimmedBodyString(object.text, "Message text", MAX_MESSAGE_CHARS);
  if (!text.ok) {
    return text;
  }

  const request: ConsoleSendMessageRequest = { text: text.value };
  if (object.model !== undefined) {
    const model = safeTrimmedBodyString(object.model, "Model", MAX_OPTION_CHARS);
    if (!model.ok) {
      return model;
    }
    request.model = model.value;
  }
  if (object.mode !== undefined) {
    const mode = safeTrimmedBodyString(object.mode, "Mode", MAX_OPTION_CHARS);
    if (!mode.ok) {
      return mode;
    }
    request.mode = mode.value;
  }
  if (object.attachmentArtifactIds !== undefined) {
    if (!Array.isArray(object.attachmentArtifactIds) || object.attachmentArtifactIds.length > MAX_ATTACHMENT_IDS) {
      return { ok: false, result: safeError(400, badRequestError("Attachment artifact ids must be a small list of opaque Console artifact ids.")) };
    }
    const attachmentArtifactIds: NonNullable<ConsoleSendMessageRequest["attachmentArtifactIds"]> = [];
    for (const id of object.attachmentArtifactIds) {
      if (!isConsoleOpaqueId("artifact", id)) {
        return { ok: false, result: safeError(400, badRequestError("Attachment artifact ids must be opaque Console artifact ids.")) };
      }
      attachmentArtifactIds.push(id);
    }
    request.attachmentArtifactIds = attachmentArtifactIds;
  }

  return { ok: true, value: request };
}

function parseCreateSessionBody(parsed: ParsedJsonBody): CreateSessionBody {
  if (!parsed.ok) {
    return parsed;
  }
  const object = asPlainObject(parsed.value);
  if (!object || hasUnknownKeys(object, ["title"])) {
    return { ok: false, result: safeError(400, badRequestError("Create session request body has invalid fields.")) };
  }

  if (object.title === undefined) {
    return { ok: true, value: {} };
  }

  const title = safeTrimmedBodyString(object.title, "Session title", MAX_TITLE_CHARS);
  if (!title.ok) {
    return title;
  }
  return { ok: true, value: { title: title.value } };
}

function parseApprovalAnswerBody(parsed: ParsedJsonBody): ApprovalAnswerBody {
  if (!parsed.ok) {
    return parsed;
  }
  const object = asPlainObject(parsed.value);
  if (!object || hasUnknownKeys(object, ["answer", "scope", "reason"])) {
    return { ok: false, result: safeError(400, badRequestError("Approval answer request body has invalid fields.")) };
  }

  if (object.answer !== "approve" && object.answer !== "deny") {
    return { ok: false, result: safeError(400, badRequestError("Approval answer must be approve or deny.")) };
  }

  const request: ConsoleApprovalAnswerRequest = { answer: object.answer };
  if (object.scope !== undefined) {
    if (object.scope !== "single" && object.scope !== "all_pending_in_session") {
      return { ok: false, result: safeError(400, badRequestError("Approval answer scope is invalid.")) };
    }
    request.scope = object.scope;
  }
  if (object.reason !== undefined) {
    const reason = safeTrimmedBodyString(object.reason, "Approval answer reason", MAX_REASON_CHARS);
    if (!reason.ok) {
      return reason;
    }
    request.reason = reason.value;
  }

  return { ok: true, value: request };
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasUnknownKeys(object: Record<string, unknown>, allowed: string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(object).some((key) => !allowedSet.has(key));
}

function safeTrimmedBodyString(
  value: unknown,
  label: string,
  maxLength: number
): { ok: true; value: string } | { ok: false; result: JsonRouteResult } {
  if (typeof value !== "string") {
    return { ok: false, result: safeError(400, badRequestError(`${label} must be a string.`)) };
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, result: safeError(400, badRequestError(`${label} must not be blank.`)) };
  }
  if (trimmed.length > maxLength) {
    return { ok: false, result: safeError(400, badRequestError(`${label} is too long.`)) };
  }
  try {
    assertConsoleSafeString(trimmed, label);
    assertNoRawBridgeMarkers(trimmed, label);
  } catch {
    return { ok: false, result: safeError(400, badRequestError(`${label} contains unsupported data.`)) };
  }
  return { ok: true, value: trimmed };
}

function csrfAllowed(request: IncomingMessage, options: ConsoleApiHttpOptions): boolean {
  const csrfToken = currentCsrfToken(options);
  if (!csrfToken) {
    return false;
  }
  const headerToken = firstHeader(request.headers["x-csrf-token"]);
  return headerToken !== null && timingSafeEqualString(headerToken, csrfToken);
}

function currentCsrfToken(options: ConsoleApiHttpOptions): string | null {
  const value = typeof options.csrfToken === "function" ? options.csrfToken() : options.csrfToken;
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sameOriginAllowed(request: IncomingMessage): boolean {
  const source = firstHeader(request.headers.origin) || firstHeader(request.headers.referer);
  if (!source) {
    return true;
  }
  try {
    const sourceUrl = new URL(source);
    const host = firstHeader(request.headers["x-forwarded-host"]) || firstHeader(request.headers.host);
    if (!host) {
      return false;
    }
    const proto = firstHeader(request.headers["x-forwarded-proto"]) || "http";
    const expected = new URL(`${proto}://${host}`);
    return sourceUrl.protocol === expected.protocol && sourceUrl.host === expected.host;
  } catch {
    return false;
  }
}

function firstHeader(value: string | string[] | undefined): string | null {
  const text = Array.isArray(value) ? value[0] : value;
  const trimmed = String(text ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function timingSafeEqualString(a: string, b: string): boolean {
  return a.length === b.length && a === b;
}

function drain(request: IncomingMessage): void {
  request.resume();
}

function assertConsoleApiPayloadSafe(value: unknown): void {
  visitShape(value, (node, key) => {
    if (key && rawBridgeKeyPattern.test(key)) {
      throw new TypeError(`field name contains raw Bridge marker`);
    }

    if (typeof node === "string") {
      assertConsoleSafeString(node, key ?? "value");
      assertNoRawBridgeMarkers(node, key ?? "value");
    }

    if (!key) {
      return;
    }

    const kind = idFieldKinds[key as keyof typeof idFieldKinds];
    if (kind && !isConsoleOpaqueId(kind, node)) {
      throw new TypeError(`${key} must be an opaque Console ${kind} id`);
    }

    const listKind = listIdFieldKinds[key as keyof typeof listIdFieldKinds];
    if (listKind) {
      if (!Array.isArray(node)) {
        throw new TypeError(`${key} must be a list of opaque Console ${listKind} ids`);
      }
      for (const item of node) {
        if (!isConsoleOpaqueId(listKind, item)) {
          throw new TypeError(`${key} must contain only opaque Console ${listKind} ids`);
        }
      }
    }

    if (key === "eventsUrl" && typeof node === "string" && !/^\/api\/sessions\/ses_[A-Za-z0-9_-]{6,128}\/events$/.test(node)) {
      throw new TypeError("eventsUrl must use an opaque Console session id");
    }

    if (key === "url" && typeof node === "string" && node.startsWith("/api/artifacts/") && !/^\/api\/artifacts\/art_[A-Za-z0-9_-]{6,128}$/.test(node)) {
      throw new TypeError("artifact url must use an opaque Console artifact id");
    }
  });
}

function assertNoRawBridgeMarkers(value: string, fieldName: string): void {
  for (const { label, pattern } of rawBridgeStringPatterns) {
    if (pattern.test(value)) {
      throw new TypeError(`${fieldName} contains ${label}`);
    }
  }
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

function isConsoleApiError(value: unknown): value is ConsoleApiError {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as ConsoleApiError).code === "string" &&
    typeof (value as ConsoleApiError).message === "string" &&
    typeof (value as ConsoleApiError).retryable === "boolean"
  );
}

function safePathname(urlValue: string): string | null {
  try {
    return new URL(urlValue, "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

function isApiPathname(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}
