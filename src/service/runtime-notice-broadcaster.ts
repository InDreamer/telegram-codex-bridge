import { classifyNotification } from "../codex/notification-classifier.js";
import type { BridgeStateStore } from "../state/store.js";

type GlobalRuntimeNotice = Extract<
  ReturnType<typeof classifyNotification>,
  { kind: "config_warning" | "deprecation_notice" | "model_rerouted" | "skills_changed" | "thread_compacted" }
>;

interface RuntimeNoticeBroadcasterDeps {
  getStore: () => BridgeStateStore | null;
  safeSendMessage: (chatId: string, text: string) => Promise<boolean>;
}

export class RuntimeNoticeBroadcaster {
  constructor(private readonly deps: RuntimeNoticeBroadcasterDeps) {}

  async broadcast(notification: GlobalRuntimeNotice): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const message = formatGlobalRuntimeNotice(notification);
    if (!message) {
      return;
    }

    const bindings = store.listChatBindings();
    for (const binding of bindings) {
      const delivered = await this.deps.safeSendMessage(binding.telegramChatId, message);
      if (!delivered) {
        store.createRuntimeNotice({
          telegramChatId: binding.telegramChatId,
          type: "app_server_notice",
          message
        });
      }
    }
  }
}

export function formatGlobalRuntimeNotice(notification: GlobalRuntimeNotice): string | null {
  switch (notification.kind) {
    case "config_warning":
      return notification.summary
        ? `Codex 配置警告：${notification.summary}${notification.detail ? `\n${notification.detail}` : ""}`
        : null;
    case "deprecation_notice":
      return notification.summary
        ? `Codex 弃用提示：${notification.summary}${notification.detail ? `\n${notification.detail}` : ""}`
        : null;
    case "model_rerouted":
      if (!notification.fromModel || !notification.toModel) {
        return null;
      }
      return `Codex 已调整模型：${notification.fromModel} -> ${notification.toModel}${notification.reason ? ` (${notification.reason})` : ""}`;
    case "skills_changed":
      return "Codex 技能列表已刷新。";
    case "thread_compacted":
      return "Codex 线程上下文已压缩。";
    default:
      return null;
  }
}
