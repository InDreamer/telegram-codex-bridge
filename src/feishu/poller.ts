import * as Lark from "@larksuiteoapi/node-sdk";

import type { BridgeConfig } from "../config.js";
import { isRetryable } from "../errors.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { getFeishuPackConfig } from "../packs/feishu/config.js";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser
} from "../telegram/api.js";
import { parseCallbackData } from "../telegram/ui-callbacks.js";
import { normalizeWhitespace } from "../util/text.js";
import { resolveFeishuSdkDomain, type FeishuTelegramApiCompat } from "./api.js";

interface PendingQueueWaiter {
  resolve(): void;
}

interface FeishuEventDispatcherLike {
  register(handles: Record<string, (event: any) => Promise<unknown> | unknown>): unknown;
}

interface FeishuWsClientLike {
  start(params: {
    eventDispatcher: FeishuEventDispatcherLike;
  }): Promise<void>;
  close(params?: {
    force?: boolean;
  }): void;
}

interface FeishuTelegramPollerCompatDeps {
  createWsClient?: (options: {
    appId: string;
    appSecret: string;
    apiBaseUrl: string;
  }) => FeishuWsClientLike;
  createEventDispatcher?: () => FeishuEventDispatcherLike;
  maxQueueSize?: number;
}

const DEFAULT_MAX_PENDING_UPDATES = 1000;

export function buildFeishuWsClientOptions(options: {
  appId: string;
  appSecret: string;
  apiBaseUrl: string;
}): ConstructorParameters<typeof Lark.WSClient>[0] {
  return {
    appId: options.appId,
    appSecret: options.appSecret,
    domain: resolveFeishuSdkDomain(options.apiBaseUrl),
    autoReconnect: true
  };
}

function parseFeishuTextContent(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return typeof parsed.text === "string" ? parsed.text : null;
  } catch {
    return null;
  }
}

function buildFeishuImageBridgeMedia(
  imageKey: string,
  refs: {
    messageId: string;
    chatId: string;
  }
): NonNullable<TelegramMessage["bridgeMedia"]>[number] {
  return {
    kind: "image",
    resourceId: imageKey,
    platformRef: {
      platform: "feishu",
      conversationId: refs.chatId,
      messageId: refs.messageId,
      resourceType: "image"
    }
  };
}

function buildFeishuFileBridgeMedia(
  fileKey: string,
  refs: {
    messageId: string;
    chatId: string;
  },
  fileName?: string
): NonNullable<TelegramMessage["bridgeMedia"]>[number] {
  return {
    kind: "file",
    resourceId: fileKey,
    ...(typeof fileName === "string" && fileName.trim() ? { fileName } : {}),
    platformRef: {
      platform: "feishu",
      conversationId: refs.chatId,
      messageId: refs.messageId,
      resourceType: "file"
    }
  };
}

function parseFeishuPostContent(
  parsed: {
    title?: string;
    content?: Array<Array<{
      tag?: string;
      text?: string;
      image_key?: string;
    }>>;
  },
  refs: {
    messageId: string;
    chatId: string;
  }
): {
  text: string | null;
  bridgeMedia: NonNullable<TelegramMessage["bridgeMedia"]>;
} {
  const textLines: string[] = [];
  const bridgeMedia: NonNullable<TelegramMessage["bridgeMedia"]> = [];

  if (typeof parsed.title === "string" && parsed.title.trim()) {
    textLines.push(parsed.title);
  }

  for (const line of parsed.content ?? []) {
    if (!Array.isArray(line)) {
      continue;
    }

    const inlineText: string[] = [];
    for (const element of line) {
      if (element?.tag === "img" && typeof element.image_key === "string" && element.image_key.trim()) {
        bridgeMedia.push(buildFeishuImageBridgeMedia(element.image_key, refs));
        continue;
      }

      if (typeof element?.text === "string" && element.text.trim()) {
        inlineText.push(element.text);
      }
    }

    if (inlineText.length > 0) {
      textLines.push(inlineText.join(" "));
    }
  }

  return {
    text: textLines.length > 0 ? normalizeWhitespace(textLines.join("\n")) : null,
    bridgeMedia
  };
}

function parseFeishuMessageContent(
  messageType: string,
  content: string,
  refs: {
    messageId: string;
    chatId: string;
  }
): {
  text: string | null;
  bridgeMedia: NonNullable<TelegramMessage["bridgeMedia"]>;
} {
  if (messageType === "text") {
    return {
      text: parseFeishuTextContent(content),
      bridgeMedia: []
    };
  }

  try {
    const parsed = JSON.parse(content) as {
      image_key?: string;
      file_key?: string;
      file_name?: string;
      title?: string;
      content?: Array<Array<{
        tag?: string;
        text?: string;
        image_key?: string;
      }>>;
    };

    if (messageType === "image" && typeof parsed.image_key === "string" && parsed.image_key.trim()) {
      return {
        text: null,
        bridgeMedia: [buildFeishuImageBridgeMedia(parsed.image_key, refs)]
      };
    }

    if (messageType === "file" && typeof parsed.file_key === "string" && parsed.file_key.trim()) {
      return {
        text: null,
        bridgeMedia: [buildFeishuFileBridgeMedia(parsed.file_key, refs, parsed.file_name)]
      };
    }

    if (messageType === "post") {
      return parseFeishuPostContent(parsed, refs);
    }
  } catch {
    return {
      text: null,
      bridgeMedia: []
    };
  }

  return {
    text: null,
    bridgeMedia: []
  };
}

function extractFeishuCallbackData(event: {
  action?: {
    tag?: string;
    option?: unknown;
    value?: Record<string, unknown> | string;
  };
}): string | null {
  const actionValue = event.action?.value;
  if (typeof actionValue === "string" && actionValue.trim().length > 0) {
    return actionValue;
  }

  if (
    actionValue
    && typeof actionValue === "object"
    && typeof actionValue.callback_data === "string"
    && actionValue.callback_data.trim().length > 0
  ) {
    return actionValue.callback_data;
  }

  if (event.action?.tag === "overflow" && typeof event.action.option === "string" && event.action.option.trim().length > 0) {
    return event.action.option;
  }

  return null;
}

function buildFeishuCardCallbackResponse(
  callbackData: string | null,
  accepted: boolean
): Record<string, unknown> {
  if (!accepted || !callbackData || !parseCallbackData(callbackData)) {
    return {
      toast: {
        type: "error",
        content: "Button expired, reopen."
      }
    };
  }

  const parsed = parseCallbackData(callbackData);
  if (!parsed) {
    return {
      toast: {
        type: "error",
        content: "Button expired, reopen."
      }
    };
  }

  switch (parsed.kind) {
    case "status_interrupt":
      return {
        toast: {
          type: "warning",
          content: "Requesting interrupt…"
        }
      };
    case "commands_run":
    case "pick":
    case "path_confirm":
    case "browse_use_current_dir_confirm":
    case "rollback_confirm":
    case "plan_implement":
      return {
        toast: {
          type: "info",
          content: "Processing…"
        }
      };
    default:
      return {
        toast: {
          type: "info",
          content: "Updating…"
        }
      };
  }
}

export class FeishuTelegramPollerCompat {
  private readonly api: FeishuTelegramApiCompat;
  private readonly logger: Logger;
  private readonly onUpdate: (update: TelegramUpdate) => Promise<void>;
  private readonly config: BridgeConfig;
  private readonly deps: FeishuTelegramPollerCompatDeps;
  private readonly maxQueueSize: number;
  private wsClient: FeishuWsClientLike | null = null;
  private eventDispatcher: FeishuEventDispatcherLike | null = null;
  private readonly queue: TelegramUpdate[] = [];
  private waiter: PendingQueueWaiter | null = null;
  private running = false;
  private nextUpdateId = 1;
  private queueOverflowLogged = false;

  constructor(
    api: FeishuTelegramApiCompat,
    config: BridgeConfig,
    _paths: BridgePaths,
    logger: Logger,
    onUpdate: (update: TelegramUpdate) => Promise<void>,
    deps: FeishuTelegramPollerCompatDeps = {}
  ) {
    this.api = api;
    this.logger = logger;
    this.onUpdate = onUpdate;
    this.config = config;
    this.deps = deps;
    this.maxQueueSize = Math.max(1, deps.maxQueueSize ?? DEFAULT_MAX_PENDING_UPDATES);
  }

  async run(): Promise<void> {
    this.running = true;
    await this.api.ready();
    this.ensureTransport();
    await this.wsClient!.start({
      eventDispatcher: this.eventDispatcher!
    });

    while (this.running) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.waiter = { resolve };
        });
        this.waiter = null;
        continue;
      }

      const update = this.queue.shift();
      if (!update) {
        continue;
      }

      try {
        await this.onUpdate(update);
      } catch (error) {
        if (isRetryable(error)) {
          await this.logger.warn("feishu compat poller failed to handle translated update", {
            error: `${error}`
          });
        } else {
          await this.logger.error("feishu compat poller failed with fatal error handling update; stopping poller", {
            error: `${error}`
          });
          this.running = false;
        }
      }
    }
  }

  stop(): void {
    this.running = false;
    this.wsClient?.close({ force: true });
    this.waiter?.resolve();
  }

  private enqueue(update: TelegramUpdate): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      if (!this.queueOverflowLogged) {
        this.queueOverflowLogged = true;
        void this.logger.warn("feishu compat poller queue overflow; dropping oldest update", {
          maxQueueSize: this.maxQueueSize
        });
      }
    }
    this.queue.push(update);
    this.waiter?.resolve();
  }

  private async translateMessageEvent(event: {
    sender: {
      sender_id?: {
        open_id?: string;
      };
    };
    message: {
      message_id: string;
      chat_id: string;
      create_time: string;
      message_type: string;
      content: string;
    };
  }): Promise<TelegramUpdate | null> {
    const remoteOpenId = event.sender.sender_id?.open_id;
    if (!remoteOpenId) {
      return null;
    }

    const refs = this.api.refsStore;
    const localUserId = refs.getOrCreateLocalUserId(remoteOpenId);
    const localChatId = refs.getOrCreateLocalChatId(event.message.chat_id);
    refs.rememberUserChat(remoteOpenId, event.message.chat_id);
    const localMessageId = refs.recordRemoteMessage(event.message.message_id, event.message.chat_id);
    const messageBase: TelegramMessage = {
      message_id: localMessageId,
      from: this.buildTelegramUser(localUserId, remoteOpenId),
      chat: {
        id: localChatId,
        type: "private"
      },
      date: Math.floor(Number.parseInt(event.message.create_time, 10) / 1000)
    };

    const parsedContent = parseFeishuMessageContent(event.message.message_type, event.message.content, {
      messageId: event.message.message_id,
      chatId: event.message.chat_id
    });
    if (!parsedContent.text && parsedContent.bridgeMedia.length === 0) {
      return null;
    }

    return {
      update_id: this.nextUpdateId++,
      message: {
        ...messageBase,
        ...(parsedContent.text ? { text: parsedContent.text } : {}),
        ...(parsedContent.bridgeMedia.length > 0 ? { bridgeMedia: parsedContent.bridgeMedia } : {})
      }
    };
  }

  private async translateChatEnteredEvent(event: {
    chat_id: string;
    create_time?: string;
    operator_id?: {
      open_id?: string;
    };
  }): Promise<TelegramUpdate | null> {
    const remoteOpenId = event.operator_id?.open_id;
    if (!remoteOpenId) {
      return null;
    }

    const refs = this.api.refsStore;
    const localUserId = refs.getOrCreateLocalUserId(remoteOpenId);
    const localChatId = refs.getOrCreateLocalChatId(event.chat_id);
    refs.rememberUserChat(remoteOpenId, event.chat_id);

    return {
      update_id: this.nextUpdateId++,
      platform_event: {
        source: "feishu",
        kind: "chat_entered",
        user: this.buildTelegramUser(localUserId, remoteOpenId),
        chat: {
          id: localChatId,
          type: "private"
        }
      }
    };
  }

  private async translateBotMenuEvent(event: {
    event_key?: string;
    operator?: {
      operator_id?: {
        open_id?: string;
      };
    };
  }): Promise<TelegramUpdate | null> {
    const remoteOpenId = event.operator?.operator_id?.open_id;
    const eventKey = typeof event.event_key === "string" ? event.event_key : null;
    if (!remoteOpenId || !eventKey) {
      return null;
    }

    const refs = this.api.refsStore;
    const localUserId = refs.getOrCreateLocalUserId(remoteOpenId);
    const localChatId = refs.resolveLocalChatIdForRemoteUser(remoteOpenId);
    if (localChatId === null) {
      return null;
    }

    return {
      update_id: this.nextUpdateId++,
      platform_event: {
        source: "feishu",
        kind: "bot_menu",
        user: this.buildTelegramUser(localUserId, remoteOpenId),
        chat: {
          id: localChatId,
          type: "private"
        },
        eventKey
      }
    };
  }

  private async translateCardCallbackEvent(event: {
    open_id?: string;
    open_message_id?: string;
    token: string;
    operator?: {
      open_id?: string;
        };
        context?: {
          open_message_id?: string;
          open_chat_id?: string;
        };
        action?: {
          tag?: string;
          option?: unknown;
          value?: Record<string, unknown> | string;
        };
      }): Promise<TelegramUpdate | null> {
    const remoteOpenId = event.open_id ?? event.operator?.open_id ?? null;
    const remoteMessageId = event.open_message_id ?? event.context?.open_message_id ?? null;
    const callbackData = extractFeishuCallbackData(event);
    if (!callbackData || !remoteOpenId || !remoteMessageId) {
      return null;
    }

    const refs = this.api.refsStore;
    const localUserId = refs.getOrCreateLocalUserId(remoteOpenId);
    const remoteRef = refs.resolveRemoteMessageByRemoteId(remoteMessageId);
    if (!remoteRef) {
      return null;
    }
    refs.rememberUserChat(remoteOpenId, event.context?.open_chat_id ?? remoteRef.remoteChatId);
    const localChatId = refs.getOrCreateLocalChatId(remoteRef.remoteChatId);
    const callbackQuery: TelegramCallbackQuery = {
      id: event.token,
      from: this.buildTelegramUser(localUserId, remoteOpenId),
      data: callbackData,
      message: {
        message_id: remoteRef.localMessageId,
        chat: {
          id: localChatId,
          type: "private"
        },
        date: Math.floor(Date.now() / 1000)
      }
    };

    return {
      update_id: this.nextUpdateId++,
      callback_query: callbackQuery
    };
  }

  private buildTelegramUser(localUserId: number, remoteOpenId: string): TelegramUser {
    return {
      id: localUserId,
      is_bot: false,
      first_name: remoteOpenId,
      username: remoteOpenId
    };
  }

  private ensureTransport(): void {
    if (this.wsClient && this.eventDispatcher) {
      return;
    }

    const feishuConfig = getFeishuPackConfig(this.config);
    const wsClient = this.deps.createWsClient
      ? this.deps.createWsClient({
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        apiBaseUrl: feishuConfig.apiBaseUrl
      })
      : new Lark.WSClient(buildFeishuWsClientOptions({
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        apiBaseUrl: feishuConfig.apiBaseUrl
      }));
    const eventDispatcher = this.deps.createEventDispatcher
      ? this.deps.createEventDispatcher()
      : new Lark.EventDispatcher({});
    eventDispatcher.register({
      "im.message.receive_v1": async (event: {
        sender: {
          sender_id?: {
            open_id?: string;
          };
        };
        message: {
          message_id: string;
          chat_id: string;
          create_time: string;
          message_type: string;
          content: string;
        };
      }) => {
        const update = await this.translateMessageEvent(event);
        if (update) {
          this.enqueue(update);
        }
      },
      "im.chat.access_event.bot_p2p_chat_entered_v1": async (event: {
        chat_id: string;
        create_time?: string;
        operator_id?: {
          open_id?: string;
        };
      }) => {
        const update = await this.translateChatEnteredEvent(event);
        if (update) {
          this.enqueue(update);
        }
      },
      "application.bot.menu_v6": async (event: {
        event_key?: string;
        operator?: {
          operator_id?: {
            open_id?: string;
          };
        };
      }) => {
        const update = await this.translateBotMenuEvent(event);
        if (update) {
          this.enqueue(update);
        }
      },
      "card.action.trigger": async (event: {
        open_id?: string;
        open_message_id?: string;
        token: string;
        operator?: {
          open_id?: string;
        };
        context?: {
          open_message_id?: string;
          open_chat_id?: string;
        };
        action?: {
          tag?: string;
          option?: unknown;
          value?: Record<string, unknown> | string;
        };
      }) => {
        const callbackData = extractFeishuCallbackData(event);
        const update = await this.translateCardCallbackEvent(event);
        if (update) {
          this.enqueue(update);
        }
        return buildFeishuCardCallbackResponse(callbackData, update !== null);
      }
    });
    this.wsClient = wsClient;
    this.eventDispatcher = eventDispatcher;
  }
}
