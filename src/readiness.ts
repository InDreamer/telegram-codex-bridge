import { TelegramApi } from "./telegram/api.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import type { Logger } from "./logger.js";
import type { BridgePaths } from "./paths.js";
import { commandExists, runCommand } from "./process.js";
import type { BridgeConfig } from "./config.js";
import type { BridgeStateStore } from "./state/store.js";
import type { ReadinessDetails, ReadinessSnapshot } from "./types.js";

export interface ReadinessProbeResult {
  snapshot: ReadinessSnapshot;
  appServer: CodexAppServerClient | null;
}

function buildSnapshot(
  state: ReadinessSnapshot["state"],
  details: ReadinessDetails,
  appServerPid?: number | null
): ReadinessSnapshot {
  return {
    state,
    checkedAt: new Date().toISOString(),
    details,
    appServerPid: appServerPid ? `${appServerPid}` : null
  };
}

export async function probeReadiness(options: {
  config: BridgeConfig;
  store: BridgeStateStore;
  paths: BridgePaths;
  logger: Logger;
  keepAppServer?: boolean;
  persist?: boolean;
}): Promise<ReadinessProbeResult> {
  const { config, store, paths, logger } = options;
  const details: ReadinessDetails = {
    codexInstalled: false,
    codexAuthenticated: false,
    appServerAvailable: false,
    telegramTokenValid: false,
    authorizedUserBound: store.getAuthorizedUser() !== null,
    issues: []
  };

  const codexAvailable = await commandExists(config.codexBin);
  if (!codexAvailable) {
    details.issues.push("codex binary not found in PATH");
    const snapshot = buildSnapshot("bridge_unhealthy", details);
    if (options.persist ?? true) {
      store.writeReadinessSnapshot(snapshot);
    }
    return { snapshot, appServer: null };
  }

  const versionResult = await runCommand(config.codexBin, ["--version"]);
  if (versionResult.exitCode !== 0) {
    details.issues.push(versionResult.stderr || "failed to read codex version");
    const snapshot = buildSnapshot("bridge_unhealthy", details);
    if (options.persist ?? true) {
      store.writeReadinessSnapshot(snapshot);
    }
    return { snapshot, appServer: null };
  }

  details.codexInstalled = true;
  details.codexVersion = versionResult.stdout;

  const loginStatus = await runCommand(config.codexBin, ["login", "status"]);
  const loginOutput = loginStatus.stdout || loginStatus.stderr;
  details.codexLoginStatus = loginOutput;
  details.codexAuthenticated = loginStatus.exitCode === 0 && loginOutput.includes("Logged in");

  if (!details.codexAuthenticated) {
    details.issues.push("codex login status is not ready");
    const snapshot = buildSnapshot("codex_not_authenticated", details);
    if (options.persist ?? true) {
      store.writeReadinessSnapshot(snapshot);
    }
    return { snapshot, appServer: null };
  }

  if (!config.telegramBotToken) {
    details.issues.push("missing TELEGRAM_BOT_TOKEN");
    const snapshot = buildSnapshot("telegram_token_invalid", details);
    if (options.persist ?? true) {
      store.writeReadinessSnapshot(snapshot);
    }
    return { snapshot, appServer: null };
  }

  try {
    const telegram = new TelegramApi(config.telegramBotToken, config.telegramApiBaseUrl);
    const bot = await telegram.getMe();
    details.telegramTokenValid = true;
    if (bot.username) {
      details.telegramBotUsername = bot.username;
    }
    details.telegramBotId = `${bot.id}`;
  } catch (error) {
    details.issues.push(`${error}`);
    const snapshot = buildSnapshot("telegram_token_invalid", details);
    if (options.persist ?? true) {
      store.writeReadinessSnapshot(snapshot);
    }
    return { snapshot, appServer: null };
  }

  let appServer: CodexAppServerClient | null = null;

  try {
    appServer = new CodexAppServerClient(config.codexBin, paths.appServerLogPath, logger);
    await appServer.initializeAndProbe();
    details.appServerAvailable = true;
    if (appServer.pid !== null) {
      details.appServerPid = appServer.pid;
    }
  } catch (error) {
    details.issues.push(`${error}`);

    if (appServer) {
      await appServer.stop().catch(() => {});
    }

    const snapshot = buildSnapshot("app_server_unavailable", details);
    if (options.persist ?? true) {
      store.writeReadinessSnapshot(snapshot);
    }
    return { snapshot, appServer: null };
  }

  const state = details.authorizedUserBound ? "ready" : "awaiting_authorization";
  const snapshot = buildSnapshot(state, details, appServer.pid);
  if (options.persist ?? true) {
    store.writeReadinessSnapshot(snapshot);
  }

  if (!(options.keepAppServer ?? false)) {
    await appServer.stop();
    return { snapshot, appServer: null };
  }

  return { snapshot, appServer };
}
