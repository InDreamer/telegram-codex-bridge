import test from "node:test";
import assert from "node:assert/strict";

import type { SessionRow } from "../types.js";
import { buildSessionsText } from "./ui.js";

async function withMockedNow<T>(nowIso: string, callback: () => Promise<T> | T): Promise<T> {
  const RealDate = Date;
  const fixedTime = Date.parse(nowIso);

  class MockDate extends RealDate {
    constructor(value?: string | number | Date) {
      super(value ?? fixedTime);
    }

    static now(): number {
      return fixedTime;
    }

    static parse(text: string): number {
      return RealDate.parse(text);
    }

    static UTC(...args: Parameters<typeof Date.UTC>): number {
      return RealDate.UTC(...args);
    }
  }

  globalThis.Date = MockDate as unknown as DateConstructor;
  try {
    return await callback();
  } finally {
    globalThis.Date = RealDate;
  }
}

function createSession(overrides: Partial<SessionRow>): SessionRow {
  return {
    sessionId: overrides.sessionId ?? "session-1",
    telegramChatId: overrides.telegramChatId ?? "chat-1",
    threadId: overrides.threadId ?? null,
    displayName: overrides.displayName ?? "Session Alpha",
    projectName: overrides.projectName ?? "Project One",
    projectPath: overrides.projectPath ?? "/tmp/project-one",
    status: overrides.status ?? "idle",
    failureReason: overrides.failureReason ?? null,
    archived: overrides.archived ?? false,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-03-10T10:00:00.000Z",
    lastUsedAt: overrides.lastUsedAt ?? "2026-03-10T10:00:00.000Z",
    lastTurnId: overrides.lastTurnId ?? null,
    lastTurnStatus: overrides.lastTurnStatus ?? "completed"
  };
}

test("buildSessionsText renders active markers and state summaries for visible sessions", async () => {
  await withMockedNow("2026-03-10T10:10:00.000Z", () => {
    const text = buildSessionsText({
      sessions: [
        createSession({
          sessionId: "session-1",
          displayName: "Session Alpha",
          projectName: "Project One",
          status: "idle",
          lastTurnStatus: "completed",
          lastUsedAt: "2026-03-10T10:00:00.000Z"
        }),
        createSession({
          sessionId: "session-2",
          displayName: "Session Beta",
          projectName: "Project Two",
          status: "failed",
          failureReason: "bridge_restart",
          lastTurnStatus: "failed",
          lastUsedAt: "2026-03-10T10:05:00.000Z"
        })
      ],
      activeSessionId: "session-1"
    });

    assert.match(text, /^最近会话/um);
    assert.match(text, /1\. \[当前\] Session Alpha \| Project One \| 空闲 \| 上次已完成 \| 10分钟前/u);
    assert.match(text, /2\. Session Beta \| Project Two \| 失败（桥接服务重启） \| 5分钟前/u);
  });
});

test("buildSessionsText renders archived view with a dedicated title", async () => {
  await withMockedNow("2026-03-10T10:10:00.000Z", () => {
    const text = buildSessionsText({
      sessions: [
        createSession({
          sessionId: "session-1",
          displayName: "Session Alpha",
          archived: true,
          archivedAt: "2026-03-10T10:08:00.000Z",
          lastUsedAt: "2026-03-10T10:00:00.000Z"
        })
      ],
      activeSessionId: null,
      archived: true
    });

    assert.match(text, /^已归档会话/um);
    assert.match(text, /1\. Session Alpha \| Project One \| 空闲 \| 上次已完成 \| 10分钟前/u);
    assert.doesNotMatch(text, /\[当前\]/u);
  });
});
