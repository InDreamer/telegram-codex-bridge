import type { Logger } from "../logger.js";
import { classifyNotification } from "../codex/notification-classifier.js";
import type { BridgeStateStore } from "../state/store.js";
import { nowIso } from "../util/time.js";

export type PendingThreadArchiveState = "archived" | "unarchived";

export interface PendingThreadArchiveOp {
  id: number;
  sessionId: string;
  expectedRemoteState: PendingThreadArchiveState;
  requestedAt: string;
  origin: "telegram_archive" | "telegram_unarchive";
  localStateCommitted: boolean;
  remoteStateObserved: PendingThreadArchiveState | null;
}

type ThreadArchiveNotification = Extract<
  ReturnType<typeof classifyNotification>,
  { kind: "thread_archived" | "thread_unarchived" }
>;

interface ThreadArchiveReconcilerDeps {
  logger: Logger;
  getStore: () => BridgeStateStore | null;
}

export class ThreadArchiveReconciler {
  private readonly pendingThreadArchiveOps = new Map<string, PendingThreadArchiveOp[]>();
  private nextPendingThreadArchiveOpId = 1;

  constructor(private readonly deps: ThreadArchiveReconcilerDeps) {}

  get pendingOps(): ReadonlyMap<string, PendingThreadArchiveOp[]> {
    return this.pendingThreadArchiveOps;
  }

  registerPendingOp(
    threadId: string,
    sessionId: string,
    expectedRemoteState: PendingThreadArchiveState,
    origin: PendingThreadArchiveOp["origin"]
  ): number {
    const requestedAt = nowIso();
    const opId = this.nextPendingThreadArchiveOpId++;
    const pending: PendingThreadArchiveOp = {
      id: opId,
      sessionId,
      expectedRemoteState,
      requestedAt,
      origin,
      localStateCommitted: false,
      remoteStateObserved: null
    };
    const queue = this.pendingThreadArchiveOps.get(threadId) ?? [];
    queue.push(pending);
    this.pendingThreadArchiveOps.set(threadId, queue);
    void this.deps.logger.info("thread archive op registered", {
      opId,
      sessionId,
      threadId,
      expectedRemoteState,
      origin,
      requestedAt,
      pendingDepth: queue.length
    });
    return opId;
  }

  async markLocalCommit(threadId: string, opId: number | null): Promise<void> {
    if (opId === null) {
      return;
    }

    const pending = this.findPendingOp(threadId, opId);
    if (!pending) {
      return;
    }

    pending.localStateCommitted = true;
    if (pending.remoteStateObserved !== pending.expectedRemoteState) {
      return;
    }

    this.removePendingOp(threadId, opId);
    await this.deps.logger.info("thread archive op confirmed", {
      opId: pending.id,
      sessionId: pending.sessionId,
      threadId,
      expectedRemoteState: pending.expectedRemoteState,
      origin: pending.origin,
      requestedAt: pending.requestedAt
    });
  }

  dropPendingOp(threadId: string, opId: number | null): PendingThreadArchiveOp | null {
    if (opId === null) {
      return null;
    }

    return this.removePendingOp(threadId, opId);
  }

  async handleNotification(classified: ThreadArchiveNotification): Promise<void> {
    if (!classified.threadId) {
      return;
    }

    const actualRemoteState: PendingThreadArchiveState =
      classified.kind === "thread_archived" ? "archived" : "unarchived";
    const pending = this.pendingThreadArchiveOps.get(classified.threadId)?.[0] ?? null;

    if (!pending) {
      const session = this.deps.getStore()?.getSessionByThreadId(classified.threadId) ?? null;
      await this.deps.logger.warn("thread archive drift observed", {
        threadId: classified.threadId,
        actualRemoteState,
        sessionId: session?.sessionId ?? null,
        localArchived: session?.archived ?? null,
        method: classified.method
      });
      return;
    }

    if (pending.expectedRemoteState !== actualRemoteState) {
      this.removePendingOp(classified.threadId, pending.id);
      await this.deps.logger.warn("thread archive op conflicted", {
        opId: pending.id,
        sessionId: pending.sessionId,
        threadId: classified.threadId,
        expectedRemoteState: pending.expectedRemoteState,
        actualRemoteState,
        origin: pending.origin,
        requestedAt: pending.requestedAt,
        method: classified.method
      });
      return;
    }

    pending.remoteStateObserved = actualRemoteState;
    if (!pending.localStateCommitted) {
      await this.deps.logger.info("thread archive op observed before local commit", {
        opId: pending.id,
        sessionId: pending.sessionId,
        threadId: classified.threadId,
        actualRemoteState,
        origin: pending.origin,
        requestedAt: pending.requestedAt,
        method: classified.method
      });
      return;
    }

    this.removePendingOp(classified.threadId, pending.id);
    await this.deps.logger.info("thread archive op confirmed", {
      opId: pending.id,
      sessionId: pending.sessionId,
      threadId: classified.threadId,
      expectedRemoteState: pending.expectedRemoteState,
      origin: pending.origin,
      requestedAt: pending.requestedAt,
      method: classified.method
    });
  }

  async clearOnAppServerExit(): Promise<void> {
    if (this.pendingThreadArchiveOps.size === 0) {
      return;
    }

    await this.deps.logger.warn("clearing pending thread archive ops after app-server exit", {
      pendingCount: this.countPendingOps()
    });
    this.pendingThreadArchiveOps.clear();
  }

  clear(): void {
    this.pendingThreadArchiveOps.clear();
  }

  private findPendingOp(threadId: string, opId: number): PendingThreadArchiveOp | null {
    const queue = this.pendingThreadArchiveOps.get(threadId);
    if (!queue) {
      return null;
    }

    return queue.find((pending) => pending.id === opId) ?? null;
  }

  private removePendingOp(threadId: string, opId: number): PendingThreadArchiveOp | null {
    const queue = this.pendingThreadArchiveOps.get(threadId);
    if (!queue) {
      return null;
    }

    const index = queue.findIndex((pending) => pending.id === opId);
    if (index === -1) {
      return null;
    }

    const [removed] = queue.splice(index, 1);
    if (queue.length === 0) {
      this.pendingThreadArchiveOps.delete(threadId);
    } else {
      this.pendingThreadArchiveOps.set(threadId, queue);
    }

    return removed ?? null;
  }

  private countPendingOps(): number {
    let count = 0;
    for (const queue of this.pendingThreadArchiveOps.values()) {
      count += queue.length;
    }
    return count;
  }
}
