import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildLaunchAgentPlist, prepareRelease } from "./install.js";
import type { BridgePaths } from "./paths.js";
import type { CommandResult } from "./process.js";

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
