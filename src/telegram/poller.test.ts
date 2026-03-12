import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { TelegramPoller, readOffset, writeOffset } from "./poller.js";

function createTestPaths(root: string): BridgePaths {
  const runtimeDir = join(root, "runtime");

  return {
    homeDir: root,
    repoRoot: root,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir: join(root, "logs"),
    runtimeDir,
    cacheDir: join(root, "cache"),
    dbPath: join(root, "state", "bridge.db"),
    envPath: join(root, "config", "bridge.env"),
    servicePath: join(root, "service", "bridge.service"),
    binPath: join(root, "bin", "ctb"),
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(root, "logs", "bridge.log"),
    bootstrapLogPath: join(root, "logs", "bootstrap.log"),
    appServerLogPath: join(root, "logs", "app-server.log")
  };
}

function createCollectingLogger() {
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const logger: Logger = {
    info: async () => {},
    warn: async (_message, meta) => {
      warnings.push(meta);
    },
    error: async () => {}
  };

  return { logger, warnings };
}

async function createOffsetFixture(): Promise<{ paths: BridgePaths; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "ctb-poller-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true })
  ]);

  return {
    paths,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("writeOffset persists the offset without leaving temp files behind", async () => {
  const { paths, cleanup } = await createOffsetFixture();

  try {
    await writeOffset(paths, 42);

    const content = await readFile(paths.offsetPath, "utf8");
    assert.equal(content, `${JSON.stringify({ offset: 42 })}\n`);

    const runtimeFiles = await readdir(paths.runtimeDir);
    assert.deepEqual(runtimeFiles, ["telegram-offset.json"]);
  } finally {
    await cleanup();
  }
});

test("readOffset recovers from a corrupted offset file", async () => {
  const { paths, cleanup } = await createOffsetFixture();
  const { logger, warnings } = createCollectingLogger();

  try {
    await writeFile(paths.offsetPath, "{\"offset\":", "utf8");

    const offset = await readOffset(paths, logger);

    assert.equal(offset, 0);
    const runtimeFiles = await readdir(paths.runtimeDir);
    assert.equal(runtimeFiles.includes("telegram-offset.json"), false);
    assert.equal(runtimeFiles.some((name) => name.startsWith("telegram-offset.json.corrupt.")), true);
    assert.equal(warnings.length, 1);
  } finally {
    await cleanup();
  }
});

test("TelegramPoller.run survives a corrupted offset file at startup", async () => {
  const { paths, cleanup } = await createOffsetFixture();
  const { logger } = createCollectingLogger();
  const config: BridgeConfig = {
    telegramBotToken: "token",
    codexBin: "codex",
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramPollTimeoutSeconds: 1,
    telegramPollIntervalMs: 0
  };

  try {
    await writeFile(paths.offsetPath, "{\"offset\":", "utf8");

    let polledOffset: number | null = null;
    let poller: TelegramPoller;
    const api = {
      getUpdates: async (offset: number) => {
        polledOffset = offset;
        poller.stop();
        return [];
      }
    } as unknown as ConstructorParameters<typeof TelegramPoller>[0];

    poller = new TelegramPoller(api, config, paths, logger, async () => {});
    await poller.run();

    assert.equal(polledOffset, 0);
  } finally {
    await cleanup();
  }
});
