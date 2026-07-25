import { access, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, sep } from "node:path";

import type { BridgeStateStore } from "../state/store.js";
import type { ProjectCandidate, ProjectPickerGroup, ProjectPickerResult, RecentProjectRow } from "../types.js";
import { expandHomePath } from "../util/path.js";

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
const MAX_VISIBLE_PROJECT_CANDIDATES = 5;
const MAX_VISIBLE_RECENT_CANDIDATES = 3;

interface AggregateCandidate {
  projectPath: string;
  projectName: string;
  projectAlias: string | null;
  pinned: boolean;
  lastUsedAt: string | null;
  lastSuccessAt: string | null;
  hasExistingSession: boolean;
  accessible: boolean;
}

function normalizePathForDisplay(path: string): string {
  return path.split(sep).join("/");
}

function buildProjectPathLabel(projectPath: string, homeDir: string): string {
  if (projectPath === homeDir) {
    return "~";
  }

  if (projectPath.startsWith(`${homeDir}${sep}`)) {
    return `~/${normalizePathForDisplay(relative(homeDir, projectPath))}`;
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
  return "recent";
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
      fromScan: false,
      detectedMarkers: []
    });
  }

  return projectCandidates
    .sort(compareCandidates)
    .filter((candidate) => candidate.accessible || candidate.score > 0);
}

function buildProjectGroups(candidates: ProjectCandidate[]): ProjectPickerGroup[] {
  const definitions: Array<{ key: ProjectPickerGroup["key"]; title: string; limit: number }> = [
    { key: "pinned", title: "Pinned", limit: MAX_VISIBLE_PROJECT_CANDIDATES },
    { key: "recent", title: "Recent", limit: MAX_VISIBLE_RECENT_CANDIDATES }
  ];

  let remainingBudget = MAX_VISIBLE_PROJECT_CANDIDATES;

  return definitions
    .map((definition) => {
      if (remainingBudget <= 0) {
        return {
          key: definition.key,
          title: definition.title,
          candidates: []
        };
      }

      const groupCandidates = candidates
        .filter((candidate) => candidate.group === definition.key)
        .slice(0, Math.min(definition.limit, remainingBudget));
      remainingBudget -= groupCandidates.length;

      return {
        key: definition.key,
        title: definition.title,
        candidates: groupCandidates
      };
    })
    .filter((group) => group.candidates.length > 0);
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
    group: recentProject?.pinned ? "pinned" : "recent",
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

export async function buildProjectPicker(
  homeDir: string,
  _configuredRoots: string[],
  store: BridgeStateStore
): Promise<ProjectPickerResult> {
  const ranked = await buildCandidates(homeDir, store);
  const groups = buildProjectGroups(ranked);
  const projectMap = new Map<string, ProjectCandidate>(ranked.map((candidate) => [candidate.projectKey, candidate]));

  return {
    title: "Select a project to start a session",
    emptyText: ranked.length === 0 ? "No recent projects. Browse directory or enter a path manually." : null,
    noticeLines: [],
    groups,
    partial: false,
    allRootsFailed: false,
    projectMap
  };
}

export async function refreshProjectPicker(
  homeDir: string,
  configuredRoots: string[],
  store: BridgeStateStore,
  previousProjectKeys: Set<string>
): Promise<{ picker: ProjectPickerResult; hasNewResults: boolean }> {
  const picker = await buildProjectPicker(homeDir, configuredRoots, store);
  const currentKeys = new Set([...picker.projectMap.keys()]);
  const hasNewResults = [...currentKeys].some((projectKey) => !previousProjectKeys.has(projectKey));

  return { picker, hasNewResults };
}

export async function validateManualProjectPath(
  inputPath: string,
  homeDir: string,
  store: BridgeStateStore
): Promise<ProjectCandidate | null> {
  const resolvedPath = expandHomePath(inputPath.trim(), homeDir);

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
