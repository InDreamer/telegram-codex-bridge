import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { TelegramApi } from "./telegram/api.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import type { Logger } from "./logger.js";
import type { BridgePaths } from "./paths.js";
import { commandExists, runCommand, type CommandResult } from "./process.js";
import type { BridgeConfig } from "./config.js";
import type { BridgeStateStore } from "./state/store.js";
import type { ReadinessDetails, ReadinessSnapshot } from "./types.js";

const NODE_ENGINE_FALLBACK = ">=25.0.0";
const MIN_CODEX_VERSION = [0, 114, 0] as const;
const REQUIRED_CLIENT_REQUESTS = [
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/archive",
  "thread/unarchive",
  "turn/start",
  "turn/interrupt"
] as const;
const REQUIRED_SERVER_NOTIFICATIONS = [
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "item/started",
  "item/completed",
  "item/mcpToolCall/progress",
  "item/webSearch/progress",
  "turn/plan/updated",
  "thread/archived",
  "thread/unarchived",
  "error"
] as const;

type ServiceManagerName = "systemd" | "launchd" | "none";
type ServiceManagerHealth = "ok" | "warning" | "error";
type CapabilityCheckSource = "cache" | "generated_schema" | "unknown";

interface ServiceManagerStatus {
  manager: ServiceManagerName;
  health: ServiceManagerHealth;
  issues: string[];
}

interface CapabilityCheckSummary {
  ok: boolean;
  source: CapabilityCheckSource;
  issues: string[];
}

interface TelegramValidationResult {
  ok: boolean;
  botId?: string;
  username?: string;
  issue?: string;
}

interface AppServerLifecycle {
  pid?: number | null;
  initializeAndProbe(): Promise<void>;
  stop(): Promise<void>;
}

interface ReadinessDependencies {
  nodeVersion?: string;
  commandExists?: typeof commandExists;
  runCommand?: typeof runCommand;
  detectServiceManager?: (deps: {
    commandExists: typeof commandExists;
  }) => Promise<ServiceManagerStatus>;
  validateTelegramToken?: (token: string, baseUrl: string) => Promise<TelegramValidationResult>;
  createAppServer?: (options: {
    codexBin: string;
    appServerLogPath: string;
    logger: Logger;
  }) => AppServerLifecycle;
  evaluateCapabilities?: (options: {
    codexBin: string;
    codexVersionText: string;
    paths: BridgePaths;
    runCommand: typeof runCommand;
  }) => Promise<CapabilityCheckSummary>;
}

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
    appServerPid: appServerPid === null || appServerPid === undefined ? null : `${appServerPid}`
  };
}

function normalizeIssue(message: string): string {
  return message.trim().replace(/\s+/gu, " ");
}

function finalizeFailure(
  state: ReadinessSnapshot["state"],
  details: ReadinessDetails,
  store: BridgeStateStore,
  persist: boolean
): ReadinessProbeResult {
  const snapshot = buildSnapshot(state, details);
  if (persist) {
    store.writeReadinessSnapshot(snapshot);
  }
  return { snapshot, appServer: null };
}

function parseVersionParts(text: string): number[] | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    return null;
  }

  return match.slice(1, 4).map((value) => Number.parseInt(value, 10));
}

function isVersionAtLeast(versionText: string, minimum: readonly number[]): boolean {
  const actual = parseVersionParts(versionText);
  if (!actual) {
    return false;
  }

  for (let index = 0; index < minimum.length; index += 1) {
    const left = actual[index] ?? 0;
    const right = minimum[index] ?? 0;
    if (left > right) {
      return true;
    }
    if (left < right) {
      return false;
    }
  }

  return true;
}

async function readDeclaredNodeEngine(paths: BridgePaths): Promise<string> {
  try {
    const packageJson = JSON.parse(await readFile(join(paths.repoRoot, "package.json"), "utf8")) as {
      engines?: {
        node?: string;
      };
    };
    return packageJson.engines?.node ?? NODE_ENGINE_FALLBACK;
  } catch {
    return NODE_ENGINE_FALLBACK;
  }
}

function normalizeVersionLabel(versionText: string): string {
  const parts = parseVersionParts(versionText);
  return parts ? parts.join(".") : versionText.replace(/[^\w.-]+/gu, "_");
}

async function isDirectoryWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultDetectServiceManager(deps: {
  commandExists: typeof commandExists;
}): Promise<ServiceManagerStatus> {
  if (process.platform === "darwin" && await deps.commandExists("launchctl")) {
    return {
      manager: "launchd",
      health: "ok",
      issues: []
    };
  }

  if (await deps.commandExists("systemctl")) {
    return {
      manager: "systemd",
      health: "ok",
      issues: []
    };
  }

  return {
    manager: "none",
    health: "warning",
    issues: ["no supported service manager found"]
  };
}

async function defaultValidateTelegramToken(token: string, baseUrl: string): Promise<TelegramValidationResult> {
  try {
    const telegram = new TelegramApi(token, baseUrl);
    const bot = await telegram.getMe();
    const result: TelegramValidationResult = {
      ok: true,
      botId: `${bot.id}`
    };
    if (bot.username) {
      result.username = bot.username;
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      issue: `${error}`
    };
  }
}

function defaultCreateAppServer(options: {
  codexBin: string;
  appServerLogPath: string;
  logger: Logger;
}): AppServerLifecycle {
  return new CodexAppServerClient(options.codexBin, options.appServerLogPath, options.logger);
}

function extractMethodsFromSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }

  const oneOf = (schema as { oneOf?: unknown[] }).oneOf;
  if (!Array.isArray(oneOf)) {
    return [];
  }

  return oneOf.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const methodEnum = (entry as {
      properties?: {
        method?: {
          enum?: string[];
        };
      };
    }).properties?.method?.enum;
    return Array.isArray(methodEnum) ? methodEnum : [];
  });
}

async function loadCapabilityCache(cacheFilePath: string): Promise<CapabilityCheckSummary | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheFilePath, "utf8")) as CapabilityCheckSummary;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.ok === "boolean" &&
      Array.isArray(parsed.issues) &&
      (parsed.source === "cache" || parsed.source === "generated_schema" || parsed.source === "unknown")
    ) {
      return {
        ok: parsed.ok,
        issues: parsed.issues.map((issue) => normalizeIssue(`${issue}`)),
        source: "cache"
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCapabilityCache(cacheFilePath: string, summary: CapabilityCheckSummary): Promise<void> {
  await mkdir(dirname(cacheFilePath), { recursive: true }).catch(() => {});
  await writeFile(cacheFilePath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function defaultEvaluateCapabilities(options: {
  codexBin: string;
  codexVersionText: string;
  paths: BridgePaths;
  runCommand: typeof runCommand;
}): Promise<CapabilityCheckSummary> {
  const cacheFilePath = join(
    options.paths.cacheDir,
    `codex-capabilities-${normalizeVersionLabel(options.codexVersionText)}.json`
  );
  const cached = await loadCapabilityCache(cacheFilePath);
  if (cached) {
    return cached;
  }

  const schemaDir = await mkdtemp(join(tmpdir(), "ctb-codex-schema-"));

  try {
    const generation = await options.runCommand(options.codexBin, [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      schemaDir
    ]);
    if (generation.exitCode !== 0) {
      const summary = {
        ok: false,
        source: "generated_schema",
        issues: [generation.stderr || generation.stdout || "failed to generate app-server schema"]
      } satisfies CapabilityCheckSummary;
      await mkdir(options.paths.cacheDir, { recursive: true });
      await writeCapabilityCache(cacheFilePath, summary);
      return summary;
    }

    const clientRequestSchema = JSON.parse(await readFile(join(schemaDir, "ClientRequest.json"), "utf8"));
    const serverNotificationSchema = JSON.parse(await readFile(join(schemaDir, "ServerNotification.json"), "utf8"));
    const clientRequests = new Set(extractMethodsFromSchema(clientRequestSchema));
    const notifications = new Set(extractMethodsFromSchema(serverNotificationSchema));

    const issues = [
      ...REQUIRED_CLIENT_REQUESTS
        .filter((method) => !clientRequests.has(method))
        .map((method) => `missing request: ${method}`),
      ...REQUIRED_SERVER_NOTIFICATIONS
        .filter((method) => !notifications.has(method))
        .map((method) => `missing notification: ${method}`)
    ];
    const summary = {
      ok: issues.length === 0,
      source: "generated_schema",
      issues
    } satisfies CapabilityCheckSummary;
    await mkdir(options.paths.cacheDir, { recursive: true });
    await writeCapabilityCache(cacheFilePath, summary);
    return summary;
  } catch (error) {
    const summary = {
      ok: false,
      source: "unknown",
      issues: [`capability check failed: ${error}`]
    } satisfies CapabilityCheckSummary;
    await mkdir(options.paths.cacheDir, { recursive: true }).catch(() => {});
    await writeCapabilityCache(cacheFilePath, summary).catch(() => {});
    return summary;
  } finally {
    await rm(schemaDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function probeReadiness(options: {
  config: BridgeConfig;
  store: BridgeStateStore;
  paths: BridgePaths;
  logger: Logger;
  keepAppServer?: boolean;
  persist?: boolean;
  deps?: ReadinessDependencies;
}): Promise<ReadinessProbeResult> {
  const { config, store, paths, logger } = options;
  const persist = options.persist ?? true;
  const deps = {
    nodeVersion: options.deps?.nodeVersion ?? process.version,
    commandExists: options.deps?.commandExists ?? commandExists,
    runCommand: options.deps?.runCommand ?? runCommand,
    detectServiceManager: options.deps?.detectServiceManager ?? defaultDetectServiceManager,
    validateTelegramToken: options.deps?.validateTelegramToken ?? defaultValidateTelegramToken,
    createAppServer: options.deps?.createAppServer ?? defaultCreateAppServer,
    evaluateCapabilities: options.deps?.evaluateCapabilities ?? defaultEvaluateCapabilities
  };
  const details: ReadinessDetails = {
    codexInstalled: false,
    codexAuthenticated: false,
    appServerAvailable: false,
    telegramTokenValid: false,
    authorizedUserBound: store.getAuthorizedUser() !== null,
    issues: [],
    nodeVersion: deps.nodeVersion
  };

  const requiredNodeRange = await readDeclaredNodeEngine(paths);
  details.nodeVersionSupported = isVersionAtLeast(deps.nodeVersion, parseVersionParts(requiredNodeRange) ?? [25, 0, 0]);
  if (!details.nodeVersionSupported) {
    details.issues.push(`Node ${deps.nodeVersion} does not satisfy required range ${requiredNodeRange}`);
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  [details.stateRootWritable, details.configRootWritable, details.installRootWritable] = await Promise.all([
    isDirectoryWritable(paths.stateRoot),
    isDirectoryWritable(paths.configRoot),
    isDirectoryWritable(paths.installRoot)
  ]);

  if (!details.stateRootWritable) {
    details.issues.push(`state root is not writable: ${paths.stateRoot}`);
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  if (!details.configRootWritable) {
    details.issues.push(`config root is not writable: ${paths.configRoot}`);
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  const serviceManager = await deps.detectServiceManager({
    commandExists: deps.commandExists
  });
  details.serviceManager = serviceManager.manager;
  details.serviceManagerHealth = serviceManager.health;
  if (serviceManager.manager === "none") {
    details.issues.push(...serviceManager.issues.map((issue) => normalizeIssue(`service manager warning: ${issue}`)));
  }

  const codexAvailable = await deps.commandExists(config.codexBin);
  if (!codexAvailable) {
    details.issues.push("codex binary not found in PATH");
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  const versionResult = await deps.runCommand(config.codexBin, ["--version"]);
  if (versionResult.exitCode !== 0) {
    details.issues.push(versionResult.stderr || "failed to read codex version");
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  details.codexInstalled = true;
  details.codexVersion = versionResult.stdout;
  details.codexVersionSupported = isVersionAtLeast(versionResult.stdout, MIN_CODEX_VERSION);
  if (!details.codexVersionSupported) {
    details.issues.push(
      `Codex version ${versionResult.stdout} is below required floor ${MIN_CODEX_VERSION.join(".")}`
    );
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  const capabilitySummary = await deps.evaluateCapabilities({
    codexBin: config.codexBin,
    codexVersionText: versionResult.stdout,
    paths,
    runCommand: deps.runCommand
  });
  details.capabilityCheckPassed = capabilitySummary.ok;
  details.capabilityCheckSource = capabilitySummary.source;
  if (!capabilitySummary.ok) {
    details.issues.push(...capabilitySummary.issues.map((issue) => normalizeIssue(issue)));
    return finalizeFailure("bridge_unhealthy", details, store, persist);
  }

  const loginStatus = await deps.runCommand(config.codexBin, ["login", "status"]);
  const loginOutput = loginStatus.stdout || loginStatus.stderr;
  details.codexLoginStatus = loginOutput;
  details.codexAuthenticated = loginStatus.exitCode === 0 && loginOutput.includes("Logged in");

  if (!details.codexAuthenticated) {
    details.issues.push("codex login status is not ready");
    return finalizeFailure("codex_not_authenticated", details, store, persist);
  }

  if (!config.telegramBotToken) {
    details.issues.push("missing TELEGRAM_BOT_TOKEN");
    return finalizeFailure("telegram_token_invalid", details, store, persist);
  }

  const telegramValidation = await deps.validateTelegramToken(config.telegramBotToken, config.telegramApiBaseUrl);
  if (!telegramValidation.ok) {
    details.issues.push(telegramValidation.issue ?? "telegram token validation failed");
    return finalizeFailure("telegram_token_invalid", details, store, persist);
  }

  details.telegramTokenValid = true;
  if (telegramValidation.username) {
    details.telegramBotUsername = telegramValidation.username;
  }
  if (telegramValidation.botId) {
    details.telegramBotId = telegramValidation.botId;
  }

  let appServer: AppServerLifecycle | null = null;

  try {
    appServer = deps.createAppServer({
      codexBin: config.codexBin,
      appServerLogPath: paths.appServerLogPath,
      logger
    });
    await appServer.initializeAndProbe();
    details.appServerAvailable = true;
  } catch (error) {
    details.issues.push(`${error}`);

    if (appServer) {
      await appServer.stop().catch(() => {});
    }

    return finalizeFailure("app_server_unavailable", details, store, persist);
  }

  const state = details.authorizedUserBound ? "ready" : "awaiting_authorization";
  const snapshot = buildSnapshot(state, details, appServer.pid);
  if (persist) {
    store.writeReadinessSnapshot(snapshot);
  }

  if (!(options.keepAppServer ?? false)) {
    await appServer.stop();
    return { snapshot, appServer: null };
  }

  return { snapshot, appServer: appServer as CodexAppServerClient };
}
