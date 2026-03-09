import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import type { Logger } from "../logger.js";

interface JsonRpcSuccess {
  id: number;
  result: unknown;
}

interface JsonRpcError {
  id: number;
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

type JsonRpcMessage = JsonRpcSuccess | JsonRpcError | JsonRpcNotification;
type NotificationHandler = (notification: JsonRpcNotification) => void;
type ExitHandler = (error: Error) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface ThreadStartResult {
  thread: { id: string };
}

export interface ThreadResumeResult {
  thread: {
    id: string;
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

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private initialized = false;
  private stderrStream: WriteStream | null = null;
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private readonly exitHandlers = new Set<ExitHandler>();

  constructor(
    private readonly codexBin: string,
    private readonly logPath: string,
    private readonly logger: Logger,
    private readonly startupTimeoutMs = 5000
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
      }
    });
    this.notify("initialized", {});
    await this.request("thread/list", {});
    this.initialized = true;
  }

  async startThread(cwd: string): Promise<ThreadStartResult> {
    return await this.request<ThreadStartResult>("thread/start", {
      cwd,
      approvalPolicy: "never"
    });
  }

  async resumeThread(threadId: string): Promise<ThreadResumeResult> {
    return await this.request<ThreadResumeResult>("thread/resume", {
      threadId
    });
  }

  async startTurn(options: {
    threadId: string;
    cwd: string;
    text: string;
  }): Promise<TurnStartResult> {
    return await this.request<TurnStartResult>("turn/start", {
      threadId: options.threadId,
      input: [{ type: "text", text: options.text }],
      cwd: options.cwd,
      approvalPolicy: "never"
    });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", {
      threadId,
      turnId
    });
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

    if (!("id" in message) || typeof message.id !== "number") {
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
}
