import { readFile, writeFile } from "node:fs/promises";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import type { BridgeConfig } from "../config.js";
import { TelegramApi, type TelegramUpdate } from "./api.js";

async function readOffset(paths: BridgePaths): Promise<number> {
  try {
    const content = await readFile(paths.offsetPath, "utf8");
    const parsed = JSON.parse(content) as { offset?: number };
    return parsed.offset ?? 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }

    throw error;
  }
}

async function writeOffset(paths: BridgePaths, offset: number): Promise<void> {
  await writeFile(paths.offsetPath, `${JSON.stringify({ offset })}\n`, "utf8");
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
    let offset = await readOffset(this.paths);

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
