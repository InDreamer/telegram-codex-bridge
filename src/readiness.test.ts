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
  telegramPollIntervalMs: 1500,
  projectScanRoots: [],
  voiceInputEnabled: false,
  voiceOpenaiApiKey: "",
  voiceOpenaiTranscribeModel: "gpt-4o-mini-transcribe",
  voiceFfmpegBin: "ffmpeg"
};
const REQUIRED_CLIENT_REQUESTS = [
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "turn/start",
  "turn/interrupt"
];
const REQUIRED_SERVER_NOTIFICATIONS = [
  "thread/started",
  "thread/name/updated",
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
];

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
      node: ">=24.0.0"
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

function methodsToSchema(methods: string[]): string {
  return JSON.stringify({
    oneOf: [{ properties: { method: { enum: methods } } }]
  });
}

async function writeCapabilitySchemas(
  schemaDir: string,
  options?: {
    clientRequests?: string[];
    serverNotifications?: string[];
  }
): Promise<void> {
  await writeFile(
    join(schemaDir, "ClientRequest.json"),
    methodsToSchema(options?.clientRequests ?? REQUIRED_CLIENT_REQUESTS)
  );
  await writeFile(
    join(schemaDir, "ServerNotification.json"),
    methodsToSchema(options?.serverNotifications ?? REQUIRED_SERVER_NOTIFICATIONS)
  );
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
        nodeVersion: "v23.9.0",
        commandExists: async () => true
      }
    } as any);

    assert.equal(result.snapshot.state, "bridge_unhealthy");
    assert.equal(result.snapshot.details.nodeVersion, "v23.9.0");
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

test("probeReadiness fails hard when voice input is enabled without any usable transcription backend", async () => {
  const { paths, store, cleanup } = await createReadinessContext();

  try {
    const result = await probeReadiness({
      config: {
        ...testConfig,
        voiceInputEnabled: true
      },
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
        commandExists: async (command: string) => command !== "ffmpeg",
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
          listModels: async () => ({
            data: [],
            nextCursor: null
          }),
          stop: async () => {}
        }),
        evaluateCapabilities: async () => ({
          ok: true,
          source: "cache",
          issues: []
        })
      }
    } as any);

    assert.equal(result.snapshot.state, "bridge_unhealthy");
    assert.equal(result.snapshot.details.voiceInputEnabled, true);
    assert.equal(result.snapshot.details.voiceOpenaiConfigured, false);
    assert.equal(result.snapshot.details.voiceFfmpegAvailable, false);
    assert.equal(result.snapshot.details.voiceRealtimeSupported, false);
    assert.match(result.snapshot.details.issues.join("\n"), /no usable transcription backend/u);
  } finally {
    await cleanup();
  }
});

test("probeReadiness enables experimentalApi even when voice input is disabled", async () => {
  const { paths, store, cleanup } = await createReadinessContext();
  const experimentalFlags: boolean[] = [];

  try {
    const result = await probeReadiness({
      config: {
        ...testConfig,
        voiceInputEnabled: false
      },
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
        createAppServer: (options: {
          codexBin: string;
          appServerLogPath: string;
          logger: Logger;
          experimentalApi: boolean;
        }) => {
          experimentalFlags.push(options.experimentalApi);
          return {
            pid: 123,
            initializeAndProbe: async () => {},
            stop: async () => {}
          };
        },
        evaluateCapabilities: async () => ({
          ok: true,
          source: "cache",
          issues: []
        })
      }
    } as any);

    assert.equal(result.snapshot.state, "awaiting_authorization");
    assert.deepEqual(experimentalFlags, [true]);
  } finally {
    await cleanup();
  }
});

test("probeReadiness stops paginating model pages once realtime voice support is confirmed", async () => {
  const { paths, store, cleanup } = await createReadinessContext();

  try {
    const seenCursors: Array<string | null> = [];
    const result = await probeReadiness({
      config: {
        ...testConfig,
        voiceInputEnabled: true
      },
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
        createAppServer: () => ({
          pid: 123,
          initializeAndProbe: async () => {},
          listModels: async (options?: { cursor?: string }) => {
            seenCursors.push(options?.cursor ?? null);
            if (!options?.cursor) {
              return {
                data: [{ inputModalities: ["text", "image"] }],
                nextCursor: "page-2"
              };
            }

            if (options.cursor === "page-2") {
              return {
                data: [{ inputModalities: ["text", "audio"] }],
                nextCursor: "page-3"
              };
            }

            return {
              data: [{ inputModalities: ["text"] }],
              nextCursor: null
            };
          },
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
    assert.deepEqual(seenCursors, [null, "page-2"]);
    assert.equal(result.snapshot.details.voiceRealtimeSupported, true);
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

test("probeReadiness fails hard when required subagent naming notifications are missing from generated schema", async () => {
  for (const missingMethod of ["thread/started", "thread/name/updated"]) {
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
              await writeCapabilitySchemas(schemaDir, {
                serverNotifications: REQUIRED_SERVER_NOTIFICATIONS.filter((method) => method !== missingMethod)
              });
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

      assert.equal(result.snapshot.state, "bridge_unhealthy");
      assert.equal(result.snapshot.details.capabilityCheckPassed, false);
      assert.equal(result.snapshot.details.capabilityCheckSource, "generated_schema");
      assert.match(result.snapshot.details.issues.join("\n"), new RegExp(missingMethod.replace("/", "\\/"), "u"));
    } finally {
      await cleanup();
    }
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
            await writeCapabilitySchemas(schemaDir);
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

test("probeReadiness retries transient schema generation failures instead of caching them", async () => {
  const { paths, store, cleanup } = await createReadinessContext();
  let schemaAttempts = 0;

  try {
    const deps = {
      nodeVersion: process.version,
      detectServiceManager: async () => ({
        manager: "none" as const,
        health: "warning" as const,
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
          schemaAttempts += 1;
          if (schemaAttempts === 1) {
            return { exitCode: 1, stdout: "", stderr: "temporary schema failure" };
          }
          const outIndex = args.indexOf("--out");
          assert.notEqual(outIndex, -1);
          const schemaDir = args[outIndex + 1];
          assert.ok(schemaDir);
          await writeCapabilitySchemas(schemaDir);
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
    };

    const first = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps
    } as any);
    const second = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps
    } as any);

    assert.equal(first.snapshot.state, "bridge_unhealthy");
    assert.match(first.snapshot.details.issues.join("\n"), /temporary schema failure/u);
    assert.equal(second.snapshot.state, "awaiting_authorization");
    assert.equal(second.snapshot.details.capabilityCheckPassed, true);
    assert.equal(schemaAttempts, 2);
  } finally {
    await cleanup();
  }
});

test("probeReadiness ignores stale capability cache entries from an older bridge requirement set", async () => {
  const { paths, store, cleanup } = await createReadinessContext();
  let schemaAttempts = 0;

  try {
    await writeFile(
      join(paths.cacheDir, "codex-capabilities-0.114.0.json"),
      JSON.stringify({
        ok: false,
        source: "generated_schema",
        issues: ["missing notification: item/webSearch/progress"]
      }, null, 2)
    );

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
            schemaAttempts += 1;
            const outIndex = args.indexOf("--out");
            assert.notEqual(outIndex, -1);
            const schemaDir = args[outIndex + 1];
            assert.ok(schemaDir);
            await writeCapabilitySchemas(schemaDir);
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
    assert.equal(schemaAttempts, 1);
  } finally {
    await cleanup();
  }
});

test("probeReadiness caches capability mismatches that come from a successful schema comparison", async () => {
  const { paths, store, cleanup } = await createReadinessContext();
  let schemaAttempts = 0;

  try {
    const deps = {
      nodeVersion: process.version,
      detectServiceManager: async () => ({
        manager: "none" as const,
        health: "warning" as const,
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
          schemaAttempts += 1;
          const outIndex = args.indexOf("--out");
          assert.notEqual(outIndex, -1);
          const schemaDir = args[outIndex + 1];
          assert.ok(schemaDir);
          await writeCapabilitySchemas(schemaDir, {
            serverNotifications: REQUIRED_SERVER_NOTIFICATIONS.filter((method) => method !== "thread/archived")
          });
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        throw new Error(`unexpected command: ${args.join(" ")}`);
      },
      validateTelegramToken: async () => ({
        ok: true,
        botId: "1",
        username: "bridge_bot"
      })
    };

    const first = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps
    } as any);
    const second = await probeReadiness({
      config: testConfig,
      store,
      paths,
      logger: testLogger,
      persist: false,
      deps
    } as any);

    assert.equal(first.snapshot.state, "bridge_unhealthy");
    assert.equal(second.snapshot.state, "bridge_unhealthy");
    assert.equal(second.snapshot.details.capabilityCheckSource, "cache");
    assert.match(second.snapshot.details.issues.join("\n"), /thread\/archived/u);
    assert.equal(schemaAttempts, 1);
  } finally {
    await cleanup();
  }
});
