import type { UiLanguage } from "../types.js";
import type { TelegramApi } from "./api.js";

export type TelegramCommandHandlerKey =
  | "sendHelp"
  | "sendStatus"
  | "handleNew"
  | "handleCancel"
  | "handleSessions"
  | "handleArchive"
  | "sendWhere"
  | "handleInterrupt"
  | "handleInspect"
  | "handleRuntime"
  | "handleLanguage"
  | "handleUse"
  | "handleUnarchive"
  | "handleRename"
  | "handlePin"
  | "handlePlan"
  | "handleModel"
  | "handleSkills"
  | "handleSkill"
  | "handlePlugins"
  | "handlePlugin"
  | "handleApps"
  | "handleMcp"
  | "handleAccount"
  | "handleReview"
  | "handleFork"
  | "handleRollback"
  | "handleCompact"
  | "handleLocalImage"
  | "handleMention"
  | "handleThread";

interface LocalizedTelegramCommandEntry {
  command: string;
  aliases?: string[];
  handler: TelegramCommandHandlerKey;
  description: Record<UiLanguage, string>;
  helpLines: Record<UiLanguage, string>[];
}

export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

const TELEGRAM_COMMAND_ENTRIES: LocalizedTelegramCommandEntry[] = [
  { command: "help", aliases: ["start", "commands"], handler: "sendHelp", description: { zh: "查看可用指令", en: "Show available commands" }, helpLines: [{ zh: "/help 查看可用指令", en: "/help Show available commands" }] },
  { command: "status", handler: "sendStatus", description: { zh: "查看服务状态", en: "Show bridge status" }, helpLines: [{ zh: "/status 查看服务状态", en: "/status Show bridge status" }] },
  { command: "new", handler: "handleNew", description: { zh: "选择项目并新建会话", en: "Choose a project and create a session" }, helpLines: [{ zh: "/new 选择项目并新建会话", en: "/new Choose a project and create a session" }] },
  { command: "sessions", handler: "handleSessions", description: { zh: "查看最近会话", en: "Show recent sessions" }, helpLines: [{ zh: "/sessions 查看最近会话", en: "/sessions Show recent sessions" }, { zh: "/sessions archived 查看已归档会话", en: "/sessions archived Show archived sessions" }] },
  { command: "archive", handler: "handleArchive", description: { zh: "归档当前会话", en: "Archive the current session" }, helpLines: [{ zh: "/archive 归档当前会话", en: "/archive Archive the current session" }] },
  { command: "unarchive", handler: "handleUnarchive", description: { zh: "恢复已归档会话", en: "Restore an archived session" }, helpLines: [{ zh: "/unarchive <序号> 恢复已归档会话", en: "/unarchive <index> Restore an archived session" }] },
  { command: "use", handler: "handleUse", description: { zh: "按序号切换会话", en: "Switch sessions by index" }, helpLines: [{ zh: "/use <序号> 切换到指定会话", en: "/use <index> Switch to a session" }] },
  { command: "rename", handler: "handleRename", description: { zh: "重命名当前会话或项目", en: "Rename the current session or project" }, helpLines: [{ zh: "/rename <名称> 快速重命名当前会话；裸 /rename 可选择改会话名或项目别名", en: "/rename <name> Quickly rename the session; bare /rename lets you choose session or project alias" }] },
  { command: "pin", handler: "handlePin", description: { zh: "收藏当前项目", en: "Pin the current project" }, helpLines: [{ zh: "/pin 收藏当前项目", en: "/pin Pin the current project" }] },
  { command: "plan", handler: "handlePlan", description: { zh: "切换当前会话的 Plan mode", en: "Toggle Plan mode for this session" }, helpLines: [{ zh: "/plan 切换当前会话的 Plan mode", en: "/plan Toggle Plan mode for this session" }] },
  { command: "model", handler: "handleModel", description: { zh: "查看或设置当前会话模型", en: "Show or set the session model" }, helpLines: [{ zh: "/model 查看或设置当前会话模型", en: "/model Show or set the session model" }] },
  { command: "skills", handler: "handleSkills", description: { zh: "列出当前项目可用技能", en: "List project skills" }, helpLines: [{ zh: "/skills 查看当前项目可用技能", en: "/skills List project skills" }] },
  { command: "skill", handler: "handleSkill", description: { zh: "把技能作为结构化输入发送", en: "Send a skill as structured input" }, helpLines: [{ zh: "/skill <技能名> :: 任务说明 发送 skill 结构化输入", en: "/skill <name> :: <prompt> Send a skill as structured input" }] },
  { command: "plugins", handler: "handlePlugins", description: { zh: "列出当前项目可用插件", en: "List available plugins" }, helpLines: [{ zh: "/plugins 查看当前项目可用插件", en: "/plugins List available plugins" }] },
  { command: "plugin", handler: "handlePlugin", description: { zh: "安装或卸载插件", en: "Install or uninstall plugins" }, helpLines: [{ zh: "/plugin install <市场>/<插件名> 或 /plugin uninstall <插件ID>", en: "/plugin install <market>/<name> or /plugin uninstall <pluginId>" }] },
  { command: "apps", handler: "handleApps", description: { zh: "查看当前可用 Apps", en: "List available apps" }, helpLines: [{ zh: "/apps 查看当前可用 Apps", en: "/apps List available apps" }] },
  { command: "mcp", handler: "handleMcp", description: { zh: "查看或管理 MCP 服务", en: "Inspect or manage MCP services" }, helpLines: [{ zh: "/mcp 查看 MCP 状态；/mcp reload；/mcp login <名称>", en: "/mcp Show MCP status; /mcp reload; /mcp login <name>" }] },
  { command: "account", handler: "handleAccount", description: { zh: "查看当前 Codex 账号状态", en: "Show the Codex account state" }, helpLines: [{ zh: "/account 查看当前 Codex 账号与额度", en: "/account Show the Codex account and usage status" }] },
  { command: "review", handler: "handleReview", description: { zh: "启动当前会话的代码审查", en: "Start a review for the current session" }, helpLines: [{ zh: "/review [detached] [branch <分支>|commit <SHA>|custom <说明>] 启动审查", en: "/review [detached] [branch <branch>|commit <SHA>|custom <desc>] Start a review" }] },
  { command: "fork", handler: "handleFork", description: { zh: "分叉当前会话线程", en: "Fork the current session thread" }, helpLines: [{ zh: "/fork [名称] 分叉当前线程为新会话", en: "/fork [name] Fork the current thread into a new session" }] },
  { command: "rollback", handler: "handleRollback", description: { zh: "选择目标并回滚线程", en: "Pick a rollback target" }, helpLines: [{ zh: "/rollback 选择回滚目标；/rollback <数量> 兼容旧用法", en: "/rollback Pick a rollback target; /rollback <count> keeps the legacy form" }] },
  { command: "compact", handler: "handleCompact", description: { zh: "压缩当前线程上下文", en: "Compact the current thread context" }, helpLines: [{ zh: "/compact 压缩当前线程上下文", en: "/compact Compact the current thread context" }] },
  { command: "local_image", handler: "handleLocalImage", description: { zh: "发送服务器本地图片输入", en: "Send a local server image input" }, helpLines: [{ zh: "/local_image <路径> :: 任务说明 发送本地图片输入", en: "/local_image <path> :: <prompt> Send a local image input" }] },
  { command: "mention", handler: "handleMention", description: { zh: "发送结构化引用输入", en: "Send a structured mention input" }, helpLines: [{ zh: "/mention <path> :: 任务说明 发送结构化引用输入", en: "/mention <path> :: <prompt> Send a structured mention input" }] },
  { command: "thread", handler: "handleThread", description: { zh: "设置线程名称或元数据", en: "Set thread name or metadata" }, helpLines: [{ zh: "/thread name <名称> 或 /thread meta branch=<分支> sha=<提交> origin=<URL> 或 /thread clean-terminals", en: "/thread name <name> or /thread meta branch=<branch> sha=<commit> origin=<url> or /thread clean-terminals" }] },
  { command: "where", handler: "sendWhere", description: { zh: "查看当前会话、项目和定位 ID", en: "Show current session and IDs" }, helpLines: [{ zh: "/where 查看当前会话、项目和定位 ID", en: "/where Show the current session, project, and IDs" }] },
  { command: "inspect", handler: "handleInspect", description: { zh: "查看当前任务详情", en: "Inspect the current task" }, helpLines: [{ zh: "/inspect 查看当前任务详情", en: "/inspect Inspect the current task" }] },
  { command: "runtime", handler: "handleRuntime", description: { zh: "配置运行状态卡片摘要", en: "Configure runtime card fields" }, helpLines: [{ zh: "/runtime 配置运行状态卡片顶部摘要行", en: "/runtime Configure the runtime-card field list" }] },
  { command: "language", handler: "handleLanguage", description: { zh: "切换桥接界面语言", en: "Change bridge UI language" }, helpLines: [{ zh: "/language 切换桥接界面语言", en: "/language Change bridge UI language" }] },
  { command: "interrupt", handler: "handleInterrupt", description: { zh: "停止当前正在执行的操作", en: "Interrupt the current operation" }, helpLines: [{ zh: "/interrupt 停止当前正在执行的操作", en: "/interrupt Interrupt the current operation" }] },
  { command: "cancel", handler: "handleCancel", description: { zh: "取消当前输入并返回", en: "Cancel the current input and return" }, helpLines: [{ zh: "/cancel 取消当前输入并返回", en: "/cancel Cancel the current input and return" }] }
];

const TELEGRAM_COMMAND_HANDLER_LOOKUP = buildCommandHandlerLookup();

export const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = buildTelegramCommands("zh");

export function buildTelegramCommands(language: UiLanguage): TelegramCommandDefinition[] {
  return TELEGRAM_COMMAND_ENTRIES.map(({ command, description }) => ({
    command,
    description: description[language]
  }));
}

export function resolveTelegramCommandHandler(commandName: string): TelegramCommandHandlerKey | null {
  return TELEGRAM_COMMAND_HANDLER_LOOKUP.get(commandName) ?? null;
}

export async function syncTelegramCommands(
  api: Pick<TelegramApi, "setMyCommands">,
  language: UiLanguage = "zh"
): Promise<void> {
  const scopes = [
    { type: "default" },
    { type: "all_private_chats" }
  ] as const;
  const languageCodes = [undefined, "zh", "en"];
  const commands = buildTelegramCommands(language);

  await Promise.all(
    scopes.flatMap((scope) =>
      languageCodes.map(async (languageCode) => {
        await api.setMyCommands(commands, scope, languageCode);
      })
    )
  );
}

export function buildHelpText(language: UiLanguage = "zh"): string {
  const heading = language === "en" ? "Available commands" : "可用指令";
  const lines = TELEGRAM_COMMAND_ENTRIES.flatMap(({ helpLines }) => helpLines.map((line) => line[language]));

  return [heading, ...lines].join("\n");
}

function buildCommandHandlerLookup(): ReadonlyMap<string, TelegramCommandHandlerKey> {
  const lookup = new Map<string, TelegramCommandHandlerKey>();

  for (const entry of TELEGRAM_COMMAND_ENTRIES) {
    for (const name of [entry.command, ...(entry.aliases ?? [])]) {
      if (lookup.has(name)) {
        throw new Error(`duplicate telegram command registry entry for ${name}`);
      }
      lookup.set(name, entry.handler);
    }
  }

  return lookup;
}
