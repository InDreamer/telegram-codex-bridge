import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareRelease } from "./install.js";
import type { BridgePaths } from "./paths.js";
import type { CommandResult } from "./process.js";

function createTestPaths(root: string): BridgePaths {
  return {
    homeDir: root,
    repoRoot: join(root, "repo"),
    installRoot: join(root, "install"),
    stateRoot: join(root, "state"),
    configRoot: join(root, "config"),
    logsDir: join(root, "logs"),
    runtimeDir: join(root, "runtime"),
    cacheDir: join(root, "cache"),
    dbPath: join(root, "state", "bridge.db"),
    envPath: join(root, "config", "bridge.env"),
    servicePath: join(root, "service", "bridge.service"),
    binPath: join(root, "install", "bin", "ctb"),
    manifestPath: join(root, "install", "install-manifest.json"),
    offsetPath: join(root, "runtime", "telegram-offset.json"),
    bridgeLogPath: join(root, "logs", "bridge.log"),
    bootstrapLogPath: join(root, "logs", "bootstrap.log"),
    appServerLogPath: join(root, "logs", "app-server.log")
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
