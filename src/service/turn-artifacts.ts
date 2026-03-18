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
    (item) => item.type === "agentMessage" && item.phase === "final_answer" && typeof item.text === "string"
  );
  const planItem = [...targetTurn.items].reverse().find(
    (item) => item.type === "plan" && typeof item.text === "string"
  );
  return {
    finalMessage: finalItem?.text ?? null,
    proposedPlan: planItem?.text ?? null
  };
}
