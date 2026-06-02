import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";

import type { WebReadonlyViewModelProvider } from "../service/web-readonly-view-model.js";
import { createConsoleBridgeReadAdapter, type ConsoleBridgeReadAdapter } from "./console-bridge-read-adapter.js";
import { handleConsoleApiHttpRequest, isConsoleApiPath, sendConsoleApiDenied, type ConsoleApiWriteAdapter } from "./console-api-http.js";
import { createConsoleLiveWriteAdapter } from "./console-live-write-adapter.js";
import type { ConsoleCapabilities } from "./console-api-contract.js";
import type { ReadonlyAccessGate } from "./readonly-access.js";
import {
  renderConversationResultPage,
  renderGenericErrorPage,
  renderGenericNotFoundPage,
  renderHomePage,
  renderPendingInteractionsPage,
  renderReadinessPage,
  renderRuntimePage,
  renderWorkspaceConversationListPage,
  renderWorkspaceListPage,
  APP_CSS
} from "./readonly-renderer.js";
import { CONSOLE_PRODUCT_SCRIPT } from "./console-product-renderer.js";

export interface ReadonlyHttpServerOptions {
  provider: WebReadonlyViewModelProvider;
  access: ReadonlyAccessGate;
  consoleReadAdapter?: ConsoleBridgeReadAdapter;
  consoleWriteAdapter?: ConsoleApiWriteAdapter;
  send?: WebMessageSendOptions;
}

type RouteResult = { status: number; html: string };
type WebSubmitStatus = "accepted" | "blocked" | "rejected" | "unavailable";
type WebPostRedirectStatus = WebSubmitStatus | "invalid" | "denied";

export interface WebMessageSubmitRequest {
  conversationHandle: string;
  text: string;
  nonce: string | null;
}

export interface WebMessageSubmitResult {
  status: WebSubmitStatus;
}

export interface WebMessageSendOptions {
  csrfToken: string | (() => string | null | undefined);
  submitTextMessage: (request: WebMessageSubmitRequest) => Promise<WebMessageSubmitResult> | WebMessageSubmitResult;
}

const MAX_MESSAGE_CHARS = 8_000;
const MAX_POST_BODY_BYTES = 32 * 1024;

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash()}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  "X-Content-Type-Options": "nosniff",
  "Content-Type": "text/html; charset=utf-8"
} as const;

const API_PRODUCT_SECURITY_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${styleHash()}'; script-src 'sha256-${productScriptHash()}'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
} as const;

const WRITE_SECURITY_HEADERS = API_PRODUCT_SECURITY_HEADERS;

function styleHash(): string {
  return createHash("sha256").update(`\n${APP_CSS}\n`).digest("base64");
}

function productScriptHash(): string {
  return createHash("sha256").update(`\n${CONSOLE_PRODUCT_SCRIPT}\n`).digest("base64");
}

export function createReadonlyHttpServer(options: ReadonlyHttpServerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(options, request, response);
  });
}

async function handleRequest(
  options: ReadonlyHttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  try {
    const apiPath = isConsoleApiPath(request.url ?? "/");
    if (!options.access.authorize(request.headers)) {
      if (apiPath) {
        return sendConsoleApiDenied(response, request.method === "HEAD");
      }
      return send(response, 404, renderGenericNotFoundPage(), request.method === "HEAD");
    }

    if (apiPath) {
      const consoleReadAdapter = options.consoleReadAdapter ?? createConsoleBridgeReadAdapter({ provider: options.provider });
      const consoleWriteAdapter = writeAdapterFor(options, consoleReadAdapter);
      const apiOptions = {
        provider: options.provider,
        adapter: consoleReadAdapter,
        ...(consoleWriteAdapter ? { writeAdapter: consoleWriteAdapter } : {}),
        ...(options.send ? { csrfToken: () => currentCsrfToken(options.send!) } : {})
      };
      if (handleConsoleApiHttpRequest(apiOptions, request, response)) {
        return;
      }
    }

    if (request.method === "POST") {
      return await handlePost(options, request, response);
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return send(response, 404, renderGenericNotFoundPage(), request.method === "HEAD");
    }

    const route = resolveRoute(request.url ?? "/", options.provider, options);
    return send(response, route.status, route.html, request.method === "HEAD", sendEnabled(options));
  } catch {
    return send(response, 500, renderGenericErrorPage(), request.method === "HEAD");
  }
}

async function handlePost(
  options: ReadonlyHttpServerOptions,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const pathname = safePathname(request.url ?? "/");
  const conversationMatch = /^\/conversations\/(cv_[a-f0-9]{16})\/messages$/.exec(pathname ?? "");
  if (!conversationMatch?.[1] || !options.send) {
    return send(response, 404, renderGenericNotFoundPage(), false, sendEnabled(options));
  }

  const csrfToken = currentCsrfToken(options.send);
  const wantsJson = acceptsJson(request.headers.accept);
  if (!csrfToken || !sameOriginAllowed(request) || !csrfHeaderAllowed(request, csrfToken)) {
    return sendPostOutcome(response, conversationMatch[1], "denied", wantsJson);
  }

  const parsed = await readMessageBody(request, csrfToken);
  if (!parsed.ok) {
    return sendPostOutcome(response, conversationMatch[1], "invalid", wantsJson);
  }

  try {
    const outcome = await options.send.submitTextMessage({
      conversationHandle: conversationMatch[1],
      text: parsed.text,
      nonce: parsed.nonce
    });
    return sendPostOutcome(response, conversationMatch[1], normalizeSubmitStatus(outcome.status), wantsJson);
  } catch {
    return sendPostOutcome(response, conversationMatch[1], "unavailable", wantsJson);
  }
}

function hasConsoleSessionHandleResolver(
  adapter: ConsoleBridgeReadAdapter
): adapter is ConsoleBridgeReadAdapter & {
  resolveConversationHandleForSession: NonNullable<ConsoleBridgeReadAdapter["resolveConversationHandleForSession"]>;
} {
  return typeof adapter.resolveConversationHandleForSession === "function";
}

function resolveRoute(urlValue: string, provider: WebReadonlyViewModelProvider, options: ReadonlyHttpServerOptions): RouteResult {
  let pathname = "/";
  let searchParams = new URLSearchParams();
  try {
    const url = new URL(urlValue, "http://127.0.0.1");
    pathname = url.pathname;
    searchParams = url.searchParams;
  } catch {
    return { status: 404, html: renderGenericNotFoundPage() };
  }

  if (pathname === "/" || pathname === "/chat") {
    const consoleReadAdapter = options.consoleReadAdapter ?? createConsoleBridgeReadAdapter({ provider });
    const consoleWriteAdapter = writeAdapterFor(options, consoleReadAdapter);
    const csrfToken = options.send ? currentCsrfToken(options.send) : null;
    const capabilityOverrides = consoleWriteAdapter ? writeCapabilityOverrides(consoleWriteAdapter, csrfToken) : undefined;
    return {
      status: 200,
      html: renderHomePage(undefined, {
        adapter: consoleReadAdapter,
        csrfToken,
        ...(capabilityOverrides ? { capabilities: capabilityOverrides } : {})
      })
    };
  }
  if (pathname === "/readiness") {
    return { status: 200, html: renderReadinessPage(provider.getReadinessGuardrailViewModel()) };
  }
  if (pathname === "/runtime") {
    return { status: 200, html: renderRuntimePage(provider.getRuntimeContextViewModel()) };
  }
  if (pathname === "/workspaces") {
    return { status: 200, html: renderWorkspaceListPage(provider.listWorkspaceViewModels()) };
  }
  if (pathname === "/interactions") {
    return { status: 200, html: renderPendingInteractionsPage(provider.getPendingInteractionsViewModel()) };
  }

  const conversationMatch = /^\/conversations\/(cv_[a-f0-9]{16})$/.exec(pathname);
  if (conversationMatch?.[1]) {
    return {
      status: 200,
      html: renderConversationResultPage(
        provider.getConversationResultViewModel(conversationMatch[1]),
        renderOptions(options, normalizedFlashStatus(searchParams.get("send")))
      )
    };
  }

  const workspaceMatch = /^\/workspaces\/(wk_[A-Za-z0-9_-]{1,80})\/conversations$/.exec(pathname);
  if (workspaceMatch?.[1]) {
    return {
      status: 200,
      html: renderWorkspaceConversationListPage(provider.listWorkspaceConversationViewModels(workspaceMatch[1]))
    };
  }

  return { status: 404, html: renderGenericNotFoundPage() };
}

function send(response: ServerResponse, status: number, html: string, headOnly: boolean, writeEnabled = false): void {
  response.writeHead(status, writeEnabled ? WRITE_SECURITY_HEADERS : html.includes('data-console-api-root="/api"') ? API_PRODUCT_SECURITY_HEADERS : SECURITY_HEADERS);
  response.end(headOnly ? undefined : html);
}

function renderOptions(options: ReadonlyHttpServerOptions, flashStatus: WebPostRedirectStatus | null = null) {
  const csrfToken = options.send ? currentCsrfToken(options.send) : null;
  return {
    ...(csrfToken && options.send?.submitTextMessage ? { send: { csrfToken } } : {}),
    ...(flashStatus ? { flash: { status: flashStatus } } : {})
  };
}

function sendEnabled(options: ReadonlyHttpServerOptions): boolean {
  return Boolean(options.send?.submitTextMessage && currentCsrfToken(options.send));
}

function writeAdapterFor(
  options: ReadonlyHttpServerOptions,
  consoleReadAdapter: ConsoleBridgeReadAdapter
): ConsoleApiWriteAdapter | undefined {
  return options.consoleWriteAdapter
    ?? (options.send && hasConsoleSessionHandleResolver(consoleReadAdapter)
      ? createConsoleLiveWriteAdapter({
        readAdapter: consoleReadAdapter,
        submitTextMessage: options.send.submitTextMessage
      })
      : undefined);
}

function writeCapabilityOverrides(
  writeAdapter: ConsoleApiWriteAdapter,
  csrfToken: string | null
): Partial<Pick<ConsoleCapabilities, "sendMessage">> {
  const advertised = writeAdapter.capabilities?.sendMessage;
  if (!writeAdapter.sendMessage) {
    return { sendMessage: { state: "disabled", reason: "Console write capability is disabled." } };
  }
  if (advertised?.state === "disabled") {
    return { sendMessage: advertised };
  }
  if (!csrfToken) {
    return { sendMessage: { state: "disabled", reason: "Console write capability requires CSRF protection." } };
  }
  return { sendMessage: advertised ?? { state: "enabled" } };
}

function currentCsrfToken(send: WebMessageSendOptions): string | null {
  const value = typeof send.csrfToken === "function" ? send.csrfToken() : send.csrfToken;
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safePathname(urlValue: string): string | null {
  try {
    return new URL(urlValue, "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

function acceptsJson(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(",") : accept ?? "";
  return /\bapplication\/json\b/i.test(value);
}

function csrfHeaderAllowed(request: IncomingMessage, expectedToken: string): boolean {
  const headerToken = firstHeader(request.headers["x-csrf-token"]);
  return !headerToken || timingSafeEqualString(headerToken, expectedToken);
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

type ParsedMessageBody =
  | { ok: true; text: string; nonce: string | null }
  | { ok: false };

async function readMessageBody(request: IncomingMessage, csrfToken: string): Promise<ParsedMessageBody> {
  const raw = await readBody(request);
  if (!raw) {
    return { ok: false };
  }
  const contentType = firstHeader(request.headers["content-type"])?.toLowerCase() ?? "";
  let message: unknown;
  let nonce: unknown;
  let bodyToken: unknown;

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(raw.toString("utf-8"));
    message = form.get("message") ?? form.get("text");
    nonce = form.get("nonce") ?? form.get("idempotency") ?? form.get("idempotencyKey");
    bodyToken = form.get("_csrf") ?? form.get("csrf");
  } else if (contentType.includes("application/json")) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.toString("utf-8")) as Record<string, unknown>;
    } catch {
      return { ok: false };
    }
    if (parsed.attachments !== undefined || parsed.files !== undefined) {
      return { ok: false };
    }
    message = parsed.message ?? parsed.text;
    nonce = parsed.nonce ?? parsed.idempotency ?? parsed.idempotencyKey;
    bodyToken = parsed._csrf ?? parsed.csrf;
  } else {
    return { ok: false };
  }

  if (typeof bodyToken !== "string" || !timingSafeEqualString(bodyToken, csrfToken)) {
    return { ok: false };
  }
  if (typeof message !== "string") {
    return { ok: false };
  }
  const text = message.trim();
  if (!text || text.length > MAX_MESSAGE_CHARS) {
    return { ok: false };
  }
  return {
    ok: true,
    text,
    nonce: typeof nonce === "string" && nonce.trim() ? nonce.trim().slice(0, 128) : null
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer | null> {
  const declaredLength = Number.parseInt(firstHeader(request.headers["content-length"]) ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_POST_BODY_BYTES) {
    drain(request);
    return null;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_POST_BODY_BYTES) {
      drain(request);
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function drain(request: IncomingMessage): void {
  request.resume();
}

function normalizeSubmitStatus(status: string): WebSubmitStatus {
  return status === "accepted" || status === "blocked" || status === "unavailable" ? status : "rejected";
}

function normalizedFlashStatus(status: string | null): WebPostRedirectStatus | null {
  return status === "accepted" ||
    status === "blocked" ||
    status === "rejected" ||
    status === "unavailable" ||
    status === "invalid" ||
    status === "denied"
    ? status
    : null;
}

function sendPostOutcome(
  response: ServerResponse,
  conversationHandle: string,
  status: WebSubmitStatus | "invalid" | "denied",
  wantsJson: boolean
): void {
  if (wantsJson) {
    const httpStatus = status === "accepted"
      ? 202
      : status === "blocked"
        ? 409
        : status === "unavailable"
          ? 503
          : status === "denied"
            ? 403
            : 400;
    const body = `${JSON.stringify({ status })}\n`;
    response.writeHead(httpStatus, {
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body)
    });
    response.end(body);
    return;
  }

  response.writeHead(303, {
    ...WRITE_SECURITY_HEADERS,
    Location: `/conversations/${conversationHandle}?send=${status}`,
    "Content-Length": "0"
  });
  response.end();
}
