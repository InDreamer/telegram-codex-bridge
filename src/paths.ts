import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface BridgePaths {
  homeDir: string;
  repoRoot: string;
  installRoot: string;
  stateRoot: string;
  configRoot: string;
  logsDir: string;
  runtimeDir: string;
  cacheDir: string;
  dbPath: string;
  envPath: string;
  servicePath: string;
  binPath: string;
  manifestPath: string;
  offsetPath: string;
  bridgeLogPath: string;
  bootstrapLogPath: string;
  appServerLogPath: string;
}

export function getRepoRoot(importMetaUrl: string): string {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function getBridgePaths(importMetaUrl: string, homeDir = homedir()): BridgePaths {
  const installRoot = join(homeDir, ".local", "share", "codex-telegram-bridge");
  const stateRoot = join(homeDir, ".local", "state", "codex-telegram-bridge");
  const configRoot = join(homeDir, ".config", "codex-telegram-bridge");
  const logsDir = join(stateRoot, "logs");
  const runtimeDir = join(stateRoot, "runtime");
  const cacheDir = join(stateRoot, "cache");

  return {
    homeDir,
    repoRoot: getRepoRoot(importMetaUrl),
    installRoot,
    stateRoot,
    configRoot,
    logsDir,
    runtimeDir,
    cacheDir,
    dbPath: join(stateRoot, "bridge.db"),
    envPath: join(configRoot, "bridge.env"),
    servicePath: join(homeDir, ".config", "systemd", "user", "codex-telegram-bridge.service"),
    binPath: join(installRoot, "bin", "ctb"),
    manifestPath: join(installRoot, "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log")
  };
}

export async function ensureBridgeDirectories(paths: BridgePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.runtimeDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(dirname(paths.servicePath), { recursive: true }),
    mkdir(dirname(paths.binPath), { recursive: true })
  ]);
}

