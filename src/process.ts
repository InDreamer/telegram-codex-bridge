import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import * as path from "node:path";

import { getHostPlatform, type HostPlatform } from "./platform.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ResolvedCommand {
  requestedCommand: string;
  resolvedPath: string;
  invocation: "direct" | "cmd" | "powershell";
  launchCommand: string;
  launchArgsPrefix: string[];
}

interface ResolveCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

interface SpawnPlan {
  command: string;
  args: string[];
  resolved: ResolvedCommand;
}

function hasPathSeparators(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function currentWorkingDirectory(options: ResolveCommandOptions): string {
  return typeof options.cwd === "string" ? options.cwd : process.cwd();
}

function isAbsoluteCommand(command: string, hostPlatform: HostPlatform): boolean {
  return hostPlatform === "win32" ? path.win32.isAbsolute(command) : path.isAbsolute(command);
}

function defaultWindowsExecutableExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return raw
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function currentPathModule(platform: HostPlatform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function normalizeComparablePath(value: string, hostPlatform: HostPlatform): string {
  return hostPlatform === "win32" ? value.toLowerCase() : value;
}

function dedupePaths(values: string[], hostPlatform: HostPlatform): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (value.length === 0) {
      continue;
    }

    const comparable = normalizeComparablePath(value, hostPlatform);
    if (seen.has(comparable)) {
      continue;
    }

    seen.add(comparable);
    deduped.push(value);
  }

  return deduped;
}

function pathEntries(env: NodeJS.ProcessEnv, hostPlatform: HostPlatform): string[] {
  return (env.PATH ?? "")
    .split(hostPlatform === "win32" ? ";" : ":")
    .filter((value) => value.length > 0);
}

function windowsSearchDirectories(options: ResolveCommandOptions, env: NodeJS.ProcessEnv): string[] {
  const systemRoot = env.SystemRoot ?? env.WINDIR;
  const directories = [currentWorkingDirectory(options)];

  if (systemRoot) {
    directories.push(
      path.join(systemRoot, "System32"),
      path.join(systemRoot, "System"),
      systemRoot,
      path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")
    );
  }

  for (const key of ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"] as const) {
    const basePath = env[key];
    if (basePath) {
      directories.push(path.join(basePath, "PowerShell", "7"));
    }
  }

  return dedupePaths([...directories, ...pathEntries(env, "win32")], "win32");
}

function resolveBaseCandidate(
  command: string,
  options: ResolveCommandOptions,
  hostPlatform: HostPlatform
): string[] {
  const env = options.env ?? process.env;
  const cwd = currentWorkingDirectory(options);

  if (hasPathSeparators(command) || isAbsoluteCommand(command, hostPlatform)) {
    return [isAbsoluteCommand(command, hostPlatform) ? command : path.resolve(cwd, command)];
  }

  const directories = hostPlatform === "win32"
    ? windowsSearchDirectories(options, env)
    : pathEntries(env, hostPlatform);

  return directories.map((entry) => path.join(entry, command));
}

function expandExecutableCandidates(
  baseCandidates: string[],
  requestedCommand: string,
  hostPlatform: HostPlatform,
  env: NodeJS.ProcessEnv
): string[] {
  if (hostPlatform !== "win32") {
    return baseCandidates;
  }

  const requestedExtension = currentPathModule(hostPlatform).extname(requestedCommand).toLowerCase();
  const pathext = defaultWindowsExecutableExtensions(env);

  return dedupePaths(baseCandidates.flatMap((candidate) => {
    if (requestedExtension) {
      return [candidate];
    }

    return [candidate, ...pathext.map((extension) => `${candidate}${extension}`)];
  }), hostPlatform);
}

async function isRunnableFile(candidate: string, hostPlatform: HostPlatform): Promise<boolean> {
  try {
    const candidateStats = await stat(candidate);
    if (!candidateStats.isFile()) {
      return false;
    }

    if (hostPlatform === "win32") {
      return true;
    }

    await access(candidate, constants.X_OK);
    return true;
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      return false;
    }

    throw error;
  }
}

function classifyResolvedCommand(candidate: string, requestedCommand: string): ResolvedCommand {
  const extension = path.extname(candidate).toLowerCase();

  if (extension === ".cmd" || extension === ".bat") {
    return {
      requestedCommand,
      resolvedPath: candidate,
      invocation: "cmd",
      launchCommand: "cmd.exe",
      launchArgsPrefix: ["/d", "/s", "/c"]
    };
  }

  if (extension === ".ps1") {
    return {
      requestedCommand,
      resolvedPath: candidate,
      invocation: "powershell",
      launchCommand: "powershell.exe",
      launchArgsPrefix: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]
    };
  }

  return {
    requestedCommand,
    resolvedPath: candidate,
    invocation: "direct",
    launchCommand: candidate,
    launchArgsPrefix: []
  };
}

export async function resolveCommand(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<ResolvedCommand | null> {
  const hostPlatform = getHostPlatform(options.platform);
  const env = options.env ?? process.env;
  const baseCandidates = resolveBaseCandidate(command, options, hostPlatform);
  const candidates = expandExecutableCandidates(baseCandidates, command, hostPlatform, env);

  for (const candidate of candidates) {
    if (await isRunnableFile(candidate, hostPlatform)) {
      return classifyResolvedCommand(candidate, command);
    }
  }

  return null;
}

export async function commandExists(
  command: string,
  options: ResolveCommandOptions = {}
): Promise<boolean> {
  return (await resolveCommand(command, options)) !== null;
}

export async function buildSpawnPlan(
  command: string,
  args: string[],
  options: ResolveCommandOptions = {}
): Promise<SpawnPlan> {
  const resolved = await resolveCommand(command, options);
  if (!resolved) {
    throw new Error(`command not found: ${command}`);
  }

  if (resolved.invocation === "direct") {
    return {
      command: resolved.launchCommand,
      args,
      resolved
    };
  }

  const launchCommand = await resolveCommand(resolved.launchCommand, options);
  if (!launchCommand) {
    throw new Error(`command not found: ${resolved.launchCommand}`);
  }

  return {
    command: launchCommand.resolvedPath,
    args: [...resolved.launchArgsPrefix, resolved.resolvedPath, ...args],
    resolved: {
      ...resolved,
      launchCommand: launchCommand.resolvedPath
    }
  };
}

export async function runCommand(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {}
): Promise<CommandResult> {
  const resolveOptions: ResolveCommandOptions = {};
  if (typeof options.cwd === "string") {
    resolveOptions.cwd = options.cwd;
  }
  if (options.env) {
    resolveOptions.env = options.env;
  }

  const spawnPlan = await buildSpawnPlan(command, args, resolveOptions);

  return await new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}
