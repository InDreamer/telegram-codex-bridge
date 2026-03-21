import test from "node:test";
import assert from "node:assert/strict";

import { routeBridgeCommand } from "./command-router.js";
import { TELEGRAM_COMMANDS } from "../telegram/commands.js";

function createHandlers(calls: string[]) {
  return {
    sendHelp: async () => { calls.push("sendHelp"); },
    sendStatus: async () => { calls.push("sendStatus"); },
    handleHub: async () => { calls.push("handleHub"); },
    handleNew: async () => { calls.push("handleNew"); },
    handleBrowse: async () => { calls.push("handleBrowse"); },
    handleCancel: async () => { calls.push("handleCancel"); },
    handleSessions: async () => { calls.push("handleSessions"); },
    handleArchive: async () => { calls.push("handleArchive"); },
    sendWhere: async () => { calls.push("sendWhere"); },
    handleInterrupt: async () => { calls.push("handleInterrupt"); },
    handleInspect: async () => { calls.push("handleInspect"); },
    handleRuntime: async () => { calls.push("handleRuntime"); },
    handleLanguage: async () => { calls.push("handleLanguage"); },
    handleUse: async () => { calls.push("handleUse"); },
    handleUnarchive: async () => { calls.push("handleUnarchive"); },
    handleRename: async () => { calls.push("handleRename"); },
    handlePin: async () => { calls.push("handlePin"); },
    handlePlan: async () => { calls.push("handlePlan"); },
    handleModel: async () => { calls.push("handleModel"); },
    handleSkills: async () => { calls.push("handleSkills"); },
    handleSkill: async () => { calls.push("handleSkill"); },
    handlePlugins: async () => { calls.push("handlePlugins"); },
    handlePlugin: async () => { calls.push("handlePlugin"); },
    handleApps: async () => { calls.push("handleApps"); },
    handleMcp: async () => { calls.push("handleMcp"); },
    handleAccount: async () => { calls.push("handleAccount"); },
    handleReview: async () => { calls.push("handleReview"); },
    handleFork: async () => { calls.push("handleFork"); },
    handleRollback: async () => { calls.push("handleRollback"); },
    handleCompact: async () => { calls.push("handleCompact"); },
    handleLocalImage: async () => { calls.push("handleLocalImage"); },
    handleMention: async () => { calls.push("handleMention"); },
    handleThread: async () => { calls.push("handleThread"); },
    sendUnsupported: async () => { calls.push("sendUnsupported"); }
  };
}

test("routeBridgeCommand routes every synced command through the registry", async () => {
  for (const entry of TELEGRAM_COMMANDS) {
    const calls: string[] = [];
    await routeBridgeCommand(entry.command, createHandlers(calls));
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0], "sendUnsupported");
  }
});

test("routeBridgeCommand keeps help aliases and unsupported fallback aligned with the registry", async () => {
  const calls: string[] = [];
  const handlers = createHandlers(calls);

  await routeBridgeCommand("start", handlers);
  await routeBridgeCommand("commands", handlers);
  await routeBridgeCommand("does_not_exist", handlers);

  assert.deepEqual(calls, ["sendHelp", "sendHelp", "sendUnsupported"]);
});
