import { join, resolve } from "node:path";

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

  return resolve(inputPath);
}
