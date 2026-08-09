import type { Logger } from "../logger.js";
import type {
  EgressDeleteResult,
  EgressEditResult,
  EgressMessageSendResult,
  EgressSendDocumentOptions,
  EgressSendMessageOptions,
  EgressSendPhotoOptions,
  PlatformEgressAdapter
} from "../packs/contract.js";
import { TelegramApiError } from "../telegram/api.js";
import { summarizeTextPreview } from "../util/text.js";
import { asRecord, getNumber } from "../util/untyped.js";
import { isTelegramDeleteCommitted, isTelegramEditCommitted } from "./runtime-surface-state.js";

const TELEGRAM_SEND_RETRY_DELAYS_MS = [750, 2_000] as const;
const TELEGRAM_SEND_MAX_RETRY_AFTER_MS = 10_000;

function isTelegramMessageNotModifiedError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) {
    return false;
  }

  return error.errorCode === 400 && /message is not modified/iu.test(error.description);
}

function isTelegramMessageDeleteNotFoundError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) {
    return false;
  }

  return error.errorCode === 400 && /message to delete not found/iu.test(error.description);
}

function getTelegramRetryAfterMs(error: unknown): number | null {
  if (error instanceof TelegramApiError && error.retryAfterSeconds !== null) {
    return error.retryAfterSeconds * 1000;
  }

  const message = `${error}`;
  const retryAfterMatch = message.match(/retry after\s+(\d+)/iu);
  if (retryAfterMatch) {
    const retryAfterSeconds = Number.parseInt(retryAfterMatch[1] ?? "", 10);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }
  }

  if (/too many requests/iu.test(message)) {
    return 30_000;
  }

  return null;
}

function getTelegramSendRetryDelayMs(error: unknown, attempt: number): number | null {
  if (attempt >= TELEGRAM_SEND_RETRY_DELAYS_MS.length) {
    return null;
  }

  const retryAfterMs = getTelegramRetryAfterMs(error);
  if (retryAfterMs !== null) {
    return retryAfterMs <= TELEGRAM_SEND_MAX_RETRY_AFTER_MS ? retryAfterMs : null;
  }

  const httpStatus = getGenericHttpResponseStatus(error);
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
    return null;
  }

  if (error instanceof TelegramApiError) {
    return null;
  }

  return TELEGRAM_SEND_RETRY_DELAYS_MS[attempt] ?? null;
}

function getGenericHttpResponseStatus(error: unknown): number | null {
  const errorRecord = asRecord(error);
  const responseRecord = asRecord(errorRecord?.response);
  const status = getNumber(responseRecord, "status");
  return typeof status === "number" ? status : null;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export interface SafeMessengerDeps {
  sleep?: (delayMs: number) => Promise<void>;
}

export interface SafeSendTelegramOptions {
  replyMarkup?: unknown;
  parseMode: "HTML" | null;
  successMessage: string;
  retryMessage: string;
  failureMessage: string;
}

export class SafeMessenger {
  private readonly egress: PlatformEgressAdapter;
  private readonly logger: Logger;
  private readonly deps: SafeMessengerDeps;

  constructor(egress: PlatformEgressAdapter, logger: Logger, deps: SafeMessengerDeps = {}) {
    this.egress = egress;
    this.logger = logger;
    this.deps = deps;
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: unknown
  ): Promise<boolean> {
    return (await this.sendMessageResult(chatId, text, replyMarkup)) !== null;
  }

  async sendHtmlMessage(
    chatId: string,
    html: string,
    replyMarkup?: unknown
  ): Promise<boolean> {
    return (await this.sendHtmlMessageResult(chatId, html, replyMarkup)) !== null;
  }

  async sendMessageResult(
    chatId: string,
    text: string,
    replyMarkup?: unknown
  ): Promise<EgressMessageSendResult | null> {
    return await this.sendPlatformMessage(chatId, text, {
      parseMode: null,
      ...(replyMarkup !== undefined ? { replyMarkup } : {}),
      successMessage: "message sent",
      retryMessage: "message delivery retry scheduled",
      failureMessage: "message delivery failed"
    });
  }

  async sendHtmlMessageResult(
    chatId: string,
    html: string,
    replyMarkup?: unknown
  ): Promise<EgressMessageSendResult | null> {
    return await this.sendPlatformMessage(chatId, html, {
      parseMode: "HTML",
      ...(replyMarkup !== undefined ? { replyMarkup } : {}),
      successMessage: "html message sent",
      retryMessage: "HTML message delivery retry scheduled",
      failureMessage: "HTML message delivery failed"
    });
  }

  async sendRichMarkdownMessageResult(
    chatId: string,
    markdown: string,
    replyMarkup?: unknown
  ): Promise<EgressMessageSendResult | null> {
    if (typeof this.egress.sendRichMessage !== "function") {
      return null;
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= TELEGRAM_SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const sent = await this.egress.sendRichMessage(
          chatId,
          { markdown },
          replyMarkup !== undefined ? { replyMarkup } : undefined
        );
        await this.logger.info("rich markdown message sent", {
          chatId,
          messageId: sent.messageId,
          replyMarkup: replyMarkup !== undefined ? "present" : null,
          preview: summarizeTextPreview(markdown),
          attempts: attempt + 1
        });
        return sent;
      } catch (error) {
        lastError = error;
        const retryDelayMs = getTelegramSendRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          break;
        }
        await this.logger.warn("rich markdown delivery retry scheduled", {
          chatId,
          attempt: attempt + 1,
          retryDelayMs,
          error: `${error}`
        });
        await this.sleep(retryDelayMs);
      }
    }

    await this.logger.error("rich markdown delivery failed", { chatId, error: `${lastError}` });
    return null;
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    replyMarkup?: unknown
  ): Promise<EgressEditResult> {
    try {
      const result = await this.egress.editMessageText(chatId, messageId, text,
        replyMarkup !== undefined ? { replyMarkup } : undefined);
      await this.logger.info("message edited", {
        chatId,
        messageId,
        replyMarkup: replyMarkup !== undefined ? "present" : null,
        preview: summarizeTextPreview(text)
      });
      return result;
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        await this.logger.info("message edit unchanged", {
          chatId,
          messageId,
          preview: summarizeTextPreview(text)
        });
        return { outcome: "unchanged" };
      }

      await this.logger.warn("message edit failed", { chatId, messageId, error: `${error}` });
      const retryAfterMs = getTelegramRetryAfterMs(error);
      if (retryAfterMs !== null) {
        return { outcome: "rate_limited", retryAfterMs };
      }

      return { outcome: "failed" };
    }
  }

  async editHtmlMessageText(
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: unknown
  ): Promise<EgressEditResult> {
    try {
      const result = await this.egress.editMessageText(chatId, messageId, html, {
        parseMode: "HTML",
        ...(replyMarkup !== undefined ? { replyMarkup } : {})
      });
      await this.logger.info("html message edited", {
        chatId,
        messageId,
        replyMarkup: replyMarkup !== undefined ? "present" : null,
        preview: summarizeTextPreview(html)
      });
      return result;
    } catch (error) {
      if (isTelegramMessageNotModifiedError(error)) {
        await this.logger.info("html message edit unchanged", {
          chatId,
          messageId,
          preview: summarizeTextPreview(html)
        });
        return { outcome: "unchanged" };
      }

      await this.logger.warn("HTML message edit failed", { chatId, messageId, error: `${error}` });
      const retryAfterMs = getTelegramRetryAfterMs(error);
      if (retryAfterMs !== null) {
        return { outcome: "rate_limited", retryAfterMs };
      }

      return { outcome: "failed" };
    }
  }

  async sendPhoto(
    chatId: string,
    photoPath: string,
    options?: EgressSendPhotoOptions
  ): Promise<boolean> {
    return (await this.sendPhotoResult(chatId, photoPath, options)) !== null;
  }

  async sendPhotoResult(
    chatId: string,
    photoPath: string,
    options?: EgressSendPhotoOptions
  ): Promise<EgressMessageSendResult | null> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= TELEGRAM_SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const sent = await this.egress.sendPhoto(chatId, photoPath, options);
        await this.logger.info("photo sent", {
          chatId,
          messageId: sent.messageId,
          path: photoPath,
          preview: summarizeTextPreview(options?.caption),
          attempts: attempt + 1
        });
        return sent;
      } catch (error) {
        lastError = error;
        const retryDelayMs = getTelegramSendRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          break;
        }

        await this.logger.warn("photo delivery retry scheduled", {
          chatId,
          path: photoPath,
          attempt: attempt + 1,
          retryDelayMs,
          error: `${error}`
        });
        await this.sleep(retryDelayMs);
      }
    }

    await this.logger.error("photo delivery failed", {
      chatId,
      path: photoPath,
      error: `${lastError}`
    });
    return null;
  }

  async sendDocumentResult(
    chatId: string,
    filePath: string,
    options?: EgressSendDocumentOptions
  ): Promise<EgressMessageSendResult | null> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= TELEGRAM_SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const sent = await this.egress.sendDocument(chatId, filePath, options);
        await this.logger.info("document sent", {
          chatId,
          messageId: sent.messageId,
          path: filePath,
          preview: summarizeTextPreview(options?.caption),
          attempts: attempt + 1
        });
        return sent;
      } catch (error) {
        lastError = error;
        const retryDelayMs = getTelegramSendRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          break;
        }

        await this.logger.warn("document delivery retry scheduled", {
          chatId,
          path: filePath,
          attempt: attempt + 1,
          retryDelayMs,
          error: `${error}`
        });
        await this.sleep(retryDelayMs);
      }
    }

    await this.logger.error("document delivery failed", {
      chatId,
      path: filePath,
      error: `${lastError}`
    });
    return null;
  }

  async sendPlatformMessage(
    chatId: string,
    text: string,
    options: SafeSendTelegramOptions
  ): Promise<EgressMessageSendResult | null> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= TELEGRAM_SEND_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        const sent = await this.egress.sendMessage(chatId, text, {
          parseMode: options.parseMode,
          ...(options.replyMarkup !== undefined ? { replyMarkup: options.replyMarkup } : {})
        });
        await this.logger.info(options.successMessage, {
          chatId,
          messageId: sent.messageId,
          replyMarkup: options.replyMarkup !== undefined ? "present" : null,
          preview: summarizeTextPreview(text),
          attempts: attempt + 1
        });
        return sent;
      } catch (error) {
        lastError = error;
        const retryDelayMs = getTelegramSendRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          break;
        }

        await this.logger.warn(options.retryMessage, {
          chatId,
          attempt: attempt + 1,
          retryDelayMs,
          error: `${error}`
        });
        await this.sleep(retryDelayMs);
      }
    }

    await this.logger.error(options.failureMessage, { chatId, error: `${lastError}` });
    return null;
  }

  async replaceMessage(
    chatId: string,
    messageId: number,
    text: string,
    options?: {
      html?: boolean;
      replyMarkup?: unknown;
    }
  ): Promise<boolean> {
    if (messageId > 0) {
      const result = options?.html
        ? await this.editHtmlMessageText(chatId, messageId, text, options.replyMarkup)
        : await this.editMessageText(chatId, messageId, text, options?.replyMarkup);
      if (isTelegramEditCommitted(result)) {
        return true;
      }
    }

    const sent = options?.html
      ? await this.sendHtmlMessageResult(chatId, text, options?.replyMarkup)
      : await this.sendMessageResult(chatId, text, options?.replyMarkup);
    if (!sent) {
      return false;
    }

    if (messageId > 0 && sent.messageId !== messageId) {
      await this.deleteMessageResult(chatId, messageId);
    }

    return true;
  }

  async replaceHtmlMessageResult(
    chatId: string,
    messageId: number,
    html: string,
    replyMarkup?: unknown
  ): Promise<number | null> {
    if (messageId > 0) {
      const result = await this.editHtmlMessageText(chatId, messageId, html, replyMarkup);
      if (isTelegramEditCommitted(result)) {
        return messageId;
      }
    }

    const sent = await this.sendHtmlMessageResult(chatId, html, replyMarkup);
    if (!sent) {
      return null;
    }

    if (messageId > 0 && sent.messageId !== messageId) {
      await this.deleteMessageResult(chatId, messageId);
    }

    return sent.messageId;
  }

  async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    return isTelegramDeleteCommitted(await this.deleteMessageResult(chatId, messageId));
  }

  async deleteMessageResult(chatId: string, messageId: number): Promise<EgressDeleteResult> {
    try {
      const result = await this.egress.deleteMessage(chatId, messageId);
      await this.logger.info("message deleted", { chatId, messageId });
      return result;
    } catch (error) {
      if (isTelegramMessageDeleteNotFoundError(error)) {
        await this.logger.info("message delete skipped; message already missing", {
          chatId,
          messageId
        });
        return { outcome: "not_found" };
      }

      await this.logger.warn("message delete failed", { chatId, messageId, error: `${error}` });
      const retryAfterMs = getTelegramRetryAfterMs(error);
      if (retryAfterMs !== null) {
        return { outcome: "rate_limited", retryAfterMs };
      }

      return { outcome: "failed" };
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await this.egress.answerCallbackQuery(callbackQueryId, text);
    } catch (error) {
      await this.logger.warn("callback acknowledgement failed", {
        callbackQueryId,
        error: `${error}`
      });
    }
  }

  async pinChatMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      const result = await this.egress.pinChatMessage(chatId, messageId);
      await this.logger.info("message pinned", { chatId, messageId });
      return result;
    } catch (error) {
      await this.logger.warn("message pin failed", { chatId, messageId, error: `${error}` });
      return false;
    }
  }

  async unpinChatMessage(chatId: string, messageId: number): Promise<boolean> {
    try {
      const result = await this.egress.unpinChatMessage(chatId, messageId);
      await this.logger.info("message unpinned", { chatId, messageId });
      return result;
    } catch (error) {
      await this.logger.warn("message unpin failed", { chatId, messageId, error: `${error}` });
      return false;
    }
  }

  private async sleep(delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return;
    }

    const sleepImpl = this.deps.sleep ?? defaultSleep;
    await sleepImpl(delayMs);
  }
}
