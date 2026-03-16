import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { loadConfig, withInstallOverrides, writeConfig, type BridgeConfig } from "./config.js";
import type { BridgePaths } from "./paths.js";

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

test("loadConfig parses PROJECT_SCAN_ROOTS from bridge.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(
      paths.envPath,
      [
        "TELEGRAM_BOT_TOKEN=test-token",
        `PROJECT_SCAN_ROOTS=~/projects${delimiter}${join(root, "work")}${delimiter}~/projects`
      ].join("\n"),
      "utf8"
    );

    const config = await loadConfig(paths);

    assert.deepEqual(config.projectScanRoots, [join(root, "projects"), join(root, "work")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig parses boolean-like VOICE_INPUT_ENABLED values from bridge.env", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeFile(
      paths.envPath,
      [
        "TELEGRAM_BOT_TOKEN=test-token",
        "VOICE_INPUT_ENABLED=on"
      ].join("\n"),
      "utf8"
    );

    const config = await loadConfig(paths);

    assert.equal(config.voiceInputEnabled, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writeConfig persists PROJECT_SCAN_ROOTS and withInstallOverrides can replace them", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-config-test-"));
  const paths = createTestPaths(root);
  const initialConfig: BridgeConfig = {
    telegramBotToken: "test-token",
    codexBin: "codex",
    telegramApiBaseUrl: "https://api.telegram.org",
    telegramPollTimeoutSeconds: 20,
    telegramPollIntervalMs: 1500,
    projectScanRoots: [join(root, "projects"), join(root, "work")],
    voiceInputEnabled: false,
    voiceOpenaiApiKey: "",
    voiceOpenaiTranscribeModel: "gpt-4o-mini-transcribe",
    voiceFfmpegBin: "ffmpeg"
  };

  try {
    await mkdir(paths.configRoot, { recursive: true });
    await writeConfig(paths, initialConfig);

    const content = await readFile(paths.envPath, "utf8");
    assert.match(
      content,
      new RegExp(`^PROJECT_SCAN_ROOTS=${join(root, "projects")}${delimiter}${join(root, "work")}$`, "mu")
    );

    const nextConfig = withInstallOverrides(initialConfig, {
      projectScanRoots: [join(root, "code")]
    });
    assert.deepEqual(nextConfig.projectScanRoots, [join(root, "code")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
