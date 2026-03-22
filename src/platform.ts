import { join } from "node:path";

export type HostPlatform = "linux" | "darwin" | "win32";
export type ServiceManager = "systemd" | "launchd" | "task_scheduler" | "none";

export const SYSTEMD_SERVICE_NAME = "codex-telegram-bridge.service";
export const LAUNCHD_SERVICE_LABEL = "com.codex.telegram-bridge";
export const WINDOWS_TASK_NAME = "CodexTelegramBridge";

export function getHostPlatform(platform: NodeJS.Platform = process.platform): HostPlatform {
  if (platform === "darwin" || platform === "win32") {
    return platform;
  }

  return "linux";
}

export function getWindowsLocalAppData(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local");
}

export function getWindowsRoamingAppData(homeDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.APPDATA ?? join(homeDir, "AppData", "Roaming");
}
