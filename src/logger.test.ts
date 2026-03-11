import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLogger, type Logger } from "./logger.js";

type LoggerFactory = (
  component: string,
  filePath: string,
  dependencies?: {
    ensureDirectory?: (filePath: string) => Promise<void>;
    appendLine?: (filePath: string, line: string) => Promise<void>;
  }
) => Logger;

const createTestLogger = createLogger as unknown as LoggerFactory;

test("createLogger reuses directory setup across multiple writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-logger-test-"));
  let directorySetupCalls = 0;
  const appendedLines: string[] = [];

  try {
    const logger = createTestLogger("bridge", join(root, "logs", "bridge.log"), {
      ensureDirectory: async () => {
        directorySetupCalls += 1;
      },
      appendLine: async (_filePath, line) => {
        appendedLines.push(line);
      }
    });

    await logger.info("first");
    await logger.warn("second");

    assert.equal(directorySetupCalls, 1, "directory setup should run once per logger instance");
    assert.equal(appendedLines.length, 2, "both log lines should still be appended");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createLogger retries directory setup after an initial failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-logger-test-"));
  let directorySetupCalls = 0;
  const appendedLines: string[] = [];

  try {
    const logger = createTestLogger("bridge", join(root, "logs", "bridge.log"), {
      ensureDirectory: async () => {
        directorySetupCalls += 1;

        if (directorySetupCalls === 1) {
          throw new Error("directory setup failed");
        }
      },
      appendLine: async (_filePath, line) => {
        appendedLines.push(line);
      }
    });

    await assert.rejects(logger.info("first"), /directory setup failed/);
    await logger.warn("second");

    assert.equal(directorySetupCalls, 2, "logger should retry directory setup after a failure");
    assert.equal(appendedLines.length, 1, "only the successful retry should append a line");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
