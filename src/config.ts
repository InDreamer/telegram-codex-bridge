import { readFile, writeFile } from "node:fs/promises";
import { delimiter } from "node:path";

import type { BridgePaths } from "./paths.js";
import { parseBooleanLike } from "./util/boolean.js";
import { expandHomePath } from "./util/path.js";

export interface BridgeConfig {
  telegramBotToken: string;
  codexBin: string;
  telegramApiBaseUrl: string;
  telegramPollTimeoutSeconds: number;
  telegramPollIntervalMs: number;
  projectScanRoots: string[];
  voiceInputEnabled: boolean;
  voiceOpenaiApiKey: string;
  voiceOpenaiTranscribeModel: string;
  voiceFfmpegBin: string;
}

const DEFAULT_CONFIG = {
  codexBin: "codex",
  telegramApiBaseUrl: "https://api.telegram.org",
  telegramPollTimeoutSeconds: 20,
  telegramPollIntervalMs: 1500,
  projectScanRoots: [],
  voiceInputEnabled: false,
  voiceOpenaiTranscribeModel: "gpt-4o-mini-transcribe",
  voiceFfmpegBin: "ffmpeg"
} as const;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return parseBooleanLike(value) ?? fallback;
}

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

export function parseProjectScanRootsValue(value: string | undefined, homeDir: string): string[] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const roots: string[] = [];

  for (const entry of value.split(delimiter).map((part) => part.trim()).filter((part) => part.length > 0)) {
    const resolved = expandHomePath(entry, homeDir);
    if (seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    roots.push(resolved);
  }

  return roots;
}

export function serializeProjectScanRoots(roots: string[]): string {
  return roots.join(delimiter);
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
    ),
    projectScanRoots: parseProjectScanRootsValue(merged.PROJECT_SCAN_ROOTS, paths.homeDir),
    voiceInputEnabled: parseBooleanEnv(merged.VOICE_INPUT_ENABLED, DEFAULT_CONFIG.voiceInputEnabled),
    voiceOpenaiApiKey: merged.VOICE_OPENAI_API_KEY ?? "",
    voiceOpenaiTranscribeModel: merged.VOICE_OPENAI_TRANSCRIBE_MODEL ?? DEFAULT_CONFIG.voiceOpenaiTranscribeModel,
    voiceFfmpegBin: merged.VOICE_FFMPEG_BIN ?? DEFAULT_CONFIG.voiceFfmpegBin
  };
}

export async function writeConfig(paths: BridgePaths, config: BridgeConfig): Promise<void> {
  const content = [
    `TELEGRAM_BOT_TOKEN=${config.telegramBotToken}`,
    `CODEX_BIN=${config.codexBin}`,
    `TELEGRAM_API_BASE_URL=${config.telegramApiBaseUrl}`,
    `TELEGRAM_POLL_TIMEOUT_SECONDS=${config.telegramPollTimeoutSeconds}`,
    `TELEGRAM_POLL_INTERVAL_MS=${config.telegramPollIntervalMs}`,
    `PROJECT_SCAN_ROOTS=${serializeProjectScanRoots(config.projectScanRoots)}`,
    `VOICE_INPUT_ENABLED=${config.voiceInputEnabled ? "1" : "0"}`,
    `VOICE_OPENAI_API_KEY=${config.voiceOpenaiApiKey}`,
    `VOICE_OPENAI_TRANSCRIBE_MODEL=${config.voiceOpenaiTranscribeModel}`,
    `VOICE_FFMPEG_BIN=${config.voiceFfmpegBin}`
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
    telegramPollIntervalMs: overrides.telegramPollIntervalMs ?? current.telegramPollIntervalMs,
    projectScanRoots: overrides.projectScanRoots ?? current.projectScanRoots,
    voiceInputEnabled: overrides.voiceInputEnabled ?? current.voiceInputEnabled,
    voiceOpenaiApiKey: overrides.voiceOpenaiApiKey ?? current.voiceOpenaiApiKey,
    voiceOpenaiTranscribeModel: overrides.voiceOpenaiTranscribeModel ?? current.voiceOpenaiTranscribeModel,
    voiceFfmpegBin: overrides.voiceFfmpegBin ?? current.voiceFfmpegBin
  };
}
