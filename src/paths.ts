import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getHostPlatform,
  getWindowsLocalAppData,
  getWindowsRoamingAppData,
  LAUNCHD_SERVICE_LABEL,
  type HostPlatform,
  WINDOWS_TASK_NAME
} from "./platform.js";

export interface BridgePaths {
  platform?: HostPlatform;
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
  taskSchedulerName?: string;
  binPath: string;
  powershellBinPath?: string;
  powershellWrapperPath?: string;
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

export function getBridgePaths(
  importMetaUrl: string,
  homeDir = homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): BridgePaths {
  const hostPlatform = getHostPlatform(platform);
  const installRoot = hostPlatform === "win32"
    ? join(getWindowsLocalAppData(homeDir, env), "codex-telegram-bridge")
    : join(homeDir, ".local", "share", "codex-telegram-bridge");
  const stateRoot = hostPlatform === "win32"
    ? installRoot
    : join(homeDir, ".local", "state", "codex-telegram-bridge");
  const configRoot = hostPlatform === "win32"
    ? join(getWindowsRoamingAppData(homeDir, env), "codex-telegram-bridge")
    : join(homeDir, ".config", "codex-telegram-bridge");
  const logsDir = join(stateRoot, "logs");
  const telegramSessionFlowLogsDir = join(logsDir, "telegram-session-flow");
  const runtimeDir = join(stateRoot, "runtime");
  const cacheDir = join(stateRoot, "cache");
  const binBaseName = hostPlatform === "win32" ? "ctb.cmd" : "ctb";
  const paths: BridgePaths = {
    platform: hostPlatform,
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
    servicePath: hostPlatform === "win32"
      ? join(configRoot, "tasks", `${WINDOWS_TASK_NAME}.ps1`)
      : join(homeDir, ".config", "systemd", "user", "codex-telegram-bridge.service"),
    launchAgentPath: join(homeDir, "Library", "LaunchAgents", `${LAUNCHD_SERVICE_LABEL}.plist`),
    binPath: join(installRoot, "bin", binBaseName),
    manifestPath: join(installRoot, "install-manifest.json"),
    offsetPath: join(runtimeDir, "telegram-offset.json"),
    bridgeLogPath: join(logsDir, "bridge.log"),
    bootstrapLogPath: join(logsDir, "bootstrap.log"),
    appServerLogPath: join(logsDir, "app-server.log"),
    telegramStatusCardLogPath: join(telegramSessionFlowLogsDir, "status-card.log"),
    telegramPlanCardLogPath: join(telegramSessionFlowLogsDir, "plan-card.log"),
    telegramErrorCardLogPath: join(telegramSessionFlowLogsDir, "error-card.log")
  };

  if (hostPlatform === "win32") {
    paths.taskSchedulerName = WINDOWS_TASK_NAME;
    paths.powershellBinPath = join(installRoot, "bin", "ctb.ps1");
    paths.powershellWrapperPath = paths.powershellBinPath;
  }

  return paths;
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
    mkdir(dirname(paths.binPath), { recursive: true }),
    ...(paths.powershellWrapperPath ? [mkdir(dirname(paths.powershellWrapperPath), { recursive: true })] : [])
  ]);
}
