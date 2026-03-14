import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BridgeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { BridgePaths } from "./paths.js";
import { probeReadiness } from "./readiness.js";
import { BridgeStateStore } from "./state/store.js";

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

const testConfig: BridgeConfig = {
  telegramBotToken: "test-token",
  codexBin: "codex",
  telegramApiBaseUrl: "https://api.telegram.org",
  telegramPollTimeoutSeconds: 20,
  telegramPollIntervalMs: 1500
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

async function createReadinessContext(): Promise<{
  paths: BridgePaths;
  store: BridgeStateStore;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "ctb-readiness-test-"));
  const paths = createTestPaths(root);
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true })
  ]);
  await writeFile(join(paths.repoRoot, "package.json"), JSON.stringify({
    name: "telegram-codex-bridge",
    engines: {
      node: ">=25.0.0"
    }
  }, null, 2));

  const store = await BridgeStateStore.open(paths, testLogger);
  return {
    paths,
    store,
    cleanup: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}

test("probeReadiness fails hard when Node does not satisfy the declared engine floor", async () => {
  const { paths, store, cleanup } = await createReadinessContext();

  try {
    const result = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps: {
        nodeVersion: "v24.9.0",
        commandExists: async () => true
      }
    } as any);

    assert.equal(result.snapshot.state, "bridge_unhealthy");
    assert.equal(result.snapshot.details.nodeVersion, "v24.9.0");
    assert.equal(result.snapshot.details.nodeVersionSupported, false);
    assert.match(result.snapshot.details.issues.join("\n"), /Node/u);
  } finally {
    await cleanup();
  }
});

test("probeReadiness fails hard when the state root is not writable", async () => {
  const { paths, store, cleanup } = await createReadinessContext();

  try {
    await chmod(paths.stateRoot, 0o500);

    const result = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps: {
        nodeVersion: process.version,
        commandExists: async () => true
      }
    } as any);

    assert.equal(result.snapshot.state, "bridge_unhealthy");
    assert.equal(result.snapshot.details.stateRootWritable, false);
    assert.match(result.snapshot.details.issues.join("\n"), /state root/u);
  } finally {
    await chmod(paths.stateRoot, 0o700).catch(() => {});
    await cleanup();
  }
});

test("probeReadiness warns when no supported service manager is available but does not hard fail on that fact alone", async () => {
  const { paths, store, cleanup } = await createReadinessContext();

  try {
    const result = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps: {
        nodeVersion: process.version,
        detectServiceManager: async () => ({
          manager: "none",
          health: "warning",
          issues: ["no supported service manager found"]
        }),
        commandExists: async () => true,
        runCommand: async (_command: string, args: string[]) => {
          if (args[0] === "--version") {
            return { exitCode: 0, stdout: "codex-cli 0.114.0", stderr: "" };
          }
          if (args[0] === "login") {
            return { exitCode: 0, stdout: "Logged in", stderr: "" };
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        validateTelegramToken: async () => ({
          ok: true,
          botId: "1",
          username: "bridge_bot"
        }),
        createAppServer: () => ({
          pid: 123,
          initializeAndProbe: async () => {},
          stop: async () => {}
        }),
        evaluateCapabilities: async () => ({
          ok: true,
          source: "cache",
          issues: []
        })
      }
    } as any);

    assert.equal(result.snapshot.state, "awaiting_authorization");
    assert.equal(result.snapshot.details.serviceManager, "none");
    assert.equal(result.snapshot.details.serviceManagerHealth, "warning");
    assert.match(result.snapshot.details.issues.join("\n"), /service manager/u);
  } finally {
    await cleanup();
  }
});

test("probeReadiness fails hard when the current Codex capability surface is below the V2 floor", async () => {
  const { paths, store, cleanup } = await createReadinessContext();

  try {
    const result = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps: {
        nodeVersion: process.version,
        detectServiceManager: async () => ({
          manager: "none",
          health: "warning",
          issues: []
        }),
        commandExists: async () => true,
        runCommand: async (_command: string, args: string[]) => {
          if (args[0] === "--version") {
            return { exitCode: 0, stdout: "codex-cli 0.114.0", stderr: "" };
          }
          if (args[0] === "login") {
            return { exitCode: 0, stdout: "Logged in", stderr: "" };
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        validateTelegramToken: async () => ({
          ok: true,
          botId: "1",
          username: "bridge_bot"
        }),
        evaluateCapabilities: async () => ({
          ok: false,
          source: "generated_schema",
          issues: ["missing notification: thread/archived"]
        })
      }
    } as any);

    assert.equal(result.snapshot.state, "bridge_unhealthy");
    assert.equal(result.snapshot.details.capabilityCheckPassed, false);
    assert.equal(result.snapshot.details.capabilityCheckSource, "generated_schema");
    assert.match(result.snapshot.details.issues.join("\n"), /thread\/archived/u);
  } finally {
    await cleanup();
  }
});

test("probeReadiness accepts schemas that omit item/webSearch/progress", async () => {
  const { paths, store, cleanup } = await createReadinessContext();

  try {
    const result = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps: {
        nodeVersion: process.version,
        detectServiceManager: async () => ({
          manager: "none",
          health: "warning",
          issues: []
        }),
        commandExists: async () => true,
        runCommand: async (_command: string, args: string[]) => {
          if (args[0] === "--version") {
            return { exitCode: 0, stdout: "codex-cli 0.114.0", stderr: "" };
          }
          if (args[0] === "login") {
            return { exitCode: 0, stdout: "Logged in", stderr: "" };
          }
          if (args[0] === "app-server" && args[1] === "generate-json-schema") {
            const outIndex = args.indexOf("--out");
            assert.notEqual(outIndex, -1);
            const schemaDir = args[outIndex + 1];
            assert.ok(schemaDir);
            const methodsToSchema = (methods: string[]) => JSON.stringify({
              oneOf: [{ properties: { method: { enum: methods } } }]
            });

            await writeFile(
              join(schemaDir, "ClientRequest.json"),
              methodsToSchema([
                "thread/list",
                "thread/read",
                "thread/start",
                "thread/resume",
                "thread/archive",
                "thread/unarchive",
                "turn/start",
                "turn/interrupt"
              ])
            );
            await writeFile(
              join(schemaDir, "ServerNotification.json"),
              methodsToSchema([
                "turn/started",
                "turn/completed",
                "thread/status/changed",
                "item/started",
                "item/completed",
                "item/mcpToolCall/progress",
                "turn/plan/updated",
                "thread/archived",
                "thread/unarchived",
                "error"
              ])
            );
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          throw new Error(`unexpected command: ${args.join(" ")}`);
        },
        validateTelegramToken: async () => ({
          ok: true,
          botId: "1",
          username: "bridge_bot"
        }),
        createAppServer: () => ({
          pid: 123,
          initializeAndProbe: async () => {},
          stop: async () => {}
        })
      }
    } as any);

    assert.equal(result.snapshot.state, "awaiting_authorization");
    assert.equal(result.snapshot.details.capabilityCheckPassed, true);
    assert.equal(result.snapshot.details.capabilityCheckSource, "generated_schema");
  } finally {
    await cleanup();
  }
});
