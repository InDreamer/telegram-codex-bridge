import type { JsonRpcServerRequest } from "./app-server.js";
import type { BridgePlatformAction } from "../core/interaction-model/platform-actions.js";
import { normalizeServerRequest } from "../interactions/normalize.js";
import { asRecord, getString, getRequiredString } from "../util/untyped.js";

export interface BridgeDynamicToolDeclaration {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: "string" }>;
    required?: readonly string[];
  };
}

export interface BridgeDynamicToolDefinition {
  toolName: string;
  action: BridgePlatformAction;
  description: string;
  inputSchema: BridgeDynamicToolDeclaration["inputSchema"];
}

export interface PlatformActionRequestSupport {
  kind: "platform_action";
  action: BridgePlatformAction;
  toolName: string;
  path: string | null;
  caption: string | null;
  fileName: string | null;
}

export interface InteractionRequestSupport {
  kind: "interaction";
  normalized: NonNullable<ReturnType<typeof normalizeServerRequest>>;
}

export interface UnsupportedRequestSupport {
  kind: "unsupported";
  errorCode: number;
  errorMessage: string;
  userMessage?: string | null;
  logDetail?: string | null;
}

export type ServerRequestSupport =
  | PlatformActionRequestSupport
  | InteractionRequestSupport
  | UnsupportedRequestSupport;

export function createDynamicToolDeclarations(
  tools: readonly BridgeDynamicToolDefinition[]
): BridgeDynamicToolDeclaration[] {
  return tools.map((tool) => ({
    name: tool.toolName,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

export function interpretSharedServerRequest(request: JsonRpcServerRequest): ServerRequestSupport | null {
  if (request.method === "item/tool/call") {
    return null;
  }

  if (request.method === "account/chatgptAuthTokens/refresh") {
    const reason = getString(asRecord(request.params), "reason") ?? "unknown";
    return {
      kind: "unsupported",
      errorCode: -32601,
      errorMessage: "ChatGPT auth token refresh is not supported by the active bridge pack",
      userMessage: `Codex requested ChatGPT token refresh (reason: ${reason})，但当前 bridge pack 不持有可刷新的 ChatGPT access token / account id，已拒绝这次请求。`,
      logDetail: `reason=${reason}`
    };
  }

  const normalized = normalizeServerRequest(request.method, request.params);
  if (normalized) {
    return {
      kind: "interaction",
      normalized
    };
  }

  return {
    kind: "unsupported",
    errorCode: -32601,
    errorMessage: `Unsupported server request: ${request.method}`
  };
}

export function interpretDynamicToolRequest(
  request: JsonRpcServerRequest,
  tools: readonly BridgeDynamicToolDefinition[]
): ServerRequestSupport {
  if (request.method !== "item/tool/call") {
    return {
      kind: "unsupported",
      errorCode: -32601,
      errorMessage: `Unsupported server request: ${request.method}`
    };
  }

  const requestParams = asRecord(request.params);
  const toolName = getString(requestParams, "tool") ?? "unknown";
  const allowedTool = tools.find((candidate) => candidate.toolName === toolName);
  if (!allowedTool) {
    const supportedTools = tools.map((tool) => tool.toolName);
    return {
      kind: "unsupported",
      errorCode: -32601,
      errorMessage: `Dynamic tool call is not supported by the active bridge pack: ${toolName}`,
      userMessage: supportedTools.length > 0
        ? `Codex initiated a dynamic tool call (${toolName})，但当前 bridge pack 仅声明了这些 dynamic tools：${supportedTools.join(", ")}。`
        : `Codex initiated a dynamic tool call (${toolName})，但当前 bridge pack 未声明任何可用的 dynamic tools。`,
      logDetail: `tool=${toolName}`
    };
  }

  const argumentsRecord = asRecord(requestParams?.arguments);
  return {
    kind: "platform_action",
    action: allowedTool.action,
    toolName,
    path: getRequiredString(argumentsRecord, "path"),
    caption: getString(argumentsRecord, "caption"),
    fileName: getString(argumentsRecord, "filename")
  };
}
