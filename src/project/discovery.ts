import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

import type { BridgeStateStore } from "../state/store.js";
import type { ProjectCandidate, ProjectPickerResult } from "../types.js";

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

async function buildCandidates(
  homeDir: string,
  store: BridgeStateStore,
  scanResult: ScanResult
): Promise<ProjectCandidate[]> {
  const recentProjects = store.listRecentProjects();
  const scannedProjects = store.listProjectScanCache();
  const sessionStats = store.listSessionProjectStats();
  const aggregate = new Map<string, AggregateCandidate>();

  for (const recentProject of recentProjects) {
    aggregate.set(recentProject.projectPath, {
      projectPath: recentProject.projectPath,
      projectName: recentProject.projectName,
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
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      const leftUsedAt = Date.parse(left.lastUsedAt ?? "1970-01-01");
      const rightUsedAt = Date.parse(right.lastUsedAt ?? "1970-01-01");
      if (rightUsedAt !== leftUsedAt) {
        return rightUsedAt - leftUsedAt;
      }

      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }

      return left.projectName.localeCompare(right.projectName, "zh-CN");
    })
    .filter((candidate) => candidate.accessible || candidate.score > 0);
}

export async function buildProjectPicker(homeDir: string, store: BridgeStateStore): Promise<ProjectPickerResult> {
  const scanResult = await scanProjects(homeDir, store);
  const ranked = await buildCandidates(homeDir, store, scanResult);
  const primary = ranked.length > 0 && ranked[0]?.score !== undefined && ranked[0].score >= 60 ? ranked[0] : null;
  const frequent = primary ? ranked.slice(1, 6) : ranked.slice(0, 5);
  const projectMap = new Map<string, ProjectCandidate>(ranked.map((candidate) => [candidate.projectKey, candidate]));

  return {
    title: "选择这次要操作的项目",
    emptyText: ranked.length === 0 ? "未找到推荐项目，请扫描更多仓库或手动输入路径。" : null,
    primary,
    frequent,
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
  homeDir: string
): Promise<ProjectCandidate | null> {
  const resolvedPath = expandProjectPath(inputPath.trim(), homeDir);

  try {
    const inspection = await inspectProjectDirectory(resolvedPath);
    if (inspection.markers.length === 0) {
      return null;
    }

    return {
      projectKey: projectKeyForPath(resolvedPath),
      projectPath: resolvedPath,
      projectName: basename(resolvedPath),
      score: 0,
      pinned: false,
      hasExistingSession: false,
      lastUsedAt: null,
      lastSuccessAt: null,
      accessible: true,
      fromScan: false,
      detectedMarkers: inspection.markers
    };
  } catch {
    return null;
  }
}

export function projectKeyForPath(projectPath: string): string {
  return createHash("sha1").update(projectPath).digest("hex").slice(0, 12);
}
