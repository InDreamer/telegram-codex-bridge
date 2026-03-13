import test from "node:test";
import assert from "node:assert/strict";

import type { SessionRow } from "../types.js";
import {
  buildRuntimeStatusReplyMarkup,
  buildRuntimeStatusCard,
  buildSessionsText,
  renderFinalAnswerHtmlChunks
} from "./ui.js";

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

test("buildRuntimeStatusCard renders bold prefixes and markdown progress on a new line", () => {
  const text = buildRuntimeStatusCard({
    sessionName: "ansi-escape",
    projectName: "ansi-escape",
    state: "Completed",
    progressText: "确认 `ansi-escape` 是 **codex-tui** 的 ANSI 到 `ratatui` 适配边界层。"
  });

  assert.equal(
    text,
    [
      "<b>Runtime Status</b>",
      "<b>Session:</b> ansi-escape",
      "<b>State:</b> Completed",
      "<b>Progress:</b>",
      "确认 <code>ansi-escape</code> 是 <b>codex-tui</b> 的 ANSI 到 <code>ratatui</code> 适配边界层。",
      "Use /inspect for full details"
    ].join("\n")
  );
});

test("buildRuntimeStatusReplyMarkup prefers the in-progress step over earlier pending steps", () => {
  const replyMarkup = buildRuntimeStatusReplyMarkup({
    sessionId: "session-1",
    planEntries: [
      "Collect protocol evidence (pending)",
      "Wire inspect renderer (inProgress)"
    ],
    planExpanded: false
  });

  assert.equal(replyMarkup?.inline_keyboard[0]?.[0]?.text, "当前计划：Wire inspect renderer");
});

test("renderFinalAnswerHtmlChunks converts common Markdown into Telegram-safe HTML", () => {
  const chunks = renderFinalAnswerHtmlChunks(
    [
      "# Summary",
      "",
      "- **Status**: `ok`",
      "- Link: [Docs](https://example.com/docs)",
      "",
      "> Reviewed and ready.",
      "",
      "```ts",
      "console.log(\"hi\")",
      "```"
    ].join("\n"),
    3000
  );

  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0],
    [
      "<b>Summary</b>",
      "",
      "• <b>Status</b>: <code>ok</code>",
      "• Link: <a href=\"https://example.com/docs\">Docs</a>",
      "",
      "<blockquote>Reviewed and ready.</blockquote>",
      "",
      "<pre><code class=\"language-ts\">console.log(\"hi\")</code></pre>"
    ].join("\n")
  );
});

test("renderFinalAnswerHtmlChunks splits large code blocks into valid HTML chunks", () => {
  const chunks = renderFinalAnswerHtmlChunks(
    [
      "```ts",
      "const one = 1;",
      "const two = 2;",
      "const three = 3;",
      "const four = 4;",
      "```"
    ].join("\n"),
    90
  );

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], "<pre><code class=\"language-ts\">const one = 1;\nconst two = 2;</code></pre>");
  assert.equal(
    chunks[1],
    "(2/2) <pre><code class=\"language-ts\">const three = 3;\nconst four = 4;</code></pre>"
  );
});

test("renderFinalAnswerHtmlChunks keeps plain underscores and wildcard stars as text", () => {
  const chunks = renderFinalAnswerHtmlChunks(
    [
      "snake_case and foo_bar_baz",
      "",
      "Use * as wildcard and **bold** text"
    ].join("\n"),
    3000
  );

  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0],
    [
      "snake_case and foo_bar_baz",
      "",
      "Use * as wildcard and <b>bold</b> text"
    ].join("\n")
  );
});

test("renderFinalAnswerHtmlChunks preserves balanced parentheses in Markdown links", () => {
  const chunks = renderFinalAnswerHtmlChunks(
    "See [Docs](https://example.com/a_(b)) for details.",
    3000
  );

  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0],
    "See <a href=\"https://example.com/a_(b)\">Docs</a> for details."
  );
});

test("renderFinalAnswerHtmlChunks keeps wrapped list lines attached to the same item", () => {
  const chunks = renderFinalAnswerHtmlChunks(
    [
      "- item one",
      "  continuation line",
      "- item two"
    ].join("\n"),
    3000
  );

  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0],
    [
      "• item one\ncontinuation line",
      "• item two"
    ].join("\n")
  );
});
