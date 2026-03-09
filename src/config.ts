import { readFile, writeFile } from "node:fs/promises";

import type { BridgePaths } from "./paths.js";

export interface BridgeConfig {
  telegramBotToken: string;
  codexBin: string;
  telegramApiBaseUrl: string;
  telegramPollTimeoutSeconds: number;
  telegramPollIntervalMs: number;
}

const DEFAULT_CONFIG = {
  codexBin: "codex",
  telegramApiBaseUrl: "https://api.telegram.org",
  telegramPollTimeoutSeconds: 20,
  telegramPollIntervalMs: 1500
} as const;

function parseEnvFile(content: string): Record<string, string> {
  const entries = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator === -1) {
        return null;
      }

      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return Object.fromEntries(entries);
}

export async function loadConfig(paths: BridgePaths): Promise<BridgeConfig> {
  let envFile: Record<string, string> = {};

  try {
    envFile = parseEnvFile(await readFile(paths.envPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const merged = {
    ...envFile,
    ...process.env
  };

  return {
    telegramBotToken: merged.TELEGRAM_BOT_TOKEN ?? "",
    codexBin: merged.CODEX_BIN ?? DEFAULT_CONFIG.codexBin,
    telegramApiBaseUrl: merged.TELEGRAM_API_BASE_URL ?? DEFAULT_CONFIG.telegramApiBaseUrl,
    telegramPollTimeoutSeconds: Number.parseInt(
      merged.TELEGRAM_POLL_TIMEOUT_SECONDS ?? `${DEFAULT_CONFIG.telegramPollTimeoutSeconds}`,
      10
    ),
    telegramPollIntervalMs: Number.parseInt(
      merged.TELEGRAM_POLL_INTERVAL_MS ?? `${DEFAULT_CONFIG.telegramPollIntervalMs}`,
      10
    )
  };
}

export async function writeConfig(paths: BridgePaths, config: BridgeConfig): Promise<void> {
  const content = [
    `TELEGRAM_BOT_TOKEN=${config.telegramBotToken}`,
    `CODEX_BIN=${config.codexBin}`,
    `TELEGRAM_API_BASE_URL=${config.telegramApiBaseUrl}`,
    `TELEGRAM_POLL_TIMEOUT_SECONDS=${config.telegramPollTimeoutSeconds}`,
    `TELEGRAM_POLL_INTERVAL_MS=${config.telegramPollIntervalMs}`
  ].join("\n");

  await writeFile(paths.envPath, `${content}\n`, "utf8");
}

export function withInstallOverrides(
  current: BridgeConfig,
  overrides: Partial<BridgeConfig>
): BridgeConfig {
  return {
    telegramBotToken: overrides.telegramBotToken ?? current.telegramBotToken,
    codexBin: overrides.codexBin ?? current.codexBin,
    telegramApiBaseUrl: overrides.telegramApiBaseUrl ?? current.telegramApiBaseUrl,
    telegramPollTimeoutSeconds: overrides.telegramPollTimeoutSeconds ?? current.telegramPollTimeoutSeconds,
    telegramPollIntervalMs: overrides.telegramPollIntervalMs ?? current.telegramPollIntervalMs
  };
}
