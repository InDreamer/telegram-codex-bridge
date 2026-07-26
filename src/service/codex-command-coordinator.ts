import type { CodexAppServerClient, UserInput } from "../codex/app-server.js";
import {
  createRollbackConfirmView,
  createRollbackPickerView
} from "../core/workflow/runtime-workflow.js";
import type { BridgeStateStore } from "../state/store.js";
import type { TelegramInlineKeyboardMarkup } from "../telegram/api.js";
import {
  buildModelPickerClosedText,
  buildModelPickerMessage,
  buildReasoningEffortPickerMessage,
  buildRollbackClosedMessage,
  buildRollbackConfirmMessage,
  buildRollbackPickerMessage,
  formatSessionModelReasoningConfig,
  type RollbackTargetView
} from "../telegram/ui.js";
import type { ReasoningEffort, SessionRow } from "../types.js";
import { normalizeAndTruncate, normalizeWhitespace, truncateText, summarizeTextPreview, splitStructuredInputCommand, HISTORY_TEXT_LIMIT } from "../util/text.js";
import { asRecord, getArray, getString } from "../util/untyped.js";

interface ReviewCommandArgs {
  delivery?: "inline" | "detached";
  target:
    | { type: "uncommittedChanges" }
    | { type: "baseBranch"; branch: string }
    | { type: "commit"; sha: string; title?: string | null }
    | { type: "custom"; instructions: string };
}

interface ThreadMetadataUpdate {
  branch?: string | null;
  sha?: string | null;
  originUrl?: string | null;
}

interface CodexCommandCoordinatorDeps {
  getStore: () => BridgeStateStore | null;
  ensureAppServerAvailable: () => Promise<CodexAppServerClient>;
  startFreshThreadForClear: (session: SessionRow) => Promise<Awaited<ReturnType<CodexAppServerClient["startThread"]>>>;
  fetchAllModels: () => Promise<
    NonNullable<Awaited<ReturnType<CodexAppServerClient["listModels"]>>["data"]>
  >;
  fetchAllApps: (
    threadId?: string
  ) => Promise<NonNullable<Awaited<ReturnType<CodexAppServerClient["listApps"]>>["data"]>>;
  fetchAllMcpServerStatuses: () => Promise<
    NonNullable<Awaited<ReturnType<CodexAppServerClient["listMcpServerStatuses"]>>["data"]>
  >;
  resolveSessionModelState: (session: SessionRow) => Promise<{
    configuredModel: string | null;
    configuredReasoningEffort: ReasoningEffort | null;
    effectiveModel: string | null;
    effectiveReasoningEffort: ReasoningEffort | null;
  }>;
  ensureSessionThread: (session: SessionRow) => Promise<string>;
  beginActiveTurn: (
    chatId: string,
    session: SessionRow,
    threadId: string,
    turnId: string,
    turnStatus: string,
    options?: {
      mode?: "default" | "review";
    }
  ) => Promise<void>;
  submitOrQueueRichInput: (
    chatId: string,
    session: SessionRow,
    inputs: UserInput[],
    prompt: string | null,
    promptLabel: string
  ) => Promise<void>;
  getRunningTurnCapacity: (chatId: string) => {
    allowed: boolean;
    runningCount: number;
    limit: number;
  };
  resolvePendingInteractionsForSession: (
    chatId: string,
    sessionId: string,
    options: {
      state: "failed" | "expired";
      reason: string;
      resolutionSource: "server_response_success" | "server_response_error" | "app_server_exit" | "interaction_delivery_failed" | "turn_expired" | "session_clear" | "bridge_restart_recovery";
    }
  ) => Promise<void>;
  resetPendingTransientInputs: (chatId: string) => void;
  clearRecentActivity: (sessionId: string) => void;
  syncCurrentSessionCard: (chatId: string, reason: string) => Promise<void>;
  safeSendMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeSendHtmlMessage: (
    chatId: string,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<boolean>;
  safeEditMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<unknown>;
  safeEditHtmlMessageText: (
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup
  ) => Promise<unknown>;
  safeAnswerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
}

export class CodexCommandCoordinator {
  constructor(private readonly deps: CodexCommandCoordinatorDeps) {}

  async handleModel(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const requestedModel = args.trim();
    await this.deps.ensureAppServerAvailable();
    const models = await this.deps.fetchAllModels();

    if (!requestedModel) {
      const modelState = await this.deps.resolveSessionModelState(activeSession);
      const picker = buildModelPickerMessage({
        session: activeSession,
        models,
        page: 0,
        modelState
      });
      await this.deps.safeSendMessage(chatId, picker.text, picker.replyMarkup);
      return;
    }

    if (requestedModel === "default" || requestedModel === "Default") {
      await this.persistSessionModelSelection(chatId, null, activeSession, null, null);
      return;
    }

    const matched = models.find((model) => model.id === requestedModel || model.model === requestedModel);
    if (!matched) {
      await this.deps.safeSendMessage(chatId, "Model not found. Send /model.");
      return;
    }

    if (matched.supportedReasoningEfforts.length > 1) {
      const modelIndex = models.findIndex((model) => model.id === matched.id);
      const modelState = await this.deps.resolveSessionModelState(activeSession);
      const picker = buildReasoningEffortPickerMessage({
        session: activeSession,
        model: matched,
        modelIndex,
        modelState
      });
      await this.deps.safeSendMessage(chatId, picker.text, picker.replyMarkup);
      return;
    }

    await this.persistSessionModelSelection(chatId, null, activeSession, matched.id, null);
  }

  async handleModelDefaultCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    store.setSessionSelectedModel(session.sessionId, null);
    store.setSessionSelectedReasoningEffort(session.sessionId, null);
    await this.deps.safeEditMessageText(
      chatId,
      messageId,
      this.buildModelSelectionText(session.displayName, "Default model")
    );
  }

  async handleModelCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    const modelState = await this.deps.resolveSessionModelState(session);
    await this.deps.safeEditHtmlMessageText(chatId, messageId, buildModelPickerClosedText(session, modelState));
  }

  async handleModelPageCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    page: number
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.deps.ensureAppServerAvailable();
    const models = await this.deps.fetchAllModels();
    const modelState = await this.deps.resolveSessionModelState(session);
    const picker = buildModelPickerMessage({ session, models, page, modelState });
    await this.deps.safeEditMessageText(chatId, messageId, picker.text, picker.replyMarkup);
  }

  async handleModelPickCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    modelIndex: number
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.deps.ensureAppServerAvailable();
    const models = await this.deps.fetchAllModels();
    const model = models[modelIndex];
    if (!model) {
      await this.handleExpiredModelPicker(chatId, messageId);
      return;
    }

    if (model.supportedReasoningEfforts.length > 1) {
      const modelState = await this.deps.resolveSessionModelState(session);
      const picker = buildReasoningEffortPickerMessage({ session, model, modelIndex, modelState });
      await this.deps.safeEditMessageText(chatId, messageId, picker.text, picker.replyMarkup);
      return;
    }

    await this.persistSessionModelSelection(chatId, messageId, session, model.id, null);
  }

  async handleModelEffortCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    modelIndex: number,
    effort: ReasoningEffort | null
  ): Promise<void> {
    const session = this.getActiveSessionForModelCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, try again.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.deps.ensureAppServerAvailable();
    const models = await this.deps.fetchAllModels();
    const model = models[modelIndex];
    if (!model) {
      await this.handleExpiredModelPicker(chatId, messageId);
      return;
    }

    await this.persistSessionModelSelection(chatId, messageId, session, model.id, effort);
  }

  async handleSkills(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.listSkills({
      cwds: [activeSession.projectPath],
      forceReload: false
    });
    const entry = result.data.find((candidate) => candidate.cwd === activeSession.projectPath) ?? result.data[0];
    if (!entry) {
      await this.deps.safeSendMessage(chatId, "No skills for this project.");
      return;
    }

    const lines = this.buildSessionProjectContextLines(activeSession, "Available Skills");
    for (const skill of entry.skills.slice(0, 20)) {
      const description = skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description;
      const marker = skill.enabled ? "[Enabled] " : "[Disabled] ";
      lines.push(`${marker}${skill.name} | ${summarizeTextPreview(description, 80)}`);
    }
    if (entry.errors.length > 0) {
      lines.push("", `Scan warning: ${summarizeTextPreview(entry.errors[0]?.message ?? "unknown error", 120)}`);
    }
    lines.push("", "使用 /skill <技能名> :: 任务说明 将 skill 作为结构化输入发送给 Codex。");
    await this.deps.safeSendMessage(chatId, lines.join("\n"));
  }

  async handleSkill(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.deps.safeSendMessage(chatId, "用法：/skill <技能名> :: 任务说明");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.listSkills({
      cwds: [activeSession.projectPath],
      forceReload: false
    });
    const entry = result.data.find((candidate) => candidate.cwd === activeSession.projectPath) ?? result.data[0];
    const skill = entry?.skills.find((candidate) => candidate.name === parsed.value);
    if (!skill) {
      await this.deps.safeSendMessage(chatId, "Skill not found. Send /skills.");
      return;
    }

    await this.deps.submitOrQueueRichInput(chatId, activeSession, [{
      type: "skill",
      name: skill.name,
      path: skill.path
    }], parsed.prompt, `skill: ${skill.name}`);
  }

  async handlePlugins(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.listPlugins({
      cwds: [activeSession.projectPath]
    });
    if (result.marketplaces.length === 0) {
      await this.deps.safeSendMessage(chatId, "No plugins for this project.");
      return;
    }

    const lines = this.buildSessionProjectContextLines(activeSession, "Available Plugins");
    const installExample = findFirstInstallablePlugin(result);

    for (const marketplace of result.marketplaces.slice(0, 5)) {
      lines.push(`Market: ${marketplace.name}`);
      for (const plugin of marketplace.plugins.slice(0, 8)) {
        const flags = [
          plugin.installed ? "[Installed]" : "[Not installed]",
          plugin.enabled ? "[Enabled]" : ""
        ].join("");
        const label = plugin.interface?.displayName ?? plugin.name;
        const description = plugin.interface?.shortDescription;
        lines.push(`${flags} ${plugin.id} | ${label}${description ? ` | ${summarizeTextPreview(description, 60)}` : ""}`);
      }
    }

    lines.push("", "使用 /plugin install <市场>/<插件名> 安装插件。");
    lines.push("使用 /plugin uninstall <插件ID> 卸载插件。");
    if (installExample) {
      lines.push(`例如：/plugin install ${installExample.marketplaceName}/${installExample.pluginName}`);
    }
    await this.deps.safeSendMessage(chatId, lines.join("\n"));
  }

  async handlePlugin(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const [subcommand = "", ...rest] = args.trim().split(/\s+/u);
    const appServer = await this.deps.ensureAppServerAvailable();

    if (subcommand === "install") {
      const target = rest.join(" ").trim();
      const parsedTarget = parsePluginInstallTarget(target);
      if (!parsedTarget) {
        await this.deps.safeSendMessage(chatId, "用法：/plugin install <市场>/<插件名>");
        return;
      }

      const result = await appServer.listPlugins({
        cwds: [activeSession.projectPath]
      });
      const marketplace = result.marketplaces.find((entry) => entry.name === parsedTarget.marketplaceName);
      const plugin = marketplace?.plugins.find((entry) => entry.name === parsedTarget.pluginName);
      if (!marketplace || !plugin) {
        await this.deps.safeSendMessage(chatId, "Plugin not found. Send /plugins.");
        return;
      }

      const installResult = await appServer.installPlugin({
        marketplacePath: marketplace.path,
        pluginName: plugin.name
      });
      const lines = [`已为项目「${this.projectDisplayName(activeSession)}」安装插件：${plugin.name}`];
      if (installResult.appsNeedingAuth.length > 0) {
        lines.push("", "Some Apps may need additional auth:");
        for (const app of installResult.appsNeedingAuth.slice(0, 5)) {
          lines.push(`- ${app.name}${app.installUrl ? ` | ${app.installUrl}` : ""}`);
        }
      }
      await this.deps.safeSendMessage(chatId, lines.join("\n"));
      return;
    }

    if (subcommand === "uninstall") {
      const pluginId = rest.join(" ").trim();
      if (!pluginId) {
        await this.deps.safeSendMessage(chatId, "用法：/plugin uninstall <插件ID>");
        return;
      }

      await appServer.uninstallPlugin(pluginId);
      await this.deps.safeSendMessage(chatId, `已为项目「${this.projectDisplayName(activeSession)}」卸载插件：${pluginId}`);
      return;
    }

    await this.deps.safeSendMessage(chatId, "用法：/plugin install <市场>/<插件名> 或 /plugin uninstall <插件ID>");
  }

  async handleApps(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    await this.deps.ensureAppServerAvailable();
    const apps = await this.deps.fetchAllApps(activeSession.threadId ?? undefined);
    if (apps.length === 0) {
      await this.deps.safeSendMessage(chatId, "No Apps available.");
      return;
    }

    const lines = this.buildSessionProjectContextLines(activeSession, "Available Apps");
    for (const app of apps.slice(0, 12)) {
      const flags = [
        app.isAccessible ? "[Accessible]" : "[Inaccessible]",
        app.isEnabled ? "[Enabled]" : "[Not enabled]"
      ].join("");
      lines.push(`${flags} ${app.name}${app.description ? ` | ${summarizeTextPreview(app.description, 70)}` : ""}`);
      if (app.pluginDisplayNames.length > 0) {
        lines.push(`Plugin: ${app.pluginDisplayNames.join(", ")}`);
      }
      if (app.installUrl) {
        lines.push(`Install: ${app.installUrl}`);
      }
    }

    await this.deps.safeSendMessage(chatId, lines.join("\n"));
  }

  async handleMcp(chatId: string, args: string): Promise<void> {
    const trimmed = args.trim();
    const [subcommand = "", ...rest] = trimmed.split(/\s+/u);
    const appServer = await this.deps.ensureAppServerAvailable();

    if (!trimmed) {
      const statuses = await this.deps.fetchAllMcpServerStatuses();
      if (statuses.length === 0) {
        await this.deps.safeSendMessage(chatId, "No MCP servers.");
        return;
      }

      const lines = ["MCP Server Status"];
      for (const status of statuses.slice(0, 12)) {
        lines.push(
          `${status.name} | ${formatMcpAuthStatus(status.authStatus)} | 工具 ${Object.keys(status.tools).length} | 资源 ${status.resources.length} | 模板 ${status.resourceTemplates.length}`
        );
      }
      lines.push("", "Use /mcp reload or /mcp login <name>.");
      await this.deps.safeSendMessage(chatId, lines.join("\n"));
      return;
    }

    if (subcommand === "reload") {
      await appServer.reloadMcpServers();
      await this.deps.safeSendMessage(chatId, "MCP config reloaded.");
      return;
    }

    if (subcommand === "login") {
      const serverName = rest.join(" ").trim();
      if (!serverName) {
        await this.deps.safeSendMessage(chatId, "Usage: /mcp login <name>");
        return;
      }

      const result = await appServer.loginToMcpServer({ name: serverName });
      if (!result.authorizationUrl) {
        await this.deps.safeSendMessage(chatId, "Can't generate MCP login link.");
        return;
      }

      await this.deps.safeSendMessage(
        chatId,
        `MCP login link generated: ${serverName}\n${result.authorizationUrl}\n完成后重新发送 /mcp 查看最新状态。`
      );
      return;
    }

    await this.deps.safeSendMessage(chatId, "Usage: /mcp, /mcp reload, or /mcp login <name>");
  }

  async handleAccount(chatId: string): Promise<void> {
    const appServer = await this.deps.ensureAppServerAvailable();
    const accountResult = await appServer.readAccount(false);
    let rateLimitsResult: Awaited<ReturnType<CodexAppServerClient["readAccountRateLimits"]>> | null = null;

    try {
      rateLimitsResult = await appServer.readAccountRateLimits();
    } catch {
      rateLimitsResult = null;
    }

    const lines = ["Codex Account"];
    if (!accountResult.account) {
      lines.push("Not logged in");
    } else if (accountResult.account.type === "apiKey") {
      lines.push("Type: API Key");
    } else {
      lines.push("Type: ChatGPT");
      lines.push(`Email: ${accountResult.account.email}`);
      lines.push(`Plan: ${accountResult.account.planType}`);
    }
    lines.push(`Needs OpenAI Auth: ${accountResult.requiresOpenaiAuth ? "Yes" : "No"}`);

    const rateSummary = formatRateLimitSummary(rateLimitsResult?.rateLimits ?? null);
    if (rateSummary) {
      lines.push(rateSummary);
    }

    await this.deps.safeSendMessage(chatId, lines.join("\n"));
  }

  async handleReview(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Project still running. Wait or stop first.");
      return;
    }

    const capacity = this.deps.getRunningTurnCapacity(chatId);
    if (!capacity.allowed) {
      await this.deps.safeSendMessage(
        chatId,
        `Max parallel: ${capacity.limit} sessions. Wait or stop some.`
      );
      return;
    }

    const parsed = parseReviewCommandArgs(args);
    if (!parsed) {
      await this.deps.safeSendMessage(
        chatId,
        "用法：/review [detached] [branch <分支>|commit <SHA>|custom <说明>]"
      );
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const threadId = await this.deps.ensureSessionThread(activeSession);
    const result = await appServer.reviewStart({
      threadId,
      target: parsed.target,
      ...(parsed.delivery ? { delivery: parsed.delivery } : {})
    });

    let reviewSession = store.getSessionById(activeSession.sessionId) ?? activeSession;
    if (result.reviewThreadId !== threadId) {
      reviewSession = store.createSession({
        chatId,
        projectName: activeSession.projectName,
        projectPath: activeSession.projectPath,
        displayName: `Review: ${activeSession.displayName}`,
        displayNameSource: "manual",
        selectedModel: activeSession.selectedModel,
        selectedReasoningEffort: activeSession.selectedReasoningEffort,
        planMode: activeSession.planMode,
        needsDefaultCollaborationModeReset: activeSession.needsDefaultCollaborationModeReset
      });
      store.updateSessionThreadId(reviewSession.sessionId, result.reviewThreadId);
      reviewSession = store.getSessionById(reviewSession.sessionId) ?? reviewSession;
      await this.deps.safeSendMessage(chatId, `Review session created: ${reviewSession.displayName}`);
    }

    await this.deps.beginActiveTurn(chatId, reviewSession, result.reviewThreadId, result.turn.id, result.turn.status, {
      mode: "review"
    });
  }

  async handleFork(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.deps.safeSendMessage(chatId, "No threads to fork. Complete a task first.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Project still running. Wait or stop first.");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const forked = await appServer.forkThread({
      threadId: activeSession.threadId,
      ...(activeSession.selectedModel ? { model: activeSession.selectedModel } : {})
    });
    const lastForkTurn = forked.thread.turns.at(-1) ?? null;
    const requestedForkName = args.trim();
    const created = store.createSession({
      chatId,
      projectName: activeSession.projectName,
      projectPath: activeSession.projectPath,
      displayName: requestedForkName || `Fork: ${activeSession.displayName}`,
      displayNameSource: requestedForkName ? "manual" : "auto",
      selectedModel: activeSession.selectedModel ?? forked.model,
      selectedReasoningEffort: activeSession.selectedReasoningEffort ?? forked.reasoningEffort ?? null,
      planMode: activeSession.planMode,
      needsDefaultCollaborationModeReset: activeSession.needsDefaultCollaborationModeReset,
      threadId: forked.thread.id,
      lastTurnId: lastForkTurn?.id ?? activeSession.lastTurnId,
      lastTurnStatus: lastForkTurn?.status ?? activeSession.lastTurnStatus
    });
    await this.deps.safeSendMessage(chatId, `Fork session created: ${created.displayName}`);
  }

  async handleRollback(chatId: string, args: string): Promise<void> {
    const session = this.getIdleRollbackSession(chatId);
    if (!session) {
      return;
    }

    const trimmed = args.trim();
    if (!trimmed) {
      const targets = await this.buildRollbackTargets(session);
      if (targets.length === 0) {
        await this.deps.safeSendMessage(chatId, "No rollback targets available.");
        return;
      }

      const rendered = buildRollbackPickerMessage(createRollbackPickerView({
        sessionId: session.sessionId,
        page: 0,
        targets
      }));
      await this.deps.safeSendHtmlMessage(chatId, rendered.text, rendered.replyMarkup);
      return;
    }

    const numTurns = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(numTurns) || numTurns < 1) {
      await this.deps.safeSendMessage(chatId, "用法：/rollback 或 /rollback <回滚的 turn 数量>");
      return;
    }

    await this.executeRollback(session, numTurns);
    await this.deps.safeSendMessage(chatId, buildRollbackSuccessText(numTurns, session.displayName));
  }

  async handleRollbackPickerCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    options:
      | {
          mode: "list";
          page: number;
        }
      | {
          mode: "confirm";
          page: number;
          targetIndex: number;
        }
  ): Promise<void> {
    const session = this.getRollbackSessionForCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, resend /rollback.");
      return;
    }

    const targets = await this.buildRollbackTargets(session);
    if (targets.length === 0) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "No rollback targets available.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);

    if (options.mode === "confirm") {
      const target = targets.find((candidate) => candidate.index === options.targetIndex);
      if (!target) {
        await this.deps.safeEditMessageText(chatId, messageId, "Target expired, resend /rollback.");
        return;
      }

      const rendered = buildRollbackConfirmMessage(createRollbackConfirmView({
        sessionId,
        page: options.page,
        target
      }));
      await this.deps.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
      return;
    }

    const rendered = buildRollbackPickerMessage(createRollbackPickerView({
      sessionId,
      page: options.page,
      targets
    }));
    await this.deps.safeEditHtmlMessageText(chatId, messageId, rendered.text, rendered.replyMarkup);
  }

  async handleRollbackConfirmCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string,
    targetIndex: number
  ): Promise<void> {
    const session = this.getRollbackSessionForCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, resend /rollback.");
      return;
    }

    const targets = await this.buildRollbackTargets(session);
    const target = targets.find((candidate) => candidate.index === targetIndex);
    if (!target || target.rollbackCount < 1) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Target expired, resend /rollback.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.executeRollback(session, target.rollbackCount);
    await this.deps.safeEditMessageText(
      chatId,
      messageId,
      `Rolled back to: ${target.sequenceNumber}. ${target.label}\n${buildRollbackSuccessText(target.rollbackCount, session.displayName)}`
    );
  }

  async handleRollbackCloseCallback(
    callbackQueryId: string,
    chatId: string,
    messageId: number,
    sessionId: string
  ): Promise<void> {
    const session = this.getRollbackSessionForCallback(chatId, sessionId);
    if (!session) {
      await this.deps.safeAnswerCallbackQuery(callbackQueryId, "Button expired, resend /rollback.");
      return;
    }

    await this.deps.safeAnswerCallbackQuery(callbackQueryId);
    await this.deps.safeEditHtmlMessageText(chatId, messageId, buildRollbackClosedMessage());
  }

  async handleCompact(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.deps.safeSendMessage(chatId, "No threads to compress.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Project still running. Wait or stop first.");
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    await appServer.compactThread(activeSession.threadId);
    await this.deps.safeSendMessage(chatId, `Session "${activeSession.displayName}" compression requested.`);
  }

  async handleClear(chatId: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Project still running. Wait or stop first.");
      return;
    }

    const previousThreadId = activeSession.threadId;
    if (previousThreadId) {
      const archivedSnapshot = store.createSession({
        chatId,
        projectName: activeSession.projectName,
        projectPath: activeSession.projectPath,
        displayName: this.buildClearedSnapshotName(activeSession.displayName),
        displayNameSource: "manual",
        selectedModel: activeSession.selectedModel,
        selectedReasoningEffort: activeSession.selectedReasoningEffort,
        planMode: activeSession.planMode,
        needsDefaultCollaborationModeReset: activeSession.needsDefaultCollaborationModeReset,
        threadId: previousThreadId,
        lastTurnId: activeSession.lastTurnId,
        lastTurnStatus: activeSession.lastTurnStatus
      });
      store.archiveSession(archivedSnapshot.sessionId);
      store.setActiveSession(chatId, activeSession.sessionId);
    }

    await this.deps.resolvePendingInteractionsForSession(chatId, activeSession.sessionId, {
      state: "expired",
      reason: "session_cleared",
      resolutionSource: "session_clear"
    });
    this.deps.resetPendingTransientInputs(chatId);
    store.updateSessionStatus(activeSession.sessionId, "idle", {
      lastTurnId: null,
      lastTurnStatus: null
    });
    const started = await this.deps.startFreshThreadForClear(activeSession);
    store.updateSessionThreadId(activeSession.sessionId, started.thread.id);
    this.deps.clearRecentActivity(activeSession.sessionId);
    await this.deps.syncCurrentSessionCard(chatId, "session_cleared");
    await this.deps.safeSendMessage(
      chatId,
      previousThreadId
        ? `Session "${activeSession.displayName}" context cleared, switched to new thread.上一线程已保留到归档会话中，可用 /sessions archived 查看。`
        : `Session "${activeSession.displayName}" reset, new thread started.`
    );
  }

  async handleThreadCommand(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      await this.deps.safeSendMessage(chatId, "当前会话还没有 Codex 线程，请先完成一次任务。");
      return;
    }

    if (activeSession.status === "running") {
      await this.deps.safeSendMessage(chatId, "Project still running. Wait or stop first.");
      return;
    }

    const trimmed = args.trim();
    const [subcommand, ...rest] = trimmed.split(/\s+/u);
    if (!subcommand) {
      await this.deps.safeSendMessage(
        chatId,
        "用法：/thread name <名称> 或 /thread meta branch=<分支> sha=<提交> origin=<URL> 或 /thread clean-terminals"
      );
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();

    if (subcommand === "name") {
      const nextName = rest.join(" ").trim();
      if (!nextName) {
        await this.deps.safeSendMessage(chatId, "用法：/thread name <名称>");
        return;
      }

      await appServer.setThreadName(activeSession.threadId, nextName);
      store.renameSession(activeSession.sessionId, nextName);
      await this.deps.safeSendMessage(chatId, `Session title updated: ${nextName}`);
      return;
    }

    if (subcommand === "meta") {
      const gitInfo = parseThreadMetadataTokens(rest);
      if (!gitInfo) {
        await this.deps.safeSendMessage(chatId, "用法：/thread meta branch=<分支> sha=<提交> origin=<URL>");
        return;
      }

      await appServer.updateThreadMetadata({
        threadId: activeSession.threadId,
        gitInfo
      });
      const fragments = [
        gitInfo.branch !== undefined ? `branch=${gitInfo.branch ?? "clear"}` : null,
        gitInfo.sha !== undefined ? `sha=${gitInfo.sha ?? "clear"}` : null,
        gitInfo.originUrl !== undefined ? `origin=${gitInfo.originUrl ?? "clear"}` : null
      ].filter((value): value is string => Boolean(value));
      await this.deps.safeSendMessage(
        chatId,
        `Session "${activeSession.displayName}" thread metadata updated: ${fragments.join(", ")}`
      );
      return;
    }

    if (subcommand === "clean-terminals") {
      await appServer.cleanBackgroundTerminals(activeSession.threadId);
      await this.deps.safeSendMessage(chatId, `Session "${activeSession.displayName}" background terminal cleaned.`);
      return;
    }

    await this.deps.safeSendMessage(
      chatId,
      "用法：/thread name <名称> 或 /thread meta branch=<分支> sha=<提交> origin=<URL> 或 /thread clean-terminals"
    );
  }

  private getActiveSessionForModelCallback(chatId: string, sessionId: string): SessionRow | null {
    const store = this.deps.getStore();
    if (!store) {
      return null;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId) {
      return null;
    }

    return activeSession;
  }

  private projectDisplayName(session: Pick<SessionRow, "projectName" | "projectAlias">): string {
    return session.projectAlias?.trim() || session.projectName;
  }

  private buildSessionProjectContextLines(
    session: Pick<SessionRow, "displayName" | "projectName" | "projectAlias">,
    title: string
  ): string[] {
    return [
      `Session: ${session.displayName}`,
      `Project: ${this.projectDisplayName(session)}`,
      title
    ];
  }

  private buildModelSelectionText(sessionName: string, nextConfig: string): string {
    return `Session "${sessionName}" model set to: ${nextConfig}\nWill take effect on next task.`;
  }

  private async handleExpiredModelPicker(chatId: string, messageId: number): Promise<void> {
    await this.deps.safeEditMessageText(chatId, messageId, "Model list expired. Send /model.");
  }

  private async persistSessionModelSelection(
    chatId: string,
    messageId: number | null,
    session: SessionRow,
    modelId: string | null,
    effort: ReasoningEffort | null
  ): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    store.setSessionSelectedModel(session.sessionId, modelId);
    store.setSessionSelectedReasoningEffort(session.sessionId, effort);

    const nextConfig = formatSessionModelReasoningConfig({
      selectedModel: modelId,
      selectedReasoningEffort: effort
    });
    const text = this.buildModelSelectionText(session.displayName, nextConfig);

    if (messageId === null) {
      await this.deps.safeSendMessage(chatId, text);
      return;
    }

    await this.deps.safeEditMessageText(chatId, messageId, text);
  }

  private getIdleRollbackSession(chatId: string): SessionRow | null {
    const store = this.deps.getStore();
    if (!store) {
      return null;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || !activeSession.threadId) {
      void this.deps.safeSendMessage(chatId, "Session has no threads to roll back.");
      return null;
    }

    if (activeSession.status === "running") {
      void this.deps.safeSendMessage(chatId, "Project still running. Wait or stop first.");
      return null;
    }

    return activeSession;
  }

  private getRollbackSessionForCallback(chatId: string, sessionId: string): SessionRow | null {
    const store = this.deps.getStore();
    if (!store) {
      return null;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== sessionId || !activeSession.threadId) {
      return null;
    }

    if (activeSession.status === "running") {
      return null;
    }

    return activeSession;
  }

  private async executeRollback(session: SessionRow, numTurns: number): Promise<void> {
    const store = this.deps.getStore();
    if (!store || !session.threadId) {
      return;
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.rollbackThread(session.threadId, numTurns);
    const lastTurn = result.thread.turns.at(-1) ?? null;
    store.updateSessionStatus(session.sessionId, "idle", {
      lastTurnId: lastTurn?.id ?? null,
      lastTurnStatus: lastTurn?.status ?? null
    });
    this.deps.clearRecentActivity(session.sessionId);
  }

  private async buildRollbackTargets(session: SessionRow): Promise<RollbackTargetView[]> {
    if (!session.threadId) {
      return [];
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const result = await appServer.readThread(session.threadId, true);
    const threadRecord = asRecord(result.thread);
    const turns = getArray(threadRecord, "turns");
    const targets: RollbackTargetView[] = [];
    let sequenceNumber = 1;

    for (let turnIndex = turns.length - 2; turnIndex >= 0; turnIndex -= 1) {
      const turn = asRecord(turns[turnIndex]);
      const label = this.summarizeRollbackTargetInput(session.threadId, turn);
      if (!label) {
        continue;
      }

      targets.push({
        index: turnIndex,
        sequenceNumber,
        label,
        rollbackCount: turns.length - turnIndex - 1
      });
      sequenceNumber += 1;
    }

    return targets;
  }

  private summarizeRollbackTargetInput(threadId: string, turn: Record<string, unknown> | null): string | null {
    const turnId = getString(turn, "id");
    if (turnId) {
      const source = this.deps.getStore()?.getTurnInputSource(threadId, turnId);
      if (source?.sourceKind === "voice") {
        return truncateText(`Voice: ${normalizeWhitespace(source.transcript)}`, HISTORY_TEXT_LIMIT);
      }
    }

    const userMessage = asRecord(turn?.userMessage);
    const content = getArray(userMessage, "content");
    if (content.length === 0) {
      return null;
    }

    const textParts: string[] = [];
    const labels: string[] = [];

    for (const item of content) {
      const record = asRecord(item);
      const type = getString(record, "type");
      switch (type) {
        case "text": {
          const text = normalizeWhitespace(getString(record, "text") ?? "");
          if (text) {
            textParts.push(text);
          }
          break;
        }
        case "image":
        case "localImage":
          labels.push("Image input");
          break;
        case "skill":
          labels.push(`skill: ${getString(record, "name") ?? "unknown"}`);
          break;
        case "mention":
          labels.push(`Ref: ${getString(record, "name") ?? getString(record, "path") ?? "unknown"}`);
          break;
        default:
          labels.push("Structured input");
          break;
      }
    }

    const summary = textParts.length > 0
      ? textParts.join(" ")
      : labels.length > 0
        ? labels.join(" + ")
        : null;
    return summary ? truncateText(summary, HISTORY_TEXT_LIMIT) : null;
  }

  private buildClearedSnapshotName(displayName: string): string {
    return displayName.startsWith("Before: ") ? displayName : `Before: ${displayName}`;
  }
}

function parseReviewCommandArgs(args: string): ReviewCommandArgs | null {
  const tokens = args.trim().split(/\s+/u).filter(Boolean);
  let delivery: "inline" | "detached" | undefined;
  let index = 0;

  if (tokens[0] === "detached") {
    delivery = "detached";
    index += 1;
  }

  const kind = tokens[index];
  if (!kind) {
    return {
      ...(delivery ? { delivery } : {}),
      target: { type: "uncommittedChanges" }
    };
  }

  if (kind === "branch" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "baseBranch",
        branch: tokens.slice(index + 1).join(" ")
      }
    };
  }

  if (kind === "commit" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "commit",
        sha: tokens[index + 1] ?? ""
      }
    };
  }

  if (kind === "custom" && tokens[index + 1]) {
    return {
      ...(delivery ? { delivery } : {}),
      target: {
        type: "custom",
        instructions: tokens.slice(index + 1).join(" ")
      }
    };
  }

  return null;
}

function parseThreadMetadataTokens(tokens: string[]): ThreadMetadataUpdate | null {
  const gitInfo: ThreadMetadataUpdate = {};

  for (const token of tokens) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) {
      return null;
    }

    const key = token.slice(0, separatorIndex).trim();
    const rawValue = token.slice(separatorIndex + 1).trim();
    const value = rawValue === "-" ? null : rawValue;
    switch (key) {
      case "branch":
        gitInfo.branch = value;
        break;
      case "sha":
        gitInfo.sha = value;
        break;
      case "origin":
      case "originUrl":
        gitInfo.originUrl = value;
        break;
      default:
        return null;
    }
  }

  return Object.keys(gitInfo).length > 0 ? gitInfo : null;
}

function parsePluginInstallTarget(value: string): { marketplaceName: string; pluginName: string } | null {
  const trimmed = value.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  return {
    marketplaceName: trimmed.slice(0, slashIndex),
    pluginName: trimmed.slice(slashIndex + 1)
  };
}

function findFirstInstallablePlugin(
  result: Awaited<ReturnType<CodexAppServerClient["listPlugins"]>>
): { marketplaceName: string; pluginName: string } | null {
  for (const marketplace of result.marketplaces) {
    const plugin = marketplace.plugins.find((entry) => !entry.installed);
    if (plugin) {
      return {
        marketplaceName: marketplace.name,
        pluginName: plugin.name
      };
    }
  }

  return null;
}

function formatMcpAuthStatus(status: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth"): string {
  switch (status) {
    case "unsupported":
      return "Auth not supported";
    case "notLoggedIn":
      return "Not logged in";
    case "bearerToken":
      return "Bearer Token";
    case "oAuth":
      return "OAuth";
    default:
      return status;
  }
}

function formatRateLimitSummary(rateLimits: {
  limitName: string | null;
  primary: {
    usedPercent: number;
    windowDurationMins: number | null;
    resetsAt: number | null;
  } | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  planType: string | null;
} | null): string | null {
  if (!rateLimits) {
    return null;
  }

  const parts: string[] = [];
  if (rateLimits.limitName) {
    parts.push(`Quota: ${rateLimits.limitName}`);
  }
  if (rateLimits.planType) {
    parts.push(`限额Plan: ${rateLimits.planType}`);
  }
  if (rateLimits.primary) {
    const window = rateLimits.primary.windowDurationMins ? `${rateLimits.primary.windowDurationMins} minutes` : "Current window";
    parts.push(`Quota used: ${rateLimits.primary.usedPercent}% (${window})`);
  }
  if (rateLimits.credits) {
    parts.push(
      rateLimits.credits.unlimited
        ? "Credits: 无限"
        : `Credits: ${rateLimits.credits.balance ?? (rateLimits.credits.hasCredits ? "Available" : "Unavailable")}`
    );
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function buildRollbackSuccessText(numTurns: number, sessionName?: string): string {
  const summary = sessionName
    ? `Session "${sessionName}" rolled back ${numTurns} turn(s).`
    : `Rolled back ${numTurns} turn(s).`;
  return `${summary}\nNote: This does not undo file changes already written by the agent.`;
}
