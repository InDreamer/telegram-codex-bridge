import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TurnDebugJournal } from "./debug-journal.js";
import { getBridgePaths, getDebugRuntimeDir } from "../paths.js";

test("bridge paths expose a canonical debug runtime directory", () => {
  const homeDir = process.platform === "win32" ? "C:\\Users\\bridge" : "/tmp/home";
  const paths = getBridgePaths("file:///tmp/repo/src/cli.ts", homeDir);
  const debugDir = getDebugRuntimeDir(paths.runtimeDir);

  if (process.platform === "win32") {
    assert.match(debugDir, /codex-telegram-bridge\\runtime\\debug$/u);
    return;
  }

  assert.equal(debugDir, "/tmp/home/.local/state/codex-telegram-bridge/runtime/debug");
});

test("turn debug journal writes newline-delimited JSON records under thread and turn paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-debug-journal-"));

  try {
    const journal = new TurnDebugJournal({
      debugRootDir: root,
      threadId: "thread-1",
      turnId: "turn-1"
    });

    await journal.append({
      receivedAt: "2026-03-10T12:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      method: "item/mcpToolCall/progress",
      params: {
        message: "Searching docs"
      }
    });

    assert.match(journal.filePath, /thread-1\/turn-1\.jsonl$/u);
    const fileText = await readFile(journal.filePath, "utf8");
    const record = JSON.parse(fileText.trim()) as { method: string; params: { message: string } };
    assert.equal(record.method, "item/mcpToolCall/progress");
    assert.equal(record.params.message, "Searching docs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
