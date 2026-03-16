import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";

import type { BridgeStateStore } from "../state/store.js";
import type { ProjectCandidate, ProjectPickerGroup, ProjectPickerResult, RecentProjectRow } from "../types.js";

const SCAN_ROOT_NAMES = ["Repo", "workspace", "code"] as const;
const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", ".jj"] as const;
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo"
]);
const MAX_DEPTH = 3;
const MAX_CANDIDATES = 200;
const MAX_SCAN_MS = 3000;
const MAX_GROUP_CANDIDATES = 5;

interface ScanCandidate {
  projectPath: string;
  projectName: string;
  scanRoot: string;
  confidence: number;
  detectedMarkers: string[];
  existsNow: boolean;
}

interface ScanDirectory {
  path: string;
  root: string;
  depth: number;
}

interface ScanResult {
  scanned: ScanCandidate[];
  partial: boolean;
  allRootsFailed: boolean;
}

interface AggregateCandidate {
  projectPath: string;
  projectName: string;
  projectAlias: string | null;
  pinned: boolean;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  hasExistingSession: boolean;
  fromScan: boolean;
  existsNow: boolean;
  detectedMarkers: string[];
  accessible: boolean;
}

function computeConfidence(markers: string[]): number {
  let confidence = 50 + markers.length * 10;
  if (markers.includes(".git") || markers.includes(".jj")) {
    confidence += 20;
  }

  return Math.min(confidence, 100);
}

function isHiddenPath(path: string): boolean {
  return basename(path).startsWith(".");
}

function expandProjectPath(inputPath: string, homeDir: string): string {
  if (inputPath === "~") {
    return homeDir;
  }

  if (inputPath.startsWith("~/")) {
    return join(homeDir, inputPath.slice(2));
  }

  return resolve(inputPath);
}

function normalizePathForDisplay(path: string): string {
  return path.split(sep).join("/");
}

function buildProjectPathLabel(projectPath: string, homeDir: string): string {
  for (const rootName of SCAN_ROOT_NAMES) {
    const rootPath = join(homeDir, rootName);
    if (projectPath === rootPath) {
      return rootName;
    }

    if (projectPath.startsWith(`${rootPath}${sep}`)) {
      const relativePath = normalizePathForDisplay(relative(rootPath, projectPath));
      return `${rootName}/${relativePath}`;
    }
  }

  return normalizePathForDisplay(projectPath);
}

function projectDisplayName(projectName: string, projectAlias: string | null): string {
  return projectAlias?.trim() || projectName;
}

function projectIsRecent(candidate: AggregateCandidate): boolean {
  return candidate.lastUsedAt !== null || candidate.lastSuccessAt !== null || candidate.hasExistingSession;
}

function projectGroup(candidate: AggregateCandidate): ProjectCandidate["group"] {
  if (candidate.pinned) {
    return "pinned";
  }

  if (projectIsRecent(candidate)) {
    return "recent";
  }

  return "discovered";
}

async function pathAccessible(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspectProjectDirectory(path: string): Promise<{ markers: string[]; childDirectories: string[] }> {
  const entries = await readdir(path, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  const markers = PROJECT_MARKERS.filter((marker) => names.has(marker));
  const childDirectories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  return { markers: [...markers], childDirectories };
}

async function scanProjects(homeDir: string, store: BridgeStateStore): Promise<ScanResult> {
  const pinnedPaths = new Set(store.listPinnedProjectPaths());
  const queue: ScanDirectory[] = SCAN_ROOT_NAMES.map((rootName) => ({
    path: join(homeDir, rootName),
    root: join(homeDir, rootName),
    depth: 0
  }));

  const seen = new Set<string>();
  const candidates = new Map<string, ScanCandidate>();
  const deadline = Date.now() + MAX_SCAN_MS;
  let partial = false;
  let successfulRoots = 0;

  while (queue.length > 0) {
    if (Date.now() >= deadline || candidates.size >= MAX_CANDIDATES) {
      partial = true;
      break;
    }

    const current = queue.shift();
    if (!current || seen.has(current.path)) {
      continue;
    }

    seen.add(current.path);

    if (current.depth > 0 && isHiddenPath(current.path) && !pinnedPaths.has(current.path)) {
      continue;
    }

    let inspection: { markers: string[]; childDirectories: string[] };
    try {
      inspection = await inspectProjectDirectory(current.path);
      if (current.depth === 0) {
        successfulRoots += 1;
      }
    } catch {
      continue;
    }

    if (inspection.markers.length > 0) {
      candidates.set(current.path, {
        projectPath: current.path,
        projectName: basename(current.path),
        scanRoot: current.root,
        confidence: computeConfidence(inspection.markers),
        detectedMarkers: inspection.markers,
        existsNow: true
      });
    }

    if (current.depth >= MAX_DEPTH) {
      continue;
    }

    for (const childName of inspection.childDirectories) {
      if (EXCLUDED_DIR_NAMES.has(childName)) {
        continue;
      }

      if (childName.startsWith(".") && !pinnedPaths.has(join(current.path, childName))) {
        continue;
      }

      queue.push({
        path: join(current.path, childName),
        root: current.root,
        depth: current.depth + 1
      });
    }
  }

  const scanned = [...candidates.values()];
  if (scanned.length > 0) {
    store.upsertProjectScanCandidates(scanned);
  }

  return {
    scanned,
    partial,
    allRootsFailed: successfulRoots === 0
  };
}

function compareCandidates(left: ProjectCandidate, right: ProjectCandidate): number {
  if (right.score !== left.score) {
    return right.score - left.score;
  }

  const leftUsedAt = Date.parse(left.lastUsedAt ?? "1970-01-01");
  const rightUsedAt = Date.parse(right.lastUsedAt ?? "1970-01-01");
  if (rightUsedAt !== leftUsedAt) {
    return rightUsedAt - leftUsedAt;
  }

  const leftSuccessAt = Date.parse(left.lastSuccessAt ?? "1970-01-01");
  const rightSuccessAt = Date.parse(right.lastSuccessAt ?? "1970-01-01");
  if (rightSuccessAt !== leftSuccessAt) {
    return rightSuccessAt - leftSuccessAt;
  }

  return left.displayName.localeCompare(right.displayName, "zh-CN");
}

async function buildCandidates(homeDir: string, store: BridgeStateStore): Promise<ProjectCandidate[]> {
  const recentProjects = store.listRecentProjects();
  const scannedProjects = store.listProjectScanCache();
  const sessionStats = store.listSessionProjectStats();
  const aggregate = new Map<string, AggregateCandidate>();

  for (const recentProject of recentProjects) {
    aggregate.set(recentProject.projectPath, {
      projectPath: recentProject.projectPath,
      projectName: recentProject.projectName,
      projectAlias: recentProject.projectAlias,
      pinned: recentProject.pinned,
      lastUsedAt: recentProject.lastUsedAt,
      lastSuccessAt: recentProject.lastSuccessAt,
      hasExistingSession: false,
      fromScan: false,
      existsNow: false,
      detectedMarkers: [],
      accessible: false
    });
  }

  for (const sessionProject of sessionStats) {
    const existing = aggregate.get(sessionProject.projectPath);
    aggregate.set(sessionProject.projectPath, {
      projectPath: sessionProject.projectPath,
      projectName: existing?.projectName ?? sessionProject.projectName,
      projectAlias: existing?.projectAlias ?? null,
      pinned: existing?.pinned ?? false,
      lastUsedAt: existing?.lastUsedAt ?? sessionProject.lastUsedAt,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      hasExistingSession: true,
      fromScan: existing?.fromScan ?? false,
      existsNow: existing?.existsNow ?? false,
      detectedMarkers: existing?.detectedMarkers ?? [],
      accessible: false
    });
  }

  for (const scannedProject of scannedProjects) {
    const existing = aggregate.get(scannedProject.projectPath);
    aggregate.set(scannedProject.projectPath, {
      projectPath: scannedProject.projectPath,
      projectName: existing?.projectName ?? scannedProject.projectName,
      projectAlias: existing?.projectAlias ?? null,
      pinned: existing?.pinned ?? false,
      lastUsedAt: existing?.lastUsedAt ?? null,
      lastSuccessAt: existing?.lastSuccessAt ?? null,
      hasExistingSession: existing?.hasExistingSession ?? false,
      fromScan: true,
      existsNow: scannedProject.existsNow,
      detectedMarkers: scannedProject.detectedMarkers,
      accessible: false
    });
  }

  const latestUsedPath = [...aggregate.values()]
    .filter((candidate) => candidate.lastUsedAt !== null)
    .sort((left, right) => Date.parse(right.lastUsedAt ?? "1970-01-01") - Date.parse(left.lastUsedAt ?? "1970-01-01"))[0]
    ?.projectPath;

  const latestSuccessPath = [...aggregate.values()]
    .filter((candidate) => candidate.lastSuccessAt !== null)
    .sort(
      (left, right) =>
        Date.parse(right.lastSuccessAt ?? "1970-01-01") - Date.parse(left.lastSuccessAt ?? "1970-01-01")
    )[0]?.projectPath;

  const projectCandidates: ProjectCandidate[] = [];

  for (const candidate of aggregate.values()) {
    const accessible = await pathAccessible(candidate.projectPath);
    candidate.accessible = accessible;

    let score = 0;
    if (candidate.pinned) {
      score += 100;
    }

    if (latestSuccessPath === candidate.projectPath) {
      score += 80;
    }

    if (latestUsedPath === candidate.projectPath) {
      score += 60;
    }

    if (candidate.hasExistingSession) {
      score += 40;
    }

    if (candidate.fromScan && candidate.existsNow) {
      score += 20;
    }

    if (!accessible) {
      score -= 50;
    }

    projectCandidates.push({
      projectKey: projectKeyForPath(candidate.projectPath),
      projectPath: candidate.projectPath,
      projectName: candidate.projectName,
      projectAlias: candidate.projectAlias,
      displayName: projectDisplayName(candidate.projectName, candidate.projectAlias),
      pathLabel: buildProjectPathLabel(candidate.projectPath, homeDir),
      group: projectGroup(candidate),
      isRecent: projectIsRecent(candidate),
      score,
      pinned: candidate.pinned,
      hasExistingSession: candidate.hasExistingSession,
      lastUsedAt: candidate.lastUsedAt,
      lastSuccessAt: candidate.lastSuccessAt,
      accessible,
      fromScan: candidate.fromScan,
      detectedMarkers: candidate.detectedMarkers
    });
  }

  return projectCandidates
    .sort(compareCandidates)
    .filter((candidate) => candidate.accessible || candidate.score > 0);
}

function buildProjectGroups(candidates: ProjectCandidate[]): ProjectPickerGroup[] {
  const definitions: Array<{ key: ProjectCandidate["group"]; title: string }> = [
    { key: "pinned", title: "已收藏" },
    { key: "recent", title: "最近使用" },
    { key: "discovered", title: "本地发现" }
  ];

  return definitions
    .map((definition) => ({
      key: definition.key,
      title: definition.title,
      candidates: candidates.filter((candidate) => candidate.group === definition.key).slice(0, MAX_GROUP_CANDIDATES)
    }))
    .filter((group) => group.candidates.length > 0);
}

function buildNoticeLines(scanResult: ScanResult): string[] {
  const lines: string[] = [];
  if (scanResult.allRootsFailed) {
    lines.push("默认扫描目录当前不可用，以下结果可能主要来自历史记录。");
  } else if (scanResult.partial) {
    lines.push("本地扫描结果可能不完整。");
  }

  return lines;
}

function buildManualPathCandidate(
  projectPath: string,
  homeDir: string,
  recentProject: RecentProjectRow | null,
  detectedMarkers: string[]
): ProjectCandidate {
  const projectName = recentProject?.projectName ?? basename(projectPath);
  const projectAlias = recentProject?.projectAlias ?? null;
  const isRecent = Boolean(recentProject);

  return {
    projectKey: projectKeyForPath(projectPath),
    projectPath,
    projectName,
    projectAlias,
    displayName: projectDisplayName(projectName, projectAlias),
    pathLabel: buildProjectPathLabel(projectPath, homeDir),
    group: recentProject?.pinned ? "pinned" : isRecent ? "recent" : "discovered",
    isRecent,
    score: 0,
    pinned: recentProject?.pinned ?? false,
    hasExistingSession: false,
    lastUsedAt: recentProject?.lastUsedAt ?? null,
    lastSuccessAt: recentProject?.lastSuccessAt ?? null,
    accessible: true,
    fromScan: false,
    detectedMarkers
  };
}

export async function buildProjectPicker(homeDir: string, store: BridgeStateStore): Promise<ProjectPickerResult> {
  const scanResult = await scanProjects(homeDir, store);
  const ranked = await buildCandidates(homeDir, store);
  const groups = buildProjectGroups(ranked);
  const projectMap = new Map<string, ProjectCandidate>(ranked.map((candidate) => [candidate.projectKey, candidate]));

  return {
    title: "选择要新建会话的项目",
    emptyText: ranked.length === 0 ? "未找到可用项目，请扫描本地项目或手动输入路径。" : null,
    noticeLines: buildNoticeLines(scanResult),
    groups,
    partial: scanResult.partial,
    allRootsFailed: scanResult.allRootsFailed,
    projectMap
  };
}

export async function refreshProjectPicker(
  homeDir: string,
  store: BridgeStateStore,
  previousProjectKeys: Set<string>
): Promise<{ picker: ProjectPickerResult; hasNewResults: boolean }> {
  const picker = await buildProjectPicker(homeDir, store);
  const currentKeys = new Set([...picker.projectMap.keys()]);
  const hasNewResults = [...currentKeys].some((projectKey) => !previousProjectKeys.has(projectKey));

  return { picker, hasNewResults };
}

export async function validateManualProjectPath(
  inputPath: string,
  homeDir: string,
  store: BridgeStateStore
): Promise<ProjectCandidate | null> {
  const resolvedPath = expandProjectPath(inputPath.trim(), homeDir);

  try {
    const stats = await stat(resolvedPath);
    if (!stats.isDirectory()) {
      return null;
    }

    await access(resolvedPath, constants.R_OK);
    const inspection = await inspectProjectDirectory(resolvedPath);
    return buildManualPathCandidate(
      resolvedPath,
      homeDir,
      store.getRecentProjectByPath(resolvedPath),
      inspection.markers
    );
  } catch {
    return null;
  }
}

export function projectKeyForPath(projectPath: string): string {
  return createHash("sha1").update(projectPath).digest("hex").slice(0, 12);
}
