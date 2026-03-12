import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DebugJournalRecord } from "./types.js";

export interface DebugJournalWriter {
  filePath: string;
  append(record: DebugJournalRecord): Promise<void>;
}

interface TurnDebugJournalOptions {
  debugRootDir: string;
  threadId: string;
  turnId: string;
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 512 * 1024;

export class TurnDebugJournal implements DebugJournalWriter {
  readonly filePath: string;
  private readonly maxBytes: number;
  private directoryReady: Promise<void> | null = null;
  private currentSizeBytes: number | null = null;

  constructor(options: TurnDebugJournalOptions) {
    this.filePath = join(options.debugRootDir, options.threadId, `${options.turnId}.jsonl`);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async append(record: DebugJournalRecord): Promise<void> {
    await this.ensureDirectory();

    const line = `${JSON.stringify(record)}\n`;
    const lineSize = Buffer.byteLength(line);
    const currentSize = await this.getCurrentSizeBytes();

    if (currentSize + lineSize > this.maxBytes) {
      await writeFile(this.filePath, line, "utf8");
      this.currentSizeBytes = lineSize;
      return;
    }

    await appendFile(this.filePath, line, "utf8");
    this.currentSizeBytes = currentSize + lineSize;
  }

  private async ensureDirectory(): Promise<void> {
    this.directoryReady ??= mkdir(dirname(this.filePath), { recursive: true }).then(() => {});
    await this.directoryReady;
  }

  private async getCurrentSizeBytes(): Promise<number> {
    if (this.currentSizeBytes !== null) {
      return this.currentSizeBytes;
    }

    this.currentSizeBytes = await getFileSize(this.filePath);
    return this.currentSizeBytes;
  }
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const result = await stat(filePath);
    return result.size;
  } catch {
    return 0;
  }
}
