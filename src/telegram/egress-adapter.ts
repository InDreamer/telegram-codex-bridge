import type {
  EgressDeleteResult,
  EgressEditResult,
  EgressMessageSendResult,
  EgressRichMessage,
  EgressSendDocumentOptions,
  EgressSendMessageOptions,
  EgressSendPhotoOptions,
  PlatformEgressAdapter
} from "../packs/contract.js";
import type { TelegramApi, TelegramInlineKeyboardMarkup } from "./api.js";

export class TelegramEgressAdapter implements PlatformEgressAdapter {
  readonly kind = "bot_api" as const;

  constructor(private readonly api: TelegramApi) {}

  async sendMessage(
    chatId: string,
    text: string,
    options?: EgressSendMessageOptions
  ): Promise<EgressMessageSendResult> {
    const opts: Record<string, unknown> = {};
    if (options?.parseMode === "HTML") {
      opts.parseMode = "HTML";
    }
    if (options?.replyMarkup !== undefined) {
      opts.replyMarkup = options.replyMarkup;
    }
    const sent = await this.api.sendMessage(chatId, text, Object.keys(opts).length > 0 ? opts : undefined);
    return { messageId: sent.message_id };
  }

  async sendRichMessage(
    chatId: string,
    richMessage: EgressRichMessage,
    options?: Pick<EgressSendMessageOptions, "replyMarkup">
  ): Promise<EgressMessageSendResult> {
    const sent = await this.api.sendRichMessage(chatId, {
      ...(richMessage.blocks !== undefined ? { blocks: richMessage.blocks } : {}),
      ...(richMessage.html !== undefined ? { html: richMessage.html } : {}),
      ...(richMessage.markdown !== undefined ? { markdown: richMessage.markdown } : {}),
      ...(richMessage.media !== undefined ? { media: richMessage.media } : {}),
      ...(richMessage.isRtl !== undefined ? { is_rtl: richMessage.isRtl } : {}),
      ...(richMessage.skipEntityDetection !== undefined
        ? { skip_entity_detection: richMessage.skipEntityDetection }
        : {})
    }, options?.replyMarkup !== undefined
      ? { replyMarkup: options.replyMarkup as TelegramInlineKeyboardMarkup }
      : undefined);
    return { messageId: sent.message_id };
  }

  async sendPhoto(
    chatId: string,
    photoPath: string,
    options?: EgressSendPhotoOptions
  ): Promise<EgressMessageSendResult> {
    const sent = await this.api.sendPhoto(chatId, photoPath, options);
    return { messageId: sent.message_id };
  }

  async sendDocument(
    chatId: string,
    filePath: string,
    options?: EgressSendDocumentOptions
  ): Promise<EgressMessageSendResult> {
    const sent = await this.api.sendDocument(chatId, filePath, options);
    return { messageId: sent.message_id };
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options?: EgressSendMessageOptions
  ): Promise<EgressEditResult> {
    const opts: Record<string, unknown> = {};
    if (options?.parseMode === "HTML") {
      opts.parseMode = "HTML";
    }
    if (options?.replyMarkup !== undefined) {
      opts.replyMarkup = options.replyMarkup;
    }
    await this.api.editMessageText(
      chatId,
      messageId,
      text,
      Object.keys(opts).length > 0 ? opts : undefined
    );
    return { outcome: "edited" };
  }

  async deleteMessage(chatId: string, messageId: number): Promise<EgressDeleteResult> {
    await this.api.deleteMessage(chatId, messageId);
    return { outcome: "deleted" };
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.api.answerCallbackQuery(callbackQueryId, text);
  }

  async pinChatMessage(chatId: string, messageId: number): Promise<boolean> {
    return await this.api.pinChatMessage(chatId, messageId, { disableNotification: true });
  }

  async unpinChatMessage(chatId: string, messageId: number): Promise<boolean> {
    return await this.api.unpinChatMessage(chatId, messageId);
  }
}
