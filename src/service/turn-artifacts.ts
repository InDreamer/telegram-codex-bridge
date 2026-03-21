import type { CodexAppServerClient } from "../codex/app-server.js";

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
  turnId: string
): Promise<{ finalMessage: string | null; proposedPlan: string | null }> {
  const resumed = await appServer.resumeThread(threadId);
  const targetTurn = resumed.thread.turns.find((turn) => turn.id === turnId);
  if (!targetTurn) {
    return {
      finalMessage: null,
      proposedPlan: null
    };
  }

  const finalItem = targetTurn.items.find(
    (item) => item.type === "agentMessage" && item.phase === "final_answer" && hasMeaningfulText(item.text)
  );
  const reviewExitItem = [...targetTurn.items].reverse().find(
    (item) => item.type === "exitedReviewMode" && hasMeaningfulText(item.review)
  );
  const reviewAgentMessage = reviewExitItem
    ? [...targetTurn.items].reverse().find(
      (item) => item.type === "agentMessage" && item.phase !== "commentary" && hasMeaningfulText(item.text)
    )
    : null;
  const planItem = [...targetTurn.items].reverse().find(
    (item) => item.type === "plan" && typeof item.text === "string"
  );
  return {
    finalMessage: finalItem?.text ?? reviewExitItem?.review ?? reviewAgentMessage?.text ?? null,
    proposedPlan: planItem?.text ?? null
  };
}

function hasMeaningfulText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
