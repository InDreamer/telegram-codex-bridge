import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { BridgePaths } from "../paths.js";

export async function readRepoPackageJson<T>(paths: BridgePaths): Promise<T> {
  return JSON.parse(await readFile(join(paths.repoRoot, "package.json"), "utf8")) as T;
}
