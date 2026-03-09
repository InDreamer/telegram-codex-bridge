import { cp, chmod, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig, withInstallOverrides, writeConfig, type BridgeConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { ensureBridgeDirectories, type BridgePaths } from "./paths.js";
import { commandExists, runCommand } from "./process.js";
import { probeReadiness } from "./readiness.js";
import { BridgeStateStore } from "./state/store.js";
import { TelegramApi } from "./telegram/api.js";
import { syncTelegramCommands } from "./telegram/commands.js";
import type { InstallManifest, PendingAuthorizationRow, ReadinessSnapshot } from "./types.js";

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

function formatSnapshot(snapshot: ReadinessSnapshot | null): string {
  if (!snapshot) {
    return "readiness=unknown";
  }

  const issueText =
    snapshot.details.issues.length === 0 ? "issues=none" : `issues=${snapshot.details.issues.join("; ")}`;
  return [
    `readiness=${snapshot.state}`,
    `checked_at=${snapshot.checkedAt}`,
    `codex_installed=${snapshot.details.codexInstalled}`,
    `codex_authenticated=${snapshot.details.codexAuthenticated}`,
    `telegram_token_valid=${snapshot.details.telegramTokenValid}`,
    `app_server_available=${snapshot.details.appServerAvailable}`,
    `authorized_user_bound=${snapshot.details.authorizedUserBound}`,
    issueText
  ].join("\n");
}

async function readPackageVersion(paths: BridgePaths): Promise<string> {
  const packageJson = JSON.parse(await readFile(join(paths.repoRoot, "package.json"), "utf8")) as {
    version: string;
  };

  return packageJson.version;
}

async function writeInstallManifest(paths: BridgePaths): Promise<void> {
  const manifest: InstallManifest = {
    version: await readPackageVersion(paths),
    sourceRoot: paths.repoRoot.startsWith(paths.installRoot) ? null : paths.repoRoot,
    installedAt: new Date().toISOString()
  };

  await writeFile(paths.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readInstallManifest(paths: BridgePaths): Promise<InstallManifest | null> {
  try {
    const content = await readFile(paths.manifestPath, "utf8");
    return JSON.parse(content) as InstallManifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function writeWrapperScript(paths: BridgePaths): Promise<void> {
  const content = `#!/usr/bin/env bash
set -euo pipefail
exec ${JSON.stringify(process.execPath)} --disable-warning=ExperimentalWarning ${JSON.stringify(join(paths.installRoot, "dist", "cli.js"))} "$@"
`;

  await writeFile(paths.binPath, content, "utf8");
  await chmod(paths.binPath, 0o755);
}

async function writeSystemdUnit(paths: BridgePaths): Promise<void> {
  const content = `[Unit]
Description=Codex Telegram Bridge
After=default.target

[Service]
Type=simple
WorkingDirectory=${paths.installRoot}
EnvironmentFile=${paths.envPath}
ExecStart=${process.execPath} --disable-warning=ExperimentalWarning ${join(paths.installRoot, "dist", "cli.js")} service run
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;

  await writeFile(paths.servicePath, content, "utf8");
}

async function systemctlAvailable(): Promise<boolean> {
  return await commandExists("systemctl");
}

function countPendingRuntimeNotices(store: BridgeStateStore): number {
  return store.countRuntimeNotices();
}

async function callSystemctl(args: string[]): Promise<void> {
  const result = await runCommand("systemctl", ["--user", ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `systemctl failed: ${args.join(" ")}`);
  }
}

async function copyRelease(paths: BridgePaths): Promise<void> {
  await rm(join(paths.installRoot, "dist"), { recursive: true, force: true });
  await cp(join(paths.repoRoot, "dist"), join(paths.installRoot, "dist"), { recursive: true });
  await cp(join(paths.repoRoot, "package.json"), join(paths.installRoot, "package.json"));
}

export async function installBridge(
  paths: BridgePaths,
  logger: Logger,
  overrides: {
    telegramBotToken?: string;
    codexBin?: string;
  }
): Promise<void> {
  await ensureBridgeDirectories(paths);
  const overrideConfig: Partial<BridgeConfig> = {};
  if (overrides.telegramBotToken) {
    overrideConfig.telegramBotToken = overrides.telegramBotToken;
  }

  if (overrides.codexBin) {
    overrideConfig.codexBin = overrides.codexBin;
  }

  const config = withInstallOverrides(await loadConfig(paths), overrideConfig);

  if (!config.telegramBotToken) {
    throw new Error("missing Telegram bot token; pass --telegram-token or set TELEGRAM_BOT_TOKEN");
  }

  await copyRelease(paths);
  await writeConfig(paths, config);
  await writeInstallManifest(paths);
  await writeWrapperScript(paths);
  await writeSystemdUnit(paths);

  const store = await BridgeStateStore.open(paths, logger);
  try {
    const { snapshot } = await probeReadiness({
      config,
      store,
      paths,
      logger,
      persist: true
    });

    if (snapshot.state !== "ready" && snapshot.state !== "awaiting_authorization") {
      throw new Error(formatSnapshot(snapshot));
    }

    const telegramApi = new TelegramApi(config.telegramBotToken, config.telegramApiBaseUrl);
    await syncTelegramCommands(telegramApi);
  } finally {
    store.close();
  }

  if (await systemctlAvailable()) {
    await callSystemctl(["daemon-reload"]);
    await callSystemctl(["enable", "--now", "codex-telegram-bridge.service"]);
  } else {
    await logger.warn("systemctl is unavailable; service unit was written but not enabled");
  }
}

export async function getStatus(paths: BridgePaths): Promise<string> {
  const manifest = await readInstallManifest(paths);
  const configExists = await pathExists(paths.envPath);
  const serviceExists = await pathExists(paths.servicePath);
  const installExists =
    manifest !== null &&
    (await pathExists(join(paths.installRoot, "dist", "cli.js"))) &&
    (await pathExists(paths.binPath));
  const stateExists = await pathExists(paths.stateRoot);

  let systemdState = "unavailable";
  if (await systemctlAvailable()) {
    const result = await runCommand("systemctl", [
      "--user",
      "is-active",
      "codex-telegram-bridge.service"
    ]);
    systemdState = result.exitCode === 0 ? result.stdout : result.stdout || result.stderr || "inactive";
  }

  let snapshot: ReadinessSnapshot | null = null;
  let activeSessionSummary = "none";
  let pendingNotices = 0;
  if (await pathExists(paths.dbPath)) {
    const store = await BridgeStateStore.open(paths, {
      info: async () => {},
      warn: async () => {},
      error: async () => {}
    });
    snapshot = store.getReadinessSnapshot();
    pendingNotices = countPendingRuntimeNotices(store);
    const binding = store.listChatBindings()[0];
    const activeSession = binding?.activeSessionId ? store.getSessionById(binding.activeSessionId) : null;
    if (activeSession) {
      activeSessionSummary = `${activeSession.projectName}/${activeSession.displayName}/${activeSession.status}`;
    }
    store.close();
  }

  return [
    `installed=${installExists}`,
    `install_root=${paths.installRoot}`,
    `state_root=${paths.stateRoot}`,
    `config_present=${configExists}`,
    `service_file_present=${serviceExists}`,
    `systemd_state=${systemdState}`,
    `version=${manifest?.version ?? "unknown"}`,
    `installed_at=${manifest?.installedAt ?? "unknown"}`,
    `state_dir_present=${stateExists}`,
    `active_session=${activeSessionSummary}`,
    `pending_runtime_notices=${pendingNotices}`,
    formatSnapshot(snapshot)
  ].join("\n");
}

export async function runDoctor(paths: BridgePaths, logger: Logger): Promise<string> {
  await ensureBridgeDirectories(paths);
  const store = await BridgeStateStore.open(paths, logger);
  try {
    const config = await loadConfig(paths);
    const { snapshot } = await probeReadiness({
      config,
      store,
      paths,
      logger,
      persist: true
    });
    const pendingNoticeCount = countPendingRuntimeNotices(store);
    if (snapshot.details.telegramTokenValid) {
      const telegramApi = new TelegramApi(config.telegramBotToken, config.telegramApiBaseUrl);
      await syncTelegramCommands(telegramApi);
    }
    return [formatSnapshot(snapshot), `pending_runtime_notices=${pendingNoticeCount}`].join("\n");
  } finally {
    store.close();
  }
}

export async function startService(): Promise<void> {
  await callSystemctl(["start", "codex-telegram-bridge.service"]);
}

export async function stopService(): Promise<void> {
  await callSystemctl(["stop", "codex-telegram-bridge.service"]);
}

export async function restartService(): Promise<void> {
  await callSystemctl(["restart", "codex-telegram-bridge.service"]);
}

export async function updateBridge(paths: BridgePaths): Promise<void> {
  const manifest = await readInstallManifest(paths);
  if (!manifest?.sourceRoot) {
    throw new Error("update requires a retained source checkout; reinstall from source instead");
  }

  const config = await loadConfig(paths);
  const env = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: config.telegramBotToken,
    CODEX_BIN: config.codexBin,
    TELEGRAM_API_BASE_URL: config.telegramApiBaseUrl
  };

  const installResult = await runCommand("npm", ["install"], {
    cwd: manifest.sourceRoot,
    env
  });
  if (installResult.exitCode !== 0) {
    throw new Error(installResult.stderr || installResult.stdout || "npm install failed");
  }

  const buildResult = await runCommand("npm", ["run", "build"], {
    cwd: manifest.sourceRoot,
    env
  });
  if (buildResult.exitCode !== 0) {
    throw new Error(buildResult.stderr || buildResult.stdout || "npm run build failed");
  }

  const reinstallResult = await runCommand(process.execPath, ["dist/cli.js", "install"], {
    cwd: manifest.sourceRoot,
    env
  });
  if (reinstallResult.exitCode !== 0) {
    throw new Error(reinstallResult.stderr || reinstallResult.stdout || "reinstall failed");
  }
}

export async function uninstallBridge(paths: BridgePaths, purgeState: boolean): Promise<void> {
  if (await systemctlAvailable()) {
    await runCommand("systemctl", ["--user", "disable", "--now", "codex-telegram-bridge.service"]);
    await runCommand("systemctl", ["--user", "daemon-reload"]);
  }

  await unlink(paths.servicePath).catch(() => {});
  await rm(paths.installRoot, { recursive: true, force: true });
  await rm(paths.configRoot, { recursive: true, force: true });

  if (purgeState) {
    await rm(paths.stateRoot, { recursive: true, force: true });
  }
}

function formatCandidate(candidate: PendingAuthorizationRow, index: number): string {
  return [
    `[${index}] user_id=${candidate.telegramUserId}`,
    `chat_id=${candidate.telegramChatId}`,
    `username=${candidate.telegramUsername ?? "-"}`,
    `display_name=${candidate.displayName ?? "-"}`,
    `first_seen=${candidate.firstSeenAt}`,
    `last_seen=${candidate.lastSeenAt}`,
    `expired=${candidate.expired}`
  ].join(" ");
}

export async function listPendingAuthorizations(
  paths: BridgePaths,
  logger: Logger,
  options?: {
    includeExpired?: boolean;
    latest?: boolean;
    select?: number;
    userId?: string;
  }
): Promise<string> {
  await ensureBridgeDirectories(paths);
  const store = await BridgeStateStore.open(paths, logger);

  try {
    const listOptions: { includeExpired?: boolean } = {};
    if (options?.includeExpired) {
      listOptions.includeExpired = true;
    }

    const candidates = store.listPendingAuthorizations(listOptions);

    if (options?.latest || options?.select !== undefined || options?.userId) {
      let target: PendingAuthorizationRow | undefined;

      if (options.userId) {
        target = candidates.find((candidate) => candidate.telegramUserId === options.userId);
      } else if (options.latest) {
        [target] = candidates;
      } else if (options.select !== undefined) {
        target = candidates[options.select];
      }

      if (!target) {
        throw new Error("no matching pending authorization candidate");
      }

      store.confirmPendingAuthorization(target);
      return `authorized user ${target.telegramUserId} bound to chat ${target.telegramChatId}`;
    }

    if (candidates.length === 0) {
      return "no pending authorization candidates";
    }

    return candidates.map((candidate, index) => formatCandidate(candidate, index)).join("\n");
  } finally {
    store.close();
  }
}

export async function clearAuthorization(paths: BridgePaths, logger: Logger): Promise<string> {
  await ensureBridgeDirectories(paths);
  const store = await BridgeStateStore.open(paths, logger);
  try {
    store.clearAuthorization();
    return "authorization cleared; bridge returned to awaiting_authorization";
  } finally {
    store.close();
  }
}
