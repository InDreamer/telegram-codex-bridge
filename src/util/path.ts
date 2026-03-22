import { join, posix, resolve, win32 } from "node:path";

import { getHostPlatform, type HostPlatform } from "../platform.js";

/**
 * Expand `~` and `~/…` prefixed paths relative to `homeDir`;
 * otherwise resolve to an absolute path.
 *
 * Shared by config parsing and project discovery.
 */
export function expandHomePath(inputPath: string, homeDir: string): string {
  if (inputPath === "~") {
    return homeDir;
  }

  if (inputPath.startsWith("~/")) {
    return join(homeDir, inputPath.slice(2));
  }

  if (inputPath.startsWith("~\\")) {
    return join(homeDir, inputPath.slice(2));
  }

  return resolve(inputPath);
}

function trimTrailingSeparator(inputPath: string, pathSeparator: string): string {
  if (inputPath.length <= 1) {
    return inputPath;
  }

  return inputPath.replace(new RegExp(`${pathSeparator}+$`, "u"), "");
}

export function normalizeComparablePath(
  inputPath: string,
  platform: HostPlatform = getHostPlatform()
): string {
  if (platform === "win32") {
    const resolved = win32.normalize(win32.resolve(inputPath));
    return trimTrailingSeparator(resolved, "\\\\").toLowerCase();
  }

  return trimTrailingSeparator(posix.normalize(posix.resolve(inputPath)), "/");
}

export function pathsOverlap(
  left: string,
  right: string,
  platform: HostPlatform = getHostPlatform()
): boolean {
  const normalizedLeft = normalizeComparablePath(left, platform);
  const normalizedRight = normalizeComparablePath(right, platform);
  const pathSeparator = platform === "win32" ? "\\" : "/";

  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}${pathSeparator}`)
    || normalizedRight.startsWith(`${normalizedLeft}${pathSeparator}`);
}

export function pathStartsWithin(
  path: string,
  prefix: string,
  platform: HostPlatform = getHostPlatform()
): boolean {
  const normalizedPath = normalizeComparablePath(path, platform);
  const normalizedPrefix = normalizeComparablePath(prefix, platform);
  const pathSeparator = platform === "win32" ? "\\" : "/";

  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}${pathSeparator}`);
}
