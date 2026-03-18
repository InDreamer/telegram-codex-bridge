import type { ParsedCallbackData } from "../telegram/ui.js";
import type { ReasoningEffort, RuntimeStatusField, UiLanguage } from "../types.js";

export interface BridgeCallbackRouterHandlers {
  answer(text?: string): Promise<void>;
  handleProjectPick(projectKey: string): Promise<void>;
  handleScanMore(): Promise<void>;
  enterManualPathMode(): Promise<void>;
  returnToProjectPicker(): Promise<void>;
  confirmManualProject(projectKey: string): Promise<void>;
  beginSessionRename(sessionId: string): Promise<void>;
  beginProjectRename(sessionId: string): Promise<void>;
  clearProjectAlias(sessionId: string): Promise<void>;
  handleModelDefault(sessionId: string): Promise<void>;
  handleModelPage(sessionId: string, page: number): Promise<void>;
  handleModelPick(sessionId: string, modelIndex: number): Promise<void>;
  handleModelEffort(sessionId: string, modelIndex: number, effort: ReasoningEffort | null): Promise<void>;
  toggleStatusCardSection(sessionId: string, expanded: boolean, section: "plan" | "agents"): Promise<void>;
  renderPersistedFinalAnswer(answerId: string, mode: { expanded: boolean; page?: number }): Promise<void>;
  renderPersistedPlanResult(answerId: string, mode: { expanded: boolean; page?: number }): Promise<void>;
  handleRuntimePreferencesPage(token: string, page: number): Promise<void>;
  handleRuntimePreferencesToggle(token: string, field: RuntimeStatusField): Promise<void>;
  handleRuntimePreferencesSave(token: string): Promise<void>;
  handleRuntimePreferencesReset(token: string): Promise<void>;
  handleLanguageSet(language: UiLanguage): Promise<void>;
  handleInspectView(sessionId: string, options: { collapsed: boolean; page: number }): Promise<void>;
  handlePlanImplement(sessionId: string): Promise<void>;
  handleRollbackList(sessionId: string, page: number): Promise<void>;
  handleRollbackPick(sessionId: string, page: number, targetIndex: number): Promise<void>;
  handleRollbackConfirm(sessionId: string, targetIndex: number): Promise<void>;
  handleInteractionDecision(parsed: Extract<ParsedCallbackData, { kind: "interaction_decision" }>): Promise<void>;
  handleInteractionQuestion(parsed: Extract<ParsedCallbackData, { kind: "interaction_question" }>): Promise<void>;
  handleInteractionText(parsed: Extract<ParsedCallbackData, { kind: "interaction_text" }>): Promise<void>;
  handleInteractionCancel(interactionId: string): Promise<void>;
  handleInteractionAnswerToggle(interactionId: string, expanded: boolean): Promise<void>;
}

export async function routeBridgeCallback(
  parsed: ParsedCallbackData,
  handlers: BridgeCallbackRouterHandlers
): Promise<void> {
  switch (parsed.kind) {
    case "pick":
      await handlers.answer();
      await handlers.handleProjectPick(parsed.projectKey);
      return;
    case "scan_more":
      await handlers.answer();
      await handlers.handleScanMore();
      return;
    case "path_manual":
      await handlers.answer();
      await handlers.enterManualPathMode();
      return;
    case "path_back":
      await handlers.answer();
      await handlers.returnToProjectPicker();
      return;
    case "path_confirm":
      await handlers.answer();
      await handlers.confirmManualProject(parsed.projectKey);
      return;
    case "rename_session":
      await handlers.answer();
      await handlers.beginSessionRename(parsed.sessionId);
      return;
    case "rename_project":
      await handlers.answer();
      await handlers.beginProjectRename(parsed.sessionId);
      return;
    case "rename_project_clear":
      await handlers.answer();
      await handlers.clearProjectAlias(parsed.sessionId);
      return;
    case "model_default":
      await handlers.handleModelDefault(parsed.sessionId);
      return;
    case "model_page":
      await handlers.handleModelPage(parsed.sessionId, parsed.page);
      return;
    case "model_pick":
      await handlers.handleModelPick(parsed.sessionId, parsed.modelIndex);
      return;
    case "model_effort":
      await handlers.handleModelEffort(parsed.sessionId, parsed.modelIndex, parsed.effort);
      return;
    case "plan_expand":
      await handlers.toggleStatusCardSection(parsed.sessionId, true, "plan");
      return;
    case "plan_collapse":
      await handlers.toggleStatusCardSection(parsed.sessionId, false, "plan");
      return;
    case "agent_expand":
      await handlers.toggleStatusCardSection(parsed.sessionId, true, "agents");
      return;
    case "agent_collapse":
      await handlers.toggleStatusCardSection(parsed.sessionId, false, "agents");
      return;
    case "final_open":
      await handlers.renderPersistedFinalAnswer(parsed.answerId, { expanded: true, page: 1 });
      return;
    case "final_close":
      await handlers.renderPersistedFinalAnswer(parsed.answerId, { expanded: false });
      return;
    case "final_page":
      await handlers.renderPersistedFinalAnswer(parsed.answerId, { expanded: true, page: parsed.page });
      return;
    case "plan_result_open":
      await handlers.renderPersistedPlanResult(parsed.answerId, { expanded: true, page: 1 });
      return;
    case "plan_result_close":
      await handlers.renderPersistedPlanResult(parsed.answerId, { expanded: false });
      return;
    case "plan_result_page":
      await handlers.renderPersistedPlanResult(parsed.answerId, { expanded: true, page: parsed.page });
      return;
    case "runtime_page":
      await handlers.handleRuntimePreferencesPage(parsed.token, parsed.page);
      return;
    case "runtime_toggle":
      await handlers.handleRuntimePreferencesToggle(parsed.token, parsed.field);
      return;
    case "runtime_save":
      await handlers.handleRuntimePreferencesSave(parsed.token);
      return;
    case "runtime_reset":
      await handlers.handleRuntimePreferencesReset(parsed.token);
      return;
    case "language_set":
      await handlers.handleLanguageSet(parsed.language);
      return;
    case "inspect_expand":
    case "inspect_page":
      await handlers.handleInspectView(parsed.sessionId, { collapsed: false, page: parsed.page });
      return;
    case "inspect_collapse":
      await handlers.handleInspectView(parsed.sessionId, { collapsed: true, page: 0 });
      return;
    case "plan_implement":
      await handlers.handlePlanImplement(parsed.sessionId);
      return;
    case "rollback_page":
    case "rollback_back":
      await handlers.handleRollbackList(parsed.sessionId, parsed.page);
      return;
    case "rollback_pick":
      await handlers.handleRollbackPick(parsed.sessionId, parsed.page, parsed.targetIndex);
      return;
    case "rollback_confirm":
      await handlers.handleRollbackConfirm(parsed.sessionId, parsed.targetIndex);
      return;
    case "interaction_decision":
      await handlers.handleInteractionDecision(parsed);
      return;
    case "interaction_question":
      await handlers.handleInteractionQuestion(parsed);
      return;
    case "interaction_text":
      await handlers.handleInteractionText(parsed);
      return;
    case "interaction_cancel":
      await handlers.handleInteractionCancel(parsed.interactionId);
      return;
    case "interaction_answer_expand":
      await handlers.handleInteractionAnswerToggle(parsed.interactionId, true);
      return;
    case "interaction_answer_collapse":
      await handlers.handleInteractionAnswerToggle(parsed.interactionId, false);
      return;
  }

  const exhaustive: never = parsed;
  return exhaustive;
}
