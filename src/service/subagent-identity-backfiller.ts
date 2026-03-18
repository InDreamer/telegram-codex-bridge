import type { SubagentIdentityEvent, ActivityTracker } from "../activity/tracker.js";
import type { CollabAgentStateSnapshot } from "../activity/types.js";
import type { CodexAppServerClient } from "../codex/app-server.js";
import type { Logger } from "../logger.js";
import { getString } from "../util/untyped.js";

interface SubagentIdentityBackfillActiveTurn {
  sessionId: string;
  chatId: string;
  threadId: string;
  turnId: string;
  tracker: Pick<ActivityTracker, "applyResolvedSubagentIdentity" | "drainSubagentIdentityEvents" | "getInspectSnapshot">;
  subagentIdentityBackfillStates: Map<string, "pending" | "resolved" | "exhausted">;
}

interface SubagentIdentityBackfillerDeps {
  logger: Logger;
  getAppServer: () => Pick<CodexAppServerClient, "readThread"> | null;
}

export class SubagentIdentityBackfiller {
  constructor(private readonly deps: SubagentIdentityBackfillerDeps) {}

  async backfill(
    activeTurn: SubagentIdentityBackfillActiveTurn,
    agentEntries: CollabAgentStateSnapshot[]
  ): Promise<boolean> {
    const appServer = this.deps.getAppServer();
    if (!appServer?.readThread) {
      return false;
    }

    const candidates = agentEntries.filter((agent) => {
      if (agent.labelSource === "nickname") {
        return false;
      }
      const backfillState = activeTurn.subagentIdentityBackfillStates.get(agent.threadId);
      return backfillState !== "pending" && backfillState !== "resolved" && backfillState !== "exhausted";
    });

    if (candidates.length === 0) {
      return false;
    }

    for (const agent of candidates) {
      activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "pending");
    }

    const fetchResults = await Promise.allSettled(
      candidates.map(async (agent) => {
        await this.deps.logger.info("subagent identity backfill requested", {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: agent.threadId
        });
        const result = await appServer.readThread(agent.threadId, false) as {
          thread?: {
            agentNickname?: string | null;
            agentRole?: string | null;
            name?: string | null;
          };
        };
        return { agent, thread: result.thread ?? null };
      })
    );

    let changed = false;
    for (const entry of fetchResults) {
      if (entry.status === "rejected") {
        continue;
      }

      const { agent, thread } = entry.value;
      try {
        const applied = thread
          ? activeTurn.tracker.applyResolvedSubagentIdentity(agent.threadId, {
            agentNickname: getString(thread, "agentNickname"),
            agentRole: getString(thread, "agentRole"),
            threadName: getString(thread, "name")
          })
          : false;
        await this.logSubagentIdentityEvents(activeTurn, activeTurn.tracker.drainSubagentIdentityEvents());

        const resolvedLabel = activeTurn.tracker.getInspectSnapshot().agentSnapshot
          .find((candidate) => candidate.threadId === agent.threadId);

        if (applied && resolvedLabel && resolvedLabel.labelSource !== "fallback") {
          changed = true;
          activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "resolved");
          await this.deps.logger.info("subagent identity backfill resolved", {
            sessionId: activeTurn.sessionId,
            chatId: activeTurn.chatId,
            threadId: activeTurn.threadId,
            turnId: activeTurn.turnId,
            subagentThreadId: agent.threadId,
            label: resolvedLabel.label,
            labelSource: resolvedLabel.labelSource
          });
          continue;
        }

        activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "exhausted");
        await this.deps.logger.info("subagent identity backfill exhausted", {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: agent.threadId
        });
      } catch (error) {
        activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "exhausted");
        await this.deps.logger.warn("subagent identity backfill failed", {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: agent.threadId,
          error: `${error}`
        });
      }
    }

    for (const [index, entry] of fetchResults.entries()) {
      if (entry.status === "rejected") {
        const agent = candidates[index]!;
        activeTurn.subagentIdentityBackfillStates.set(agent.threadId, "exhausted");
        await this.deps.logger.warn("subagent identity backfill failed", {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: agent.threadId,
          error: `${entry.reason}`
        });
      }
    }

    return changed;
  }

  private async logSubagentIdentityEvents(
    activeTurn: Pick<SubagentIdentityBackfillActiveTurn, "sessionId" | "chatId" | "threadId" | "turnId">,
    events: SubagentIdentityEvent[]
  ): Promise<void> {
    for (const event of events) {
      await this.deps.logger.info(
        event.kind === "cached" ? "subagent identity cached" : "subagent identity applied",
        {
          sessionId: activeTurn.sessionId,
          chatId: activeTurn.chatId,
          threadId: activeTurn.threadId,
          turnId: activeTurn.turnId,
          subagentThreadId: event.threadId,
          label: event.label,
          labelSource: event.labelSource,
          origin: event.origin
        }
      );
    }
  }
}
