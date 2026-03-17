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
  buildProjectAliasClearedText,
  buildProjectAliasRenamedText,
  buildProjectPickerMessage,
  buildProjectSelectedText,
  buildRenameTargetPicker,
  buildRollbackConfirmMessage,
  buildRollbackPickerMessage,
  buildRuntimeErrorCard,
  buildRuntimePreferencesAppliedMessage,
  buildRuntimePreferencesMessage,
  buildSessionCreatedText,
  buildWhereText,
  buildStatusText,
  buildInspectViewMessage,
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
    selectedReasoningEffort: "selectedReasoningEffort" in overrides ? overrides.selectedReasoningEffort ?? null : null,
    planMode: overrides.planMode ?? false,
    displayName: overrides.displayName ?? "Session Alpha",
    projectName: overrides.projectName ?? "Project One",
    projectAlias: "projectAlias" in overrides ? overrides.projectAlias ?? null : null,
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
    proposedPlanSnapshot: (overrides as any).proposedPlanSnapshot ?? [],
    agentSnapshot: overrides.agentSnapshot ?? [],
    completedCommentary: overrides.completedCommentary ?? [],
    tokenUsage: overrides.tokenUsage ?? null,
    latestDiffSummary: overrides.latestDiffSummary ?? null,
    terminalInteractionSummary: overrides.terminalInteractionSummary ?? null,
    pendingInteractions: overrides.pendingInteractions ?? [],
    answeredInteractions: (overrides as any).answeredInteractions ?? []
  };
}

function createProjectCandidate(overrides: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return {
    projectKey: overrides.projectKey ?? "project-1",
    projectPath: overrides.projectPath ?? "/tmp/project-one",
    projectName: overrides.projectName ?? "Project One",
    projectAlias: "projectAlias" in overrides ? overrides.projectAlias ?? null : null,
    displayName: overrides.displayName ?? overrides.projectName ?? "Project One",
    pathLabel: overrides.pathLabel ?? "Repo/project-one",
    group: overrides.group ?? "discovered",
    isRecent: overrides.isRecent ?? false,
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
      projectName: "Project & One",
      selectedModel: "gpt-5",
      selectedReasoningEffort: "high"
    })
  );

  assert.equal(
    text,
    [
      "<b>服务状态</b>",
      "<b>桥接状态：</b> ready",
      "<b>Telegram 连通：</b> 异常",
      "<b>Codex 可用：</b> 正常",
      "<b>当前会话：</b> Project &amp; One / Session &lt;Alpha&gt; / 空闲 / gpt-5 + 高 / 上次已完成",
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
      lastTurnStatus: "completed",
      selectedModel: "gpt-5",
      selectedReasoningEffort: "minimal"
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
      "<b>模型 + 思考强度：</b> gpt-5 + 极省",
      "<b>plan mode:</b> off",
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
      lastTurnStatus: null,
      selectedModel: null,
      selectedReasoningEffort: null
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
      "<b>模型 + 思考强度：</b> 默认模型 + 默认",
      "<b>plan mode:</b> off",
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
      displayName: "Project & One",
      projectPath: "/tmp/project<one>"
    })
  );

  assert.equal(
    rendered.text,
    [
      "要在这个目录中新建会话吗？",
      "<b>项目：</b> Project &amp; One",
      "<b>路径：</b> /tmp/project&lt;one&gt;"
    ].join("\n")
  );
  assert.equal(rendered.replyMarkup.inline_keyboard[0]?.[0]?.text, "确认新建会话");
});

test("buildProjectSelectedText renders a bold field label", () => {
  assert.equal(buildProjectSelectedText("Project & One"), "<b>当前项目：</b> Project &amp; One");
});

test("project creation and alias replies render bold field labels", () => {
  assert.equal(buildSessionCreatedText("Alias & One"), "<b>已新建会话：</b> Alias &amp; One");
  assert.equal(buildProjectAliasRenamedText("Alias & One"), "<b>当前项目别名已更新为：</b> Alias &amp; One");
  assert.equal(buildProjectAliasClearedText("Project & One"), "<b>已清除项目别名：</b> Project &amp; One");
});

test("buildProjectPickerMessage renders grouped candidates with path hints", () => {
  const rendered = buildProjectPickerMessage({
    title: "选择要新建会话的项目",
    emptyText: null,
    noticeLines: ["本地扫描结果可能不完整。"],
    groups: [
      {
        key: "pinned",
        title: "已收藏",
        candidates: [
          createProjectCandidate({
            projectKey: "project-1",
            projectName: "Project One",
            displayName: "Alias One",
            pathLabel: "Repo/team/project-one",
            group: "pinned",
            isRecent: true,
            pinned: true,
            hasExistingSession: true,
            fromScan: true
          })
        ]
      },
      {
        key: "discovered",
        title: "本地发现",
        candidates: [
          createProjectCandidate({
            projectKey: "project-2",
            projectName: "Project Two",
            displayName: "Project Two",
            pathLabel: "workspace/project-two",
            group: "discovered",
            isRecent: false,
            fromScan: true
          })
        ]
      }
    ],
    partial: true,
    allRootsFailed: false,
    projectMap: new Map([
      ["project-1", createProjectCandidate({
        projectKey: "project-1",
        projectName: "Project One",
        displayName: "Alias One",
        pathLabel: "Repo/team/project-one",
        group: "pinned",
        isRecent: true,
        pinned: true,
        hasExistingSession: true,
        fromScan: true
      })],
      ["project-2", createProjectCandidate({
        projectKey: "project-2",
        projectName: "Project Two",
        displayName: "Project Two",
        pathLabel: "workspace/project-two",
        group: "discovered",
        isRecent: false,
        fromScan: true
      })]
    ])
  });

  assert.match(rendered.text, /^选择要新建会话的项目/um);
  assert.match(rendered.text, /已收藏/u);
  assert.match(rendered.text, /1\. Alias One/u);
  assert.match(rendered.text, /Repo\/team\/project-one/u);
  assert.match(rendered.text, /最近 · 本地发现 · 有历史会话/u);
  assert.match(rendered.text, /本地发现/u);
  assert.equal(rendered.replyMarkup.inline_keyboard.at(-1)?.[0]?.text, "扫描本地项目");
});

test("buildRenameTargetPicker includes project alias clear action when needed", () => {
  const rendered = buildRenameTargetPicker({
    sessionId: "session-1",
    projectName: "Alias One",
    hasProjectAlias: true
  });

  assert.match(rendered.text, /<b>当前项目：<\/b> Alias One/u);
  assert.equal(rendered.replyMarkup.inline_keyboard[0]?.[0]?.text, "重命名会话");
  assert.equal(rendered.replyMarkup.inline_keyboard[1]?.[0]?.text, "设置项目别名");
  assert.equal(rendered.replyMarkup.inline_keyboard[2]?.[0]?.text, "清除项目别名");
});

test("buildRuntimeStatusCard keeps only fixed runtime fields and renders progress on a new line", () => {
  const text = buildRuntimeStatusCard({
    sessionName: "ansi-escape",
    projectName: "codex-tui",
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

  assert.doesNotMatch(text, /<b>Project:<\/b>/u);
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

  assert.equal(replyMarkup?.inline_keyboard[0]?.[0]?.text, "计划清单：Wire inspect renderer");
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

test("buildRuntimeStatusCard renders optional runtime fields on separate lines", () => {
  const text = buildRuntimeStatusCard({
    sessionName: "Session Alpha",
    projectName: "Project One",
    state: "Running",
    optionalFieldLines: [
      "model-with-reasoning: gpt-5 + 高",
      "plan_mode: on"
    ]
  });

  assert.match(text, /<b>Model With Reasoning:<\/b> gpt-5 \+ 高/u);
  assert.match(text, /<b>Plan Mode:<\/b> on/u);
  assert.doesNotMatch(text, /<b>概览:<\/b>/u);
  assert.doesNotMatch(text, /\|/u);
});

test("buildRuntimeStatusCard renders progress after optional fields and expanded sections", () => {
  const text = buildRuntimeStatusCard({
    sessionName: "Session Alpha",
    state: "Running",
    optionalFieldLines: ["current-dir: /tmp/project-one"],
    planEntries: ["Review runtime card ordering (inProgress)"],
    planExpanded: true,
    agentEntries: [{
      threadId: "thread-agent-1",
      label: "agent-ent42",
      labelSource: "fallback",
      status: "running",
      progress: "Searching docs"
    }],
    agentsExpanded: true,
    progressText: "Preparing the latest card layout."
  });

  assert.match(text, /<b>Current Dir:<\/b> \/tmp\/project-one/u);
  assert.ok(text.indexOf("<b>计划清单:</b>") > text.indexOf("<b>Current Dir:</b>"));
  assert.ok(text.indexOf("<b>Agents:</b>") > text.indexOf("<b>计划清单:</b>"));
  assert.ok(text.indexOf("<b>Progress:</b>") > text.indexOf("<b>Agents:</b>"));
  assert.ok(text.indexOf("Use /inspect for full details") > text.indexOf("<b>Progress:</b>"));
});

test("buildRuntimePreferencesMessage renders v4 callbacks for toggle and save actions", () => {
  const rendered = buildRuntimePreferencesMessage({
    token: "token123",
    fields: ["session_name", "thread_id"],
    page: 0
  });

  assert.match(rendered.text, /已选字段：<\/b> 2 个/u);
  assert.deepEqual(parseCallbackData(rendered.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ""), {
    kind: "runtime_toggle",
    token: "token123",
    field: "model-name"
  });
  assert.deepEqual(parseCallbackData(rendered.replyMarkup.inline_keyboard.at(-2)?.[0]?.callback_data ?? ""), {
    kind: "runtime_save",
    token: "token123"
  });
});

test("buildRuntimePreferencesMessage includes v4 cli fields and keeps bridge extension selections", () => {
  const rendered = buildRuntimePreferencesMessage({
    token: "token123",
    fields: ["model-with-reasoning", "current-dir", "current_step", "final_answer_ready"] as any,
    page: 0
  });
  const buttonText = rendered.replyMarkup.inline_keyboard.flat().map((button) => button.text).join("\n");

  assert.match(rendered.text, /Codex CLI/u);
  assert.match(rendered.text, /当前分组：<\/b> Codex CLI/u);
  assert.doesNotMatch(rendered.text, /undefined/u);
  assert.match(rendered.text, /模型/u);
  assert.match(rendered.text, /当前目录/u);
  assert.match(rendered.text, /当前步骤/u);
  assert.match(rendered.text, /最终答复已就绪/u);
  assert.doesNotMatch(buttonText, /项目路径/u);
});

test("buildRuntimePreferencesMessage includes the Plan mode bridge field", () => {
  const rendered = buildRuntimePreferencesMessage({
    token: "token123",
    fields: ["plan_mode"] as any,
    page: 3
  });

  assert.match(rendered.text, /Plan mode/u);
  const planModeButton = rendered.replyMarkup.inline_keyboard
    .flat()
    .find((button) => button.text.includes("Plan mode"));
  assert.ok(planModeButton?.callback_data);
  assert.deepEqual(parseCallbackData(planModeButton.callback_data), {
    kind: "runtime_toggle",
    token: "token123",
    field: "plan_mode"
  });
});

test("buildRuntimePreferencesAppliedMessage renders selected field labels in order", () => {
  const rendered = buildRuntimePreferencesAppliedMessage([
    "model-name",
    "plan_mode",
    "thread_id"
  ] as any);

  assert.equal(
    rendered,
    [
      "<b>已应用 Runtime 卡片字段</b>",
      "<b>当前字段：</b> 模型名、Plan mode、线程 ID（旧）"
    ].join("\n")
  );
});

test("buildRuntimePreferencesAppliedMessage renders none when no fields are selected", () => {
  assert.equal(
    buildRuntimePreferencesAppliedMessage([]),
    [
      "<b>已应用 Runtime 卡片字段</b>",
      "<b>当前字段：</b> 无"
    ].join("\n")
  );
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
    } as any),
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
  assert.match(text, /<b>计划清单<\/b>/u);
  assert.match(text, /- Wire inspect renderer \(inProgress\)/u);
  assert.match(text, /<b>补充说明<\/b>/u);
  assert.match(text, /- Checked &lt;final&gt; answer/u);
  assert.doesNotMatch(text, /Debug file/u);
  assert.doesNotMatch(text, /最近网页搜索/u);
});

test("buildInspectText separates checklist, proposed plan, and answered interactions", () => {
  const text = buildInspectText(createInspectSnapshot({
    planSnapshot: ["Collect protocol evidence (completed)"],
    proposedPlanSnapshot: ["## Final proposal", "Ship the Telegram plan result message."],
    answeredInteractions: [
      "Codex 需要更多信息 / Env: staging / Notes: 已提交敏感回答，不显示内容"
    ]
  } as any));

  assert.match(text, /<b>计划清单<\/b>/u);
  assert.match(text, /Collect protocol evidence \(completed\)/u);
  assert.match(text, /<b>方案草稿<\/b>/u);
  assert.match(text, /Final proposal/u);
  assert.match(text, /<b>最近已答交互<\/b>/u);
  assert.match(text, /Env: staging/u);
});

test("buildInteractionResolvedCard can render expandable answered questionnaire details", () => {
  const collapsed = buildInteractionResolvedCard({
    title: "Codex 需要更多信息",
    state: "answered",
    summary: "已提交 2 个回答",
    details: [
      "1. Env",
      "问题：Which environment?",
      "回答：staging",
      "2. Notes",
      "问题：Anything else?",
      "回答：已提交敏感回答，不显示内容"
    ],
    expandable: true,
    expanded: false,
    interactionId: "ix-1"
  } as any);

  assert.match(collapsed.text, /<b>结果：<\/b> 已提交 2 个回答/u);
  assert.equal(collapsed.replyMarkup?.inline_keyboard[0]?.[0]?.text, "查看已提交回答");

  const expanded = buildInteractionResolvedCard({
    title: "Codex 需要更多信息",
    state: "answered",
    summary: "已提交 2 个回答",
    details: [
      "1. Env",
      "问题：Which environment?",
      "回答：staging"
    ],
    expandable: true,
    expanded: true,
    interactionId: "ix-1"
  } as any);

  assert.match(expanded.text, /Which environment\?/u);
  assert.match(expanded.text, /staging/u);
  assert.equal(expanded.replyMarkup?.inline_keyboard[0]?.[0]?.text, "收起已提交回答");
});

test("buildInspectViewMessage supports collapse and paged expansion", () => {
  const html = [
    "<b>当前任务详情</b>",
    `<b>补充说明</b>\n${"A".repeat(2600)}`,
    `<b>最近命令</b>\n${"B".repeat(2600)}`
  ].join("\n\n");

  const collapsed = buildInspectViewMessage({
    sessionId: "session-1",
    html,
    page: 0,
    collapsed: true
  });
  assert.match(collapsed.text, /详情已折叠/u);
  assert.deepEqual(parseCallbackData(collapsed.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ""), {
    kind: "inspect_expand",
    sessionId: "session-1",
    page: 0
  });

  const expanded = buildInspectViewMessage({
    sessionId: "session-1",
    html,
    page: 1,
    collapsed: false
  });
  assert.ok(expanded.totalPages >= 2);
  assert.match(expanded.text, /详情页：<\/b> 2\//u);
  assert.deepEqual(parseCallbackData(expanded.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ""), {
    kind: "inspect_page",
    sessionId: "session-1",
    page: 0
  });
});

test("buildInspectViewMessage splits oversized single sections below Telegram-safe length", () => {
  const html = [
    "<b>当前任务详情</b>",
    `<b>补充说明</b>\n${"A".repeat(5000)}`
  ].join("\n\n");

  const firstPage = buildInspectViewMessage({
    sessionId: "session-1",
    html,
    page: 0,
    collapsed: false
  });
  const secondPage = buildInspectViewMessage({
    sessionId: "session-1",
    html,
    page: 1,
    collapsed: false
  });

  assert.ok(firstPage.totalPages >= 2);
  assert.ok(firstPage.text.length < 4096);
  assert.ok(secondPage.text.length < 4096);
});

test("rollback picker and confirm messages use v4 callbacks", () => {
  const picker = buildRollbackPickerMessage({
    sessionId: "session-rb",
    page: 0,
    targets: [
      { index: 5, sequenceNumber: 1, label: "语音：打开日志", rollbackCount: 1 },
      { index: 4, sequenceNumber: 2, label: "检查状态", rollbackCount: 2 },
      { index: 3, sequenceNumber: 3, label: "第三条", rollbackCount: 3 },
      { index: 2, sequenceNumber: 4, label: "第四条", rollbackCount: 4 },
      { index: 1, sequenceNumber: 5, label: "第五条", rollbackCount: 5 },
      { index: 0, sequenceNumber: 6, label: "第六条", rollbackCount: 6 },
      { index: 7, sequenceNumber: 7, label: "第七条", rollbackCount: 7 }
    ]
  });

  assert.deepEqual(parseCallbackData(picker.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ""), {
    kind: "rollback_pick",
    sessionId: "session-rb",
    page: 0,
    targetIndex: 5
  });
  assert.deepEqual(parseCallbackData(picker.replyMarkup.inline_keyboard.at(-1)?.[0]?.callback_data ?? ""), {
    kind: "rollback_page",
    sessionId: "session-rb",
    page: 1
  });

  const confirm = buildRollbackConfirmMessage({
    sessionId: "session-rb",
    page: 1,
    target: { index: 5, sequenceNumber: 1, label: "语音：打开日志", rollbackCount: 1 }
  });
  assert.deepEqual(parseCallbackData(confirm.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? ""), {
    kind: "rollback_confirm",
    sessionId: "session-rb",
    targetIndex: 5
  });
  assert.deepEqual(parseCallbackData(confirm.replyMarkup.inline_keyboard[1]?.[0]?.callback_data ?? ""), {
    kind: "rollback_back",
    sessionId: "session-rb",
    page: 1
  });
});

test("parseCallbackData understands compact and legacy v3 interaction callbacks", () => {
  const approval = buildInteractionApprovalCard({
    interactionId: "550e8400-e29b-41d4-a716-446655440000",
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
  const approvalCallback = approval.replyMarkup.inline_keyboard[0]?.[1]?.callback_data ?? "";
  assert.ok(Buffer.byteLength(approvalCallback, "utf8") <= 64);
  assert.deepEqual(parseCallbackData(approvalCallback), {
    kind: "interaction_decision",
    interactionId: "550e8400-e29b-41d4-a716-446655440000",
    decisionKey: null,
    decisionIndex: 1
  });

  const questionnaire = buildInteractionQuestionCard({
    interactionId: "550e8400-e29b-41d4-a716-446655440000",
    title: "Codex 需要更多信息",
    questionId: "repo:env",
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
  const questionCallback = questionnaire.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? "";
  const textCallback = questionnaire.replyMarkup.inline_keyboard[1]?.[0]?.callback_data ?? "";
  const cancelCallback = questionnaire.replyMarkup.inline_keyboard[2]?.[0]?.callback_data ?? "";

  assert.ok(Buffer.byteLength(questionCallback, "utf8") <= 64);
  assert.ok(Buffer.byteLength(textCallback, "utf8") <= 64);
  assert.deepEqual(parseCallbackData(questionCallback), {
    kind: "interaction_question",
    interactionId: "550e8400-e29b-41d4-a716-446655440000",
    questionId: null,
    questionIndex: 0,
    optionIndex: 0
  });
  assert.deepEqual(parseCallbackData(textCallback), {
    kind: "interaction_text",
    interactionId: "550e8400-e29b-41d4-a716-446655440000",
    questionId: null,
    questionIndex: 0
  });
  assert.deepEqual(parseCallbackData(cancelCallback), {
    kind: "interaction_cancel",
    interactionId: "550e8400-e29b-41d4-a716-446655440000"
  });

  assert.deepEqual(parseCallbackData("v3:ix:decision:ix-1:accept"), {
    kind: "interaction_decision",
    interactionId: "ix-1",
    decisionKey: "accept",
    decisionIndex: null
  });
  assert.deepEqual(parseCallbackData("v3:ix:question:ix-1:environment:2"), {
    kind: "interaction_question",
    interactionId: "ix-1",
    questionId: "environment",
    questionIndex: null,
    optionIndex: 2
  });
  assert.deepEqual(parseCallbackData("v3:ix:text:ix-1:notes"), {
    kind: "interaction_text",
    interactionId: "ix-1",
    questionId: "notes",
    questionIndex: null
  });
  assert.deepEqual(parseCallbackData("v3:ix:cancel:ix-1"), {
    kind: "interaction_cancel",
    interactionId: "ix-1"
  });
  assert.deepEqual(parseCallbackData("v1:rename:session:session-1"), {
    kind: "rename_session",
    sessionId: "session-1"
  });
  assert.deepEqual(parseCallbackData("v1:rename:project:session-1"), {
    kind: "rename_project",
    sessionId: "session-1"
  });
  assert.deepEqual(parseCallbackData("v1:rename:project:clear:session-1"), {
    kind: "rename_project_clear",
    sessionId: "session-1"
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
  const approvalCallbacks = approval.replyMarkup.inline_keyboard[0]?.map((button) => button.callback_data ?? "") ?? [];
  assert.equal(approvalCallbacks.length, 3);
  assert.equal(approvalCallbacks.every((callback) => callback.startsWith("v3:ix:d:")), true);
  assert.equal(approvalCallbacks.some((callback) => callback.includes("acceptForSession")), false);

  const questionnaire = buildInteractionQuestionCard({
    interactionId: "ix-2",
    title: "Codex 需要更多信息",
    questionId: "repo:env",
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
  assert.match(questionnaire.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? "", /^v3:ix:q:/u);
  assert.match(questionnaire.replyMarkup.inline_keyboard[1]?.[0]?.callback_data ?? "", /^v3:ix:t:/u);
  assert.equal((questionnaire.replyMarkup.inline_keyboard[0]?.[0]?.callback_data ?? "").includes("repo:env"), false);
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
