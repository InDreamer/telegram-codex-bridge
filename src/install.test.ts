import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildLaunchAgentPlist, getStatus, prepareRelease, runDoctor } from "./install.js";
import type { Logger } from "./logger.js";
import { BridgeStateStore } from "./state/store.js";
import type { BridgePaths } from "./paths.js";
import type { CommandResult } from "./process.js";
import type { ReadinessSnapshot } from "./types.js";

function createTestPaths(root: string): BridgePaths {
  const logsDir = join(root, "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(root, "runtime");

  return {
    homeDir: root,
    repoRoot: join(root, "repo"),
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
    binPath: join(root, "install", "bin", "ctb"),
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function createReleaseFixture(paths: BridgePaths): Promise<void> {
  await mkdir(paths.repoRoot, { recursive: true });
  await mkdir(paths.installRoot, { recursive: true });
  await writeFile(paths.repoRoot + "/package.json", '{ "name": "telegram-codex-bridge" }\n', "utf8");
}

function withEnvironment<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

const testLogger: Logger = {
  info: async () => {},
  warn: async () => {},
  error: async () => {}
};

function createReadinessSnapshot(
  overrides: Omit<Partial<ReadinessSnapshot>, "details"> & {
    details?: Partial<ReadinessSnapshot["details"]>;
  } = {}
): ReadinessSnapshot {
  const detailOverrides = (overrides.details ?? {}) as Partial<ReadinessSnapshot["details"]>;
  return {
    state: overrides.state ?? "ready",
    checkedAt: overrides.checkedAt ?? "2026-03-14T10:00:00.000Z",
    details: {
      codexInstalled: true,
      codexAuthenticated: true,
      appServerAvailable: true,
      telegramTokenValid: true,
      authorizedUserBound: true,
      issues: [],
      nodeVersion: "v25.8.1",
      nodeVersionSupported: true,
      codexVersion: "codex-cli 0.114.0",
      codexVersionSupported: true,
      serviceManager: "none",
      serviceManagerHealth: "warning",
      stateRootWritable: true,
      configRootWritable: true,
      installRootWritable: true,
      capabilityCheckPassed: true,
      capabilityCheckSource: "cache",
      ...detailOverrides
    },
    appServerPid: overrides.appServerPid ?? null
  };
}

test("prepareRelease builds before copying dist into the install root", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);
  const calls: Array<{ command: string; args: string[]; cwd: string | URL | undefined }> = [];

  try {
    await createReleaseFixture(paths);

    await prepareRelease(paths, async (command, args, options) => {
      calls.push({ command, args, cwd: options?.cwd });
      await mkdir(join(paths.repoRoot, "dist"), { recursive: true });
      await writeFile(join(paths.repoRoot, "dist", "cli.js"), "console.log('ok');\n", "utf8");
      return {
        exitCode: 0,
        stdout: "",
        stderr: ""
      } satisfies CommandResult;
    });

    assert.deepEqual(calls, [
      {
        command: "npm",
        args: ["run", "build"],
        cwd: paths.repoRoot
      }
    ]);
    assert.equal(await readFile(join(paths.installRoot, "dist", "cli.js"), "utf8"), "console.log('ok');\n");
    assert.equal(
      await readFile(join(paths.installRoot, "package.json"), "utf8"),
      '{ "name": "telegram-codex-bridge" }\n'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareRelease aborts if the build command fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await createReleaseFixture(paths);
    await mkdir(join(paths.installRoot, "dist"), { recursive: true });
    await writeFile(join(paths.installRoot, "dist", "stale.js"), "stale\n", "utf8");

    await assert.rejects(
      prepareRelease(paths, async () => {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "build exploded"
        } satisfies CommandResult;
      }),
      /build exploded/
    );

    assert.equal(await readFile(join(paths.installRoot, "dist", "stale.js"), "utf8"), "stale\n");
    assert.equal(await pathExists(join(paths.installRoot, "package.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepareRelease rejects successful builds that do not produce dist/cli.js", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await createReleaseFixture(paths);

    await assert.rejects(
      prepareRelease(paths, async () => {
        return {
          exitCode: 0,
          stdout: "",
          stderr: ""
        } satisfies CommandResult;
      }),
      /dist\/cli\.js/
    );

    assert.equal(await pathExists(join(paths.installRoot, "dist")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildLaunchAgentPlist keeps launchd passthrough env only and does not pin bridge config", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await withEnvironment(
      {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HTTPS_PROXY: "http://proxy.internal:8443",
        TELEGRAM_BOT_TOKEN: "stale-token",
        CODEX_BIN: "/tmp/stale-codex",
        TELEGRAM_API_BASE_URL: "https://stale.example.invalid",
        TELEGRAM_POLL_TIMEOUT_SECONDS: "99",
        TELEGRAM_POLL_INTERVAL_MS: "9999"
      },
      async () => {
        const plist = buildLaunchAgentPlist(paths);

        assert.match(plist, /<key>EnvironmentVariables<\/key>/u);
        assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/usr\/bin:\/bin<\/string>/u);
        assert.match(plist, /<key>HTTPS_PROXY<\/key>\s*<string>http:\/\/proxy\.internal:8443<\/string>/u);
        assert.doesNotMatch(plist, /TELEGRAM_BOT_TOKEN/u);
        assert.doesNotMatch(plist, /CODEX_BIN/u);
        assert.doesNotMatch(plist, /TELEGRAM_API_BASE_URL/u);
        assert.doesNotMatch(plist, /TELEGRAM_POLL_TIMEOUT_SECONDS/u);
        assert.doesNotMatch(plist, /TELEGRAM_POLL_INTERVAL_MS/u);
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getStatus returns state-store failure diagnostics when the database cannot be opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await Promise.all([
      mkdir(paths.stateRoot, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.configRoot, { recursive: true })
    ]);
    await writeFile(paths.dbPath, "not a sqlite database", "utf8");

    const status = await getStatus(paths);

    assert.match(status, /state_store_open=failed/u);
    assert.match(status, /state_store_failure_class=integrity_failure/u);
    assert.match(status, /state_store_failure_stage=/u);
    assert.match(status, /state_store_failure_action=/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDoctor returns state-store failure diagnostics instead of throwing when the database cannot be opened", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await Promise.all([
      mkdir(paths.stateRoot, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.configRoot, { recursive: true })
    ]);

    const db = new DatabaseSync(paths.dbPath);
    db.exec("CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT)");
    db.close();

    const originalPrepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function patchedPrepare(sql: string) {
      if (sql === "PRAGMA integrity_check") {
        const error = new Error("database is locked");
        (error as NodeJS.ErrnoException).code = "ERR_SQLITE_ERROR";
        throw error;
      }
      return originalPrepare.call(this, sql);
    };

    try {
      const doctor = await runDoctor(paths, testLogger);
      assert.match(doctor, /state_store_open=failed/u);
      assert.match(doctor, /state_store_failure_class=transient_open_failure/u);
      assert.match(doctor, /state_store_failure_action=/u);
    } finally {
      DatabaseSync.prototype.prepare = originalPrepare;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getStatus renders the expanded readiness summary fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await Promise.all([
      mkdir(paths.installRoot, { recursive: true }),
      mkdir(paths.stateRoot, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.configRoot, { recursive: true }),
      mkdir(join(paths.servicePath, ".."), { recursive: true })
    ]);
    await writeFile(paths.manifestPath, JSON.stringify({
      version: "0.1.0",
      sourceRoot: null,
      installedAt: "2026-03-14T09:00:00.000Z"
    }, null, 2));
    await writeFile(join(paths.installRoot, "dist", "cli.js"), "console.log('ok');\n", "utf8").catch(async () => {
      await mkdir(join(paths.installRoot, "dist"), { recursive: true });
      await writeFile(join(paths.installRoot, "dist", "cli.js"), "console.log('ok');\n", "utf8");
    });
    await mkdir(join(paths.binPath, ".."), { recursive: true });
    await writeFile(paths.binPath, "#!/usr/bin/env bash\n", "utf8");
    await writeFile(paths.envPath, "TELEGRAM_BOT_TOKEN=test-token\n", "utf8");

    const store = await BridgeStateStore.open(paths, testLogger);
    try {
      store.writeReadinessSnapshot(createReadinessSnapshot({
        details: {
          issues: ["service manager warning: no supported service manager found"]
        }
      }));
    } finally {
      store.close();
    }

    const output = await getStatus(paths, {
      detectServiceManager: async () => "none",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: ""
      })
    } as any);

    assert.match(output, /node_version=v25\.8\.1/u);
    assert.match(output, /node_version_supported=true/u);
    assert.match(output, /codex_version=codex-cli 0\.114\.0/u);
    assert.match(output, /codex_version_supported=true/u);
    assert.match(output, /service_manager_health=warning/u);
    assert.match(output, /capability_check_passed=true/u);
    assert.match(output, /capability_check_source=cache/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDoctor prints the expanded readiness matrix without syncing Telegram when the token is invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await Promise.all([
      mkdir(paths.installRoot, { recursive: true }),
      mkdir(paths.stateRoot, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.configRoot, { recursive: true }),
      mkdir(paths.cacheDir, { recursive: true })
    ]);
    await writeFile(paths.envPath, "TELEGRAM_BOT_TOKEN=test-token\n", "utf8");

    const output = await runDoctor(paths, testLogger, {
      probeReadiness: async () => ({
        snapshot: createReadinessSnapshot({
          state: "telegram_token_invalid",
          details: {
            telegramTokenValid: false,
            issues: ["telegram rejected the configured token"]
          }
        }),
        appServer: null
      })
    } as any);

    assert.match(output, /readiness=telegram_token_invalid/u);
    assert.match(output, /node_version=v25\.8\.1/u);
    assert.match(output, /capability_check_passed=true/u);
    assert.match(output, /issues=telegram rejected the configured token/u);
    assert.match(output, /pending_runtime_notices=0/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runDoctor prints archive drift diagnostics when readiness is otherwise healthy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await Promise.all([
      mkdir(paths.installRoot, { recursive: true }),
      mkdir(paths.stateRoot, { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.configRoot, { recursive: true }),
      mkdir(paths.cacheDir, { recursive: true })
    ]);
    await writeFile(paths.envPath, "TELEGRAM_BOT_TOKEN=test-token\n", "utf8");

    const output = await runDoctor(paths, testLogger, {
      probeReadiness: async () => ({
        snapshot: createReadinessSnapshot(),
        appServer: {
          listThreads: async () => ({
            data: [],
            nextCursor: null
          }),
          stop: async () => {}
        } as any
      }),
      createTelegramApi: () => ({
        getMe: async () => ({
          id: 1,
          is_bot: true,
          first_name: "Bridge",
          username: "bridge_bot"
        }),
        setMyCommands: async () => {}
      }),
      syncTelegramCommands: async () => {},
      scanArchiveDrift: async () => ({
        issues: [{
          kind: "remote_archived_local_visible",
          sessionId: "session-1",
          threadId: "thread-1",
          projectName: "Project One",
          displayName: "Session One"
        }]
      })
    } as any);

    assert.match(output, /archive_drift_count=1/u);
    assert.match(output, /archive_drift_1=remote_archived_local_visible \| session=session-1 \| thread=thread-1/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
