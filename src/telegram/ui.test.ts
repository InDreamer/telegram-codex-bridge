import test from "node:test";
import assert from "node:assert/strict";

import type { InspectSnapshot } from "../activity/types.js";
import type { ProjectCandidate, ReadinessSnapshot, SessionRow } from "../types.js";
import {
  buildInteractionApprovalCard,
  buildInteractionExpiredCard,
  buildInteractionQuestionCard,
  buildInteractionResolvedCard,
  buildInspectText,
  buildManualPathConfirmMessage,
  buildProjectSelectedText,
  buildRuntimeErrorCard,
  buildWhereText,
  buildStatusText,
  buildRuntimeStatusReplyMarkup,
  buildRuntimeStatusCard,
  buildSessionsText,
  parseCallbackData,
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
    selectedModel: "selectedModel" in overrides ? overrides.selectedModel ?? null : null,
    displayName: overrides.displayName ?? "Session Alpha",
    projectName: overrides.projectName ?? "Project One",
    projectPath: overrides.projectPath ?? "/tmp/project-one",
    status: overrides.status ?? "idle",
    failureReason: overrides.failureReason ?? null,
    archived: overrides.archived ?? false,
    archivedAt: overrides.archivedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-03-10T10:00:00.000Z",
    lastUsedAt: overrides.lastUsedAt ?? "2026-03-10T10:00:00.000Z",
    lastTurnId: "lastTurnId" in overrides ? overrides.lastTurnId ?? null : null,
    lastTurnStatus: "lastTurnStatus" in overrides ? overrides.lastTurnStatus ?? null : "completed"
  };
}

function createReadinessSnapshot(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    state: overrides.state ?? "ready",
    checkedAt: overrides.checkedAt ?? "2026-03-10T10:00:00.000Z",
    details: {
      codexInstalled: true,
      codexAuthenticated: true,
      appServerAvailable: true,
      telegramTokenValid: true,
      authorizedUserBound: true,
      issues: [],
      ...overrides.details
    },
    appServerPid: overrides.appServerPid ?? null
  };
}

function createInspectSnapshot(overrides: Partial<InspectSnapshot> = {}): InspectSnapshot {
  return {
    turnStatus: overrides.turnStatus ?? "running",
    threadRuntimeState: overrides.threadRuntimeState ?? "active",
    activeItemType: overrides.activeItemType ?? "commandExecution",
    activeItemId: overrides.activeItemId ?? "item-1",
    activeItemLabel: overrides.activeItemLabel ?? "pnpm test",
    lastActivityAt: overrides.lastActivityAt ?? "2026-03-10T10:00:05.000Z",
    currentItemStartedAt: overrides.currentItemStartedAt ?? "2026-03-10T10:00:00.000Z",
    currentItemDurationSec: overrides.currentItemDurationSec ?? 5,
    lastHighValueEventType: overrides.lastHighValueEventType ?? null,
    lastHighValueTitle: overrides.lastHighValueTitle ?? null,
    lastHighValueDetail: overrides.lastHighValueDetail ?? null,
    latestProgress: overrides.latestProgress ?? null,
    recentStatusUpdates: overrides.recentStatusUpdates ?? [],
    threadBlockedReason: overrides.threadBlockedReason ?? null,
    finalMessageAvailable: overrides.finalMessageAvailable ?? false,
    inspectAvailable: overrides.inspectAvailable ?? true,
    debugAvailable: overrides.debugAvailable ?? true,
    errorState: overrides.errorState ?? null,
    recentTransitions: overrides.recentTransitions ?? [],
    recentCommandSummaries: overrides.recentCommandSummaries ?? [],
    recentFileChangeSummaries: overrides.recentFileChangeSummaries ?? [],
    recentMcpSummaries: overrides.recentMcpSummaries ?? [],
    recentWebSearches: overrides.recentWebSearches ?? [],
    recentHookSummaries: overrides.recentHookSummaries ?? [],
    recentNoticeSummaries: overrides.recentNoticeSummaries ?? [],
    planSnapshot: overrides.planSnapshot ?? [],
    agentSnapshot: overrides.agentSnapshot ?? [],
    completedCommentary: overrides.completedCommentary ?? [],
    tokenUsage: overrides.tokenUsage ?? null,
    latestDiffSummary: overrides.latestDiffSummary ?? null,
    terminalInteractionSummary: overrides.terminalInteractionSummary ?? null,
    pendingInteractions: overrides.pendingInteractions ?? []
  };
}

function createProjectCandidate(overrides: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return {
    projectKey: overrides.projectKey ?? "project-1",
    projectPath: overrides.projectPath ?? "/tmp/project-one",
    projectName: overrides.projectName ?? "Project One",
    score: overrides.score ?? 0,
    pinned: overrides.pinned ?? false,
    hasExistingSession: overrides.hasExistingSession ?? false,
    lastUsedAt: overrides.lastUsedAt ?? null,
    lastSuccessAt: overrides.lastSuccessAt ?? null,
    accessible: overrides.accessible ?? true,
    fromScan: overrides.fromScan ?? false,
    detectedMarkers: overrides.detectedMarkers ?? ["package.json"]
  };
}

test("buildStatusText renders bold field labels and escapes values for Telegram HTML", () => {
  const text = buildStatusText(
    createReadinessSnapshot({
      details: {
        codexInstalled: true,
        codexAuthenticated: true,
        appServerAvailable: true,
        telegramTokenValid: false,
        authorizedUserBound: true,
        issues: ["token <expired>"]
      }
    }),
    createSession({
      displayName: "Session <Alpha>",
      projectName: "Project & One"
    })
  );

  assert.equal(
    text,
    [
      "<b>服务状态</b>",
      "<b>桥接状态：</b> ready",
      "<b>Telegram 连通：</b> 异常",
      "<b>Codex 可用：</b> 正常",
      "<b>当前会话：</b> Project &amp; One / Session &lt;Alpha&gt; / 空闲 / 上次已完成",
      "<b>最近检查：</b> 2026-03-10T10:00:00.000Z",
      "<b>问题：</b> token &lt;expired&gt;"
    ].join("\n")
  );
});

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

test("buildWhereText includes stable bridge and Codex identifiers when available", () => {
  const text = buildWhereText(
    createSession({
      sessionId: "session-where",
      threadId: "thread-where",
      lastTurnId: "turn-where",
      displayName: "Session <Alpha>",
      projectName: "Project & One",
      projectPath: "/tmp/project<one>",
      status: "idle",
      lastTurnStatus: "completed"
    })
  );

  assert.equal(
    text,
    [
      "<b>当前会话</b>",
      "<b>会话名：</b> Session &lt;Alpha&gt;",
      "<b>项目：</b> Project &amp; One",
      "<b>路径：</b> /tmp/project&lt;one&gt;",
      "<b>状态：</b> 空闲",
      "<b>Bridge 会话 ID：</b> session-where",
      "<b>Codex 线程 ID：</b> thread-where",
      "<b>最近 Turn ID：</b> turn-where",
      "<b>上次结果：</b> 上次已完成"
    ].join("\n")
  );
});

test("buildWhereText explains when the Codex thread has not been created yet", () => {
  const text = buildWhereText(
    createSession({
      sessionId: "session-pending-thread",
      threadId: null,
      lastTurnId: null,
      displayName: "Session Alpha",
      projectName: "Project One",
      projectPath: "/tmp/project-one",
      status: "idle",
      lastTurnStatus: null
    })
  );

  assert.equal(
    text,
    [
      "<b>当前会话</b>",
      "<b>会话名：</b> Session Alpha",
      "<b>项目：</b> Project One",
      "<b>路径：</b> /tmp/project-one",
      "<b>状态：</b> 空闲",
      "<b>Bridge 会话 ID：</b> session-pending-thread",
      "<b>Codex 线程 ID：</b> 尚未创建（首次发送任务后生成）",
      "<b>最近 Turn ID：</b> 暂无"
    ].join("\n")
  );
});

test("buildManualPathConfirmMessage renders bold field labels and keeps the keyboard", () => {
  const rendered = buildManualPathConfirmMessage(
    createProjectCandidate({
      projectName: "Project & One",
      projectPath: "/tmp/project<one>"
    })
  );

  assert.equal(
    rendered.text,
    [
      "在这个项目中开始会话？",
      "<b>项目：</b> Project &amp; One",
      "<b>路径：</b> /tmp/project&lt;one&gt;"
    ].join("\n")
  );
  assert.equal(rendered.replyMarkup.inline_keyboard[0]?.[0]?.text, "确认进入项目");
});

test("buildProjectSelectedText renders a bold field label", () => {
  assert.equal(buildProjectSelectedText("Project & One"), "<b>当前项目：</b> Project &amp; One");
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
    planExpanded: false,
    agentEntries: [],
    agentsExpanded: false
  });

  assert.equal(replyMarkup?.inline_keyboard[0]?.[0]?.text, "当前计划：Wire inspect renderer");
});

test("buildRuntimeStatusCard renders expanded running agents inline", () => {
  const text = buildRuntimeStatusCard({
    state: "Running",
    progressText: "Delegating work",
    agentEntries: [
      {
        threadId: "thread-agent-1",
        label: "agent-ent42",
        labelSource: "fallback",
        status: "running",
        progress: "Searching docs"
      },
      {
        threadId: "thread-agent-2",
        label: "agent-x9k2p1",
        labelSource: "fallback",
        status: "pendingInit",
        progress: null
      }
    ],
    agentsExpanded: true
  });

  assert.match(text, /<b>Agents:<\/b>/u);
  assert.match(text, /1\. agent-ent42 \(running\): Searching docs/u);
  assert.match(text, /2\. agent-x9k2p1 \(pending\)/u);
});

test("buildRuntimeStatusReplyMarkup adds an agent button when running subagents exist", () => {
  const replyMarkup = buildRuntimeStatusReplyMarkup({
    sessionId: "session-agent",
    planEntries: [],
    planExpanded: false,
    agentEntries: [
      {
        threadId: "thread-agent-1",
        label: "agent-ent42",
        labelSource: "fallback",
        status: "running",
        progress: "Searching docs"
      }
    ],
    agentsExpanded: false
  });

  assert.equal(replyMarkup?.inline_keyboard[0]?.[0]?.text, "Agent：1 个运行中");
});

test("buildRuntimeErrorCard renders bold field labels and escapes detail text", () => {
  const text = buildRuntimeErrorCard({
    sessionName: "Session <Alpha>",
    projectName: "Project & One",
    title: "Runtime <error>",
    detail: "Need <retry>"
  });

  assert.equal(
    text,
    [
      "<b>Error</b>",
      "<b>Session:</b> Session &lt;Alpha&gt;",
      "<b>Project:</b> Project &amp; One",
      "<b>Title:</b> Runtime &lt;error&gt;",
      "<b>Detail:</b> Need &lt;retry&gt;"
    ].join("\n")
  );
});

test("buildInspectText renders a concise Chinese inspect view without duplicate or debug-heavy sections", () => {
  const text = buildInspectText(
    createInspectSnapshot({
      recentStatusUpdates: ["Searching <docs>"],
      finalMessageAvailable: true,
      recentTransitions: [
        {
          at: "2026-03-10T10:00:04.000Z",
          kind: "item",
          turnStatus: "running",
          activeItemType: "commandExecution",
          summary: "Started <pnpm test>"
        }
      ],
      recentFileChangeSummaries: ["Updated src/service.ts <done>"],
      recentMcpSummaries: ["Searching <docs>"],
      planSnapshot: ["Wire inspect renderer (inProgress)"],
      completedCommentary: ["Checked <final> answer"]
    }),
    {
      sessionName: "Project & One",
      projectName: "Project & One",
      debugFilePath: "/tmp/debug<1>.jsonl",
      commands: [
        {
          commandText: "pnpm test",
          state: "Running",
          latestSummary: "26/26 <ok>"
        }
      ]
    }
  );

  assert.match(text, /^<b>当前任务详情<\/b>/u);
  assert.match(text, /<b>会话：<\/b> Project &amp; One/u);
  assert.doesNotMatch(text, /<b>项目：<\/b>/u);
  assert.match(text, /<b>状态：<\/b> 执行中/u);
  assert.match(text, /<b>当前动作：<\/b> 正在运行命令：pnpm test/u);
  assert.match(text, /<b>已耗时：<\/b> 5s/u);
  assert.match(text, /<b>最近结论：<\/b> Searching &lt;docs&gt;/u);
  assert.match(text, /<b>最终答复：<\/b> 已就绪/u);
  assert.match(text, /<b>最近动作<\/b>/u);
  assert.match(text, /1\. .*Started &lt;pnpm test&gt;/u);
  assert.match(text, /<b>最近命令<\/b>/u);
  assert.match(text, /1\. <b>命令：<\/b> \$ pnpm test/u);
  assert.match(text, /- <b>状态：<\/b> 进行中/u);
  assert.match(text, /- <b>结果：<\/b> 26\/26 &lt;ok&gt;/u);
  assert.doesNotMatch(text, /&nbsp;/u);
  assert.match(text, /<b>最近文件变更<\/b>/u);
  assert.match(text, /- Updated src\/service\.ts &lt;done&gt;/u);
  assert.match(text, /<b>最近工具与搜索<\/b>/u);
  assert.match(text, /- Searching &lt;docs&gt;/u);
  assert.match(text, /<b>当前计划<\/b>/u);
  assert.match(text, /- Wire inspect renderer \(inProgress\)/u);
  assert.match(text, /<b>补充说明<\/b>/u);
  assert.match(text, /- Checked &lt;final&gt; answer/u);
  assert.doesNotMatch(text, /Debug file/u);
  assert.doesNotMatch(text, /最近网页搜索/u);
});

test("parseCallbackData understands v3 interaction callback families", () => {
  assert.deepEqual(parseCallbackData("v3:ix:decision:ix-1:accept"), {
    kind: "interaction_decision",
    interactionId: "ix-1",
    decisionKey: "accept"
  });
  assert.deepEqual(parseCallbackData("v3:ix:question:ix-1:environment:2"), {
    kind: "interaction_question",
    interactionId: "ix-1",
    questionId: "environment",
    optionIndex: 2
  });
  assert.deepEqual(parseCallbackData("v3:ix:text:ix-1:notes"), {
    kind: "interaction_text",
    interactionId: "ix-1",
    questionId: "notes"
  });
  assert.deepEqual(parseCallbackData("v3:ix:cancel:ix-1"), {
    kind: "interaction_cancel",
    interactionId: "ix-1"
  });
});

test("interaction cards render approval and questionnaire flows without leaking raw protocol fields", () => {
  const approval = buildInteractionApprovalCard({
    interactionId: "ix-1",
    title: "Codex 需要命令批准",
    subtitle: "命令审批",
    body: "pnpm test",
    detail: "需要网络访问",
    actions: [
      { text: "批准", decisionKey: "accept" },
      { text: "本会话内总是批准", decisionKey: "acceptForSession" },
      { text: "拒绝", decisionKey: "decline" }
    ]
  });

  assert.match(approval.text, /Codex 需要命令批准/u);
  assert.deepEqual(
    approval.replyMarkup.inline_keyboard[0]?.map((button) => button.callback_data),
    [
      "v3:ix:decision:ix-1:accept",
      "v3:ix:decision:ix-1:acceptForSession",
      "v3:ix:decision:ix-1:decline"
    ]
  );

  const questionnaire = buildInteractionQuestionCard({
    interactionId: "ix-2",
    title: "Codex 需要更多信息",
    questionId: "environment",
    header: "Env",
    question: "Which environment?",
    questionIndex: 1,
    totalQuestions: 2,
    options: [
      { label: "staging", description: "Shared test env" },
      { label: "prod", description: "Production" }
    ],
    isOther: true,
    isSecret: false
  });

  assert.match(questionnaire.text, /Which environment/u);
  assert.equal(questionnaire.replyMarkup.inline_keyboard[0]?.[0]?.callback_data, "v3:ix:question:ix-2:environment:0");
  assert.equal(questionnaire.replyMarkup.inline_keyboard[1]?.[0]?.callback_data, "v3:ix:text:ix-2:environment");
});

test("resolved and expired interaction cards drop action buttons", () => {
  const resolved = buildInteractionResolvedCard({
    title: "Codex 需要命令批准",
    state: "answered",
    summary: "已批准"
  });
  const expired = buildInteractionExpiredCard({
    title: "Codex 需要更多信息",
    reason: "turn_completed"
  });

  assert.equal(resolved.replyMarkup, undefined);
  assert.equal(expired.replyMarkup, undefined);
  assert.match(resolved.text, /已处理/u);
  assert.match(expired.text, /已过期/u);
});

test("buildInspectText includes pending interaction summaries when present", () => {
  const text = buildInspectText(
    createInspectSnapshot({
      pendingInteractions: [
        {
          interactionId: "ix-1",
          requestMethod: "item/tool/requestUserInput",
          interactionKind: "questionnaire",
          state: "awaiting_text",
          awaitingText: true
        }
      ]
    })
  );

  assert.match(text, /待处理交互/u);
  assert.match(text, /questionnaire/u);
  assert.match(text, /等待文字回答/u);
});

test("buildInspectText renders canceled pending-interaction summaries when provided", () => {
  const text = buildInspectText(
    createInspectSnapshot({
      pendingInteractions: [
        {
          interactionId: "ix-2",
          requestMethod: "item/commandExecution/requestApproval",
          interactionKind: "approval",
          state: "canceled",
          awaitingText: false
        }
      ]
    })
  );

  assert.match(text, /approval/u);
  assert.match(text, /已取消/u);
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

test("renderFinalAnswerHtmlChunks preserves ordered list start numbers", () => {
  const chunks = renderFinalAnswerHtmlChunks(
    [
      "2. Continue from the previous step",
      "3. Verify the result"
    ].join("\n"),
    3000
  );

  assert.equal(chunks.length, 1);
  assert.equal(
    chunks[0],
    [
      "2. Continue from the previous step",
      "3. Verify the result"
    ].join("\n")
  );
});
