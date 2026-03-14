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
  telegramSessionFlowLogsDir: string;
  runtimeDir: string;
  cacheDir: string;
  dbPath: string;
  stateStoreFailurePath: string;
  envPath: string;
  servicePath: string;
  launchAgentPath: string;
  binPath: string;
  manifestPath: string;
  offsetPath: string;
  bridgeLogPath: string;
  bootstrapLogPath: string;
  appServerLogPath: string;
  telegramStatusCardLogPath: string;
  telegramPlanCardLogPath: string;
  telegramErrorCardLogPath: string;
}

export function getRepoRoot(importMetaUrl: string): string {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function getDebugRuntimeDir(runtimeDir: string): string {
  return join(runtimeDir, "debug");
}

export function getBridgePaths(importMetaUrl: string, homeDir = homedir()): BridgePaths {
  const installRoot = join(homeDir, ".local", "share", "codex-telegram-bridge");
  const stateRoot = join(homeDir, ".local", "state", "codex-telegram-bridge");
  const configRoot = join(homeDir, ".config", "codex-telegram-bridge");
  const logsDir = join(stateRoot, "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(stateRoot, "runtime");
  const cacheDir = join(stateRoot, "cache");

  return {
    homeDir,
    repoRoot: getRepoRoot(importMetaUrl),
    installRoot,
    stateRoot,
    configRoot,
    logsDir,
    telegramSessionFlowLogsDir,
    runtimeDir,
    cacheDir,
    dbPath: join(stateRoot, "bridge.db"),
    stateStoreFailurePath: join(stateRoot, "state-store-open-failure.json"),
    envPath: join(configRoot, "bridge.env"),
    servicePath: join(homeDir, ".config", "systemd", "user", "codex-telegram-bridge.service"),
    launchAgentPath: join(homeDir, "Library", "LaunchAgents", "com.codex.telegram-bridge.plist"),
    binPath: join(installRoot, "bin", "ctb"),
    manifestPath: join(installRoot, "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log"),
    telegramStatusCardLogPath: join(telegramSessionFlowLogsDir, "status-card.log"),
    telegramPlanCardLogPath: join(telegramSessionFlowLogsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(telegramSessionFlowLogsDir, "error-card.log")
  };
}

export async function ensureBridgeDirectories(paths: BridgePaths): Promise<void> {
  await Promise.all([
    mkdir(paths.installRoot, { recursive: true }),
    mkdir(paths.stateRoot, { recursive: true }),
    mkdir(paths.configRoot, { recursive: true }),
    mkdir(paths.logsDir, { recursive: true }),
    mkdir(paths.telegramSessionFlowLogsDir, { recursive: true }),
    mkdir(paths.cacheDir, { recursive: true }),
    mkdir(getDebugRuntimeDir(paths.runtimeDir), { recursive: true }),
    mkdir(dirname(paths.servicePath), { recursive: true }),
    mkdir(dirname(paths.launchAgentPath), { recursive: true }),
    mkdir(dirname(paths.binPath), { recursive: true })
  ]);
}
