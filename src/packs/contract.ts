import type { BridgeConfig } from "../config.js";
import type { JsonRpcServerRequest } from "../codex/app-server.js";
import type { BridgeDynamicToolDeclaration, ServerRequestSupport } from "../codex/server-request-policy.js";
import type { PlatformCapabilitySnapshot } from "../core/interaction-model/surface.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import type { BridgeStateStore } from "../state/store.js";
import type { ReadinessSnapshot } from "../types.js";
import type { BridgePackName } from "./names.js";

export interface PackHealthCheck {
  id: string;
  ok: boolean;
  summary: string;
  missingEnv?: string[] | undefined;
  blocking?: boolean | undefined;
  source?: "automatic" | "observed" | "operator_checklist" | "heuristic" | undefined;
}

export interface PackHealthReport {
  state: "ready" | "awaiting_authorization" | "pack_unhealthy";
  checks: PackHealthCheck[];
  issues: string[];
  metadata?: Record<string, string | boolean | null | undefined>;
  setupState?: "complete" | "incomplete";
  setupChecklist?: string[];
}

export interface EgressMessageSendResult {
  messageId: number;
}

export interface EgressEditResult {
  outcome: "edited" | "unchanged" | "rate_limited" | "failed";
  retryAfterMs?: number | null;
}

export interface EgressDeleteResult {
  outcome: "deleted" | "not_found" | "rate_limited" | "failed";
  retryAfterMs?: number | null;
}

export interface EgressSendMessageOptions {
  replyMarkup?: unknown;
  parseMode?: "HTML" | null;
}

export interface EgressRichMessage {
  markdown?: string;
  html?: string;
  blocks?: unknown[];
  media?: unknown[];
  isRtl?: boolean;
  skipEntityDetection?: boolean;
}

export interface EgressSendPhotoOptions {
  caption?: string;
  parseMode?: "HTML";
}

export interface EgressSendDocumentOptions {
  caption?: string;
  parseMode?: "HTML";
  fileName?: string;
}

export interface PlatformEgressAdapter {
  readonly kind: "bot_api" | "open_api";

  sendMessage(chatId: string, text: string, options?: EgressSendMessageOptions): Promise<EgressMessageSendResult>;
  sendRichMessage?(
    chatId: string,
    richMessage: EgressRichMessage,
    options?: Pick<EgressSendMessageOptions, "replyMarkup">
  ): Promise<EgressMessageSendResult>;
  sendPhoto(chatId: string, photoPath: string, options?: EgressSendPhotoOptions): Promise<EgressMessageSendResult>;
  sendDocument(chatId: string, filePath: string, options?: EgressSendDocumentOptions): Promise<EgressMessageSendResult>;
  editMessageText(chatId: string, messageId: number, text: string, options?: EgressSendMessageOptions): Promise<EgressEditResult>;
  deleteMessage(chatId: string, messageId: number): Promise<EgressDeleteResult>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  pinChatMessage(chatId: string, messageId: number): Promise<boolean>;
  unpinChatMessage(chatId: string, messageId: number): Promise<boolean>;
}

export interface BridgePackRuntime {
  run(): Promise<void>;
  stop(context?: { source?: string; signal?: string | null }): Promise<void>;
}

export interface BridgePackDefinition<PackConfig = unknown> {
  name: BridgePackName;
  displayName: string;
  skillName: string;
  capabilities: PlatformCapabilitySnapshot;
  ingress: {
    kind: "polling" | "long_connection";
    ownsCallbacks: boolean;
    ownsRichInput: boolean;
    ownsMediaIngress: boolean;
  };
  presentation: {
    preferBridgeCommandButtons: boolean;
  };
  egress: {
    kind: "bot_api" | "open_api";
    syncControlSurface(options: {
      config: BridgeConfig;
      logger: Logger;
    }): Promise<void>;
  };
  authBinding: {
    isBound(store: BridgeStateStore): boolean;
    describeMissingCredentials(config: BridgeConfig): string[];
  };
  install: {
    validateInstallConfig(config: BridgeConfig): void;
    shouldSyncControlSurface(snapshot: ReadinessSnapshot): boolean;
  };
  platformActions: {
    getDynamicToolDeclarations(): BridgeDynamicToolDeclaration[];
    interpretServerRequest(request: JsonRpcServerRequest): ServerRequestSupport;
  };
  healthChecks: {
    run(options: {
      config: BridgeConfig;
      store: BridgeStateStore;
      logger: Logger;
    }): Promise<PackHealthReport>;
  };
  getPackConfig(config: BridgeConfig): PackConfig;
  createRuntime(options: {
    paths: BridgePaths;
    config: BridgeConfig;
  }): BridgePackRuntime;
}
