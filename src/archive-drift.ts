import type { ThreadListResult } from "./codex/app-server.js";
import type { SessionRow } from "./types.js";

export type ArchiveDriftKind =
  | "remote_archived_local_visible"
  | "remote_visible_local_archived"
  | "local_thread_missing_remote";

export interface ArchiveDriftIssue {
  kind: ArchiveDriftKind;
  sessionId: string;
  threadId: string;
  projectName: string;
  displayName: string;
}

export interface ArchiveDriftSummary {
  issues: ArchiveDriftIssue[];
}

interface ArchiveDriftStore {
  listSessionsWithThreads(): SessionRow[];
}

export async function collectArchiveDriftDiagnostics(options: {
  store: ArchiveDriftStore;
  listThreads: (options?: {
    archived?: boolean;
    cursor?: string;
  }) => Promise<ThreadListResult>;
}): Promise<ArchiveDriftSummary> {
  const [visibleRemoteThreads, archivedRemoteThreads] = await Promise.all([
    collectThreadIds(options.listThreads, false),
    collectThreadIds(options.listThreads, true)
  ]);
  const localSessions = options.store.listSessionsWithThreads();
  const issues: ArchiveDriftIssue[] = [];

  for (const session of localSessions) {
    if (!session.threadId) {
      continue;
    }

    if (session.archived) {
      if (visibleRemoteThreads.has(session.threadId)) {
        issues.push({
          kind: "remote_visible_local_archived",
          sessionId: session.sessionId,
          threadId: session.threadId,
          projectName: session.projectName,
          displayName: session.displayName
        });
        continue;
      }
    } else if (archivedRemoteThreads.has(session.threadId)) {
      issues.push({
        kind: "remote_archived_local_visible",
        sessionId: session.sessionId,
        threadId: session.threadId,
        projectName: session.projectName,
        displayName: session.displayName
      });
      continue;
    }

    if (!visibleRemoteThreads.has(session.threadId) && !archivedRemoteThreads.has(session.threadId)) {
      issues.push({
        kind: "local_thread_missing_remote",
        sessionId: session.sessionId,
        threadId: session.threadId,
        projectName: session.projectName,
        displayName: session.displayName
      });
    }
  }

  return { issues };
}

async function collectThreadIds(
  listThreads: (options?: {
    archived?: boolean;
    cursor?: string;
  }) => Promise<ThreadListResult>,
  archived: boolean
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const response = await listThreads(cursor === undefined ? { archived } : { archived, cursor });
    for (const thread of response.data) {
      ids.add(thread.id);
    }

    if (!response.nextCursor) {
      return ids;
    }

    cursor = response.nextCursor;
  }
}
