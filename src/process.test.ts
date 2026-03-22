import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSpawnPlan, commandExists, resolveCommand, runCommand } from "./process.js";

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

test("resolveCommand finds platform executables from PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-process-test-"));
  const binDir = join(root, "bin");

  try {
    await mkdir(binDir, { recursive: true });
    const executablePath = await writeExecutableFixture(binDir, "codex", {
      posix: "#!/usr/bin/env bash\nprintf 'codex %s\\n' \"$*\"\n",
      win32: "@echo off\r\necho codex %*\r\n"
    });

    const resolved = await resolveCommand("codex", {
      env: {
        ...process.env,
        PATH: process.platform === "win32" ? `${binDir};${process.env.PATH ?? ""}` : `${binDir}:${process.env.PATH ?? ""}`
      }
    });

    assert.ok(resolved);
    assert.equal(resolved.resolvedPath, executablePath);
    assert.equal(resolved.invocation, process.platform === "win32" ? "cmd" : "direct");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runCommand executes platform wrapper shims", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-process-run-test-"));
  const binDir = join(root, "bin");

  try {
    await mkdir(binDir, { recursive: true });
    await writeExecutableFixture(binDir, "npm", {
      posix: "#!/usr/bin/env bash\nprintf 'npm %s\\n' \"$*\"\n",
      win32: "@echo off\r\necho npm %*\r\n"
    });

    const result = await runCommand("npm", ["run", "build"], {
      env: {
        ...process.env,
        PATH: process.platform === "win32" ? `${binDir};${process.env.PATH ?? ""}` : `${binDir}:${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /npm run build/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveCommand classifies PowerShell scripts on win32", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-process-ps1-test-"));

  try {
    const scriptPath = join(root, "bridge.ps1");
    await writeFile(scriptPath, "Write-Output 'ok'\r\n", "utf8");

    const resolved = await resolveCommand(scriptPath, { platform: "win32" });
    assert.ok(resolved);
    assert.equal(resolved.invocation, "powershell");
    assert.equal(resolved.resolvedPath, scriptPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveCommand searches win32 system directories before PATH", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-process-win32-search-"));
  const cwd = join(root, "cwd");
  const pathDir = join(root, "path");
  const systemRoot = join(root, "Windows");
  const system32Dir = join(systemRoot, "System32");
  const powerShellDir = join(system32Dir, "WindowsPowerShell", "v1.0");

  try {
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(pathDir, { recursive: true }),
      mkdir(powerShellDir, { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(system32Dir, "curl.exe"), "", "utf8"),
      writeFile(join(powerShellDir, "powershell.exe"), "", "utf8")
    ]);

    const env = {
      ...process.env,
      PATH: pathDir,
      SystemRoot: systemRoot
    };

    const resolvedCurl = await resolveCommand("curl", { cwd, env, platform: "win32" });
    const resolvedPowerShell = await resolveCommand("powershell.exe", { cwd, env, platform: "win32" });

    assert.ok(resolvedCurl);
    assert.equal(resolvedCurl.resolvedPath, join(system32Dir, "curl.exe"));
    assert.ok(resolvedPowerShell);
    assert.equal(resolvedPowerShell.resolvedPath, join(powerShellDir, "powershell.exe"));
    assert.equal(await commandExists("powershell.exe", { cwd, env, platform: "win32" }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildSpawnPlan resolves cmd.exe for win32 command shims", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-process-win32-cmd-"));
  const cwd = join(root, "cwd");
  const binDir = join(root, "bin");
  const systemRoot = join(root, "Windows");
  const system32Dir = join(systemRoot, "System32");
  const shimPath = join(binDir, "npm.cmd");
  const cmdPath = join(system32Dir, "cmd.exe");

  try {
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(binDir, { recursive: true }),
      mkdir(system32Dir, { recursive: true })
    ]);
    await Promise.all([
      writeFile(shimPath, "@echo off\r\n", "utf8"),
      writeFile(cmdPath, "", "utf8")
    ]);

    const spawnPlan = await buildSpawnPlan("npm", ["run", "build"], {
      cwd,
      env: {
        ...process.env,
        PATH: binDir,
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        SystemRoot: systemRoot
      },
      platform: "win32"
    });

    assert.equal(spawnPlan.command, cmdPath);
    assert.deepEqual(spawnPlan.args, ["/d", "/s", "/c", shimPath, "run", "build"]);
    assert.equal(spawnPlan.resolved.invocation, "cmd");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("commandExists ignores non-executable PATH entries on POSIX", async () => {
  if (process.platform === "win32") {
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "ctb-process-nonexec-test-"));
  const binDir = join(root, "bin");
  const commandName = "ctb-nonexec-fixture";

  try {
    await mkdir(binDir, { recursive: true });
    const candidate = join(binDir, commandName);
    await writeFile(candidate, "#!/usr/bin/env bash\nexit 0\n", "utf8");
    await chmod(candidate, 0o644);

    const env = {
      ...process.env,
      PATH: binDir
    };

    assert.equal(await commandExists(commandName, { env }), false);
    assert.equal(await resolveCommand(commandName, { env }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
