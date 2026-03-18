import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type { Logger } from "../logger.js";
import type { ReasoningEffort } from "../types.js";

interface JsonRpcSuccess {
  id: JsonRpcRequestId;
  result: unknown;
}

interface JsonRpcError {
  id: JsonRpcRequestId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest {
  id: JsonRpcRequestId;
  method: string;
  params?: unknown;
}

export type JsonRpcRequestId = number | string;

type JsonRpcMessage = JsonRpcSuccess | JsonRpcError | JsonRpcNotification | JsonRpcServerRequest;
type NotificationHandler = (notification: JsonRpcNotification) => void;
type ServerRequestHandler = (request: JsonRpcServerRequest) => void;
type ExitHandler = (error: Error) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface ThreadStartParams {
  cwd: string;
  approvalPolicy: "never";
  sandbox: "danger-full-access";
  model?: string;
}

interface TurnStartParams {
  threadId: string;
  cwd: string;
  approvalPolicy: "never";
  collaborationMode?: {
    mode: "default" | "plan";
    settings: {
      model: string;
      developer_instructions?: string | null;
      reasoning_effort?: ReasoningEffort | null;
    };
  };
  sandboxPolicy: {
    type: "dangerFullAccess";
  };
  input: UserInput[];
  model?: string;
  effort?: ReasoningEffort;
}

export interface ThreadRealtimeAudioChunk {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel?: number | null;
}

export type UserInput =
  | {
      type: "text";
      text: string;
      text_elements?: Array<{
        byteRange: {
          start: number;
          end: number;
        };
        placeholder?: string | null;
      }>;
    }
  | {
      type: "image";
      url: string;
    }
  | {
      type: "localImage";
      path: string;
    }
  | {
      type: "skill";
      name: string;
      path: string;
    }
  | {
      type: "mention";
      name: string;
      path: string;
    };

export interface ThreadStartResult {
  thread: { id: string };
  model?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}

export interface ModelListResult {
  data: Array<{
    id: string;
    model: string;
    displayName: string;
    description: string;
    hidden: boolean;
    isDefault: boolean;
    defaultReasoningEffort: ReasoningEffort;
    supportedReasoningEfforts: Array<{
      reasoningEffort: ReasoningEffort;
      description: string;
    }>;
    inputModalities?: string[];
    supportsPersonality?: boolean;
  }>;
  nextCursor?: string | null;
}

export interface SkillListResult {
  data: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      description: string;
      path: string;
      scope: string;
      enabled: boolean;
      shortDescription?: string | null;
      interface?: {
        displayName?: string | null;
        shortDescription?: string | null;
      } | null;
    }>;
    errors: Array<{
      path: string;
      message: string;
    }>;
  }>;
}

export interface PluginListResult {
  marketplaces: Array<{
    name: string;
    path: string;
    plugins: Array<{
      id: string;
      name: string;
      installed: boolean;
      enabled: boolean;
      source?: {
        type: string;
        path?: string;
      } | null;
      interface?: {
        displayName?: string | null;
        shortDescription?: string | null;
      } | null;
    }>;
  }>;
}

export interface PluginInstallResult {
  appsNeedingAuth: Array<{
    id: string;
    name: string;
    description: string | null;
    installUrl: string | null;
  }>;
}

export interface AppListResult {
  data: Array<{
    id: string;
    name: string;
    description: string | null;
    installUrl: string | null;
    isAccessible: boolean;
    isEnabled: boolean;
    pluginDisplayNames: string[];
  }>;
  nextCursor?: string | null;
}

export interface McpServerStatusListResult {
  data: Array<{
    name: string;
    tools: Record<string, unknown>;
    resources: unknown[];
    resourceTemplates: unknown[];
    authStatus: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
  }>;
  nextCursor?: string | null;
}

export interface McpServerOauthLoginResult {
  authorizationUrl: string;
}

export interface AccountReadResult {
  account:
    | {
        type: "apiKey";
      }
    | {
        type: "chatgpt";
        email: string;
        planType: string;
      }
    | null;
  requiresOpenaiAuth: boolean;
}

export interface RateLimitSnapshotResult {
  limitId: string | null;
  limitName: string | null;
  primary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  secondary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  planType: string | null;
}

export interface AccountRateLimitsReadResult {
  rateLimits: RateLimitSnapshotResult;
  rateLimitsByLimitId: Record<string, RateLimitSnapshotResult> | null;
}

export interface ThreadResumeResult {
  model?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  thread: {
    id: string;
    reasoningEffort?: ReasoningEffort | null;
    turns: Array<{
      id: string;
      items: Array<{
        type: string;
        text?: string;
        phase?: string | null;
      }>;
    }>;
  };
}

export interface TurnStartResult {
  turn: {
    id: string;
    status: string;
  };
}

export interface ReviewStartResult {
  reviewThreadId: string;
  turn: {
    id: string;
    status: string;
  };
}

export interface ThreadForkResult {
  thread: {
    id: string;
    turns: Array<{
      id: string;
      status: string;
    }>;
  };
  cwd: string;
  model: string;
  reasoningEffort?: ReasoningEffort | null;
}

export interface ThreadRollbackResult {
  thread: {
    id: string;
    turns: Array<{
      id: string;
      status: string;
    }>;
  };
}

export interface ThreadListResult {
  data: Array<{
    id: string;
    name?: string | null;
    cwd: string;
    preview: string;
    updatedAt: number;
    createdAt: number;
    status: unknown;
  }>;
  nextCursor?: string | null;
}

export interface ThreadReadResult {
  thread: {
    id: string;
    name?: string | null;
    cwd: string;
    preview: string;
    updatedAt: number;
    createdAt: number;
    status: unknown;
    turns: unknown[];
  };
}

export function buildThreadStartParams(options: {
  cwd: string;
  model?: string;
}): ThreadStartParams {
  return {
    cwd: options.cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ...(options.model ? { model: options.model } : {})
  };
}

export function buildTurnStartParams(options: {
  threadId: string;
  cwd: string;
  text?: string;
  input?: UserInput[];
  model?: string;
  effort?: ReasoningEffort;
  collaborationMode?: {
    mode: "default" | "plan";
    settings: {
      model: string;
      developerInstructions?: string | null;
      reasoningEffort?: ReasoningEffort | null;
    };
  };
}): TurnStartParams {
  const input = options.input ?? (options.text ? [{ type: "text", text: options.text }] : []);
  return {
    threadId: options.threadId,
    cwd: options.cwd,
    approvalPolicy: "never",
    ...(options.collaborationMode
      ? {
          collaborationMode: {
            mode: options.collaborationMode.mode,
            settings: {
              model: options.collaborationMode.settings.model,
              ...(options.collaborationMode.settings.developerInstructions !== undefined
                ? {
                    developer_instructions:
                      options.collaborationMode.settings.developerInstructions
                  }
                : {}),
              ...(options.collaborationMode.settings.reasoningEffort !== undefined
                ? {
                    reasoning_effort: options.collaborationMode.settings.reasoningEffort
                  }
                : {})
            }
          }
        }
      : {}),
    sandboxPolicy: { type: "dangerFullAccess" },
    input,
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {})
  };
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private initialized = false;
  private stderrStream: WriteStream | null = null;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly serverRequestHandlers = new Set<ServerRequestHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();

  constructor(
    private readonly codexBin: string,
    private readonly logPath: string,
    private readonly logger: Logger,
    private readonly startupTimeoutMs = 5000,
    private readonly options: {
      experimentalApi?: boolean;
    } = {}
  ) {}

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    await mkdir(dirname(this.logPath), { recursive: true });
    this.stderrStream = createWriteStream(this.logPath, { flags: "a" });

    const child = spawn(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child = child;

    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrStream?.write(chunk.toString());
    });

    child.on("error", (error) => {
      const wrapped = new Error(`app-server failed to start: ${error}`);
      this.rejectAllPending(wrapped);
      this.emitExit(wrapped);
    });

    child.on("close", (code, signal) => {
      this.initialized = false;
      this.child = null;
      const wrapped = new Error(`app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.rejectAllPending(wrapped);
      this.emitExit(wrapped);
      void this.logger.warn("app-server child exited", { code: code ?? null, signal: signal ?? null });
    });

    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      this.handleMessage(line);
    });
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get isRunning(): boolean {
    return this.child !== null;
  }

  async initializeAndProbe(): Promise<void> {
    await this.start();
    await this.request("initialize", {
      clientInfo: {
        name: "codex-telegram-bridge",
        version: "0.1.0"
      },
      ...(this.options.experimentalApi ? {
        capabilities: {
          experimentalApi: true
        }
      } : {})
    });
    this.notify("initialized", {});
    await this.request("thread/list", {});
    this.initialized = true;
  }

  async startThread(options: {
    cwd: string;
    model?: string;
  }): Promise<ThreadStartResult> {
    return await this.request<ThreadStartResult>("thread/start", buildThreadStartParams(options));
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResult> {
    return await this.request<ThreadResumeResult>("thread/resume", {
      threadId
    });
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.request("thread/archive", { threadId });
  }

  async unarchiveThread(threadId: string): Promise<void> {
    await this.request("thread/unarchive", { threadId });
  }

  async listThreads(options?: {
    archived?: boolean;
    cursor?: string;
    cwd?: string;
    limit?: number;
    sortKey?: "created_at" | "updated_at";
  }): Promise<ThreadListResult> {
    const params: Record<string, unknown> = {};
    if (options?.archived !== undefined) {
      params.archived = options.archived;
    }
    if (options?.cursor !== undefined) {
      params.cursor = options.cursor;
    }
    if (options?.cwd !== undefined) {
      params.cwd = options.cwd;
    }
    if (options?.limit !== undefined) {
      params.limit = options.limit;
    }
    if (options?.sortKey !== undefined) {
      params.sortKey = options.sortKey;
    }

    return await this.request<ThreadListResult>("thread/list", params);
  }

  async readThread(threadId: string, includeTurns = false): Promise<ThreadReadResult> {
    return await this.request<ThreadReadResult>("thread/read", {
      threadId,
      includeTurns
    });
  }

  async listModels(options?: {
    cursor?: string;
    includeHidden?: boolean;
    limit?: number;
  }): Promise<ModelListResult> {
    const params: Record<string, unknown> = {};
    if (options?.cursor !== undefined) {
      params.cursor = options.cursor;
    }
    if (options?.includeHidden !== undefined) {
      params.includeHidden = options.includeHidden;
    }
    if (options?.limit !== undefined) {
      params.limit = options.limit;
    }

    return await this.request<ModelListResult>("model/list", params);
  }

  async listSkills(options: {
    cwds: string[];
    forceReload?: boolean;
  }): Promise<SkillListResult> {
    return await this.request<SkillListResult>("skills/list", {
      cwds: options.cwds,
      forceReload: options.forceReload ?? false
    });
  }

  async listPlugins(options?: {
    cwds?: string[];
  }): Promise<PluginListResult> {
    return await this.request<PluginListResult>("plugin/list", {
      ...(options?.cwds ? { cwds: options.cwds } : {})
    });
  }

  async installPlugin(options: {
    marketplacePath: string;
    pluginName: string;
  }): Promise<PluginInstallResult> {
    return await this.request<PluginInstallResult>("plugin/install", options);
  }

  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.request("plugin/uninstall", { pluginId });
  }

  async listApps(options?: {
    cursor?: string;
    limit?: number;
    threadId?: string;
    forceRefetch?: boolean;
  }): Promise<AppListResult> {
    const params: Record<string, unknown> = {};
    if (options?.cursor !== undefined) {
      params.cursor = options.cursor;
    }
    if (options?.limit !== undefined) {
      params.limit = options.limit;
    }
    if (options?.threadId !== undefined) {
      params.threadId = options.threadId;
    }
    if (options?.forceRefetch !== undefined) {
      params.forceRefetch = options.forceRefetch;
    }

    return await this.request<AppListResult>("app/list", params);
  }

  async listMcpServerStatuses(options?: {
    cursor?: string;
    limit?: number;
  }): Promise<McpServerStatusListResult> {
    const params: Record<string, unknown> = {};
    if (options?.cursor !== undefined) {
      params.cursor = options.cursor;
    }
    if (options?.limit !== undefined) {
      params.limit = options.limit;
    }

    return await this.request<McpServerStatusListResult>("mcpServerStatus/list", params);
  }

  async reloadMcpServers(): Promise<void> {
    await this.request("config/mcpServer/reload", undefined);
  }

  async loginToMcpServer(options: {
    name: string;
    scopes?: string[];
  }): Promise<McpServerOauthLoginResult> {
    return await this.request<McpServerOauthLoginResult>("mcpServer/oauth/login", {
      name: options.name,
      ...(options.scopes ? { scopes: options.scopes } : {})
    });
  }

  async readAccount(refreshToken = false): Promise<AccountReadResult> {
    return await this.request<AccountReadResult>("account/read", {
      refreshToken
    });
  }

  async readAccountRateLimits(): Promise<AccountRateLimitsReadResult> {
    return await this.request<AccountRateLimitsReadResult>("account/rateLimits/read", undefined);
  }

  async cleanBackgroundTerminals(threadId: string): Promise<void> {
    await this.request("thread/backgroundTerminals/clean", { threadId });
  }

  async startTurn(options: {
    threadId: string;
    cwd: string;
    text?: string;
    input?: UserInput[];
    model?: string;
    effort?: ReasoningEffort;
    collaborationMode?: {
      mode: "default" | "plan";
      settings: {
        model: string;
        developerInstructions?: string | null;
        reasoningEffort?: ReasoningEffort | null;
      };
    };
  }): Promise<TurnStartResult> {
    return await this.request<TurnStartResult>("turn/start", buildTurnStartParams(options));
  }

  async reviewStart(options: {
    threadId: string;
    target:
      | { type: "uncommittedChanges" }
      | { type: "baseBranch"; branch: string }
      | { type: "commit"; sha: string; title?: string | null }
      | { type: "custom"; instructions: string };
    delivery?: "inline" | "detached";
  }): Promise<ReviewStartResult> {
    return await this.request<ReviewStartResult>("review/start", {
      threadId: options.threadId,
      target: options.target,
      ...(options.delivery ? { delivery: options.delivery } : {})
    });
  }

  async forkThread(options: {
    threadId: string;
    model?: string;
  }): Promise<ThreadForkResult> {
    return await this.request<ThreadForkResult>("thread/fork", {
      threadId: options.threadId,
      ...(options.model ? { model: options.model } : {})
    });
  }

  async rollbackThread(threadId: string, numTurns: number): Promise<ThreadRollbackResult> {
    return await this.request<ThreadRollbackResult>("thread/rollback", {
      threadId,
      numTurns
    });
  }

  async startThreadRealtime(options: {
    threadId: string;
    prompt: string;
    sessionId?: string | null;
  }): Promise<void> {
    await this.request("thread/realtime/start", {
      threadId: options.threadId,
      prompt: options.prompt,
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {})
    });
  }

  async appendThreadRealtimeAudio(threadId: string, audio: ThreadRealtimeAudioChunk): Promise<void> {
    await this.request("thread/realtime/appendAudio", {
      threadId,
      audio
    });
  }

  async appendThreadRealtimeText(threadId: string, text: string): Promise<void> {
    await this.request("thread/realtime/appendText", {
      threadId,
      text
    });
  }

  async stopThreadRealtime(threadId: string): Promise<void> {
    await this.request("thread/realtime/stop", { threadId });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.request("thread/compact/start", { threadId });
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  async updateThreadMetadata(options: {
    threadId: string;
    gitInfo: {
      branch?: string | null;
      sha?: string | null;
      originUrl?: string | null;
    };
  }): Promise<ThreadReadResult> {
    return await this.request<ThreadReadResult>("thread/metadata/update", options);
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", {
      threadId,
      turnId
    });
  }

  async steerTurn(options: {
    threadId: string;
    expectedTurnId: string;
    input: UserInput[];
  }): Promise<void> {
    await this.request("turn/steer", options);
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.child) {
      throw new Error("app-server child is not running");
    }

    const requestId = this.nextRequestId++;
    const payload = JSON.stringify({
      id: requestId,
      method,
      params
    });

    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`app-server request timed out: ${method}`));
      }, this.startupTimeoutMs);

      this.pending.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });

      this.child?.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }

        const pending = this.pending.get(requestId);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        reject(error);
      });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.child) {
      throw new Error("app-server child is not running");
    }

    const payload = JSON.stringify({ method, params });
    this.child.stdin.write(`${payload}\n`, "utf8");
  }

  async respondToServerRequest(id: JsonRpcRequestId, result: unknown): Promise<void> {
    await this.writeJsonRpcFrame({ id, result });
  }

  async respondToServerRequestError(
    id: JsonRpcRequestId,
    code: number,
    message: string,
    data?: unknown
  ): Promise<void> {
    await this.writeJsonRpcFrame({
      id,
      error: {
        code,
        message,
        data
      }
    });
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    this.child = null;
    child.kill("SIGTERM");
    this.initialized = false;
    this.stderrStream?.end();
    this.stderrStream = null;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.add(handler);
    return () => {
      this.serverRequestHandlers.delete(handler);
    };
  }

  onExit(handler: ExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => {
      this.exitHandlers.delete(handler);
    };
  }

  private handleMessage(line: string): void {
    if (line.trim().length === 0) {
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      void this.logger.error("failed to parse app-server frame", { line, error: `${error}` });
      return;
    }

    if ("method" in message && !("id" in message)) {
      void this.logger.info("app-server notification", { method: message.method });
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
      return;
    }

    if ("method" in message && "id" in message && (typeof message.id === "number" || typeof message.id === "string")) {
      void this.logger.info("app-server server request", { method: message.method, id: message.id });
      for (const handler of this.serverRequestHandlers) {
        handler(message);
      }
      return;
    }

    if (!("id" in message) || (typeof message.id !== "number" && typeof message.id !== "string")) {
      return;
    }

    if (typeof message.id !== "number") {
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if ("error" in message) {
      pending.reject(new Error(message.error.message));
      return;
    }

    if ("result" in message) {
      pending.resolve(message.result);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
  }

  private emitExit(error: Error): void {
    for (const handler of this.exitHandlers) {
      handler(error);
    }
  }

  private async writeJsonRpcFrame(payload: Record<string, unknown>): Promise<void> {
    if (!this.child) {
      throw new Error("app-server child is not running");
    }

    const serialized = JSON.stringify(payload);
    await new Promise<void>((resolve, reject) => {
      this.child?.stdin.write(`${serialized}\n`, "utf8", (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
