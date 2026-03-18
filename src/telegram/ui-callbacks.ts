import type { ReasoningEffort, RuntimeStatusField, UiLanguage } from "../types.js";

export type ParsedCallbackData =
  | { kind: "pick"; projectKey: string }
  | { kind: "scan_more" }
  | { kind: "path_manual" }
  | { kind: "path_back" }
  | { kind: "path_confirm"; projectKey: string }
  | { kind: "browse_open"; token: string; entryIndex: number }
  | { kind: "browse_page"; token: string; page: number }
  | { kind: "browse_up"; token: string }
  | { kind: "browse_root"; token: string }
  | { kind: "browse_refresh"; token: string }
  | { kind: "browse_back"; token: string }
  | { kind: "browse_close"; token: string }
  | { kind: "rename_session"; sessionId: string }
  | { kind: "rename_project"; sessionId: string }
  | { kind: "rename_project_clear"; sessionId: string }
  | { kind: "model_default"; sessionId: string }
  | { kind: "model_page"; sessionId: string; page: number }
  | { kind: "model_pick"; sessionId: string; modelIndex: number }
  | { kind: "model_effort"; sessionId: string; modelIndex: number; effort: ReasoningEffort | null }
  | { kind: "plan_expand"; sessionId: string }
  | { kind: "plan_collapse"; sessionId: string }
  | { kind: "agent_expand"; sessionId: string }
  | { kind: "agent_collapse"; sessionId: string }
  | { kind: "status_inspect"; sessionId: string }
  | { kind: "status_interrupt"; sessionId: string }
  | { kind: "final_open"; answerId: string }
  | { kind: "final_close"; answerId: string }
  | { kind: "final_page"; answerId: string; page: number }
  | { kind: "plan_result_open"; answerId: string }
  | { kind: "plan_result_close"; answerId: string }
  | { kind: "plan_result_page"; answerId: string; page: number }
  | { kind: "runtime_page"; token: string; page: number }
  | { kind: "runtime_toggle"; token: string; field: RuntimeStatusField }
  | { kind: "runtime_save"; token: string }
  | { kind: "runtime_reset"; token: string }
  | { kind: "language_set"; language: UiLanguage }
  | { kind: "inspect_expand"; sessionId: string; page: number }
  | { kind: "inspect_collapse"; sessionId: string }
  | { kind: "inspect_page"; sessionId: string; page: number }
  | { kind: "plan_implement"; sessionId: string }
  | { kind: "rollback_page"; sessionId: string; page: number }
  | { kind: "rollback_pick"; sessionId: string; page: number; targetIndex: number }
  | { kind: "rollback_confirm"; sessionId: string; targetIndex: number }
  | { kind: "rollback_back"; sessionId: string; page: number }
  | { kind: "interaction_decision"; interactionId: string; decisionKey: string | null; decisionIndex: number | null }
  | {
      kind: "interaction_question";
      interactionId: string;
      questionId: string | null;
      questionIndex: number | null;
      optionIndex: number;
    }
  | { kind: "interaction_text"; interactionId: string; questionId: string | null; questionIndex: number | null }
  | { kind: "interaction_cancel"; interactionId: string }
  | { kind: "interaction_answer_expand"; interactionId: string }
  | { kind: "interaction_answer_collapse"; interactionId: string };

const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

const RUNTIME_STATUS_FIELD_CODES: ReadonlyMap<RuntimeStatusField, string> = new Map([
  ["model-name", "mn"],
  ["model-with-reasoning", "mw"],
  ["current-dir", "cd"],
  ["project-root", "rt"],
  ["git-branch", "gb"],
  ["context-remaining", "xr"],
  ["context-used", "xu"],
  ["five-hour-limit", "f5"],
  ["weekly-limit", "wk"],
  ["codex-version", "cv"],
  ["context-window-size", "ws"],
  ["used-tokens", "ut"],
  ["total-input-tokens", "ti"],
  ["total-output-tokens", "to"],
  ["session-id", "si"],
  ["session_name", "sn"],
  ["project_name", "pn"],
  ["project_path", "pp"],
  ["plan_mode", "pm"],
  ["model_reasoning", "mr"],
  ["thread_id", "th"],
  ["turn_id", "tu"],
  ["blocked_reason", "br"],
  ["current_step", "cs"],
  ["last_token_usage", "lt"],
  ["total_token_usage", "tt"],
  ["context_window", "cw"],
  ["final_answer_ready", "fr"]
]);

const RUNTIME_STATUS_CODE_TO_FIELD: ReadonlyMap<string, RuntimeStatusField> = new Map(
  [...RUNTIME_STATUS_FIELD_CODES].map(([field, code]) => [code, field])
);

export function parseCommand(text: string): { name: string; args: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [commandToken, ...rest] = trimmed.split(/\s+/u);
  if (!commandToken) {
    return null;
  }

  const commandName = commandToken.split("@")[0]?.slice(1).toLowerCase();
  if (!commandName) {
    return null;
  }

  return {
    name: commandName,
    args: rest.join(" ").trim()
  };
}

export function encodePickCallback(projectKey: string): string {
  return `v1:pick:${projectKey}`;
}

export function encodeScanMoreCallback(): string {
  return "v1:scan:more";
}

export function encodePathManualCallback(): string {
  return "v1:path:manual";
}

export function encodePathBackCallback(): string {
  return "v1:path:back";
}

export function encodePathConfirmCallback(projectKey: string): string {
  return `v1:path:confirm:${projectKey}`;
}

export function encodeBrowseOpenCallback(token: string, entryIndex: number): string {
  return ensureTelegramCallbackDataLimit(`v5:br:o:${token}:${encodeInteractionIndex(entryIndex)}`);
}

export function encodeBrowsePageCallback(token: string, page: number): string {
  return ensureTelegramCallbackDataLimit(`v5:br:p:${token}:${encodeInteractionIndex(page)}`);
}

export function encodeBrowseUpCallback(token: string): string {
  return ensureTelegramCallbackDataLimit(`v5:br:u:${token}`);
}

export function encodeBrowseRootCallback(token: string): string {
  return ensureTelegramCallbackDataLimit(`v5:br:r:${token}`);
}

export function encodeBrowseRefreshCallback(token: string): string {
  return ensureTelegramCallbackDataLimit(`v5:br:f:${token}`);
}

export function encodeBrowseBackCallback(token: string): string {
  return ensureTelegramCallbackDataLimit(`v5:br:b:${token}`);
}

export function encodeBrowseCloseCallback(token: string): string {
  return ensureTelegramCallbackDataLimit(`v5:br:c:${token}`);
}

export function encodeRenameSessionCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v1:rename:session:${sessionId}`);
}

export function encodeRenameProjectCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v1:rename:project:${sessionId}`);
}

export function encodeRenameProjectClearCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v1:rename:project:clear:${sessionId}`);
}

export function encodeModelDefaultCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v2:model:default:${sessionId}`);
}

export function encodeModelPageCallback(sessionId: string, page: number): string {
  return ensureTelegramCallbackDataLimit(`v2:model:page:${sessionId}:${encodeInteractionIndex(page)}`);
}

export function encodeModelPickCallback(sessionId: string, modelIndex: number): string {
  return ensureTelegramCallbackDataLimit(`v2:model:pick:${sessionId}:${encodeInteractionIndex(modelIndex)}`);
}

export function encodeModelEffortCallback(
  sessionId: string,
  modelIndex: number,
  effort: ReasoningEffort | null
): string {
  return ensureTelegramCallbackDataLimit(
    `v2:model:effort:${sessionId}:${encodeInteractionIndex(modelIndex)}:${effort ?? "default"}`
  );
}

export function encodePlanExpandCallback(sessionId: string): string {
  return `v1:plan:expand:${sessionId}`;
}

export function encodePlanCollapseCallback(sessionId: string): string {
  return `v1:plan:collapse:${sessionId}`;
}

export function encodeAgentExpandCallback(sessionId: string): string {
  return `v1:agent:expand:${sessionId}`;
}

export function encodeAgentCollapseCallback(sessionId: string): string {
  return `v1:agent:collapse:${sessionId}`;
}

export function encodeStatusInspectCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v5:st:i:${sessionId}`);
}

export function encodeStatusInterruptCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v5:st:x:${sessionId}`);
}

export function encodeFinalAnswerOpenCallback(answerId: string): string {
  return `v1:final:open:${answerId}`;
}

export function encodeFinalAnswerCloseCallback(answerId: string): string {
  return `v1:final:close:${answerId}`;
}

export function encodeFinalAnswerPageCallback(answerId: string, page: number): string {
  return `v1:final:page:${answerId}:${page}`;
}

export function encodePlanResultOpenCallback(answerId: string): string {
  return `v4:plan:open:${answerId}`;
}

export function encodePlanResultCloseCallback(answerId: string): string {
  return `v4:plan:close:${answerId}`;
}

export function encodePlanResultPageCallback(answerId: string, page: number): string {
  return `v4:plan:page:${answerId}:${page}`;
}

export function encodeRuntimePageCallback(token: string, page: number): string {
  return ensureTelegramCallbackDataLimit(`v4:rt:p:${token}:${encodeInteractionIndex(page)}`);
}

export function encodeRuntimeToggleCallback(token: string, field: RuntimeStatusField): string {
  return ensureTelegramCallbackDataLimit(`v4:rt:t:${token}:${encodeRuntimeStatusField(field)}`);
}

export function encodeRuntimeSaveCallback(token: string): string {
  return ensureTelegramCallbackDataLimit(`v4:rt:s:${token}`);
}

export function encodeRuntimeResetCallback(token: string): string {
  return ensureTelegramCallbackDataLimit(`v4:rt:r:${token}`);
}

export function encodeLanguageSetCallback(language: UiLanguage): string {
  return ensureTelegramCallbackDataLimit(`v4:lg:s:${language}`);
}

export function encodeInspectExpandCallback(sessionId: string, page = 0): string {
  return ensureTelegramCallbackDataLimit(`v4:in:e:${sessionId}:${encodeInteractionIndex(page)}`);
}

export function encodeInspectCollapseCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v4:in:c:${sessionId}`);
}

export function encodeInspectPageCallback(sessionId: string, page: number): string {
  return ensureTelegramCallbackDataLimit(`v4:in:p:${sessionId}:${encodeInteractionIndex(page)}`);
}

export function encodeRollbackPageCallback(sessionId: string, page: number): string {
  return ensureTelegramCallbackDataLimit(`v4:rb:p:${sessionId}:${encodeInteractionIndex(page)}`);
}

export function encodeRollbackPickCallback(sessionId: string, page: number, targetIndex: number): string {
  return ensureTelegramCallbackDataLimit(
    `v4:rb:k:${sessionId}:${encodeInteractionIndex(page)}:${encodeInteractionIndex(targetIndex)}`
  );
}

export function encodeRollbackConfirmCallback(sessionId: string, targetIndex: number): string {
  return ensureTelegramCallbackDataLimit(`v4:rb:c:${sessionId}:${encodeInteractionIndex(targetIndex)}`);
}

export function encodeRollbackBackCallback(sessionId: string, page: number): string {
  return ensureTelegramCallbackDataLimit(`v4:rb:b:${sessionId}:${encodeInteractionIndex(page)}`);
}

export function encodeInteractionDecisionCallback(interactionId: string, decisionIndex: number): string {
  return ensureTelegramCallbackDataLimit(
    `v3:ix:d:${encodeInteractionToken(interactionId)}:${encodeInteractionIndex(decisionIndex)}`
  );
}

export function encodeInteractionQuestionCallback(interactionId: string, questionIndex: number, optionIndex: number): string {
  return ensureTelegramCallbackDataLimit(
    `v3:ix:q:${encodeInteractionToken(interactionId)}:${encodeInteractionIndex(questionIndex)}:${encodeInteractionIndex(optionIndex)}`
  );
}

export function encodeInteractionTextCallback(interactionId: string, questionIndex: number): string {
  return ensureTelegramCallbackDataLimit(
    `v3:ix:t:${encodeInteractionToken(interactionId)}:${encodeInteractionIndex(questionIndex)}`
  );
}

export function encodeInteractionCancelCallback(interactionId: string): string {
  return ensureTelegramCallbackDataLimit(`v3:ix:c:${encodeInteractionToken(interactionId)}`);
}

export function encodeInteractionAnswerExpandCallback(interactionId: string): string {
  return ensureTelegramCallbackDataLimit(`v3:ix:a:${encodeInteractionToken(interactionId)}:open`);
}

export function encodeInteractionAnswerCollapseCallback(interactionId: string): string {
  return ensureTelegramCallbackDataLimit(`v3:ix:a:${encodeInteractionToken(interactionId)}:close`);
}

export function encodePlanImplementCallback(sessionId: string): string {
  return ensureTelegramCallbackDataLimit(`v4:pr:i:${sessionId}`);
}

export function parseCallbackData(data: string): ParsedCallbackData | null {
  const parts = data.split(":");
  if (parts[0] === "v5" && parts[1] === "br") {
    if (parts[2] === "o" && parts[3] && parts[4]) {
      const entryIndex = decodeInteractionIndex(parts[4]);
      if (entryIndex !== null) {
        return { kind: "browse_open", token: parts[3], entryIndex };
      }
    }

    if (parts[2] === "p" && parts[3] && parts[4]) {
      const page = decodeInteractionIndex(parts[4]);
      if (page !== null) {
        return { kind: "browse_page", token: parts[3], page };
      }
    }

    if (parts[2] === "u" && parts[3]) {
      return { kind: "browse_up", token: parts[3] };
    }

    if (parts[2] === "r" && parts[3]) {
      return { kind: "browse_root", token: parts[3] };
    }

    if (parts[2] === "f" && parts[3]) {
      return { kind: "browse_refresh", token: parts[3] };
    }

    if (parts[2] === "b" && parts[3]) {
      return { kind: "browse_back", token: parts[3] };
    }

    if (parts[2] === "c" && parts[3]) {
      return { kind: "browse_close", token: parts[3] };
    }

    return null;
  }

  if (parts[0] === "v2" && parts[1] === "model") {
    if (parts[2] === "default" && parts[3]) {
      return { kind: "model_default", sessionId: parts[3] };
    }

    if (parts[2] === "page" && parts[3] && parts[4]) {
      const page = decodeInteractionIndex(parts[4]);
      if (page !== null) {
        return { kind: "model_page", sessionId: parts[3], page };
      }
    }

    if (parts[2] === "pick" && parts[3] && parts[4]) {
      const modelIndex = decodeInteractionIndex(parts[4]);
      if (modelIndex !== null) {
        return { kind: "model_pick", sessionId: parts[3], modelIndex };
      }
    }

    if (parts[2] === "effort" && parts[3] && parts[4] && parts[5]) {
      const modelIndex = decodeInteractionIndex(parts[4]);
      if (modelIndex !== null) {
        const effort = parts[5] === "default" ? null : parseReasoningEffort(parts[5]);
        if (parts[5] === "default" || effort) {
          return { kind: "model_effort", sessionId: parts[3], modelIndex, effort };
        }
      }
    }

    return null;
  }

  if (parts[0] === "v5" && parts[1] === "st") {
    if (parts[2] === "i" && parts[3]) {
      return { kind: "status_inspect", sessionId: parts[3] };
    }

    if (parts[2] === "x" && parts[3]) {
      return { kind: "status_interrupt", sessionId: parts[3] };
    }

    return null;
  }

  if (parts[0] === "v4" && parts[1] === "rt") {
    if (parts[2] === "p" && parts[3] && parts[4]) {
      const page = decodeInteractionIndex(parts[4]);
      if (page !== null) {
        return { kind: "runtime_page", token: parts[3], page };
      }
    }

    if (parts[2] === "t" && parts[3] && parts[4]) {
      const field = decodeRuntimeStatusField(parts[4]);
      if (field) {
        return { kind: "runtime_toggle", token: parts[3], field };
      }
    }

    if (parts[2] === "s" && parts[3]) {
      return { kind: "runtime_save", token: parts[3] };
    }

    if (parts[2] === "r" && parts[3]) {
      return { kind: "runtime_reset", token: parts[3] };
    }

    return null;
  }

  if (parts[0] === "v4" && parts[1] === "lg") {
    if (parts[2] === "s" && (parts[3] === "zh" || parts[3] === "en")) {
      return { kind: "language_set", language: parts[3] };
    }

    return null;
  }

  if (parts[0] === "v4" && parts[1] === "in") {
    if (parts[2] === "e" && parts[3] && parts[4]) {
      const page = decodeInteractionIndex(parts[4]);
      if (page !== null) {
        return { kind: "inspect_expand", sessionId: parts[3], page };
      }
    }

    if (parts[2] === "c" && parts[3]) {
      return { kind: "inspect_collapse", sessionId: parts[3] };
    }

    if (parts[2] === "p" && parts[3] && parts[4]) {
      const page = decodeInteractionIndex(parts[4]);
      if (page !== null) {
        return { kind: "inspect_page", sessionId: parts[3], page };
      }
    }

    return null;
  }

  if (parts[0] === "v4" && parts[1] === "rb") {
    if (parts[2] === "p" && parts[3] && parts[4]) {
      const page = decodeInteractionIndex(parts[4]);
      if (page !== null) {
        return { kind: "rollback_page", sessionId: parts[3], page };
      }
    }

    if (parts[2] === "k" && parts[3] && parts[4] && parts[5]) {
      const page = decodeInteractionIndex(parts[4]);
      const targetIndex = decodeInteractionIndex(parts[5]);
      if (page !== null && targetIndex !== null) {
        return { kind: "rollback_pick", sessionId: parts[3], page, targetIndex };
      }
    }

    if (parts[2] === "c" && parts[3] && parts[4]) {
      const targetIndex = decodeInteractionIndex(parts[4]);
      if (targetIndex !== null) {
        return { kind: "rollback_confirm", sessionId: parts[3], targetIndex };
      }
    }

    if (parts[2] === "b" && parts[3] && parts[4]) {
      const page = decodeInteractionIndex(parts[4]);
      if (page !== null) {
        return { kind: "rollback_back", sessionId: parts[3], page };
      }
    }

    return null;
  }

  if (parts[0] !== "v1") {
    if (parts[0] === "v4" && parts[1] === "plan" && parts[2] === "open" && parts[3]) {
      return { kind: "plan_result_open", answerId: parts[3] };
    }

    if (parts[0] === "v4" && parts[1] === "plan" && parts[2] === "close" && parts[3]) {
      return { kind: "plan_result_close", answerId: parts[3] };
    }

    if (parts[0] === "v4" && parts[1] === "plan" && parts[2] === "page" && parts[3] && parts[4]) {
      const page = Number.parseInt(parts[4], 10);
      if (Number.isFinite(page) && page >= 1) {
        return { kind: "plan_result_page", answerId: parts[3], page };
      }
    }

    if (parts[0] === "v4" && parts[1] === "pr" && parts[2] === "i" && parts[3]) {
      return { kind: "plan_implement", sessionId: parts[3] };
    }

    if (parts[0] === "v3" && parts[1] === "ix") {
      if (parts[2] === "d" && parts[3] && parts[4]) {
        const interactionId = decodeInteractionToken(parts[3]);
        const decisionIndex = decodeInteractionIndex(parts[4]);
        if (interactionId && decisionIndex !== null) {
          return {
            kind: "interaction_decision",
            interactionId,
            decisionKey: null,
            decisionIndex
          };
        }
      }

      if (parts[2] === "q" && parts[3] && parts[4] && parts[5]) {
        const interactionId = decodeInteractionToken(parts[3]);
        const questionIndex = decodeInteractionIndex(parts[4]);
        const optionIndex = decodeInteractionIndex(parts[5]);
        if (interactionId && questionIndex !== null && optionIndex !== null) {
          return {
            kind: "interaction_question",
            interactionId,
            questionId: null,
            questionIndex,
            optionIndex
          };
        }
      }

      if (parts[2] === "t" && parts[3] && parts[4]) {
        const interactionId = decodeInteractionToken(parts[3]);
        const questionIndex = decodeInteractionIndex(parts[4]);
        if (interactionId && questionIndex !== null) {
          return {
            kind: "interaction_text",
            interactionId,
            questionId: null,
            questionIndex
          };
        }
      }

      if (parts[2] === "c" && parts[3]) {
        const interactionId = decodeInteractionToken(parts[3]);
        if (interactionId) {
          return {
            kind: "interaction_cancel",
            interactionId
          };
        }
      }

      if (parts[2] === "a" && parts[3] && parts[4]) {
        const interactionId = decodeInteractionToken(parts[3]);
        if (interactionId) {
          if (parts[4] === "open") {
            return {
              kind: "interaction_answer_expand",
              interactionId
            };
          }
          if (parts[4] === "close") {
            return {
              kind: "interaction_answer_collapse",
              interactionId
            };
          }
        }
      }

      if (parts[2] === "decision" && parts[3] && parts[4]) {
        return {
          kind: "interaction_decision",
          interactionId: parts[3],
          decisionKey: parts[4],
          decisionIndex: null
        };
      }

      if (parts[2] === "question" && parts[3] && parts[4] && parts[5]) {
        const optionIndex = Number.parseInt(parts[5], 10);
        if (Number.isFinite(optionIndex) && optionIndex >= 0) {
          return {
            kind: "interaction_question",
            interactionId: parts[3],
            questionId: parts[4],
            questionIndex: null,
            optionIndex
          };
        }
      }

      if (parts[2] === "text" && parts[3] && parts[4]) {
        return {
          kind: "interaction_text",
          interactionId: parts[3],
          questionId: parts[4],
          questionIndex: null
        };
      }

      if (parts[2] === "cancel" && parts[3]) {
        return {
          kind: "interaction_cancel",
          interactionId: parts[3]
        };
      }
    }

    return null;
  }

  if (parts[1] === "pick" && parts[2]) {
    return { kind: "pick", projectKey: parts[2] };
  }

  if (parts[1] === "scan" && parts[2] === "more") {
    return { kind: "scan_more" };
  }

  if (parts[1] === "path" && parts[2] === "manual") {
    return { kind: "path_manual" };
  }

  if (parts[1] === "path" && parts[2] === "back") {
    return { kind: "path_back" };
  }

  if (parts[1] === "path" && parts[2] === "confirm" && parts[3]) {
    return { kind: "path_confirm", projectKey: parts[3] };
  }

  if (parts[1] === "rename" && parts[2] === "session" && parts[3]) {
    return { kind: "rename_session", sessionId: parts[3] };
  }

  if (parts[1] === "rename" && parts[2] === "project" && parts[3] === "clear" && parts[4]) {
    return { kind: "rename_project_clear", sessionId: parts[4] };
  }

  if (parts[1] === "rename" && parts[2] === "project" && parts[3]) {
    return { kind: "rename_project", sessionId: parts[3] };
  }

  if (parts[1] === "plan" && parts[2] === "expand" && parts[3]) {
    return { kind: "plan_expand", sessionId: parts[3] };
  }

  if (parts[1] === "plan" && parts[2] === "collapse" && parts[3]) {
    return { kind: "plan_collapse", sessionId: parts[3] };
  }

  if (parts[1] === "agent" && parts[2] === "expand" && parts[3]) {
    return { kind: "agent_expand", sessionId: parts[3] };
  }

  if (parts[1] === "agent" && parts[2] === "collapse" && parts[3]) {
    return { kind: "agent_collapse", sessionId: parts[3] };
  }

  if (parts[1] === "final" && parts[2] === "open" && parts[3]) {
    return { kind: "final_open", answerId: parts[3] };
  }

  if (parts[1] === "final" && parts[2] === "close" && parts[3]) {
    return { kind: "final_close", answerId: parts[3] };
  }

  if (parts[1] === "final" && parts[2] === "page" && parts[3] && parts[4]) {
    const page = Number.parseInt(parts[4], 10);
    if (Number.isFinite(page) && page >= 1) {
      return { kind: "final_page", answerId: parts[3], page };
    }
  }

  return null;
}

function encodeInteractionToken(interactionId: string): string {
  return Buffer.from(interactionId, "utf8").toString("base64url");
}

function decodeInteractionToken(token: string): string | null {
  try {
    const interactionId = Buffer.from(token, "base64url").toString("utf8");
    return interactionId.length > 0 ? interactionId : null;
  } catch {
    return null;
  }
}

function encodeInteractionIndex(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`interaction callback index must be a non-negative safe integer: ${index}`);
  }

  return index.toString(36);
}

function decodeInteractionIndex(value: string): number | null {
  if (!/^[0-9a-z]+$/iu.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function ensureTelegramCallbackDataLimit(data: string): string {
  if (Buffer.byteLength(data, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
    throw new Error(`Telegram callback_data exceeds ${TELEGRAM_CALLBACK_DATA_LIMIT_BYTES} bytes: ${data}`);
  }

  return data;
}

function encodeRuntimeStatusField(field: RuntimeStatusField): string {
  const code = RUNTIME_STATUS_FIELD_CODES.get(field);
  if (!code) {
    throw new Error(`unknown RuntimeStatusField: ${field}`);
  }
  return code;
}

function decodeRuntimeStatusField(value: string): RuntimeStatusField | null {
  return RUNTIME_STATUS_CODE_TO_FIELD.get(value) ?? null;
}

function parseReasoningEffort(value: string): ReasoningEffort | null {
  switch (value) {
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return value;
    default:
      return null;
  }
}
