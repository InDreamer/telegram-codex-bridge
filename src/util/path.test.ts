import test from "node:test";
import assert from "node:assert/strict";

import { normalizeComparablePath, pathsOverlap } from "./path.js";

test("normalizeComparablePath folds Windows paths to one case", () => {
  assert.equal(
    normalizeComparablePath("C:\\Users\\Alice\\Projects\\", "win32"),
    "c:\\users\\alice\\projects"
  );
});

test("pathsOverlap treats differently cased Windows roots as overlapping", () => {
  assert.equal(
    pathsOverlap("C:\\Users\\Alice\\Projects", "c:\\users\\alice\\projects\\demo", "win32"),
    true
  );
  assert.equal(
    pathsOverlap("C:\\Users\\Alice\\Projects", "c:\\users\\alice\\projects", "win32"),
    true
  );
});
