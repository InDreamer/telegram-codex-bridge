import type { TelegramApi } from "./api.js";

export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

export const TELEGRAM_COMMANDS: TelegramCommandDefinition[] = [
  { command: "help", description: "查看可用指令" },
  { command: "status", description: "查看服务状态" },
  { command: "new", description: "选择项目并开始新会话" },
  { command: "sessions", description: "查看最近会话" },
  { command: "use", description: "按序号切换会话" },
  { command: "rename", description: "重命名当前会话" },
  { command: "pin", description: "收藏当前项目" },
  { command: "where", description: "查看当前会话和项目" },
  { command: "inspect", description: "查看当前任务详情" },
  { command: "interrupt", description: "停止当前正在执行的操作" },
  { command: "cancel", description: "取消手动输入路径并返回" }
];

export async function syncTelegramCommands(api: Pick<TelegramApi, "setMyCommands">): Promise<void> {
  await api.setMyCommands(TELEGRAM_COMMANDS, { type: "default" });
  await api.setMyCommands(TELEGRAM_COMMANDS, { type: "all_private_chats" });
}

export function buildHelpText(): string {
  return [
    "可用指令",
    "/help 查看可用指令",
    "/status 查看服务状态",
    "/new 选择项目并开始新会话",
    "/sessions 查看最近会话",
    "/use <序号> 切换到指定会话",
    "/rename <名称> 重命名当前会话",
    "/pin 收藏当前项目",
    "/where 查看当前会话和项目",
    "/inspect 查看当前任务详情",
    "/interrupt 停止当前正在执行的操作",
    "/cancel 取消手动输入路径并返回"
  ].join("\n");
}
