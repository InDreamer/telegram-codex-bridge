import type { TelegramApi } from "./api.js";

export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

export const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = [
  { command: "help", description: "查看可用指令" },
  { command: "status", description: "查看服务状态" },
  { command: "new", description: "选择项目并新建会话" },
  { command: "sessions", description: "查看最近会话" },
  { command: "archive", description: "归档当前会话" },
  { command: "unarchive", description: "恢复已归档会话" },
  { command: "use", description: "按序号切换会话" },
  { command: "rename", description: "重命名当前会话或项目" },
  { command: "pin", description: "收藏当前项目" },
  { command: "model", description: "查看或设置当前会话模型" },
  { command: "skills", description: "列出当前项目可用技能" },
  { command: "skill", description: "把技能作为结构化输入发送" },
  { command: "plugins", description: "列出当前项目可用插件" },
  { command: "plugin", description: "安装或卸载插件" },
  { command: "apps", description: "查看当前可用 Apps" },
  { command: "mcp", description: "查看或管理 MCP 服务" },
  { command: "account", description: "查看当前 Codex 账号状态" },
  { command: "review", description: "启动当前会话的代码审查" },
  { command: "fork", description: "分叉当前会话线程" },
  { command: "rollback", description: "选择目标并回滚线程" },
  { command: "compact", description: "压缩当前线程上下文" },
  { command: "local_image", description: "发送服务器本地图片输入" },
  { command: "mention", description: "发送结构化引用输入" },
  { command: "thread", description: "设置线程名称或元数据" },
  { command: "where", description: "查看当前会话、项目和定位 ID" },
  { command: "inspect", description: "查看当前任务详情" },
  { command: "runtime", description: "配置运行状态卡片摘要" },
  { command: "interrupt", description: "停止当前正在执行的操作" },
  { command: "cancel", description: "取消当前输入并返回" }
];

export async function syncTelegramCommands(api: Pick<TelegramApi, "setMyCommands">): Promise<void> {
  const scopes = [
    { type: "default" },
    { type: "all_private_chats" }
  ] as const;
  // Telegram stores command menus per scope and optional language code.
  const languageCodes = [undefined, "zh", "en"];

  await Promise.all(
    scopes.flatMap((scope) =>
      languageCodes.map(async (languageCode) => {
        await api.setMyCommands(TELEGRAM_COMMANDS, scope, languageCode);
      })
    )
  );
}

export function buildHelpText(): string {
  return [
    "可用指令",
    "/help 查看可用指令",
    "/status 查看服务状态",
    "/new 选择项目并新建会话",
    "/sessions 查看最近会话",
    "/sessions archived 查看已归档会话",
    "/archive 归档当前会话",
    "/unarchive <序号> 恢复已归档会话",
    "/use <序号> 切换到指定会话",
    "/rename <名称> 快速重命名当前会话；裸 /rename 可选择改会话名或项目别名",
    "/pin 收藏当前项目",
    "/model 查看或设置当前会话模型",
    "/skills 查看当前项目可用技能",
    "/skill <技能名> :: 任务说明 发送 skill 结构化输入",
    "/plugins 查看当前项目可用插件",
    "/plugin install <市场>/<插件名> 或 /plugin uninstall <插件ID>",
    "/apps 查看当前可用 Apps",
    "/mcp 查看 MCP 状态；/mcp reload；/mcp login <名称>",
    "/account 查看当前 Codex 账号与额度",
    "/review [detached] [branch <分支>|commit <SHA>|custom <说明>] 启动审查",
    "/fork [名称] 分叉当前线程为新会话",
    "/rollback 选择回滚目标；/rollback <数量> 兼容旧用法",
    "/compact 压缩当前线程上下文",
    "/local_image <路径> :: 任务说明 发送本地图片输入",
    "/mention <path> :: 任务说明 发送结构化引用输入",
    "/thread name <名称> 或 /thread meta branch=<分支> sha=<提交> origin=<URL> 或 /thread clean-terminals",
    "/where 查看当前会话、项目和定位 ID",
    "/inspect 查看当前任务详情",
    "/runtime 配置运行状态卡片顶部摘要行",
    "/interrupt 停止当前正在执行的操作",
    "/cancel 取消当前输入并返回"
  ].join("\n");
}
