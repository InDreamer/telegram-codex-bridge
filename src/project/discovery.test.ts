import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { BridgeStateStore } from "../state/store.js";
import { buildProjectPicker } from "./discovery.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

function createTestPaths(root: string): BridgePaths {
  const logsDir = join(root, "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(root, "runtime");

  return {
    homeDir: root,
    repoRoot: root,
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir,
    telegramSessionFlowLogsDir,
    runtimeDir,
    cacheDir: join(root, "cache"),
    dbPath: join(root, "state", "bridge.db"),
    stateStoreFailurePath: join(root, "state", "state-store-open-failure.json"),
    envPath: join(root, "config", "bridge.env"),
    servicePath: join(root, "service", "bridge.service"),
    launchAgentPath: join(root, "LaunchAgents", "bridge.plist"),
    binPath: join(root, "bin", "ctb"),
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log"),
    telegramStatusCardLogPath: join(telegramSessionFlowLogsDir, "status-card.log"),
    telegramPlanCardLogPath: join(telegramSessionFlowLogsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(telegramSessionFlowLogsDir, "error-card.log")
  };
}

async function createDiscoveryContext(): Promise<{
  root: string;
  paths: BridgePaths;
  store: BridgeStateStore;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ctb-discovery-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true })
  ]);

  const store = await BridgeStateStore.open(paths, testLogger);
  return {
    root,
    paths,
    store,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function writeMarker(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "{}\n", "utf8");
}

test("buildProjectPicker scans configured roots only", async () => {
  const { root, store, cleanup } = await createDiscoveryContext();
  const configuredRoot = join(root, "projects");
  const expectedProjectPath = join(configuredRoot, "alpha");
  const ignoredProjectPath = join(root, "other", "beta");

  try {
    await Promise.all([
      mkdir(join(expectedProjectPath, ".git"), { recursive: true }),
      writeMarker(join(ignoredProjectPath, "package.json"))
    ]);

    const picker = await buildProjectPicker(root, [configuredRoot], store);
    const projectPaths = [...picker.projectMap.values()].map((candidate) => candidate.projectPath);

    assert.deepEqual(projectPaths, [expectedProjectPath]);
    assert.equal([...picker.projectMap.values()][0]?.pathLabel, "~/projects/alpha");
  } finally {
    await cleanup();
  }
});

test("buildProjectPicker falls back to HOME when PROJECT_SCAN_ROOTS is unset", async () => {
  const { root, store, cleanup } = await createDiscoveryContext();
  const expectedProjectPath = join(root, "projects", "alpha");

  try {
    await writeMarker(join(expectedProjectPath, "package.json"));

    const picker = await buildProjectPicker(root, [], store);

    assert.equal(
      [...picker.projectMap.values()].some((candidate) => candidate.projectPath === expectedProjectPath),
      true
    );
  } finally {
    await cleanup();
  }
});

test("buildProjectPicker shows a generic degraded notice when every scan root fails", async () => {
  const { root, store, cleanup } = await createDiscoveryContext();

  try {
    const picker = await buildProjectPicker(root, [join(root, "missing-root")], store);

    assert.deepEqual(picker.noticeLines, ["扫描根目录当前不可用，以下结果可能主要来自历史记录。"]);
  } finally {
    await cleanup();
  }
});
