import type { UiLanguage } from "../types.js";
import type { TelegramApi } from "./api.js";

interface LocalizedTelegramCommandEntry {
  command: string;
  description: Record<UiLanguage, string>;
  help: Record<UiLanguage, string>;
}

export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

const TELEGRAM_COMMAND_ENTRIES: LocalizedTelegramCommandEntry[] = [
  { command: "help", description: { zh: "查看可用指令", en: "Show available commands" }, help: { zh: "/help 查看可用指令", en: "/help Show available commands" } },
  { command: "status", description: { zh: "查看服务状态", en: "Show bridge status" }, help: { zh: "/status 查看服务状态", en: "/status Show bridge status" } },
  { command: "new", description: { zh: "选择项目并新建会话", en: "Choose a project and create a session" }, help: { zh: "/new 选择项目并新建会话", en: "/new Choose a project and create a session" } },
  { command: "sessions", description: { zh: "查看最近会话", en: "Show recent sessions" }, help: { zh: "/sessions 查看最近会话", en: "/sessions Show recent sessions" } },
  { command: "archive", description: { zh: "归档当前会话", en: "Archive the current session" }, help: { zh: "/archive 归档当前会话", en: "/archive Archive the current session" } },
  { command: "unarchive", description: { zh: "恢复已归档会话", en: "Restore an archived session" }, help: { zh: "/unarchive <序号> 恢复已归档会话", en: "/unarchive <index> Restore an archived session" } },
  { command: "use", description: { zh: "按序号切换会话", en: "Switch sessions by index" }, help: { zh: "/use <序号> 切换到指定会话", en: "/use <index> Switch to a session" } },
  { command: "rename", description: { zh: "重命名当前会话或项目", en: "Rename the current session or project" }, help: { zh: "/rename <名称> 快速重命名当前会话；裸 /rename 可选择改会话名或项目别名", en: "/rename <name> Quickly rename the session; bare /rename lets you choose session or project alias" } },
  { command: "pin", description: { zh: "收藏当前项目", en: "Pin the current project" }, help: { zh: "/pin 收藏当前项目", en: "/pin Pin the current project" } },
  { command: "plan", description: { zh: "切换当前会话的 Plan mode", en: "Toggle Plan mode for this session" }, help: { zh: "/plan 切换当前会话的 Plan mode", en: "/plan Toggle Plan mode for this session" } },
  { command: "model", description: { zh: "查看或设置当前会话模型", en: "Show or set the session model" }, help: { zh: "/model 查看或设置当前会话模型", en: "/model Show or set the session model" } },
  { command: "skills", description: { zh: "列出当前项目可用技能", en: "List project skills" }, help: { zh: "/skills 查看当前项目可用技能", en: "/skills List project skills" } },
  { command: "skill", description: { zh: "把技能作为结构化输入发送", en: "Send a skill as structured input" }, help: { zh: "/skill <技能名> :: 任务说明 发送 skill 结构化输入", en: "/skill <name> :: <prompt> Send a skill as structured input" } },
  { command: "plugins", description: { zh: "列出当前项目可用插件", en: "List available plugins" }, help: { zh: "/plugins 查看当前项目可用插件", en: "/plugins List available plugins" } },
  { command: "plugin", description: { zh: "安装或卸载插件", en: "Install or uninstall plugins" }, help: { zh: "/plugin install <市场>/<插件名> 或 /plugin uninstall <插件ID>", en: "/plugin install <market>/<name> or /plugin uninstall <pluginId>" } },
  { command: "apps", description: { zh: "查看当前可用 Apps", en: "List available apps" }, help: { zh: "/apps 查看当前可用 Apps", en: "/apps List available apps" } },
  { command: "mcp", description: { zh: "查看或管理 MCP 服务", en: "Inspect or manage MCP services" }, help: { zh: "/mcp 查看 MCP 状态；/mcp reload；/mcp login <名称>", en: "/mcp Show MCP status; /mcp reload; /mcp login <name>" } },
  { command: "account", description: { zh: "查看当前 Codex 账号状态", en: "Show the Codex account state" }, help: { zh: "/account 查看当前 Codex 账号与额度", en: "/account Show the Codex account and usage status" } },
  { command: "review", description: { zh: "启动当前会话的代码审查", en: "Start a review for the current session" }, help: { zh: "/review [detached] [branch <分支>|commit <SHA>|custom <说明>] 启动审查", en: "/review [detached] [branch <branch>|commit <SHA>|custom <desc>] Start a review" } },
  { command: "fork", description: { zh: "分叉当前会话线程", en: "Fork the current session thread" }, help: { zh: "/fork [名称] 分叉当前线程为新会话", en: "/fork [name] Fork the current thread into a new session" } },
  { command: "rollback", description: { zh: "选择目标并回滚线程", en: "Pick a rollback target" }, help: { zh: "/rollback 选择回滚目标；/rollback <数量> 兼容旧用法", en: "/rollback Pick a rollback target; /rollback <count> keeps the legacy form" } },
  { command: "compact", description: { zh: "压缩当前线程上下文", en: "Compact the current thread context" }, help: { zh: "/compact 压缩当前线程上下文", en: "/compact Compact the current thread context" } },
  { command: "local_image", description: { zh: "发送服务器本地图片输入", en: "Send a local server image input" }, help: { zh: "/local_image <路径> :: 任务说明 发送本地图片输入", en: "/local_image <path> :: <prompt> Send a local image input" } },
  { command: "mention", description: { zh: "发送结构化引用输入", en: "Send a structured mention input" }, help: { zh: "/mention <path> :: 任务说明 发送结构化引用输入", en: "/mention <path> :: <prompt> Send a structured mention input" } },
  { command: "thread", description: { zh: "设置线程名称或元数据", en: "Set thread name or metadata" }, help: { zh: "/thread name <名称> 或 /thread meta branch=<分支> sha=<提交> origin=<URL> 或 /thread clean-terminals", en: "/thread name <name> or /thread meta branch=<branch> sha=<commit> origin=<url> or /thread clean-terminals" } },
  { command: "where", description: { zh: "查看当前会话、项目和定位 ID", en: "Show current session and IDs" }, help: { zh: "/where 查看当前会话、项目和定位 ID", en: "/where Show the current session, project, and IDs" } },
  { command: "inspect", description: { zh: "查看当前任务详情", en: "Inspect the current task" }, help: { zh: "/inspect 查看当前任务详情", en: "/inspect Inspect the current task" } },
  { command: "runtime", description: { zh: "配置运行状态卡片摘要", en: "Configure runtime card fields" }, help: { zh: "/runtime 配置运行状态卡片顶部摘要行", en: "/runtime Configure the runtime-card field list" } },
  { command: "language", description: { zh: "切换桥接界面语言", en: "Change bridge UI language" }, help: { zh: "/language 切换桥接界面语言", en: "/language Change bridge UI language" } },
  { command: "interrupt", description: { zh: "停止当前正在执行的操作", en: "Interrupt the current operation" }, help: { zh: "/interrupt 停止当前正在执行的操作", en: "/interrupt Interrupt the current operation" } },
  { command: "cancel", description: { zh: "取消当前输入并返回", en: "Cancel the current input and return" }, help: { zh: "/cancel 取消当前输入并返回", en: "/cancel Cancel the current input and return" } }
];

export const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = buildTelegramCommands("zh");

export function buildTelegramCommands(language: UiLanguage): TelegramCommandDefinition[] {
  return TELEGRAM_COMMAND_ENTRIES.map(({ command, description }) => ({
    command,
    description: description[language]
  }));
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
  const lines = TELEGRAM_COMMAND_ENTRIES.flatMap(({ command, help }) => (
    command === "sessions"
      ? [help[language], language === "en" ? "/sessions archived Show archived sessions" : "/sessions archived 查看已归档会话"]
      : [help[language]]
  ));

  return [heading, ...lines].join("\n");
}
