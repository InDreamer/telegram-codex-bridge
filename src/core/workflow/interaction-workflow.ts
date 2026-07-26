import type {
  NormalizedInteraction,
} from "../../interactions/normalize.js";
import type { PersistedInteractionRecord } from "../domain/records.js";
import type { BridgeCommandActionView } from "../interaction-model/bridge-actions.js";
import type { InteractionCardView } from "../interaction-model/interaction.js";
import {
  buildAnsweredInteractionDetails,
  buildApprovalActions,
  findQuestionIndex,
  formatPendingInteractionTerminalReason,
  getCurrentQuestion,
  parseQuestionnaireDraft,
  summarizeAnsweredInteractionForSurface,
  summarizePermissions
} from "./interaction-support.js";

export function createInteractionCardView(
  row: PersistedInteractionRecord,
  interaction: NormalizedInteraction,
  options?: {
    answeredExpanded?: boolean;
    hubHint?: string | null;
    bridgeActions?: BridgeCommandActionView[];
  }
): InteractionCardView {
  const hubHint = options?.hubHint ?? null;
  const bridgeActions = options?.bridgeActions ?? [];

  if (row.state === "answered") {
    const details = buildAnsweredInteractionDetails(row.responseJson, interaction);
    return {
      kind: "resolved",
      title: interaction.title,
      state: "answered",
      summary: summarizeAnsweredInteractionForSurface(row.responseJson, interaction),
      details,
      expandable: details.length > 0,
      expanded: options?.answeredExpanded ?? false,
      interactionId: row.interactionId,
      hubHint,
      ...(bridgeActions.length > 0 ? { bridgeActions } : {})
    };
  }

  if (row.state === "canceled") {
    return {
      kind: "resolved",
      title: interaction.title,
      state: "canceled",
      summary: "Cancelled",
      details: [],
      expandable: false,
      expanded: false,
      ...(hubHint ? { hubHint } : {}),
      ...(bridgeActions.length > 0 ? { bridgeActions } : {})
    };
  }

  if (row.state === "failed") {
    return {
      kind: "resolved",
      title: interaction.title,
      state: "failed",
      summary: formatPendingInteractionTerminalReason(row.errorReason),
      details: [],
      expandable: false,
      expanded: false,
      hubHint: null
    };
  }

  if (row.state === "expired") {
    return {
      kind: "expired",
      title: interaction.title,
      reason: formatPendingInteractionTerminalReason(row.errorReason)
    };
  }

  switch (interaction.kind) {
    case "approval":
      return {
        kind: "approval",
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: interaction.subtitle,
        body: interaction.body,
        detail: interaction.detail,
        hubHint,
        ...(bridgeActions.length > 0 ? { bridgeActions } : {}),
        actions: buildApprovalActions(interaction)
      };
    case "permissions":
      return {
        kind: "approval",
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: interaction.subtitle,
        body: summarizePermissions(interaction.requestedPermissions),
        detail: interaction.detail,
        hubHint,
        ...(bridgeActions.length > 0 ? { bridgeActions } : {}),
        actions: [
          { text: "Approve permission", decisionKey: "accept" },
          { text: "Always allow this session", decisionKey: "acceptForSession" },
          { text: "Decline", decisionKey: "decline" }
        ]
      };
    case "elicitation":
      return {
        kind: "approval",
        interactionId: row.interactionId,
        title: interaction.title,
        subtitle: `MCP: ${interaction.serverName}`,
        body: interaction.message,
        detail: interaction.detail,
        hubHint,
        ...(bridgeActions.length > 0 ? { bridgeActions } : {}),
        actions: [
          { text: "Accept", decisionKey: "accept" },
          { text: "Decline", decisionKey: "decline" }
        ]
      };
    case "questionnaire": {
      const draft = parseQuestionnaireDraft(row.responseJson);
      const currentQuestion = getCurrentQuestion(interaction, draft);
      if (!currentQuestion) {
        return {
          kind: "resolved",
          title: interaction.title,
          state: "answered",
          summary: summarizeAnsweredInteractionForSurface(row.responseJson, interaction),
          details: [],
          expandable: false,
          expanded: false,
          ...(hubHint ? { hubHint } : {})
        };
      }

      return {
        kind: "question",
        interactionId: row.interactionId,
        title: interaction.title,
        questionId: currentQuestion.id,
        header: currentQuestion.header,
        question: currentQuestion.question,
        questionIndex: findQuestionIndex(interaction, currentQuestion.id) + 1,
        totalQuestions: interaction.questions.length,
        options: currentQuestion.options?.map((option) => ({
          label: option.label,
          description: option.description
        })) ?? null,
        isOther: currentQuestion.isOther,
          isSecret: currentQuestion.isSecret,
          awaitingText: row.state === "awaiting_text",
          hubHint,
          ...(bridgeActions.length > 0 ? { bridgeActions } : {})
        };
    }
  }
}
