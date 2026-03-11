import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import type { TelegramApi } from "./api.js";
import { TelegramPoller, readOffset, writeOffset } from "./poller.js";

function createTestPaths(root: string): BridgePaths {
  return {
    homeDir: root,
    repoRoot: root,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir: join(root, "logs"),
    runtimeDir: join(root, "runtime"),
    cacheDir: join(root, "cache"),
    dbPath: join(root, "state", "bridge.db"),
    envPath: join(root, "config", "bridge.env"),
    servicePath: join(root, "service", "bridge.service"),
    binPath: join(root, "bin", "ctb"),
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(root, "runtime", "telegram-offset.json"),
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

function createTestPollerApi(getUpdates: TelegramApi["getUpdates"]): Pick<TelegramApi, "getUpdates"> {
  return { getUpdates };
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
    const api = createTestPollerApi(async (offset: number) => {
      polledOffset = offset;
      poller.stop();
      return [];
    });

    poller = new TelegramPoller(api, config, paths, logger, async () => {});
    await poller.run();

    assert.equal(polledOffset, 0);
  } finally {
    await cleanup();
  }
});

test("TelegramPoller.run resumes from the first unprocessed update after a later update fails", async () => {
  const { paths, cleanup } = await createOffsetFixture();
  const { logger, warnings } = createCollectingLogger();
  const config: BridgeConfig = {
    telegramBotToken: "token",
    codexBin: "codex",
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramPollTimeoutSeconds: 1,
    telegramPollIntervalMs: 0
  };

  try {
    await writeOffset(paths, 10);

    const persistedOffsets: number[] = [];
    class RecordingTelegramPoller extends TelegramPoller {
      protected override async persistOffset(offset: number): Promise<void> {
        persistedOffsets.push(offset);
        await super.persistOffset(offset);
      }
    }

    const processedUpdates: number[] = [];
    const polledOffsets: number[] = [];
    let failUpdateEleven = true;
    let poller: TelegramPoller;
    let pollCount = 0;
    const api = createTestPollerApi(async (offset: number) => {
      pollCount += 1;
      polledOffsets.push(offset);

      if (pollCount === 1) {
        assert.equal(offset, 10);
        return [{ update_id: 10 }, { update_id: 11 }];
      }

      if (pollCount === 2) {
        poller.stop();
        return offset === 11 ? [{ update_id: 11 }] : [{ update_id: 10 }, { update_id: 11 }];
      }

      throw new Error(`unexpected poll count: ${pollCount}`);
    });

    poller = new RecordingTelegramPoller(api, config, paths, logger, async (update) => {
      if (update.update_id === 11 && failUpdateEleven) {
        failUpdateEleven = false;
        throw new Error("update 11 failed");
      }

      processedUpdates.push(update.update_id);
    });

    await poller.run();

    assert.deepEqual(polledOffsets, [10, 11]);
    assert.deepEqual(processedUpdates, [10, 11]);
    assert.deepEqual(persistedOffsets, [11, 12]);
    assert.equal(await readOffset(paths, logger), 12);
    assert.equal(warnings.length, 1);
  } finally {
    await cleanup();
  }
});

test("TelegramPoller.run treats a falsy thrown value as a processing failure after checkpointing prior progress", async () => {
  const { paths, cleanup } = await createOffsetFixture();
  const { logger, warnings } = createCollectingLogger();
  const config: BridgeConfig = {
    telegramBotToken: "token",
    codexBin: "codex",
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramPollTimeoutSeconds: 1,
    telegramPollIntervalMs: 0
  };

  try {
    await writeOffset(paths, 10);

    const persistedOffsets: number[] = [];
    class RecordingTelegramPoller extends TelegramPoller {
      protected override async persistOffset(offset: number): Promise<void> {
        persistedOffsets.push(offset);
        await super.persistOffset(offset);
      }
    }

    const processedUpdates: number[] = [];
    let failUpdateEleven = true;
    let poller: TelegramPoller;
    let pollCount = 0;
    const api = createTestPollerApi(async (offset: number) => {
      pollCount += 1;

      if (pollCount === 1) {
        assert.equal(offset, 10);
        return [{ update_id: 10 }, { update_id: 11 }];
      }

      assert.equal(offset, 11);
      poller.stop();
      return [];
    });

    poller = new RecordingTelegramPoller(api, config, paths, logger, async (update) => {
      if (update.update_id === 11 && failUpdateEleven) {
        failUpdateEleven = false;
        throw undefined;
      }

      processedUpdates.push(update.update_id);
    });

    await poller.run();

    assert.deepEqual(processedUpdates, [10]);
    assert.deepEqual(persistedOffsets, [11]);
    assert.equal(await readOffset(paths, logger), 11);
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[0], { error: "undefined" });
  } finally {
    await cleanup();
  }
});

test("TelegramPoller.run persists the newest offset once per update batch", async () => {
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
    await writeOffset(paths, 10);

    const persistedOffsets: number[] = [];
    class RecordingTelegramPoller extends TelegramPoller {
      protected override async persistOffset(offset: number): Promise<void> {
        persistedOffsets.push(offset);
        await super.persistOffset(offset);
      }
    }

    let poller: TelegramPoller;
    let pollCount = 0;
    const api = createTestPollerApi(async (offset: number) => {
      pollCount += 1;

      if (pollCount === 1) {
        assert.equal(offset, 10);
        return [{ update_id: 10 }, { update_id: 11 }];
      }

      assert.equal(offset, 12);
      poller.stop();
      return [];
    });

    poller = new RecordingTelegramPoller(api, config, paths, logger, async () => {});

    await poller.run();

    assert.deepEqual(persistedOffsets, [12]);
    assert.equal(await readOffset(paths, logger), 12);
  } finally {
    await cleanup();
  }
});