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

  constructor(options: TurnDebugJournalOptions) {
    this.filePath = join(options.debugRootDir, options.threadId, `${options.turnId}.jsonl`);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async append(record: DebugJournalRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const line = `${JSON.stringify(record)}\n`;
    const lineSize = Buffer.byteLength(line);
    const currentSize = await getFileSize(this.filePath);

    if (currentSize + lineSize > this.maxBytes) {
      await writeFile(this.filePath, line, "utf8");
      return;
    }

    await appendFile(this.filePath, line, "utf8");
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
