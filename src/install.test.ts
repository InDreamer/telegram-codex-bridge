import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "./config.js";
import {
  buildLaunchAgentPlist,
  buildTaskSchedulerRegistrationScript,
  getStatus,
  installBridge,
  installCodexSkill,
  prepareRelease,
  runDoctor,
  uninstallBridge,
  updateBridge
} from "./install.js";
import type { Logger } from "./logger.js";
import { BridgeStateStore } from "./state/store.js";
import type { BridgePaths } from "./paths.js";
import { runCommand, type CommandResult } from "./process.js";
import type { ReadinessSnapshot } from "./types.js";

function createTestPaths(root: string): BridgePaths {
  const logsDir = join(root, "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(root, "runtime");
  const binPath = join(root, "install", "bin", process.platform === "win32" ? "ctb.cmd" : "ctb");

  const paths: BridgePaths = {
    platform: process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
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
    taskSchedulerName: "CodexTelegramBridge",
    binPath,
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log"),
    telegramStatusCardLogPath: join(telegramSessionFlowLogsDir, "status-card.log"),
    telegramPlanCardLogPath: join(telegramSessionFlowLogsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(telegramSessionFlowLogsDir, "error-card.log")
  };

  if (process.platform === "win32") {
    paths.powershellWrapperPath = join(root, "install", "bin", "ctb.ps1");
  }

  return paths;
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

async function createGithubArchiveUpdateFixture(paths: BridgePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.configRoot, { recursive: true }),
    mkdir(paths.installRoot, { recursive: true })
  ]);
  await writeFile(
    paths.envPath,
    [
      "TELEGRAM_BOT_TOKEN=test-token",
      "CODEX_BIN=/usr/local/bin/codex",
      "PROJECT_SCAN_ROOTS=/Users/example/projects:/Users/example/work",
      "VOICE_INPUT_ENABLED=0"
    ].join("\n") + "\n",
    "utf8"
  );
  await writeFile(paths.manifestPath, JSON.stringify({
    version: "0.1.0",
    sourceRoot: null,
    installedAt: "2026-03-14T09:00:00.000Z",
    installSource: {
      kind: "github-archive",
      repoOwner: "InDreamer",
      repoName: "telegram-codex-bridge",
      ref: "master",
      refType: "branch"
    }
  }, null, 2));
}

async function createSkillFixture(root: string, description = "test skill"): Promise<void> {
  const skillDir = join(root, "skills", "telegram-codex-linker");
  await mkdir(join(skillDir, "agents"), { recursive: true });
  await mkdir(join(skillDir, "references"), { recursive: true });
  await mkdir(join(skillDir, "scripts"), { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: telegram-codex-linker\ndescription: ${description}\n---\n`, "utf8");
  await writeFile(
    join(skillDir, "agents", "openai.yaml"),
    'interface:\n  display_name: "Telegram Codex Linker"\n',
    "utf8"
  );
  await writeFile(join(skillDir, "references", "install-strategy.md"), "# test strategy\n", "utf8");
  await writeFile(join(skillDir, "scripts", "install-bridge-from-github.sh"), "#!/usr/bin/env bash\n", "utf8");
  await writeFile(join(skillDir, "scripts", "install-bridge-from-github.ps1"), "Write-Output 'ok'\r\n", "utf8");
}

async function writeExecutableFixture(binDir: string, name: string, body: {
  posix: string;
  win32: string;
}): Promise<string> {
  const filePath = join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
  await writeFile(filePath, process.platform === "win32" ? body.win32 : body.posix, "utf8");
  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }
  return filePath;
}

function extendPath(binDir: string): string {
  return process.platform === "win32"
    ? `${binDir};${process.env.PATH ?? ""}`
    : `${binDir}:${process.env.PATH ?? ""}`;
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
      nodeVersion: "v24.13.1",
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
    await createSkillFixture(paths.repoRoot);

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
    assert.equal(
      await readFile(join(paths.installRoot, "skills", "telegram-codex-linker", "SKILL.md"), "utf8"),
      "---\nname: telegram-codex-linker\ndescription: test skill\n---\n"
    );
    assert.equal(
      await readFile(
        join(paths.installRoot, "skills", "telegram-codex-linker", "references", "install-strategy.md"),
        "utf8"
      ),
      "# test strategy\n"
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

test("installCodexSkill copies the bundled skill into CODEX_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await createReleaseFixture(paths);
    await createSkillFixture(paths.repoRoot);

    await withEnvironment(
      {
        CODEX_HOME: join(root, "codex-home")
      },
      async () => {
        const result = await installCodexSkill(paths);

        assert.match(result, /restart Codex to load it/u);
        assert.equal(
          await readFile(join(root, "codex-home", "skills", "telegram-codex-linker", "SKILL.md"), "utf8"),
          "---\nname: telegram-codex-linker\ndescription: test skill\n---\n"
        );
        assert.equal(
          await readFile(
            join(root, "codex-home", "skills", "telegram-codex-linker", "agents", "openai.yaml"),
            "utf8"
          ),
          'interface:\n  display_name: "Telegram Codex Linker"\n'
        );
        assert.equal(
          await readFile(
            join(root, "codex-home", "skills", "telegram-codex-linker", "scripts", "install-bridge-from-github.sh"),
            "utf8"
          ),
          "#!/usr/bin/env bash\n"
        );
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installCodexSkill prefers the current checkout bundle over an older installed copy", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    await createReleaseFixture(paths);
    await createSkillFixture(paths.repoRoot, "repo skill");
    await createSkillFixture(paths.installRoot, "installed skill");

    await withEnvironment(
      {
        CODEX_HOME: join(root, "codex-home")
      },
      async () => {
        await installCodexSkill(paths);

        assert.equal(
          await readFile(join(root, "codex-home", "skills", "telegram-codex-linker", "SKILL.md"), "utf8"),
          "---\nname: telegram-codex-linker\ndescription: repo skill\n---\n"
        );
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled bridge install script parses cleanly in bash", async () => {
  if (process.platform === "win32") {
    return;
  }
  const result = await runCommand("bash", ["-n", "skills/telegram-codex-linker/scripts/install-bridge-from-github.sh"]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test("project root discovery script parses cleanly in bash", async () => {
  if (process.platform === "win32") {
    return;
  }
  const result = await runCommand("bash", ["-n", "skills/telegram-codex-linker/scripts/discover-project-scan-roots.sh"]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test("public install script parses cleanly in bash", async () => {
  if (process.platform === "win32") {
    return;
  }
  const result = await runCommand("bash", ["-n", "scripts/install-from-github.sh"]);
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test("project root discovery script selects likely disjoint roots", async () => {
  if (process.platform === "win32") {
    return;
  }
  const homeRoot = await mkdtemp(join(tmpdir(), "ctb-scan-roots-"));
  const projectsRoot = join(homeRoot, "projects");
  const workRoot = join(homeRoot, "work");
  const miscRoot = join(homeRoot, "misc");

  try {
    await Promise.all([
      mkdir(join(projectsRoot, "alpha", ".git"), { recursive: true }),
      mkdir(join(projectsRoot, "beta"), { recursive: true }),
      mkdir(join(workRoot, "tooling"), { recursive: true }),
      mkdir(join(workRoot, "backend"), { recursive: true }),
      mkdir(join(miscRoot, "solo", ".git"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(projectsRoot, "beta", "package.json"), "{}\n", "utf8"),
      writeFile(join(workRoot, "tooling", "pyproject.toml"), "[project]\nname='tooling'\n", "utf8"),
      writeFile(join(workRoot, "backend", "go.mod"), "module example.com/backend\n", "utf8")
    ]);

    const result = await runCommand("bash", [
      "skills/telegram-codex-linker/scripts/discover-project-scan-roots.sh",
      "--home",
      homeRoot
    ]);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.deepEqual(result.stdout.split(":"), [
      await realpath(projectsRoot),
      await realpath(workRoot)
    ]);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("project root discovery script can emit one recommended root per line", async () => {
  if (process.platform === "win32") {
    return;
  }
  const homeRoot = await mkdtemp(join(tmpdir(), "ctb-scan-roots-lines-"));
  const projectsRoot = join(homeRoot, "projects");
  const workRoot = join(homeRoot, "work");

  try {
    await Promise.all([
      mkdir(join(projectsRoot, "alpha", ".git"), { recursive: true }),
      mkdir(join(projectsRoot, "beta"), { recursive: true }),
      mkdir(join(workRoot, "tooling"), { recursive: true }),
      mkdir(join(workRoot, "backend"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(projectsRoot, "beta", "package.json"), "{}\n", "utf8"),
      writeFile(join(workRoot, "tooling", "pyproject.toml"), "[project]\nname='tooling'\n", "utf8"),
      writeFile(join(workRoot, "backend", "go.mod"), "module example.com/backend\n", "utf8")
    ]);

    const result = await runCommand("bash", [
      "skills/telegram-codex-linker/scripts/discover-project-scan-roots.sh",
      "--home",
      homeRoot,
      "--format",
      "lines"
    ]);

    assert.equal(result.exitCode, 0, result.stderr || result.stdout);
    assert.deepEqual(result.stdout.split("\n"), [
      await realpath(projectsRoot),
      await realpath(workRoot)
    ]);
  } finally {
    await rm(homeRoot, { recursive: true, force: true });
  }
});

test("installBridge validates and persists non-overlapping project scan roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);
  const binDir = join(root, "bin");
  const firstRoot = join(root, "projects");
  const nestedRoot = join(firstRoot, "nested");
  const secondRoot = join(root, "work");

  try {
    await Promise.all([
      createReleaseFixture(paths),
      createSkillFixture(paths.repoRoot),
      mkdir(join(paths.repoRoot, "dist"), { recursive: true }),
      mkdir(binDir, { recursive: true }),
      mkdir(firstRoot, { recursive: true }),
      mkdir(nestedRoot, { recursive: true }),
      mkdir(secondRoot, { recursive: true })
    ]);
    await writeFile(join(paths.repoRoot, "dist", "cli.js"), "console.log('ok');\n", "utf8");
    await writeExecutableFixture(binDir, "npm", {
      posix: "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n",
      win32: "@echo off\r\nexit /b 0\r\n"
    });

    await withEnvironment(
      {
        PATH: extendPath(binDir)
      },
      async () => {
        await installBridge(paths, testLogger, {
          telegramBotToken: "test-token",
          projectScanRoots: [firstRoot, nestedRoot, secondRoot]
        }, {
          detectServiceManager: async () => "none",
          probeReadiness: async () => ({
            snapshot: createReadinessSnapshot(),
            appServer: null
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
          syncTelegramCommands: async () => {}
        } as any);
      }
    );

    const config = await loadConfig(paths);
    assert.deepEqual(config.projectScanRoots, [firstRoot, secondRoot]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installBridge restarts an already-active systemd service so the new build takes effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);
  const binDir = join(root, "bin");
  const systemctlLogPath = join(root, "systemctl.log");
  const npmLogPath = join(root, "npm.log");

  try {
    await Promise.all([
      createReleaseFixture(paths),
      createSkillFixture(paths.repoRoot),
      mkdir(join(paths.repoRoot, "dist"), { recursive: true }),
      mkdir(binDir, { recursive: true })
    ]);
    await writeFile(join(paths.repoRoot, "dist", "cli.js"), "console.log('ok');\n", "utf8");
    await writeExecutableFixture(binDir, "npm", {
      posix: `#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\\n' "$*" >> ${JSON.stringify(npmLogPath)}
`,
      win32: `@echo off\r\necho npm %*>> ${JSON.stringify(npmLogPath)}\r\nexit /b 0\r\n`
    });
    await writeExecutableFixture(binDir, "systemctl", {
      posix: `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLogPath)}
if [ "$1" = "--user" ] && [ "$2" = "is-active" ]; then
  echo active
  exit 0
fi
exit 0
`,
      win32: `@echo off\r\necho %*>> ${JSON.stringify(systemctlLogPath)}\r\nif "%1"=="--user" if "%2"=="is-active" (\r\n  echo active\r\n)\r\nexit /b 0\r\n`
    });

    await withEnvironment(
      {
        PATH: extendPath(binDir)
      },
      async () => {
        await installBridge(paths, testLogger, {
          telegramBotToken: "test-token"
        }, {
          detectServiceManager: async () => "systemd",
          probeReadiness: async () => ({
            snapshot: createReadinessSnapshot(),
            appServer: null
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
          syncTelegramCommands: async () => {}
        } as any);
      }
    );

    const systemctlLog = await readFile(systemctlLogPath, "utf8");
    assert.match(systemctlLog, /--user is-active codex-telegram-bridge\.service/u);
    assert.match(systemctlLog, /--user daemon-reload/u);
    assert.match(systemctlLog, /--user enable codex-telegram-bridge\.service/u);
    assert.match(systemctlLog, /--user restart codex-telegram-bridge\.service/u);
    assert.doesNotMatch(systemctlLog, /--user enable --now codex-telegram-bridge\.service/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installBridge writes GitHub archive metadata into the install manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);
  const binDir = join(root, "bin");

  try {
    await Promise.all([
      createReleaseFixture(paths),
      createSkillFixture(paths.repoRoot),
      mkdir(join(paths.repoRoot, "dist"), { recursive: true }),
      mkdir(binDir, { recursive: true })
    ]);
    await writeFile(join(paths.repoRoot, "dist", "cli.js"), "console.log('ok');\n", "utf8");
    await writeExecutableFixture(binDir, "npm", {
      posix: "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n",
      win32: "@echo off\r\nexit /b 0\r\n"
    });

    await withEnvironment(
      {
        PATH: extendPath(binDir),
        CTB_INSTALL_SOURCE_KIND: "github-archive",
        CTB_INSTALL_SOURCE_REPO_OWNER: "InDreamer",
        CTB_INSTALL_SOURCE_REPO_NAME: "telegram-codex-bridge",
        CTB_INSTALL_SOURCE_REF: "master",
        CTB_INSTALL_SOURCE_REF_TYPE: "branch"
      },
      async () => {
        await installBridge(paths, testLogger, {
          telegramBotToken: "test-token"
        }, {
          detectServiceManager: async () => "none",
          probeReadiness: async () => ({
            snapshot: createReadinessSnapshot(),
            appServer: null
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
          syncTelegramCommands: async () => {}
        } as any);
      }
    );

    const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
    assert.equal(manifest.sourceRoot, null);
    assert.deepEqual(manifest.installSource, {
      kind: "github-archive",
      repoOwner: "InDreamer",
      repoName: "telegram-codex-bridge",
      ref: "master",
      refType: "branch"
    });
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

test("buildTaskSchedulerRegistrationScript targets the Windows wrapper and login trigger", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const paths = createTestPaths(root);

  try {
    const script = buildTaskSchedulerRegistrationScript({
      ...paths,
      platform: "win32",
      binPath: join(root, "install", "bin", "ctb.cmd"),
      installRoot: join(root, "install"),
      taskSchedulerName: "CodexTelegramBridge"
    });

    assert.match(script, /New-ScheduledTaskAction/u);
    assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/u);
    assert.match(script, /RestartCount 999/u);
    assert.match(script, /ctb\.cmd/u);
    assert.match(script, /service run/u);
    assert.match(script, /CodexTelegramBridge/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstallBridge preserves shared Windows state when purgeState is false", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-install-test-"));
  const installRoot = join(root, "LocalAppData", "codex-telegram-bridge");
  const configRoot = join(root, "RoamingAppData", "codex-telegram-bridge");
  const logsDir = join(installRoot, "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(installRoot, "runtime");
  const cacheDir = join(installRoot, "cache");
  const paths: BridgePaths = {
    platform: "win32",
    homeDir: root,
    repoRoot: join(root, "repo"),
    installRoot,
    stateRoot: installRoot,
    configRoot,
    logsDir,
    telegramSessionFlowLogsDir,
    runtimeDir,
    cacheDir,
    dbPath: join(installRoot, "bridge.db"),
    stateStoreFailurePath: join(installRoot, "state-store-open-failure.json"),
    envPath: join(configRoot, "bridge.env"),
    servicePath: join(configRoot, "tasks", "CodexTelegramBridge.ps1"),
    launchAgentPath: join(root, "LaunchAgents", "bridge.plist"),
    taskSchedulerName: "CodexTelegramBridge",
    binPath: join(installRoot, "bin", "ctb.cmd"),
    powershellWrapperPath: join(installRoot, "bin", "ctb.ps1"),
    manifestPath: join(installRoot, "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log"),
    telegramStatusCardLogPath: join(telegramSessionFlowLogsDir, "status-card.log"),
    telegramPlanCardLogPath: join(telegramSessionFlowLogsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(telegramSessionFlowLogsDir, "error-card.log")
  };

  try {
    await Promise.all([
      mkdir(join(paths.installRoot, "dist"), { recursive: true }),
      mkdir(join(paths.installRoot, "skills"), { recursive: true }),
      mkdir(join(paths.installRoot, "bin"), { recursive: true }),
      mkdir(paths.logsDir, { recursive: true }),
      mkdir(paths.runtimeDir, { recursive: true }),
      mkdir(paths.cacheDir, { recursive: true }),
      mkdir(paths.configRoot, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(paths.installRoot, "dist", "cli.js"), "console.log('ok');\n", "utf8"),
      writeFile(join(paths.installRoot, "skills", "skill.txt"), "skill\n", "utf8"),
      writeFile(paths.binPath, "@echo off\r\n", "utf8"),
      writeFile(paths.powershellWrapperPath!, "Write-Output 'ok'\r\n", "utf8"),
      writeFile(join(paths.installRoot, "package.json"), "{ }\n", "utf8"),
      writeFile(paths.manifestPath, "{ }\n", "utf8"),
      writeFile(paths.dbPath, "sqlite\n", "utf8"),
      writeFile(paths.bridgeLogPath, "keep\n", "utf8"),
      writeFile(paths.offsetPath, "{ }\n", "utf8"),
      writeFile(join(paths.cacheDir, "persist.txt"), "keep\n", "utf8"),
      writeFile(paths.envPath, "TELEGRAM_BOT_TOKEN=test-token\n", "utf8")
    ]);

    await uninstallBridge(paths, false);

    assert.equal(await pathExists(paths.dbPath), true);
    assert.equal(await pathExists(paths.bridgeLogPath), true);
    assert.equal(await pathExists(paths.offsetPath), true);
    assert.equal(await pathExists(join(paths.cacheDir, "persist.txt")), true);
    assert.equal(await pathExists(join(paths.installRoot, "dist")), false);
    assert.equal(await pathExists(join(paths.installRoot, "skills")), false);
    assert.equal(await pathExists(join(paths.installRoot, "bin")), false);
    assert.equal(await pathExists(join(paths.installRoot, "package.json")), false);
    assert.equal(await pathExists(paths.manifestPath), false);
    assert.equal(await pathExists(paths.configRoot), false);
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

test("updateBridge redownloads non-Windows GitHub archive installs from manifest metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-update-test-"));
  const paths = createTestPaths(root);
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string | URL | undefined;
    env: NodeJS.ProcessEnv | undefined;
  }> = [];

  try {
    paths.platform = "linux";
    await createGithubArchiveUpdateFixture(paths);

    await updateBridge(paths, {
      runCommand: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd, env: options?.env as NodeJS.ProcessEnv | undefined });

        if (command === "tar") {
          const workDir = args[3];
          if (!workDir) {
            throw new Error("missing extraction workdir");
          }
          await mkdir(join(workDir, "telegram-codex-bridge-master"), { recursive: true });
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        if (command === "powershell.exe") {
          const commandText = args.at(-1) ?? "";
          const match = commandText.match(/DestinationPath '([^']+)'/u);
          const workDir = match?.[1];
          if (!workDir) {
            throw new Error("missing extraction workdir");
          }
          await mkdir(join(workDir, "telegram-codex-bridge-master"), { recursive: true });
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(calls[0]?.command, "curl");
    assert.deepEqual(calls[0]?.args, [
      "-fsSL",
      "https://codeload.github.com/InDreamer/telegram-codex-bridge/tar.gz/refs/heads/master",
      "-o",
      calls[0]?.args[3] ?? ""
    ]);
    assert.equal(calls[1]?.command, "tar");
    assert.equal(calls[2]?.command, "npm");
    assert.deepEqual(calls[2]?.args, ["install"]);
    assert.equal(calls[2]?.cwd, join((calls[1]?.args[3] as string), "telegram-codex-bridge-master"));
    assert.equal(calls[2]?.env?.CTB_INSTALL_SOURCE_KIND, "github-archive");
    assert.equal(calls[2]?.env?.CTB_INSTALL_SOURCE_REPO_OWNER, "InDreamer");
    assert.equal(calls[2]?.env?.TELEGRAM_BOT_TOKEN, "test-token");
    assert.equal(calls[3]?.command, "npm");
    assert.deepEqual(calls[3]?.args, ["run", "build"]);
    assert.equal(calls[4]?.command, process.execPath);
    assert.deepEqual(calls[4]?.args, ["dist/cli.js", "install"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateBridge prefers curl for win32 GitHub archive installs", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-update-win32-test-"));
  const paths = createTestPaths(root);
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string | URL | undefined;
    env: NodeJS.ProcessEnv | undefined;
  }> = [];

  try {
    paths.platform = "win32";
    await createGithubArchiveUpdateFixture(paths);

    await updateBridge(paths, {
      commandExists: async (command, options) => command === "curl" && options?.platform === "win32",
      runCommand: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd, env: options?.env as NodeJS.ProcessEnv | undefined });

        if (command === "powershell.exe") {
          const commandText = args.at(-1) ?? "";
          const match = commandText.match(/DestinationPath '([^']+)'/u);
          const workDir = match?.[1];
          if (workDir) {
            await mkdir(join(workDir, "telegram-codex-bridge-master"), { recursive: true });
          }
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(calls[0]?.command, "curl");
    assert.deepEqual(calls[0]?.args, [
      "-fsSL",
      "https://codeload.github.com/InDreamer/telegram-codex-bridge/zip/refs/heads/master",
      "-o",
      calls[0]?.args[3] ?? ""
    ]);
    assert.equal(calls[1]?.command, "powershell.exe");
    assert.match(calls[1]?.args.at(-1) ?? "", /Expand-Archive/u);
    assert.equal(calls[2]?.command, "npm");
    assert.deepEqual(calls[2]?.args, ["install"]);
    assert.equal(calls[2]?.cwd, join((calls[1]?.args.at(-1)?.match(/DestinationPath '([^']+)'/u)?.[1] as string), "telegram-codex-bridge-master"));
    assert.equal(calls[3]?.command, "npm");
    assert.deepEqual(calls[3]?.args, ["run", "build"]);
    assert.equal(calls[4]?.command, process.execPath);
    assert.deepEqual(calls[4]?.args, ["dist/cli.js", "install"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("updateBridge falls back to PowerShell download when curl is unavailable on win32", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-update-win32-fallback-test-"));
  const paths = createTestPaths(root);
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string | URL | undefined;
    env: NodeJS.ProcessEnv | undefined;
  }> = [];

  try {
    paths.platform = "win32";
    await createGithubArchiveUpdateFixture(paths);

    await updateBridge(paths, {
      commandExists: async () => false,
      runCommand: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd, env: options?.env as NodeJS.ProcessEnv | undefined });

        if (command === "powershell.exe") {
          const commandText = args.at(-1) ?? "";
          const match = commandText.match(/DestinationPath '([^']+)'/u);
          const workDir = match?.[1];
          if (workDir) {
            await mkdir(join(workDir, "telegram-codex-bridge-master"), { recursive: true });
          }
        }

        return { exitCode: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(calls[0]?.command, "powershell.exe");
    assert.match(calls[0]?.args.at(-1) ?? "", /Invoke-WebRequest/u);
    assert.match(calls[0]?.args.at(-1) ?? "", /zip\/refs\/heads\/master/u);
    assert.equal(calls[1]?.command, "powershell.exe");
    assert.match(calls[1]?.args.at(-1) ?? "", /Expand-Archive/u);
    assert.equal(calls[2]?.command, "npm");
    assert.deepEqual(calls[2]?.args, ["install"]);
    assert.equal(calls[3]?.command, "npm");
    assert.deepEqual(calls[3]?.args, ["run", "build"]);
    assert.equal(calls[4]?.command, process.execPath);
    assert.deepEqual(calls[4]?.args, ["dist/cli.js", "install"]);
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
    await writeFile(paths.binPath, process.platform === "win32" ? "@echo off\r\n" : "#!/usr/bin/env bash\n", "utf8");
    await writeFile(paths.envPath, "TELEGRAM_BOT_TOKEN=test-token\n", "utf8");

    const store = await BridgeStateStore.open(paths, testLogger);
    try {
      store.writeReadinessSnapshot(createReadinessSnapshot({
        details: {
          issues: ["service manager warning: no supported service manager found"],
          voiceInputEnabled: true,
          voiceOpenaiConfigured: true,
          voiceFfmpegAvailable: true,
          voiceRealtimeSupported: false
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

    assert.match(output, /node_version=v24\.13\.1/u);
    assert.match(output, /node_version_supported=true/u);
    assert.match(output, /codex_version=codex-cli 0\.114\.0/u);
    assert.match(output, /codex_version_supported=true/u);
    assert.match(output, /service_manager_health=warning/u);
    assert.match(output, /voice_input_enabled=true/u);
    assert.match(output, /voice_openai_configured=true/u);
    assert.match(output, /voice_ffmpeg_available=true/u);
    assert.match(output, /voice_realtime_supported=false/u);
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
    assert.match(output, /node_version=v24\.13\.1/u);
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
