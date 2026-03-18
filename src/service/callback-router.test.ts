import test from "node:test";
import assert from "node:assert/strict";

import { routeBridgeCallback } from "./callback-router.js";
import type { ParsedCallbackData } from "../telegram/ui.js";

type Call = { name: string; args: unknown[] };

function createHandlers(calls: Call[]) {
  return {
    answer: async (text?: string) => {
      calls.push({ name: "answer", args: [text] });
    },
    handleProjectPick: async (projectKey: string) => {
      calls.push({ name: "handleProjectPick", args: [projectKey] });
    },
    handleScanMore: async () => {
      calls.push({ name: "handleScanMore", args: [] });
    },
    enterManualPathMode: async () => {
      calls.push({ name: "enterManualPathMode", args: [] });
    },
    returnToProjectPicker: async () => {
      calls.push({ name: "returnToProjectPicker", args: [] });
    },
    confirmManualProject: async (projectKey: string) => {
      calls.push({ name: "confirmManualProject", args: [projectKey] });
    },
    handleBrowseAction: async (
      parsed: Extract<
        ParsedCallbackData,
        | { kind: "browse_open" }
        | { kind: "browse_page" }
        | { kind: "browse_up" }
        | { kind: "browse_root" }
        | { kind: "browse_refresh" }
        | { kind: "browse_back" }
        | { kind: "browse_close" }
      >
    ) => {
      calls.push({ name: "handleBrowseAction", args: [parsed] });
    },
    beginSessionRename: async (sessionId: string) => {
      calls.push({ name: "beginSessionRename", args: [sessionId] });
    },
    beginProjectRename: async (sessionId: string) => {
      calls.push({ name: "beginProjectRename", args: [sessionId] });
    },
    clearProjectAlias: async (sessionId: string) => {
      calls.push({ name: "clearProjectAlias", args: [sessionId] });
    },
    handleModelDefault: async (sessionId: string) => {
      calls.push({ name: "handleModelDefault", args: [sessionId] });
    },
    handleModelPage: async (sessionId: string, page: number) => {
      calls.push({ name: "handleModelPage", args: [sessionId, page] });
    },
    handleModelPick: async (sessionId: string, modelIndex: number) => {
      calls.push({ name: "handleModelPick", args: [sessionId, modelIndex] });
    },
    handleModelEffort: async (sessionId: string, modelIndex: number, effort: string | null) => {
      calls.push({ name: "handleModelEffort", args: [sessionId, modelIndex, effort] });
    },
    toggleStatusCardSection: async (sessionId: string, expanded: boolean, section: "plan" | "agents") => {
      calls.push({ name: "toggleStatusCardSection", args: [sessionId, expanded, section] });
    },
    renderPersistedFinalAnswer: async (answerId: string, mode: { expanded: boolean; page?: number }) => {
      calls.push({ name: "renderPersistedFinalAnswer", args: [answerId, mode] });
    },
    renderPersistedPlanResult: async (answerId: string, mode: { expanded: boolean; page?: number }) => {
      calls.push({ name: "renderPersistedPlanResult", args: [answerId, mode] });
    },
    handleRuntimePreferencesPage: async (token: string, page: number) => {
      calls.push({ name: "handleRuntimePreferencesPage", args: [token, page] });
    },
    handleRuntimePreferencesToggle: async (token: string, field: string) => {
      calls.push({ name: "handleRuntimePreferencesToggle", args: [token, field] });
    },
    handleRuntimePreferencesSave: async (token: string) => {
      calls.push({ name: "handleRuntimePreferencesSave", args: [token] });
    },
    handleRuntimePreferencesReset: async (token: string) => {
      calls.push({ name: "handleRuntimePreferencesReset", args: [token] });
    },
    handleLanguageSet: async (language: string) => {
      calls.push({ name: "handleLanguageSet", args: [language] });
    },
    handleInspectView: async (sessionId: string, options: { collapsed: boolean; page: number }) => {
      calls.push({ name: "handleInspectView", args: [sessionId, options] });
    },
    handlePlanImplement: async (sessionId: string) => {
      calls.push({ name: "handlePlanImplement", args: [sessionId] });
    },
    handleRollbackList: async (sessionId: string, page: number) => {
      calls.push({ name: "handleRollbackList", args: [sessionId, page] });
    },
    handleRollbackPick: async (sessionId: string, page: number, targetIndex: number) => {
      calls.push({ name: "handleRollbackPick", args: [sessionId, page, targetIndex] });
    },
    handleRollbackConfirm: async (sessionId: string, targetIndex: number) => {
      calls.push({ name: "handleRollbackConfirm", args: [sessionId, targetIndex] });
    },
    handleInteractionDecision: async (parsed: Extract<ParsedCallbackData, { kind: "interaction_decision" }>) => {
      calls.push({ name: "handleInteractionDecision", args: [parsed] });
    },
    handleInteractionQuestion: async (parsed: Extract<ParsedCallbackData, { kind: "interaction_question" }>) => {
      calls.push({ name: "handleInteractionQuestion", args: [parsed] });
    },
    handleInteractionText: async (parsed: Extract<ParsedCallbackData, { kind: "interaction_text" }>) => {
      calls.push({ name: "handleInteractionText", args: [parsed] });
    },
    handleInteractionCancel: async (interactionId: string) => {
      calls.push({ name: "handleInteractionCancel", args: [interactionId] });
    },
    handleInteractionAnswerToggle: async (interactionId: string, expanded: boolean) => {
      calls.push({ name: "handleInteractionAnswerToggle", args: [interactionId, expanded] });
    }
  };
}

test("project picker and rename callbacks acknowledge before delegating", async () => {
  const cases: Array<{ parsed: ParsedCallbackData; expected: Call[] }> = [
    {
      parsed: { kind: "pick", projectKey: "project-1" },
      expected: [
        { name: "answer", args: [undefined] },
        { name: "handleProjectPick", args: ["project-1"] }
      ]
    },
    {
      parsed: { kind: "scan_more" },
      expected: [
        { name: "answer", args: [undefined] },
        { name: "handleScanMore", args: [] }
      ]
    },
    {
      parsed: { kind: "path_manual" },
      expected: [
        { name: "answer", args: [undefined] },
        { name: "enterManualPathMode", args: [] }
      ]
    },
    {
      parsed: { kind: "path_back" },
      expected: [
        { name: "answer", args: [undefined] },
        { name: "returnToProjectPicker", args: [] }
      ]
    },
    {
      parsed: { kind: "path_confirm", projectKey: "project-2" },
      expected: [
        { name: "answer", args: [undefined] },
        { name: "confirmManualProject", args: ["project-2"] }
      ]
    },
    {
      parsed: { kind: "browse_open", token: "tok", entryIndex: 1 },
      expected: [
        { name: "handleBrowseAction", args: [{ kind: "browse_open", token: "tok", entryIndex: 1 }] }
      ]
    },
    {
      parsed: { kind: "browse_close", token: "tok" },
      expected: [
        { name: "handleBrowseAction", args: [{ kind: "browse_close", token: "tok" }] }
      ]
    },
    {
      parsed: { kind: "rename_session", sessionId: "session-1" },
      expected: [
        { name: "answer", args: [undefined] },
        { name: "beginSessionRename", args: ["session-1"] }
      ]
    },
    {
      parsed: { kind: "rename_project", sessionId: "session-2" },
      expected: [
        { name: "answer", args: [undefined] },
        { name: "beginProjectRename", args: ["session-2"] }
      ]
    },
    {
      parsed: { kind: "rename_project_clear", sessionId: "session-3" },
      expected: [
        { name: "answer", args: [undefined] },
        { name: "clearProjectAlias", args: ["session-3"] }
      ]
    }
  ];

  for (const { parsed, expected } of cases) {
    const calls: Call[] = [];
    await routeBridgeCallback(parsed, createHandlers(calls));
    assert.deepEqual(calls, expected);
  }
});

test("model, runtime, and language callbacks delegate to specialized handlers", async () => {
  const cases: Array<{ parsed: ParsedCallbackData; expected: Call[] }> = [
    { parsed: { kind: "model_default", sessionId: "session-1" }, expected: [{ name: "handleModelDefault", args: ["session-1"] }] },
    { parsed: { kind: "model_page", sessionId: "session-2", page: 3 }, expected: [{ name: "handleModelPage", args: ["session-2", 3] }] },
    { parsed: { kind: "model_pick", sessionId: "session-3", modelIndex: 4 }, expected: [{ name: "handleModelPick", args: ["session-3", 4] }] },
    { parsed: { kind: "model_effort", sessionId: "session-4", modelIndex: 1, effort: "high" }, expected: [{ name: "handleModelEffort", args: ["session-4", 1, "high"] }] },
    { parsed: { kind: "runtime_page", token: "tok", page: 2 }, expected: [{ name: "handleRuntimePreferencesPage", args: ["tok", 2] }] },
    { parsed: { kind: "runtime_toggle", token: "tok", field: "plan_mode" }, expected: [{ name: "handleRuntimePreferencesToggle", args: ["tok", "plan_mode"] }] },
    { parsed: { kind: "runtime_save", token: "tok" }, expected: [{ name: "handleRuntimePreferencesSave", args: ["tok"] }] },
    { parsed: { kind: "runtime_reset", token: "tok" }, expected: [{ name: "handleRuntimePreferencesReset", args: ["tok"] }] },
    { parsed: { kind: "language_set", language: "en" }, expected: [{ name: "handleLanguageSet", args: ["en"] }] }
  ];

  for (const { parsed, expected } of cases) {
    const calls: Call[] = [];
    await routeBridgeCallback(parsed, createHandlers(calls));
    assert.deepEqual(calls, expected);
  }
});

test("status-card, inspect, and persisted-result callbacks preserve their routing semantics", async () => {
  const cases: Array<{ parsed: ParsedCallbackData; expected: Call[] }> = [
    { parsed: { kind: "plan_expand", sessionId: "session-1" }, expected: [{ name: "toggleStatusCardSection", args: ["session-1", true, "plan"] }] },
    { parsed: { kind: "agent_collapse", sessionId: "session-2" }, expected: [{ name: "toggleStatusCardSection", args: ["session-2", false, "agents"] }] },
    { parsed: { kind: "final_open", answerId: "answer-1" }, expected: [{ name: "renderPersistedFinalAnswer", args: ["answer-1", { expanded: true, page: 1 }] }] },
    { parsed: { kind: "final_page", answerId: "answer-2", page: 4 }, expected: [{ name: "renderPersistedFinalAnswer", args: ["answer-2", { expanded: true, page: 4 }] }] },
    { parsed: { kind: "plan_result_close", answerId: "answer-3" }, expected: [{ name: "renderPersistedPlanResult", args: ["answer-3", { expanded: false }] }] },
    { parsed: { kind: "inspect_expand", sessionId: "session-3", page: 1 }, expected: [{ name: "handleInspectView", args: ["session-3", { collapsed: false, page: 1 }] }] },
    { parsed: { kind: "inspect_collapse", sessionId: "session-4" }, expected: [{ name: "handleInspectView", args: ["session-4", { collapsed: true, page: 0 }] }] },
    { parsed: { kind: "plan_implement", sessionId: "session-5" }, expected: [{ name: "handlePlanImplement", args: ["session-5"] }] }
  ];

  for (const { parsed, expected } of cases) {
    const calls: Call[] = [];
    await routeBridgeCallback(parsed, createHandlers(calls));
    assert.deepEqual(calls, expected);
  }
});

test("rollback and interaction callbacks keep their parsed payloads intact", async () => {
  const cases: Array<{ parsed: ParsedCallbackData; expected: Call[] }> = [
    { parsed: { kind: "rollback_back", sessionId: "session-1", page: 2 }, expected: [{ name: "handleRollbackList", args: ["session-1", 2] }] },
    { parsed: { kind: "rollback_pick", sessionId: "session-2", page: 1, targetIndex: 3 }, expected: [{ name: "handleRollbackPick", args: ["session-2", 1, 3] }] },
    { parsed: { kind: "rollback_confirm", sessionId: "session-3", targetIndex: 4 }, expected: [{ name: "handleRollbackConfirm", args: ["session-3", 4] }] },
    { parsed: { kind: "interaction_decision", interactionId: "ix-1", decisionKey: "accept", decisionIndex: 0 }, expected: [{ name: "handleInteractionDecision", args: [{ kind: "interaction_decision", interactionId: "ix-1", decisionKey: "accept", decisionIndex: 0 }] }] },
    { parsed: { kind: "interaction_question", interactionId: "ix-2", questionId: "q-1", questionIndex: 0, optionIndex: 2 }, expected: [{ name: "handleInteractionQuestion", args: [{ kind: "interaction_question", interactionId: "ix-2", questionId: "q-1", questionIndex: 0, optionIndex: 2 }] }] },
    { parsed: { kind: "interaction_text", interactionId: "ix-3", questionId: "q-2", questionIndex: 1 }, expected: [{ name: "handleInteractionText", args: [{ kind: "interaction_text", interactionId: "ix-3", questionId: "q-2", questionIndex: 1 }] }] },
    { parsed: { kind: "interaction_cancel", interactionId: "ix-4" }, expected: [{ name: "handleInteractionCancel", args: ["ix-4"] }] },
    { parsed: { kind: "interaction_answer_expand", interactionId: "ix-5" }, expected: [{ name: "handleInteractionAnswerToggle", args: ["ix-5", true] }] },
    { parsed: { kind: "interaction_answer_collapse", interactionId: "ix-6" }, expected: [{ name: "handleInteractionAnswerToggle", args: ["ix-6", false] }] }
  ];

  for (const { parsed, expected } of cases) {
    const calls: Call[] = [];
    await routeBridgeCallback(parsed, createHandlers(calls));
    assert.deepEqual(calls, expected);
  }
});
