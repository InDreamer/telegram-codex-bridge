import type { CodexAppServerClient } from "../codex/app-server.js";

type HistoryTurn = Awaited<ReturnType<CodexAppServerClient["resumeThread"]>>["thread"]["turns"][number];
type FinalMessageSource = "final_answer" | "review_exit" | "agent_message" | null;

export interface TurnArtifactsFromHistory {
  finalMessage: string | null;
  finalMessageSource: FinalMessageSource;
  proposedPlan: string | null;
  requestedTurnFound: boolean;
  usedReviewFallback: boolean;
  reviewArtifactsPresent: boolean;
  resolvedTurnId: string | null;
}

export async function extractFinalAnswerFromHistory(
  appServer: CodexAppServerClient,
  threadId: string,
  turnId: string
): Promise<string | null> {
  const artifacts = await extractTurnArtifactsFromHistory(appServer, threadId, turnId);
  return artifacts.finalMessage ?? artifacts.proposedPlan;
}

export async function extractTurnArtifactsFromHistory(
  appServer: CodexAppServerClient,
  threadId: string,
  turnId: string,
  options?: {
    allowReviewFallback?: boolean;
  }
): Promise<TurnArtifactsFromHistory> {
  const resumed = await appServer.resumeThread(threadId);
  const targetTurn = resumed.thread.turns.find((turn) => turn.id === turnId) ?? null;
  const requestedTurnFound = targetTurn !== null;
  const fallbackTurn = !requestedTurnFound && options?.allowReviewFallback
    ? findMostRecentCompletedReviewTurn(resumed.thread.turns)
    : null;
  const resolvedTurn = targetTurn ?? fallbackTurn;
  const extracted = resolvedTurn ? extractArtifactsFromTurn(resolvedTurn) : null;
  const reviewArtifactsPresent = requestedTurnFound
    ? turnContainsReviewArtifacts(targetTurn)
    : fallbackTurn !== null;

  if (!resolvedTurn) {
    return {
      finalMessage: null,
      finalMessageSource: null,
      proposedPlan: null,
      requestedTurnFound,
      usedReviewFallback: false,
      reviewArtifactsPresent,
      resolvedTurnId: null
    };
  }

  return {
    finalMessage: extracted?.finalMessage ?? null,
    finalMessageSource: extracted?.finalMessageSource ?? null,
    proposedPlan: extracted?.proposedPlan ?? null,
    requestedTurnFound,
    usedReviewFallback: fallbackTurn !== null,
    reviewArtifactsPresent,
    resolvedTurnId: resolvedTurn.id
  };
}

function extractArtifactsFromTurn(targetTurn: HistoryTurn): {
  finalMessage: string | null;
  finalMessageSource: FinalMessageSource;
  proposedPlan: string | null;
} {
  const finalItem = targetTurn.items.find(
    (item) => item.type === "agentMessage" && item.phase === "final_answer" && hasMeaningfulText(item.text)
  );
  const reviewExitItem = [...targetTurn.items].reverse().find(
    (item) => item.type === "exitedReviewMode" && hasMeaningfulText(item.review)
  );
  const trailingAgentMessage = [...targetTurn.items].reverse().find(
    (item) => item.type === "agentMessage" && item.phase !== "commentary" && hasMeaningfulText(item.text)
  );
  const planItem = [...targetTurn.items].reverse().find(
    (item) => item.type === "plan" && typeof item.text === "string"
  );

  if (finalItem) {
    return {
      finalMessage: finalItem.text ?? null,
      finalMessageSource: "final_answer",
      proposedPlan: planItem?.text ?? null
    };
  }

  if (reviewExitItem) {
    return {
      finalMessage: reviewExitItem.review ?? null,
      finalMessageSource: "review_exit",
      proposedPlan: planItem?.text ?? null
    };
  }

  if (trailingAgentMessage) {
    return {
      finalMessage: trailingAgentMessage.text ?? null,
      finalMessageSource: "agent_message",
      proposedPlan: planItem?.text ?? null
    };
  }

  return {
    finalMessage: null,
    finalMessageSource: null,
    proposedPlan: planItem?.text ?? null
  };
}

function findMostRecentCompletedReviewTurn(turns: HistoryTurn[]): HistoryTurn | null {
  return [...turns].reverse().find(
    (turn) => (turn.status ?? "completed") === "completed" && turnContainsReviewArtifacts(turn)
  ) ?? null;
}

function turnContainsReviewArtifacts(turn: HistoryTurn): boolean {
  return turn.items.some((item) => item.type === "exitedReviewMode");
}

function hasMeaningfulText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
