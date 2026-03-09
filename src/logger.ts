import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type LogLevel = "info" | "warn" | "error";

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): Promise<void>;
  warn(message: string, meta?: Record<string, unknown>): Promise<void>;
  error(message: string, meta?: Record<string, unknown>): Promise<void>;
}

function formatLine(level: LogLevel, component: string, message: string, meta?: Record<string, unknown>): string {
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...meta
  })}\n`;
}

async function writeLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, line, "utf8");
}

export function createLogger(component: string, filePath: string): Logger {
  async function log(level: LogLevel, message: string, meta?: Record<string, unknown>): Promise<void> {
    const line = formatLine(level, component, message, meta);
    await writeLine(filePath, line);

    if (level === "error") {
      process.stderr.write(line);
      return;
    }

    process.stdout.write(line);
  }

  return {
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta)
  };
}

