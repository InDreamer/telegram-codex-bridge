import type { Logger } from "../logger.js";

interface RuntimeCardTraceContext {
  sessionId: string;
  chatId: string | null;
  threadId: string | null;
  turnId: string | null;
}

interface RuntimeCardMessageStateLike {
  surface: "status" | "plan" | "error";
  key: string;
  messageId: number;
}

interface RuntimeTraceActiveTurnLike extends RuntimeCardTraceContext {}

interface RuntimeSurfaceTraceSinkDeps {
  logger: Logger;
  traceLoggers: Record<RuntimeCardMessageStateLike["surface"], Logger>;
}

export class RuntimeSurfaceTraceSink {
  constructor(private readonly deps: RuntimeSurfaceTraceSinkDeps) {}

  async logRuntimeCardEvent(
    activeTurn: RuntimeTraceActiveTurnLike,
    surface: RuntimeCardMessageStateLike,
    event: string,
    meta: Record<string, unknown> = {}
  ): Promise<void> {
    try {
      await this.deps.traceLoggers[surface.surface].info(event, {
        sessionId: activeTurn.sessionId,
        chatId: activeTurn.chatId,
        threadId: activeTurn.threadId,
        turnId: activeTurn.turnId,
        surface: surface.surface,
        key: surface.key,
        messageId: surface.messageId === 0 ? null : surface.messageId,
        ...meta
      });
    } catch (error) {
      try {
        await this.deps.logger.warn("runtime card trace log failed", {
          sessionId: activeTurn.sessionId,
          turnId: activeTurn.turnId,
          surface: surface.surface,
          key: surface.key,
          error: `${error}`
        });
      } catch {
        // Ignore trace-log failures entirely so Telegram rendering keeps running.
      }
    }
  }
}
