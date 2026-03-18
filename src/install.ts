import { constants } from "node:fs";
import { access, cp, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { loadConfig, serializeProjectScanRoots, withInstallOverrides, writeConfig, type BridgeConfig } from "./config.js";
import { collectArchiveDriftDiagnostics } from "./archive-drift.js";
import { CodexAppServerClient } from "./codex/app-server.js";
import type { Logger } from "./logger.js";
import { ensureBridgeDirectories, type BridgePaths } from "./paths.js";
import { commandExists, runCommand, type CommandResult } from "./process.js";
import { probeReadiness } from "./readiness.js";
import {
  BridgeStateStore,
  StateStoreOpenError,
  readStateStoreFailure,
  type StateStoreFailureRecord
} from "./state/store.js";
import { TelegramApi } from "./telegram/api.js";
import { syncTelegramCommands } from "./telegram/commands.js";
import {
  isOperationalReadinessState,
  type InstallManifest,
  type InstallSourceMetadata,
  type PendingAuthorizationRow,
  type ReadinessSnapshot
} from "./types.js";
import { readRepoPackageJson } from "./util/package-json.js";

type CommandRunner = (
  command: string,
  args: string[],
  options?: Parameters<typeof runCommand>[2]
) => Promise<CommandResult>;

type ServiceManager = "systemd" | "launchd" | "none";

interface InstallDependencies {
  detectServiceManager?: () => Promise<ServiceManager>;
  runCommand?: typeof runCommand;
  probeReadiness?: typeof probeReadiness;
  createTelegramApi?: (token: string, baseUrl: string) => Pick<TelegramApi, "getMe" | "setMyCommands">;
  syncTelegramCommands?: typeof syncTelegramCommands;
  scanArchiveDrift?: (options: {
    store: BridgeStateStore;
    listThreads: Pick<CodexAppServerClient, "listThreads">["listThreads"];
  }) => Promise<{
    issues: Array<{
      kind: string;
      sessionId: string;
      threadId: string;
      projectName: string;
      displayName: string;
    }>;
  }>;
}

const SERVICE_LABEL = "com.codex.telegram-bridge";
const CODEX_SKILL_NAME = "telegram-codex-linker";
const GITHUB_ARCHIVE_INSTALL_SOURCE_KIND = "github-archive";
const INSTALL_SOURCE_ENV_KEYS = {
  kind: "CTB_INSTALL_SOURCE_KIND",
  repoOwner: "CTB_INSTALL_SOURCE_REPO_OWNER",
  repoName: "CTB_INSTALL_SOURCE_REPO_NAME",
  ref: "CTB_INSTALL_SOURCE_REF",
  refType: "CTB_INSTALL_SOURCE_REF_TYPE"
} as const;

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

async function validateProjectScanRoots(
  homeDir: string,
  roots: string[],
  logger: Logger
): Promise<string[]> {
  const validatedRoots: string[] = [];

  for (const resolvedRoot of roots) {
    let stats;

    try {
      stats = await stat(resolvedRoot);
    } catch {
      throw new Error(`project scan root does not exist: ${resolvedRoot}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`project scan root is not a directory: ${resolvedRoot}`);
    }

    try {
      await access(resolvedRoot, constants.R_OK);
    } catch {
      throw new Error(`project scan root is not readable: ${resolvedRoot}`);
    }

    if (validatedRoots.includes(resolvedRoot)) {
      continue;
    }

    if (validatedRoots.some((existingRoot) => pathsOverlap(existingRoot, resolvedRoot))) {
      await logger.warn("skipping overlapping project scan root", {
        root: resolvedRoot,
        keptRoots: validatedRoots
      });
      continue;
    }

    validatedRoots.push(resolvedRoot);
  }

  return validatedRoots;
}

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

async function replaceOptionalDirectory(sourcePath: string, targetPath: string): Promise<void> {
  await rm(targetPath, { recursive: true, force: true });

  if (await pathExists(sourcePath)) {
    await cp(sourcePath, targetPath, { recursive: true });
  }
}

function formatOptionalBoolean(value: boolean | undefined): string {
  if (value === undefined) {
    return "unknown";
  }

  return value ? "true" : "false";
}

function formatOptionalValue(value: string | undefined): string {
  return value ?? "unknown";
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
    `node_version=${formatOptionalValue(snapshot.details.nodeVersion)}`,
    `node_version_supported=${formatOptionalBoolean(snapshot.details.nodeVersionSupported)}`,
    `codex_installed=${snapshot.details.codexInstalled}`,
    `codex_version=${formatOptionalValue(snapshot.details.codexVersion)}`,
    `codex_version_supported=${formatOptionalBoolean(snapshot.details.codexVersionSupported)}`,
    `codex_authenticated=${snapshot.details.codexAuthenticated}`,
    `telegram_token_valid=${snapshot.details.telegramTokenValid}`,
    `app_server_available=${snapshot.details.appServerAvailable}`,
    `authorized_user_bound=${snapshot.details.authorizedUserBound}`,
    `service_manager_health=${formatOptionalValue(snapshot.details.serviceManagerHealth)}`,
    `state_root_writable=${formatOptionalBoolean(snapshot.details.stateRootWritable)}`,
    `config_root_writable=${formatOptionalBoolean(snapshot.details.configRootWritable)}`,
    `install_root_writable=${formatOptionalBoolean(snapshot.details.installRootWritable)}`,
    `voice_input_enabled=${formatOptionalBoolean(snapshot.details.voiceInputEnabled)}`,
    `voice_openai_configured=${formatOptionalBoolean(snapshot.details.voiceOpenaiConfigured)}`,
    `voice_ffmpeg_available=${formatOptionalBoolean(snapshot.details.voiceFfmpegAvailable)}`,
    `voice_realtime_supported=${formatOptionalBoolean(snapshot.details.voiceRealtimeSupported)}`,
    `capability_check_passed=${formatOptionalBoolean(snapshot.details.capabilityCheckPassed)}`,
    `capability_check_source=${formatOptionalValue(snapshot.details.capabilityCheckSource)}`,
    issueText
  ].join("\n");
}

function formatStateStoreFailure(failure: StateStoreFailureRecord | null): string {
  if (!failure) {
    return "state_store_open=failed";
  }

  return [
    "state_store_open=failed",
    `state_store_failure_class=${failure.classification}`,
    `state_store_failure_stage=${failure.stage}`,
    `state_store_failure_at=${failure.detectedAt}`,
    `state_store_failure_action=${failure.recommendedAction}`
  ].join("\n");
}

async function readPackageVersion(paths: BridgePaths): Promise<string> {
  const packageJson = await readRepoPackageJson<{
    version: string;
  }>(paths);

  return packageJson.version;
}

function parseInstallSourceMetadataFromEnv(env: NodeJS.ProcessEnv = process.env): InstallSourceMetadata | null {
  if (env[INSTALL_SOURCE_ENV_KEYS.kind] !== GITHUB_ARCHIVE_INSTALL_SOURCE_KIND) {
    return null;
  }

  const repoOwner = env[INSTALL_SOURCE_ENV_KEYS.repoOwner]?.trim();
  const repoName = env[INSTALL_SOURCE_ENV_KEYS.repoName]?.trim();
  const ref = env[INSTALL_SOURCE_ENV_KEYS.ref]?.trim();
  const refType = env[INSTALL_SOURCE_ENV_KEYS.refType];

  if (!repoOwner || !repoName || !ref || (refType !== "branch" && refType !== "tag")) {
    return null;
  }

  return {
    kind: GITHUB_ARCHIVE_INSTALL_SOURCE_KIND,
    repoOwner,
    repoName,
    ref,
    refType
  };
}

function applyInstallSourceMetadataToEnv(
  env: NodeJS.ProcessEnv,
  installSource: InstallSourceMetadata | null | undefined
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };

  for (const key of Object.values(INSTALL_SOURCE_ENV_KEYS)) {
    delete nextEnv[key];
  }

  if (!installSource) {
    return nextEnv;
  }

  if (installSource.kind === GITHUB_ARCHIVE_INSTALL_SOURCE_KIND) {
    nextEnv[INSTALL_SOURCE_ENV_KEYS.kind] = installSource.kind;
    nextEnv[INSTALL_SOURCE_ENV_KEYS.repoOwner] = installSource.repoOwner;
    nextEnv[INSTALL_SOURCE_ENV_KEYS.repoName] = installSource.repoName;
    nextEnv[INSTALL_SOURCE_ENV_KEYS.ref] = installSource.ref;
    nextEnv[INSTALL_SOURCE_ENV_KEYS.refType] = installSource.refType;
  }

  return nextEnv;
}

function buildInstallEnvironment(
  config: BridgeConfig,
  installSource: InstallSourceMetadata | null | undefined
): NodeJS.ProcessEnv {
  return applyInstallSourceMetadataToEnv({
    ...process.env,
    TELEGRAM_BOT_TOKEN: config.telegramBotToken,
    CODEX_BIN: config.codexBin,
    TELEGRAM_API_BASE_URL: config.telegramApiBaseUrl,
    PROJECT_SCAN_ROOTS: serializeProjectScanRoots(config.projectScanRoots),
    VOICE_INPUT_ENABLED: config.voiceInputEnabled ? "1" : "0",
    VOICE_OPENAI_API_KEY: config.voiceOpenaiApiKey,
    VOICE_OPENAI_TRANSCRIBE_MODEL: config.voiceOpenaiTranscribeModel,
    VOICE_FFMPEG_BIN: config.voiceFfmpegBin
  }, installSource);
}

async function writeInstallManifest(paths: BridgePaths): Promise<void> {
  const installSource = parseInstallSourceMetadataFromEnv();
  const manifest: InstallManifest = {
    version: await readPackageVersion(paths),
    sourceRoot: installSource ? null : (paths.repoRoot.startsWith(paths.installRoot) ? null : paths.repoRoot),
    installedAt: new Date().toISOString(),
    installSource
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

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function launchdStdoutPath(paths: BridgePaths): string {
  return join(paths.logsDir, "launchd.stdout.log");
}

function launchdStderrPath(paths: BridgePaths): string {
  return join(paths.logsDir, "launchd.stderr.log");
}

function buildLaunchAgentEnvironmentVariables(): Record<string, string> {
  const environmentVariables: Record<string, string> = {};

  for (const key of [
    "PATH",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy"
  ]) {
    const value = process.env[key];
    if (value) {
      environmentVariables[key] = value;
    }
  }

  return environmentVariables;
}

export function buildLaunchAgentPlist(paths: BridgePaths): string {
  const programArguments = [
    process.execPath,
    "--disable-warning=ExperimentalWarning",
    join(paths.installRoot, "dist", "cli.js"),
    "service",
    "run"
  ];
  const environmentVariables = buildLaunchAgentEnvironmentVariables();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n")}
  </array>
${Object.keys(environmentVariables).length === 0
    ? ""
    : `  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environmentVariables).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join("\n")}
  </dict>
`}
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(paths.installRoot)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(launchdStdoutPath(paths))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(launchdStderrPath(paths))}</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>2</integer>
</dict>
</plist>
`;
}

async function writeLaunchAgent(paths: BridgePaths): Promise<void> {
  await writeFile(paths.launchAgentPath, buildLaunchAgentPlist(paths), "utf8");
}

async function systemctlAvailable(): Promise<boolean> {
  return await commandExists("systemctl");
}

async function launchctlAvailable(): Promise<boolean> {
  return process.platform === "darwin" && await commandExists("launchctl");
}

async function detectServiceManager(): Promise<ServiceManager> {
  if (await launchctlAvailable()) {
    return "launchd";
  }

  if (await systemctlAvailable()) {
    return "systemd";
  }

  return "none";
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

function launchctlDomain(): string {
  if (typeof process.getuid !== "function") {
    throw new Error("launchctl integration requires process.getuid()");
  }

  return `gui/${process.getuid()}`;
}

function launchctlServiceTarget(): string {
  return `${launchctlDomain()}/${SERVICE_LABEL}`;
}

function isLaunchctlNotLoadedMessage(message: string): boolean {
  return /could not find service|service is not loaded|no such process|input\/output error/iu.test(message);
}

async function callLaunchctl(args: string[], allowNotLoaded = false): Promise<CommandResult> {
  const result = await runCommand("launchctl", args);
  const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();

  if (result.exitCode === 0) {
    return result;
  }

  if (allowNotLoaded && isLaunchctlNotLoadedMessage(combinedOutput)) {
    return result;
  }

  throw new Error(combinedOutput || `launchctl failed: ${args.join(" ")}`);
}

async function isLaunchAgentLoaded(): Promise<boolean> {
  const result = await runCommand("launchctl", ["print", launchctlServiceTarget()]);
  return result.exitCode === 0;
}

async function getLaunchdServiceState(): Promise<string> {
  const result = await runCommand("launchctl", ["print", launchctlServiceTarget()]);
  if (result.exitCode !== 0) {
    return "unloaded";
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const pidMatch = output.match(/pid = (\d+)/u);
  if (pidMatch && pidMatch[1] && pidMatch[1] !== "0") {
    return `running(pid=${pidMatch[1]})`;
  }

  const stateMatch = output.match(/state = ([^\n]+)/u);
  if (stateMatch?.[1]) {
    return stateMatch[1].trim();
  }

  return "loaded";
}

async function startLaunchAgent(paths: BridgePaths): Promise<void> {
  const domain = launchctlDomain();
  if (await isLaunchAgentLoaded()) {
    await callLaunchctl(["bootout", domain, paths.launchAgentPath], true);
  }

  await callLaunchctl(["bootstrap", domain, paths.launchAgentPath]);
  await callLaunchctl(["enable", launchctlServiceTarget()]);
  await callLaunchctl(["kickstart", "-k", launchctlServiceTarget()]);
}

async function stopLaunchAgent(paths: BridgePaths): Promise<void> {
  await callLaunchctl(["bootout", launchctlDomain(), paths.launchAgentPath], true);
}

async function buildRelease(paths: BridgePaths, run: CommandRunner): Promise<void> {
  const buildResult = await run("npm", ["run", "build"], {
    cwd: paths.repoRoot
  });
  if (buildResult.exitCode !== 0) {
    throw new Error(buildResult.stderr || buildResult.stdout || "npm run build failed");
  }

  if (!(await pathExists(join(paths.repoRoot, "dist", "cli.js")))) {
    throw new Error("npm run build completed without producing dist/cli.js");
  }
}

export async function prepareRelease(paths: BridgePaths, run: CommandRunner = runCommand): Promise<void> {
  await buildRelease(paths, run);
  await rm(join(paths.installRoot, "dist"), { recursive: true, force: true });
  await cp(join(paths.repoRoot, "dist"), join(paths.installRoot, "dist"), { recursive: true });
  await cp(join(paths.repoRoot, "package.json"), join(paths.installRoot, "package.json"));
  await replaceOptionalDirectory(join(paths.repoRoot, "skills"), join(paths.installRoot, "skills"));
}

async function resolveBundledSkillPath(paths: BridgePaths): Promise<string> {
  const candidates = [
    join(paths.repoRoot, "skills", CODEX_SKILL_NAME),
    join(paths.installRoot, "skills", CODEX_SKILL_NAME)
  ];

  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "SKILL.md"))) {
      return candidate;
    }
  }

  throw new Error(`bundled skill ${CODEX_SKILL_NAME} not found in install or source tree`);
}

export async function installCodexSkill(paths: BridgePaths): Promise<string> {
  const sourcePath = await resolveBundledSkillPath(paths);
  const codexHome = process.env.CODEX_HOME ?? join(paths.homeDir, ".codex");
  const targetPath = join(codexHome, "skills", CODEX_SKILL_NAME);

  await mkdir(join(codexHome, "skills"), { recursive: true });
  await rm(targetPath, { recursive: true, force: true });
  await cp(sourcePath, targetPath, { recursive: true });

  return `codex skill ${CODEX_SKILL_NAME} installed at ${targetPath}; restart Codex to load it`;
}

function githubArchiveUrl(installSource: InstallSourceMetadata): string {
  if (installSource.kind !== GITHUB_ARCHIVE_INSTALL_SOURCE_KIND) {
    throw new Error(`unsupported install source kind: ${installSource.kind}`);
  }

  if (installSource.refType === "branch") {
    return `https://codeload.github.com/${installSource.repoOwner}/${installSource.repoName}/tar.gz/refs/heads/${installSource.ref}`;
  }

  return `https://codeload.github.com/${installSource.repoOwner}/${installSource.repoName}/tar.gz/refs/tags/${installSource.ref}`;
}

async function downloadGithubArchiveSource(
  installSource: InstallSourceMetadata,
  run: CommandRunner
): Promise<{ sourceRoot: string; workDir: string }> {
  const workDir = await mkdtemp(join(tmpdir(), "ctb-github-update-"));
  const archivePath = join(workDir, "source.tar.gz");
  const archiveUrl = githubArchiveUrl(installSource);

  const download = await run("curl", ["-fsSL", archiveUrl, "-o", archivePath]);
  if (download.exitCode !== 0) {
    await rm(workDir, { recursive: true, force: true });
    throw new Error(download.stderr || download.stdout || `failed to download ${archiveUrl}`);
  }

  const extract = await run("tar", ["-xzf", archivePath, "-C", workDir]);
  if (extract.exitCode !== 0) {
    await rm(workDir, { recursive: true, force: true });
    throw new Error(extract.stderr || extract.stdout || "failed to extract GitHub archive");
  }

  const sourceEntry = (await readdir(workDir, { withFileTypes: true }))
    .find((entry) => entry.isDirectory());
  if (!sourceEntry) {
    await rm(workDir, { recursive: true, force: true });
    throw new Error("GitHub archive did not contain a source directory");
  }

  return {
    sourceRoot: join(workDir, sourceEntry.name),
    workDir
  };
}

async function reinstallFromSourceRoot(
  sourceRoot: string,
  config: BridgeConfig,
  installSource: InstallSourceMetadata | null | undefined,
  run: CommandRunner
): Promise<void> {
  const env = buildInstallEnvironment(config, installSource);

  const installResult = await run("npm", ["install"], {
    cwd: sourceRoot,
    env
  });
  if (installResult.exitCode !== 0) {
    throw new Error(installResult.stderr || installResult.stdout || "npm install failed");
  }

  const buildResult = await run("npm", ["run", "build"], {
    cwd: sourceRoot,
    env
  });
  if (buildResult.exitCode !== 0) {
    throw new Error(buildResult.stderr || buildResult.stdout || "npm run build failed");
  }

  const reinstallResult = await run(process.execPath, ["dist/cli.js", "install"], {
    cwd: sourceRoot,
    env
  });
  if (reinstallResult.exitCode !== 0) {
    throw new Error(reinstallResult.stderr || reinstallResult.stdout || "reinstall failed");
  }
}

export async function installBridge(
  paths: BridgePaths,
  logger: Logger,
  overrides: {
    telegramBotToken?: string;
    codexBin?: string;
    projectScanRoots?: string[];
    voiceInputEnabled?: boolean;
    voiceOpenaiApiKey?: string;
    voiceOpenaiTranscribeModel?: string;
    voiceFfmpegBin?: string;
  },
  deps: InstallDependencies = {}
): Promise<void> {
  const detectManager = deps.detectServiceManager ?? detectServiceManager;
  const run = deps.runCommand ?? runCommand;
  const readinessProbe = deps.probeReadiness ?? probeReadiness;
  const createTelegramApi = deps.createTelegramApi ?? ((token: string, baseUrl: string) => new TelegramApi(token, baseUrl));
  const syncCommands = deps.syncTelegramCommands ?? syncTelegramCommands;
  await ensureBridgeDirectories(paths);
  const overrideConfig: Partial<BridgeConfig> = {};
  if (overrides.telegramBotToken) {
    overrideConfig.telegramBotToken = overrides.telegramBotToken;
  }

  if (overrides.codexBin) {
    overrideConfig.codexBin = overrides.codexBin;
  }

  if (overrides.projectScanRoots !== undefined) {
    overrideConfig.projectScanRoots = await validateProjectScanRoots(
      paths.homeDir,
      overrides.projectScanRoots,
      logger
    );
  }

  if (overrides.voiceInputEnabled !== undefined) {
    overrideConfig.voiceInputEnabled = overrides.voiceInputEnabled;
  }
  if (overrides.voiceOpenaiApiKey !== undefined) {
    overrideConfig.voiceOpenaiApiKey = overrides.voiceOpenaiApiKey;
  }
  if (overrides.voiceOpenaiTranscribeModel !== undefined) {
    overrideConfig.voiceOpenaiTranscribeModel = overrides.voiceOpenaiTranscribeModel;
  }
  if (overrides.voiceFfmpegBin !== undefined) {
    overrideConfig.voiceFfmpegBin = overrides.voiceFfmpegBin;
  }

  const config = withInstallOverrides(await loadConfig(paths), overrideConfig);

  if (!config.telegramBotToken) {
    throw new Error("missing Telegram bot token; pass --telegram-token or set TELEGRAM_BOT_TOKEN");
  }

  await prepareRelease(paths);
  await writeConfig(paths, config);
  await writeInstallManifest(paths);
  await writeWrapperScript(paths);
  const serviceManager = await detectManager();

  if (serviceManager === "systemd") {
    await writeSystemdUnit(paths);
  } else if (serviceManager === "launchd") {
    await writeLaunchAgent(paths);
  }

  // Preserve an already-running unit by restarting it after the new release lands.
  const systemdServiceWasActive = serviceManager === "systemd"
    ? (await run("systemctl", ["--user", "is-active", "codex-telegram-bridge.service"])).exitCode === 0
    : false;

  const store = await BridgeStateStore.open(paths, logger);
  try {
    const { snapshot } = await readinessProbe({
      config,
      store,
      paths,
      logger,
      persist: true
    });

    if (!isOperationalReadinessState(snapshot.state)) {
      throw new Error(formatSnapshot(snapshot));
    }

    const telegramApi = createTelegramApi(config.telegramBotToken, config.telegramApiBaseUrl);
    await syncCommands(telegramApi);
  } finally {
    store.close();
  }

  if (serviceManager === "systemd") {
    await callSystemctl(["daemon-reload"]);
    if (systemdServiceWasActive) {
      await callSystemctl(["enable", "codex-telegram-bridge.service"]);
      await callSystemctl(["restart", "codex-telegram-bridge.service"]);
    } else {
      await callSystemctl(["enable", "--now", "codex-telegram-bridge.service"]);
    }
  } else if (serviceManager === "launchd") {
    await startLaunchAgent(paths);
  } else {
    await logger.warn("no supported service manager found; service files were not enabled");
  }
}

export async function getStatus(paths: BridgePaths, deps: InstallDependencies = {}): Promise<string> {
  const detectManager = deps.detectServiceManager ?? detectServiceManager;
  const run = deps.runCommand ?? runCommand;
  const manifest = await readInstallManifest(paths);
  const configExists = await pathExists(paths.envPath);
  const serviceManager = await detectManager();
  const serviceDefinitionPath = serviceManager === "launchd" ? paths.launchAgentPath : paths.servicePath;
  const serviceExists = await pathExists(serviceDefinitionPath);
  const systemdServiceExists = await pathExists(paths.servicePath);
  const launchAgentExists = await pathExists(paths.launchAgentPath);
  const installExists =
    manifest !== null &&
    (await pathExists(join(paths.installRoot, "dist", "cli.js"))) &&
    (await pathExists(paths.binPath));
  const stateExists = await pathExists(paths.stateRoot);

  let serviceState = "unavailable";
  if (serviceManager === "systemd") {
    const result = await run("systemctl", [
      "--user",
      "is-active",
      "codex-telegram-bridge.service"
    ]);
    serviceState = result.exitCode === 0 ? result.stdout : result.stdout || result.stderr || "inactive";
  } else if (serviceManager === "launchd") {
    serviceState = await getLaunchdServiceState();
  }

  let snapshot: ReadinessSnapshot | null = null;
  let activeSessionSummary = "none";
  let pendingNotices = 0;
  let stateStoreFailure: StateStoreFailureRecord | null = null;
  const dbExists = await pathExists(paths.dbPath);
  let stateStoreOpen = dbExists ? "ok" : "missing";
  if (dbExists) {
    try {
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
    } catch (error) {
      stateStoreOpen = "failed";
      stateStoreFailure = error instanceof StateStoreOpenError
        ? error.failure
        : await readStateStoreFailure(paths);
    }
  }

  const lines = [
    `installed=${installExists}`,
    `install_root=${paths.installRoot}`,
    `state_root=${paths.stateRoot}`,
    `config_present=${configExists}`,
    `service_file_present=${serviceExists}`,
    `systemd_service_file_present=${systemdServiceExists}`,
    `launchd_service_file_present=${launchAgentExists}`,
    `service_manager=${serviceManager}`,
    `service_state=${serviceState}`,
    `version=${manifest?.version ?? "unknown"}`,
    `installed_at=${manifest?.installedAt ?? "unknown"}`,
    `state_dir_present=${stateExists}`,
    `state_store_open=${stateStoreOpen}`,
    `active_session=${activeSessionSummary}`,
    `pending_runtime_notices=${pendingNotices}`,
    formatSnapshot(snapshot)
  ];

  if (stateStoreOpen === "failed") {
    lines.push(formatStateStoreFailure(stateStoreFailure).replace(/^state_store_open=failed\n?/u, ""));
  }

  return lines.filter((line) => line.length > 0).join("\n");
}

export async function runDoctor(paths: BridgePaths, logger: Logger, deps: InstallDependencies = {}): Promise<string> {
  const readinessProbe = deps.probeReadiness ?? probeReadiness;
  const createTelegramApi = deps.createTelegramApi ?? ((token: string, baseUrl: string) => new TelegramApi(token, baseUrl));
  const syncCommands = deps.syncTelegramCommands ?? syncTelegramCommands;
  const scanArchiveDrift = deps.scanArchiveDrift ?? collectArchiveDriftDiagnostics;
  await ensureBridgeDirectories(paths);
  let store: BridgeStateStore | null = null;
  let appServer: CodexAppServerClient | null = null;
  try {
    store = await BridgeStateStore.open(paths, logger);
  } catch (error) {
    const failure = error instanceof StateStoreOpenError
      ? error.failure
      : await readStateStoreFailure(paths);
    return formatStateStoreFailure(failure);
  }

  try {
    const config = await loadConfig(paths);
    const result = await readinessProbe({
      config,
      store,
      paths,
      logger,
      keepAppServer: true,
      persist: true
    });
    const { snapshot } = result;
    appServer = result.appServer;
    const pendingNoticeCount = countPendingRuntimeNotices(store);
    if (snapshot.details.telegramTokenValid) {
      const telegramApi = createTelegramApi(config.telegramBotToken, config.telegramApiBaseUrl);
      await syncCommands(telegramApi);
    }
    const lines = ["state_store_open=ok", formatSnapshot(snapshot), `pending_runtime_notices=${pendingNoticeCount}`];
    if (isOperationalReadinessState(snapshot.state) && appServer) {
      try {
        const driftSummary = await scanArchiveDrift({
          store,
          listThreads: appServer.listThreads.bind(appServer)
        });
        lines.push(`archive_drift_count=${driftSummary.issues.length}`);
        driftSummary.issues.forEach((issue, index) => {
          lines.push(
            `archive_drift_${index + 1}=${issue.kind} | session=${issue.sessionId} | thread=${issue.threadId} | project=${issue.projectName} | display=${issue.displayName}`
          );
        });
      } catch (error) {
        lines.push(`archive_drift_error=${error}`);
      }
    }
    return lines.join("\n");
  } finally {
    if (appServer) {
      await appServer.stop().catch(() => {});
    }
    store?.close();
  }
}

export async function startService(paths: BridgePaths): Promise<void> {
  const serviceManager = await detectServiceManager();
  if (serviceManager === "systemd") {
    await callSystemctl(["start", "codex-telegram-bridge.service"]);
    return;
  }

  if (serviceManager === "launchd") {
    await startLaunchAgent(paths);
    return;
  }

  throw new Error("no supported service manager found; run `ctb service run` under a supervisor");
}

export async function stopService(paths: BridgePaths): Promise<void> {
  const serviceManager = await detectServiceManager();
  if (serviceManager === "systemd") {
    await callSystemctl(["stop", "codex-telegram-bridge.service"]);
    return;
  }

  if (serviceManager === "launchd") {
    await stopLaunchAgent(paths);
    return;
  }

  throw new Error("no supported service manager found");
}

export async function restartService(paths: BridgePaths): Promise<void> {
  const serviceManager = await detectServiceManager();
  if (serviceManager === "systemd") {
    await callSystemctl(["restart", "codex-telegram-bridge.service"]);
    return;
  }

  if (serviceManager === "launchd") {
    await startLaunchAgent(paths);
    return;
  }

  throw new Error("no supported service manager found");
}

export async function updateBridge(
  paths: BridgePaths,
  deps: {
    runCommand?: typeof runCommand;
  } = {}
): Promise<void> {
  const run = deps.runCommand ?? runCommand;
  const manifest = await readInstallManifest(paths);
  if (!manifest) {
    throw new Error("update requires an existing install manifest; reinstall first");
  }

  const config = await loadConfig(paths);

  if (manifest.installSource?.kind === GITHUB_ARCHIVE_INSTALL_SOURCE_KIND) {
    const { sourceRoot, workDir } = await downloadGithubArchiveSource(manifest.installSource, run);
    try {
      await reinstallFromSourceRoot(sourceRoot, config, manifest.installSource, run);
      return;
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  if (!manifest.sourceRoot) {
    throw new Error("update requires a retained source checkout or GitHub archive metadata; reinstall first");
  }

  if (!(await pathExists(manifest.sourceRoot))) {
    throw new Error("retained source checkout is missing; reinstall from GitHub or from source instead");
  }

  await reinstallFromSourceRoot(manifest.sourceRoot, config, null, run);
}

export async function uninstallBridge(paths: BridgePaths, purgeState: boolean): Promise<void> {
  const serviceManager = await detectServiceManager();
  if (serviceManager === "systemd") {
    await runCommand("systemctl", ["--user", "disable", "--now", "codex-telegram-bridge.service"]);
    await runCommand("systemctl", ["--user", "daemon-reload"]);
  } else if (serviceManager === "launchd") {
    await stopLaunchAgent(paths).catch(() => {});
  }

  await unlink(paths.servicePath).catch(() => {});
  await unlink(paths.launchAgentPath).catch(() => {});
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
