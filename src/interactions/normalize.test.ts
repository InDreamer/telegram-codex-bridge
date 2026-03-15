import test from "node:test";
import assert from "node:assert/strict";

import { normalizeServerRequest, SKIP_QUESTION_OPTION_VALUE } from "./normalize.js";

test("normalizeServerRequest converts command approvals into a bridge-owned approval shape", () => {
  const normalized = normalizeServerRequest("item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    approvalId: "approval-1",
    command: "pnpm test",
    reason: "needs network",
    cwd: "/tmp/project",
    availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
  });

  assert.deepEqual(normalized, {
    kind: "approval",
    method: "item/commandExecution/requestApproval",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    approvalId: "approval-1",
    decisionOptions: [
      { key: "accept", kind: "accept", label: "批准", payload: { decision: "accept" } },
      {
        key: "acceptForSession",
        kind: "acceptForSession",
        label: "本会话内总是批准",
        payload: { decision: "acceptForSession" }
      },
      { key: "decline", kind: "decline", label: "拒绝", payload: { decision: "decline" } },
      { key: "cancel", kind: "cancel", label: "取消本次交互", payload: { decision: "cancel" } }
    ],
    title: "Codex 需要命令批准",
    subtitle: "命令审批",
    body: "pnpm test",
    detail: "needs network\n目录：/tmp/project",
    rawParams: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      approvalId: "approval-1",
      command: "pnpm test",
      reason: "needs network",
      cwd: "/tmp/project",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"]
    }
  });
});

test("normalizeServerRequest preserves structured approval decision payloads", () => {
  const normalized = normalizeServerRequest("item/commandExecution/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    command: "curl https://example.com",
    availableDecisions: [
      "accept",
      {
        acceptWithExecpolicyAmendment: {
          command_pattern: "curl https://example.com",
          add_to_cwd: "/tmp/project"
        }
      },
      {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: {
            host: "example.com",
            action: "allow"
          }
        }
      },
      "decline"
    ]
  });

  assert.equal(normalized?.kind, "approval");
  assert.deepEqual(normalized && "decisionOptions" in normalized ? normalized.decisionOptions : null, [
    { key: "accept", kind: "accept", label: "批准", payload: { decision: "accept" } },
    {
      key: "acceptWithExecpolicyAmendment",
      kind: "acceptWithExecpolicyAmendment",
      label: "批准并记住命令规则",
      payload: {
        decision: {
          acceptWithExecpolicyAmendment: {
            command_pattern: "curl https://example.com",
            add_to_cwd: "/tmp/project"
          }
        }
      }
    },
    {
      key: "applyNetworkPolicyAmendment",
      kind: "applyNetworkPolicyAmendment",
      label: "批准并保存网络规则（example.com）",
      payload: {
        decision: {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: {
              host: "example.com",
              action: "allow"
            }
          }
        }
      }
    },
    { key: "decline", kind: "decline", label: "拒绝", payload: { decision: "decline" } }
  ]);
});

test("normalizeServerRequest converts permissions and questionnaire requests", () => {
  const permissions = normalizeServerRequest("item/permissions/requestApproval", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-2",
    permissions: {
      network: { enabled: true }
    },
    reason: "needs outbound access"
  });

  assert.equal(permissions?.kind, "permissions");
  assert.deepEqual(permissions && "requestedPermissions" in permissions ? permissions.requestedPermissions : null, {
    network: { enabled: true }
  });

  const questionnaire = normalizeServerRequest("item/tool/requestUserInput", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-3",
    questions: [
      {
        id: "environment",
        header: "Env",
        question: "Which environment?",
        options: [
          { label: "staging", description: "Shared test env" },
          { label: "prod", description: "Production" }
        ],
        isOther: true
      },
      {
        id: "notes",
        header: "Notes",
        question: "Anything else?",
        options: null,
        isSecret: true
      }
    ]
  });

  assert.deepEqual(questionnaire, {
    kind: "questionnaire",
    method: "item/tool/requestUserInput",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-3",
    title: "Codex 需要更多信息",
    questions: [
      {
        id: "environment",
        header: "Env",
        question: "Which environment?",
        options: [
          { value: "staging", label: "staging", description: "Shared test env" },
          { value: "prod", label: "prod", description: "Production" }
        ],
        isOther: true,
        isSecret: false,
        required: true,
        answerFormat: "string",
        allowedValues: ["staging", "prod"]
      },
      {
        id: "notes",
        header: "Notes",
        question: "Anything else?",
        options: null,
        isOther: false,
        isSecret: true,
        required: true,
        answerFormat: "string",
        allowedValues: null
      }
    ],
    submission: "tool_request_user_input",
    serverName: null,
    rawParams: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-3",
      questions: [
        {
          id: "environment",
          header: "Env",
          question: "Which environment?",
          options: [
            { label: "staging", description: "Shared test env" },
            { label: "prod", description: "Production" }
          ],
          isOther: true
        },
        {
          id: "notes",
          header: "Notes",
          question: "Anything else?",
          options: null,
          isSecret: true
        }
      ]
    }
  });
});

test("normalizeServerRequest converts legacy approval requests with conversationId-based params", () => {
  const patchApproval = normalizeServerRequest("applyPatchApproval", {
    conversationId: "thread-legacy",
    callId: "call-patch-1",
    fileChanges: {
      "src/service.ts": {
        type: "update",
        unified_diff: "@@ -1 +1 @@\n-old\n+new\n"
      },
      "README.md": {
        type: "delete",
        content: ""
      }
    },
    grantRoot: "/tmp/project",
    reason: "needs write access"
  });

  assert.deepEqual(patchApproval, {
    kind: "approval",
    method: "applyPatchApproval",
    threadId: "thread-legacy",
    turnId: "",
    itemId: "call-patch-1",
    approvalId: null,
    decisionOptions: [
      { key: "accept", kind: "accept", label: "批准", payload: { decision: "approved" } },
      {
        key: "acceptForSession",
        kind: "acceptForSession",
        label: "本会话内总是批准",
        payload: { decision: "approved_for_session" }
      },
      { key: "decline", kind: "decline", label: "拒绝", payload: { decision: "denied" } },
      { key: "cancel", kind: "cancel", label: "取消本次交互", payload: { decision: "abort" } }
    ],
    title: "Codex 需要补丁批准",
    subtitle: "兼容补丁审批",
    body: "src/service.ts\nREADME.md",
    detail: "needs write access\n授权根目录：/tmp/project",
    rawParams: {
      conversationId: "thread-legacy",
      callId: "call-patch-1",
      fileChanges: {
        "src/service.ts": {
          type: "update",
          unified_diff: "@@ -1 +1 @@\n-old\n+new\n"
        },
        "README.md": {
          type: "delete",
          content: ""
        }
      },
      grantRoot: "/tmp/project",
      reason: "needs write access"
    }
  });

  const execApproval = normalizeServerRequest("execCommandApproval", {
    conversationId: "thread-legacy",
    callId: "call-exec-1",
    approvalId: "approval-legacy-1",
    command: ["pnpm", "test", "--runInBand"],
    cwd: "/tmp/project",
    parsedCmd: [{ type: "unknown", cmd: "pnpm test --runInBand" }],
    reason: "needs shell access"
  });

  assert.deepEqual(execApproval, {
    kind: "approval",
    method: "execCommandApproval",
    threadId: "thread-legacy",
    turnId: "",
    itemId: "approval-legacy-1",
    approvalId: "approval-legacy-1",
    decisionOptions: [
      { key: "accept", kind: "accept", label: "批准", payload: { decision: "approved" } },
      {
        key: "acceptForSession",
        kind: "acceptForSession",
        label: "本会话内总是批准",
        payload: { decision: "approved_for_session" }
      },
      { key: "decline", kind: "decline", label: "拒绝", payload: { decision: "denied" } },
      { key: "cancel", kind: "cancel", label: "取消本次交互", payload: { decision: "abort" } }
    ],
    title: "Codex 需要命令批准",
    subtitle: "兼容命令审批",
    body: "pnpm test --runInBand",
    detail: "needs shell access\n目录：/tmp/project",
    rawParams: {
      conversationId: "thread-legacy",
      callId: "call-exec-1",
      approvalId: "approval-legacy-1",
      command: ["pnpm", "test", "--runInBand"],
      cwd: "/tmp/project",
      parsedCmd: [{ type: "unknown", cmd: "pnpm test --runInBand" }],
      reason: "needs shell access"
    }
  });
});

test("normalizeServerRequest converts MCP elicitation URL and form modes", () => {
  const elicitation = normalizeServerRequest("mcpServer/elicitation/request", {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "docs",
    mode: "url",
    message: "Open the docs approval page.",
    url: "https://example.com"
  });

  assert.deepEqual(elicitation, {
    kind: "elicitation",
    method: "mcpServer/elicitation/request",
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "docs",
    title: "MCP 需要用户确认",
    message: "Open the docs approval page.",
    mode: "url",
    detail: "https://example.com",
    rawParams: {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "docs",
      mode: "url",
      message: "Open the docs approval page.",
      url: "https://example.com"
    }
  });

  const form = normalizeServerRequest("mcpServer/elicitation/request", {
    threadId: "thread-1",
    turnId: "turn-2",
    elicitationId: "elicitation-1",
    serverName: "deploy",
    mode: "form",
    requestedSchema: {
      type: "object",
      required: ["environment", "force", "retries"],
      properties: {
        environment: {
          type: "string",
          enum: ["staging", "prod"],
          description: "Choose target environment."
        },
        force: {
          type: "boolean",
          description: "Whether to force the deploy."
        },
        retries: {
          type: "integer",
          description: "Retry count."
        },
        tags: {
          type: "array",
          description: "Optional deploy tags.",
          items: {
            enum: ["blue", "green"]
          }
        }
      }
    }
  });

  assert.equal(form?.kind, "questionnaire");
  assert.deepEqual(form, {
    kind: "questionnaire",
    method: "mcpServer/elicitation/request",
    threadId: "thread-1",
    turnId: "turn-2",
    itemId: "elicitation-1",
    title: "MCP 需要更多信息",
    questions: [
      {
        id: "environment",
        header: "environment",
        question: "Choose target environment.\n从下方选一个选项。\n这是必填项。",
        options: [
          { value: "staging", label: "staging", description: "staging" },
          { value: "prod", label: "prod", description: "prod" }
        ],
        isOther: false,
        isSecret: false,
        required: true,
        answerFormat: "string",
        allowedValues: ["staging", "prod"]
      },
      {
        id: "force",
        header: "force",
        question: "Whether to force the deploy.\n请选择是或否。\n这是必填项。",
        options: [
          { value: "true", label: "是", description: "返回 true" },
          { value: "false", label: "否", description: "返回 false" }
        ],
        isOther: false,
        isSecret: false,
        required: true,
        answerFormat: "boolean",
        allowedValues: ["true", "false"]
      },
      {
        id: "retries",
        header: "retries",
        question: "Retry count.\n请直接发送整数。\n这是必填项。",
        options: null,
        isOther: true,
        isSecret: false,
        required: true,
        answerFormat: "integer",
        allowedValues: null
      },
      {
        id: "tags",
        header: "tags",
        question: "Optional deploy tags.\n可选值：blue、green。多个值请用逗号分隔。\n这是可选项。",
        options: [
          { value: SKIP_QUESTION_OPTION_VALUE, label: "跳过", description: "保留为空" }
        ],
        isOther: true,
        isSecret: false,
        required: false,
        answerFormat: "string_array",
        allowedValues: ["blue", "green"]
      }
    ],
    submission: "mcp_elicitation_form",
    serverName: "deploy",
    rawParams: {
      threadId: "thread-1",
      turnId: "turn-2",
      elicitationId: "elicitation-1",
      serverName: "deploy",
      mode: "form",
      requestedSchema: {
        type: "object",
        required: ["environment", "force", "retries"],
        properties: {
          environment: {
            type: "string",
            enum: ["staging", "prod"],
            description: "Choose target environment."
          },
          force: {
            type: "boolean",
            description: "Whether to force the deploy."
          },
          retries: {
            type: "integer",
            description: "Retry count."
          },
          tags: {
            type: "array",
            description: "Optional deploy tags.",
            items: {
              enum: ["blue", "green"]
            }
          }
        }
      }
    }
  });

  assert.equal(normalizeServerRequest("item/tool/call", { threadId: "thread-1" }), null);
});
