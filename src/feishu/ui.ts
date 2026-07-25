import type { TelegramInlineKeyboardMarkup } from "../telegram/api.js";
import { encodeCommandPanelOpenCallback, encodeCommandPanelRunCallback, encodeStatusInspectCallback, encodeStatusInterruptCallback } from "../telegram/ui-callbacks.js";
import { escapeHtml, formatHtmlField, formatHtmlHeading } from "../telegram/ui-shared.js";
import type { ReadinessSnapshot, SessionRow, UiLanguage } from "../types.js";

export const FEISHU_BOT_MENU_EVENT_KEYS = {
  newSession: "bridge_new_session",
  status: "bridge_status",
  sessions: "bridge_sessions",
  help: "bridge_help"
} as const;

type FeishuBotMenuCommand = "new" | "status" | "sessions" | "help";

export function resolveFeishuBotMenuCommand(eventKey: string): FeishuBotMenuCommand | null {
  switch (eventKey) {
    case FEISHU_BOT_MENU_EVENT_KEYS.newSession:
      return "new";
    case FEISHU_BOT_MENU_EVENT_KEYS.status:
      return "status";
    case FEISHU_BOT_MENU_EVENT_KEYS.sessions:
      return "sessions";
    case FEISHU_BOT_MENU_EVENT_KEYS.help:
      return "help";
    default:
      return null;
  }
}

function copy(language: UiLanguage) {
  if (language === "en") {
    return {
      welcomeTitle: "Welcome to Codex Bridge",
      welcomeBodyIdle: "Start a new session or jump back into your recent work from Feishu.",
      welcomeBodyActive: "Your current session is ready. Start a new task, review status, or jump into recent sessions.",
      setupTitle: "Feishu setup is not complete",
      setupBody: "This bridge is not fully ready for Feishu yet. Review the checks below before using command entry points.",
      statusTitle: "Feishu Status",
      checksTitle: "Key Checks",
      issuesTitle: "Current Issues",
      checklistTitle: "Next Steps",
      runtimeTitle: "Runtime Snapshot",
      currentSession: "Current session:",
      noSession: "No active session",
      bridgeState: "Bridge state:",
      packReady: "Feishu setup:",
      codexReady: "Codex:",
      authorization: "Authorization:",
      ok: "OK",
      pending: "Pending",
      incomplete: "Incomplete",
      unavailable: "Unavailable",
      checkLabels: {
        credentials: "Credentials",
        tenantToken: "Tenant token",
        authorization: "Authorized user",
        textIngress: "Text ingress",
        interactiveSend: "Card delivery",
        cardCallback: "Card callback",
        fileUpload: "File upload",
        imageUpload: "Image upload",
        contention: "Shared-app contention"
      },
      actions: {
        newSession: "New Session",
        sessions: "Recent Sessions",
        status: "Status",
        help: "Help",
        commands: "Commands",
        inspect: "Inspect",
        interrupt: "Interrupt"
      }
    };
  }

  return {
    welcomeTitle: "Welcome to Codex Bridge",
    welcomeBodyIdle: "Create sessions or return to recent work.",
    welcomeBodyActive: "Session ready. Start a task, check status, or switch sessions.",
    setupTitle: "Setup incomplete",
    setupBody: "Bridge not fully ready. Check the items below.",
    statusTitle: "Feishu Status",
    checksTitle: "Checks",
    issuesTitle: "Issues",
    checklistTitle: "Next",
    runtimeTitle: "Running Overview",
    currentSession: "Session: ",
    noSession: "No active sessions",
    bridgeState: "Bridge: ",
    packReady: "Feishu: ",
    codexReady: "Codex: ",
    authorization: "Auth: ",
    ok: "OK",
    pending: "Pending",
    incomplete: "Incomplete",
    unavailable: "Unavailable",
    checkLabels: {
      credentials: "Credentials",
      tenantToken: "Tenant Token",
      authorization: "Authorized User",
      textIngress: "Text Message",
      interactiveSend: "卡片发送",
      cardCallback: "卡片回调",
      fileUpload: "文件上传",
      imageUpload: "图片上传",
      contention: "共享应用冲突"
    },
    actions: {
      newSession: "新建会话",
      sessions: "Recent",
      status: "当前状态",
      help: "Help",
      commands: "Commands",
      inspect: "查看详情",
      interrupt: "中断操作"
    }
  };
}

function projectDisplayName(session: Pick<SessionRow, "projectName" | "projectAlias">): string {
  return session.projectAlias?.trim() || session.projectName;
}

function summarizeActiveSession(session: SessionRow | null, language: UiLanguage): string {
  if (!session) {
    return copy(language).noSession;
  }

  const state = session.status === "running"
    ? (language === "en" ? "running" : "Running")
    : session.status === "failed"
      ? (language === "en" ? "failed" : "Failed")
      : session.status === "interrupted"
        ? (language === "en" ? "interrupted" : "Interrupted")
        : (language === "en" ? "idle" : "Idle");

  return `${escapeHtml(projectDisplayName(session))} / ${escapeHtml(session.displayName)} / ${escapeHtml(state)}`;
}

function buildFeishuCommandButtonRows(options: {
  language: UiLanguage;
  activeSession: SessionRow | null;
  includeStatus?: boolean;
}): TelegramInlineKeyboardMarkup {
  const labels = copy(options.language).actions;
  const rows: TelegramInlineKeyboardMarkup["inline_keyboard"] = [[
    {
      text: labels.newSession,
      callback_data: encodeCommandPanelRunCallback("new"),
      style: "primary"
    },
    {
      text: labels.sessions,
      callback_data: encodeCommandPanelRunCallback("sessions")
    }
  ]];

  rows[0]!.push({
    text: labels.status,
    callback_data: encodeCommandPanelRunCallback("status")
  });

  if (options.activeSession) {
    rows.push([
      {
        text: labels.inspect,
        callback_data: encodeStatusInspectCallback(options.activeSession.sessionId)
      },
      {
        text: labels.interrupt,
        callback_data: encodeStatusInterruptCallback(options.activeSession.sessionId),
        style: "primary"
      }
    ]);
  }

  rows.push([
    {
      text: labels.help,
      callback_data: encodeCommandPanelRunCallback("help")
    },
    {
      text: labels.commands,
      callback_data: encodeCommandPanelOpenCallback()
    }
  ]);

  return {
    inline_keyboard: rows
  };
}

export function buildFeishuWelcomeMessage(options: {
  language: UiLanguage;
  activePackLabel: string;
  activeSession: SessionRow | null;
}): {
  text: string;
  replyMarkup: TelegramInlineKeyboardMarkup;
} {
  const labels = copy(options.language);
  const body = options.activeSession ? labels.welcomeBodyActive : labels.welcomeBodyIdle;
  const lines = [
    formatHtmlHeading(labels.welcomeTitle),
    body,
    formatHtmlField(labels.currentSession, summarizeActiveSession(options.activeSession, options.language))
  ];

  return {
    text: lines.join("\n\n"),
    replyMarkup: buildFeishuCommandButtonRows({
      language: options.language,
      activeSession: options.activeSession,
      includeStatus: true
    })
  };
}

function resolveCheckLabel(id: string, language: UiLanguage): string {
  const labels = copy(language).checkLabels;
  switch (id) {
    case "feishu_credentials":
      return labels.credentials;
    case "feishu_tenant_token_validation":
      return labels.tenantToken;
    case "feishu_authorization_binding":
      return labels.authorization;
    case "feishu_text_ingress_observed":
      return labels.textIngress;
    case "feishu_interactive_card_delivery_observed":
      return labels.interactiveSend;
    case "feishu_card_callback_observed":
      return labels.cardCallback;
    case "feishu_file_upload_scopes":
      return labels.fileUpload;
    case "feishu_image_upload_scopes":
      return labels.imageUpload;
    case "feishu_shared_app_contention_suspected":
      return labels.contention;
    default:
      return id;
  }
}

function selectedFeishuChecks(snapshot: ReadinessSnapshot) {
  const orderedIds = [
    "feishu_credentials",
    "feishu_tenant_token_validation",
    "feishu_authorization_binding",
    "feishu_text_ingress_observed",
    "feishu_interactive_card_delivery_observed",
    "feishu_card_callback_observed",
    "feishu_file_upload_scopes",
    "feishu_image_upload_scopes",
    "feishu_shared_app_contention_suspected"
  ];

  const checks = snapshot.details.packChecks ?? [];
  return orderedIds
    .map((id) => checks.find((check) => check.id === id))
    .filter((check): check is NonNullable<typeof checks[number]> => Boolean(check));
}

export function buildFeishuStatusText(options: {
  language: UiLanguage;
  snapshot: ReadinessSnapshot;
  activeSession: SessionRow | null;
  runtimeStatusText?: string | null;
}): string {
  const labels = copy(options.language);
  const issueText = options.snapshot.details.issues.length === 0
    ? (options.language === "en" ? "None" : "None")
    : options.snapshot.details.issues.join("; ");
  const lines = [
    formatHtmlHeading(options.snapshot.details.setupState === "incomplete" ? labels.setupTitle : labels.statusTitle),
    options.snapshot.details.setupState === "incomplete" ? labels.setupBody : "",
    formatHtmlField(labels.bridgeState, options.snapshot.state),
    formatHtmlField(
      labels.packReady,
      options.snapshot.details.setupState === "complete" ? labels.ok : labels.incomplete
    ),
    formatHtmlField(
      labels.codexReady,
      options.snapshot.details.codexAuthenticated && options.snapshot.details.appServerAvailable ? labels.ok : labels.unavailable
    ),
    formatHtmlField(
      labels.authorization,
      options.snapshot.details.authorizedUserBound ? labels.ok : labels.pending
    ),
    formatHtmlField(labels.currentSession, summarizeActiveSession(options.activeSession, options.language))
  ].filter((line) => line.length > 0);

  const checks = selectedFeishuChecks(options.snapshot);
  if (checks.length > 0) {
    lines.push("", formatHtmlHeading(labels.checksTitle));
    for (const check of checks) {
      lines.push(formatHtmlField(
        `${resolveCheckLabel(check.id, options.language)}：`,
        check.ok ? labels.ok : labels.pending
      ));
      lines.push(escapeHtml(check.summary));
    }
  }

  if (options.snapshot.details.setupState === "incomplete" && (options.snapshot.details.setupChecklist?.length ?? 0) > 0) {
    lines.push("", formatHtmlHeading(labels.checklistTitle));
    for (const item of options.snapshot.details.setupChecklist ?? []) {
      lines.push(`- ${escapeHtml(item)}`);
    }
  }

  if (options.snapshot.details.issues.length > 0) {
    lines.push("", formatHtmlHeading(labels.issuesTitle), escapeHtml(issueText));
  }

  if (options.runtimeStatusText) {
    lines.push("", formatHtmlHeading(labels.runtimeTitle), options.runtimeStatusText);
  }

  return lines.join("\n");
}

export function buildFeishuStatusReplyMarkup(options: {
  language: UiLanguage;
  activeSession: SessionRow | null;
}): TelegramInlineKeyboardMarkup | undefined {
  return buildFeishuCommandButtonRows({
    language: options.language,
    activeSession: options.activeSession,
    includeStatus: false
  });
}
