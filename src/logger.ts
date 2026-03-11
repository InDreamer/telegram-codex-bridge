import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

type LogLevel = "info" | "warn" | "error";

interface LoggerDependencies {
  ensureDirectory(filePath: string): Promise<void>;
  appendLine(filePath: string, line: string): Promise<void>;
}

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

async function ensureDirectory(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

async function appendLine(filePath: string, line: string): Promise<void> {
  await appendFile(filePath, line, "utf8");
}

async function writeLine(
  filePath: string,
  line: string,
  ensureDirectoryReady: () => Promise<void>,
  appendLogLine: LoggerDependencies["appendLine"]
): Promise<void> {
  await ensureDirectoryReady();
  await appendLogLine(filePath, line);
}

export function createLogger(component: string, filePath: string, dependencies?: Partial<LoggerDependencies>): Logger {
  const resolvedDependencies: LoggerDependencies = {
    ensureDirectory: dependencies?.ensureDirectory ?? ensureDirectory,
    appendLine: dependencies?.appendLine ?? appendLine
  };
  let directoryReady: Promise<void> | undefined;

  function ensureDirectoryReady(): Promise<void> {
    if (!directoryReady) {
      directoryReady = resolvedDependencies.ensureDirectory(filePath).catch(error => {
        directoryReady = undefined;
        throw error;
      });
    }

    return directoryReady;
  }

  async function log(level: LogLevel, message: string, meta?: Record<string, unknown>): Promise<void> {
    const line = formatLine(level, component, message, meta);
    await writeLine(filePath, line, ensureDirectoryReady, resolvedDependencies.appendLine);

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

