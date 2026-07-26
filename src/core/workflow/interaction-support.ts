import type {
  NormalizedApprovalInteraction,
  NormalizedInteraction,
  NormalizedQuestion,
  NormalizedQuestionnaireInteraction
} from "../../interactions/normalize.js";
import { asRecord, getString, getStringArray } from "../../util/untyped.js";

export interface QuestionnaireDraft {
  answers: Record<string, unknown>;
  awaitingQuestionId?: string | null;
}

export function buildApprovalActions(interaction: NormalizedApprovalInteraction): Array<{ text: string; decisionKey: string }> {
  return interaction.decisionOptions
    .filter((option) => option.kind !== "cancel")
    .map((option) => ({
      decisionKey: option.key,
      text: option.label
    }));
}

export function buildAnsweredInteractionDetails(responseJson: string | null, interaction: NormalizedInteraction): string[] {
  if (interaction.kind !== "questionnaire") {
    return [];
  }

  const details: string[] = [];
  const payload = parseJsonRecord(responseJson);
  const answers = parseJsonRecord(payload?.answers);
  if (!answers) {
    return [];
  }

  for (const [index, question] of interaction.questions.entries()) {
    const answerRecord = parseJsonRecord(answers[question.id]);
    const answerList = extractAnsweredInteractionValues(answerRecord);
    if (!answerList) {
      continue;
    }

    details.push(`${index + 1}. ${question.header}`);
    details.push(`Q: ${question.question}`);
    details.push(`回答：${question.isSecret ? "Sensitive answer hidden" : answerList.join(", ")}`);
  }

  return details;
}

export function summarizeAnsweredInteractionForSurface(
  responseJson: string | null,
  interaction: NormalizedInteraction
): string | null {
  if (interaction.kind !== "questionnaire") {
    return summarizeAnsweredInteraction(responseJson, interaction);
  }

  const payload = parseJsonRecord(responseJson);
  const answers = parseJsonRecord(payload?.answers);
  if (!answers) {
    return summarizeAnsweredInteraction(responseJson, interaction);
  }

  const segments = interaction.questions
    .map((question) => {
      const answerRecord = parseJsonRecord(answers[question.id]);
      const answerList = extractAnsweredInteractionValues(answerRecord);
      if (!answerList) {
        return null;
      }

      const answerText = question.isSecret ? "Sensitive answer hidden" : answerList.join(", ");
      return `${question.header}: ${answerText}`;
    })
    .filter((value): value is string => Boolean(value));

  if (segments.length === 0) {
    return summarizeAnsweredInteraction(responseJson, interaction);
  }

  return `${interaction.title} / ${segments.join(" / ")}`;
}

export function summarizePermissions(value: unknown): string | null {
  const parts = collectPermissionSummaryParts(value);
  return parts.length > 0 ? parts.join("; ") : "No extra permissions";
}

export function formatPendingInteractionTerminalReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "app_server_lost":
      return "Codex disconnected, interaction stopped.";
    case "bridge_restart":
      return "Bridge restarted, interaction stopped.";
    case "response_dispatch_failed":
      return "Codex didn't receive the result.";
    case "turn_completed":
    case "turn_failed":
    case "turn_interrupted":
      return "Operation ended, interaction expired.";
    case "interaction_delivery_failed":
    case "telegram_delivery_failed":
      return "Could not deliver this interaction.";
    default:
      return reason ? "Cannot continue this interaction." : null;
  }
}

export function parseQuestionnaireDraft(responseJson: string | null): QuestionnaireDraft {
  if (!responseJson) {
    return { answers: {} };
  }

  try {
    const parsed = asRecord(JSON.parse(responseJson));
    return {
      answers: asRecord(parsed?.answers) ?? {},
      awaitingQuestionId: getString(parsed, "awaitingQuestionId")
    };
  } catch {
    return { answers: {} };
  }
}

export function getCurrentQuestion(
  interaction: NormalizedQuestionnaireInteraction,
  draft: QuestionnaireDraft
): NormalizedQuestion | null {
  if (draft.awaitingQuestionId) {
    return interaction.questions.find((question) => question.id === draft.awaitingQuestionId) ?? null;
  }

  return interaction.questions.find((question) => !hasDraftAnswer(draft, question.id)) ?? null;
}

export function findQuestionIndex(interaction: NormalizedQuestionnaireInteraction, questionId: string): number {
  return Math.max(0, interaction.questions.findIndex((question) => question.id === questionId));
}

export function hasDraftAnswer(draft: QuestionnaireDraft, questionId: string): boolean {
  return Object.prototype.hasOwnProperty.call(draft.answers, questionId);
}

function summarizeAnsweredInteraction(responseJson: string | null, interaction: NormalizedInteraction): string | null {
  const payload = parseJsonRecord(responseJson);
  switch (interaction.kind) {
    case "approval": {
      const decisionRecord = asRecord(payload?.decision);
      if (decisionRecord?.acceptWithExecpolicyAmendment) {
        return "Approved, rule updated";
      }
      if (decisionRecord?.applyNetworkPolicyAmendment) {
        const networkDecision = asRecord(decisionRecord.applyNetworkPolicyAmendment);
        const amendment = asRecord(networkDecision?.network_policy_amendment);
        const host = typeof amendment?.host === "string" ? amendment.host : null;
        return host ? `Approved, rule saved (${host})` : "Approved, rule saved";
      }

      const decision = typeof payload?.decision === "string" ? payload.decision : null;
      if (decision === "accept" || decision === "approved") {
        return "Approved";
      }
      if (decision === "acceptForSession" || decision === "approved_for_session") {
        return "Approved, cached for session";
      }
      if (decision === "decline" || decision === "denied") {
        return "Declined";
      }
      if (decision === "cancel" || decision === "abort") {
        return "Cancelled";
      }
      return "Handled";
    }
    case "permissions": {
      const scope = typeof payload?.scope === "string" ? payload.scope : "turn";
      const granted = summarizeGrantedPermissions(payload?.permissions ?? null);
      return granted ? `Authorized (${scope}): ${granted}` : `Declined (${scope})`;
    }
    case "elicitation": {
      const action = typeof payload?.action === "string" ? payload.action : null;
      return action === "accept" ? "Accepted" : action === "decline" ? "Declined" : action === "cancel" ? "Cancelled" : "Handled";
    }
    case "questionnaire": {
      const action = typeof payload?.action === "string" ? payload.action : null;
      if (action === "cancel") {
        return "Cancelled";
      }
      if (action === "decline") {
        return "Declined";
      }
      if (action === "accept") {
        const content = parseJsonRecord(payload?.content);
        const count = content ? Object.keys(content).length : 0;
        return count > 0 ? `Submitted ${count} field(s)` : "Form submitted";
      }

      const answers = parseJsonRecord(payload?.answers);
      const count = answers ? Object.keys(answers).length : 0;
      return count > 0 ? `Submitted ${count} answer(s)` : "Answer submitted";
    }
  }
}

function summarizeGrantedPermissions(value: unknown): string | null {
  const parts = collectPermissionSummaryParts(value);
  return parts.length > 0 ? parts.join("; ") : null;
}

function collectPermissionSummaryParts(value: unknown): string[] {
  const record = parseJsonRecord(value);
  if (!record) {
    return [];
  }

  const parts: string[] = [];
  const fileSystem = parseJsonRecord(record.fileSystem);
  if (fileSystem) {
    const read = Array.isArray(fileSystem.read) ? fileSystem.read.length : 0;
    const write = Array.isArray(fileSystem.write) ? fileSystem.write.length : 0;
    if (read > 0 || write > 0) {
      parts.push(`Filesystem R${read}/W${write}`);
    }
  }

  const network = parseJsonRecord(record.network);
  if (network?.enabled === true) {
    parts.push("Network");
  }

  const macos = parseJsonRecord(record.macos);
  if (macos) {
    parts.push("macOS Permissions");
  }

  return parts;
}

function extractAnsweredInteractionValues(record: Record<string, unknown> | null): string[] | null {
  if (!record) {
    return null;
  }

  const answers = getStringArray(record, "answers");
  return answers.length > 0 ? answers : null;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return parseJsonRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }

  return asRecord(value);
}
