import { createHash } from "node:crypto";

import type {
  ConsoleApiError,
  ConsoleMessage,
  ConsoleSendMessageRequest,
  ConsoleSendMessageResult,
  ConsoleSessionId
} from "./console-api-contract.js";
import type { ConsoleBridgeReadAdapter } from "./console-bridge-read-adapter.js";
import type { ConsoleApiWriteAdapter } from "./console-api-http.js";
import type { WebMessageSubmitRequest, WebMessageSubmitResult } from "./readonly-http-server.js";

export interface ConsoleLiveWriteAdapterOptions {
  readAdapter: ConsoleBridgeReadAdapter;
  submitTextMessage: (request: WebMessageSubmitRequest) => Promise<WebMessageSubmitResult> | WebMessageSubmitResult;
  now?: () => string;
}

interface ConsoleSessionHandleResolver {
  resolveConversationHandleForSession?(sessionId: ConsoleSessionId | string): string | null;
}

export function createConsoleLiveWriteAdapter(options: ConsoleLiveWriteAdapterOptions): ConsoleApiWriteAdapter {
  const now = () => safeIso(options.now?.() ?? new Date().toISOString());
  const canResolveSession = Boolean((options.readAdapter as ConsoleSessionHandleResolver).resolveConversationHandleForSession);
  return {
    capabilities: {
      archiveProject: { state: "disabled", reason: "Project archive is not wired to a safe live Web submit seam." },
      createSession: { state: "disabled", reason: "Session creation is not wired to a safe live Web submit seam." },
      sendMessage: canResolveSession
        ? { state: "enabled" }
        : { state: "disabled", reason: "Console sessions cannot be resolved to the live Web submit seam." },
      answerApproval: { state: "disabled", reason: "Approval answers are not wired to a safe live Web submit seam." }
    },
    async sendMessage(sessionId, request) {
      if (request.attachmentArtifactIds && request.attachmentArtifactIds.length > 0) {
        return apiError(
          "capability_disabled",
          "Attachments are not enabled for live Web send.",
          false,
          "uploadFiles"
        );
      }

      const conversationHandle = (options.readAdapter as ConsoleSessionHandleResolver)
        .resolveConversationHandleForSession?.(sessionId) ?? null;
      if (!conversationHandle) {
        return apiError("not_found", "Session is not available for live Web send.", false);
      }

      const detail = options.readAdapter.getSessionDetail(sessionId);
      if (isConsoleApiError(detail)) {
        return apiError("not_found", "Session is not available for live Web send.", false);
      }
      if (detail.archived || detail.status === "archived") {
        return apiError("conflict", "Archived sessions cannot receive live Web messages.", false);
      }

      const text = request.text.trim();
      const outcome = await submitSafely(options.submitTextMessage, { conversationHandle, text, nonce: null });
      if (outcome.status === "accepted") {
        return {
          accepted: true,
          sessionId,
          message: pendingUserMessage(sessionId, text, now())
        };
      }
      if (outcome.status === "blocked") {
        return apiError("conflict", "Codex is busy or waiting for owner input in this session.", false);
      }
      if (outcome.status === "unavailable") {
        return apiError("bridge_unavailable", "Live Web send is temporarily unavailable.", true);
      }
      return apiError("not_found", "Session is not available for live Web send.", false);
    }
  };
}

async function submitSafely(
  submitTextMessage: ConsoleLiveWriteAdapterOptions["submitTextMessage"],
  request: WebMessageSubmitRequest
): Promise<WebMessageSubmitResult> {
  try {
    return await submitTextMessage(request);
  } catch {
    return { status: "unavailable" };
  }
}

function pendingUserMessage(sessionId: ConsoleSessionId, text: string, createdAt: string): ConsoleMessage {
  return {
    messageId: opaqueMessageId(sessionId, text, createdAt),
    sessionId,
    role: "user",
    text,
    format: "plain_text",
    status: "pending",
    createdAt
  };
}

function opaqueMessageId(sessionId: ConsoleSessionId, text: string, createdAt: string): ConsoleMessage["messageId"] {
  const digest = createHash("sha256")
    .update("console-live-write-adapter:v1")
    .update("\0")
    .update(sessionId)
    .update("\0")
    .update(createdAt)
    .update("\0")
    .update(text)
    .digest("base64url")
    .slice(0, 22);
  return `msg_${digest}`;
}

function apiError(
  code: ConsoleApiError["code"],
  message: string,
  retryable: boolean,
  capability?: ConsoleApiError["capability"]
): ConsoleApiError {
  return {
    code,
    message,
    retryable,
    ...(capability ? { capability } : {})
  };
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

function safeIso(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString();
}
