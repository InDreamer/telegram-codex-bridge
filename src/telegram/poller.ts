import { rename, readFile, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

import type { BridgePaths } from "../paths.js";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { TelegramApi, type TelegramUpdate } from "./api.js";

function isValidOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function buildCorruptOffsetPath(offsetPath: string): string {
  return join(dirname(offsetPath), `${basename(offsetPath)}.corrupt.${Date.now()}`);
}

function isRecoverableOffsetError(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }

  return error instanceof Error && error.message === "offset file did not contain a valid non-negative number";
}

export async function readOffset(paths: BridgePaths, logger: Logger): Promise<number> {
  try {
    const content = await readFile(paths.offsetPath, "utf8");
    const parsed = JSON.parse(content) as { offset?: number };
    if (isValidOffset(parsed.offset)) {
      return parsed.offset;
    }

    throw new Error("offset file did not contain a valid non-negative number");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return 0;
    }

    if (isRecoverableOffsetError(error)) {
      const corruptPath = buildCorruptOffsetPath(paths.offsetPath);
      await logger.warn("telegram offset file invalid; resetting offset", {
        offsetPath: paths.offsetPath,
        corruptPath,
        error: `${error}`
      });

      try {
        await rename(paths.offsetPath, corruptPath);
      } catch (renameError) {
        const renameNodeError = renameError as NodeJS.ErrnoException;
        if (renameNodeError.code !== "ENOENT") {
          throw renameError;
        }
      }

      return 0;
    }

    throw error;
  }
}

export async function writeOffset(paths: BridgePaths, offset: number): Promise<void> {
  const tempPath = join(
    dirname(paths.offsetPath),
    `${basename(paths.offsetPath)}.${process.pid}.${Date.now()}.tmp`
  );
  // Rename is atomic on the same filesystem, so a crash cannot leave a half-written JSON file behind.
  await writeFile(tempPath, `${JSON.stringify({ offset })}\n`, "utf8");
  await rename(tempPath, paths.offsetPath);
}

export class TelegramPoller {
  private running = false;

  constructor(
    private readonly api: TelegramApi,
    private readonly config: BridgeConfig,
    private readonly paths: BridgePaths,
    private readonly logger: Logger,
    private readonly onUpdate: (update: TelegramUpdate) => Promise<void>
  ) {}

  async run(): Promise<void> {
    this.running = true;
    let offset = await readOffset(this.paths, this.logger);

    while (this.running) {
      try {
        const updates = await this.api.getUpdates(offset, this.config.telegramPollTimeoutSeconds);

        for (const update of updates) {
          await this.onUpdate(update);
          offset = update.update_id + 1;
          await writeOffset(this.paths, offset);
        }

        if (updates.length === 0) {
          await sleep(this.config.telegramPollIntervalMs);
        }
      } catch (error) {
        await this.logger.warn("telegram polling failed", { error: `${error}` });
        await sleep(this.config.telegramPollIntervalMs);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
