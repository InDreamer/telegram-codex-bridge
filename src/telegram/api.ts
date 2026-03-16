import { execFile } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramFile {
  file_id: string;
  file_path?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export interface TelegramBotCommandScope {
  type: "default" | "all_private_chats";
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

export class TelegramApiError extends Error {
  readonly method: string;
  readonly description: string;
  readonly errorCode: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(method: string, payload: TelegramResponse<unknown>) {
    const description = payload.description ?? `Telegram API request failed: ${method}`;
    super(description);
    this.name = "TelegramApiError";
    this.method = method;
    this.description = description;
    this.errorCode = typeof payload.error_code === "number" ? payload.error_code : null;
    this.retryAfterSeconds = typeof payload.parameters?.retry_after === "number"
      ? payload.parameters.retry_after
      : null;
  }
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.telegram.org"
  ) {}

  async getMe(): Promise<TelegramUser> {
    return await this.call<TelegramUser>("getMe", {}, 20_000);
  }

  async getUpdates(offset: number, timeoutSeconds: number): Promise<TelegramUpdate[]> {
    return await this.call<TelegramUpdate[]>("getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message", "callback_query"]
    }, (timeoutSeconds + 15) * 1000);
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
      parseMode?: "HTML";
    }
  ): Promise<TelegramMessage> {
    return await this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: options?.replyMarkup,
      parse_mode: options?.parseMode
    }, 20_000);
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return await this.call<TelegramFile>("getFile", {
      file_id: fileId
    }, 20_000);
  }

  async getFileUrl(fileId: string): Promise<string | null> {
    const file = await this.getFile(fileId);
    if (!file.file_path) {
      return null;
    }

    return this.buildFileUrl(file.file_path);
  }

  async downloadFile(
    fileId: string,
    destinationPath: string,
    file?: TelegramFile
  ): Promise<string | null> {
    const resolvedFile = file ?? await this.getFile(fileId);
    if (!resolvedFile.file_path) {
      return null;
    }

    await mkdir(dirname(destinationPath), { recursive: true });
    const tempPath = `${destinationPath}.${process.pid}.${Date.now()}.tmp`;
    const url = this.buildFileUrl(resolvedFile.file_path);

    if (shouldPreferCurl()) {
      try {
        await this.downloadWithCurl(url, tempPath, 20_000, "proxy-environment");
        await rename(tempPath, destinationPath);
        return destinationPath;
      } catch (error) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) {
        throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
      }

      const content = new Uint8Array(await response.arrayBuffer());
      await writeFile(tempPath, content);
      await rename(tempPath, destinationPath);
      return destinationPath;
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      try {
        await this.downloadWithCurl(url, tempPath, 20_000, error);
        await rename(tempPath, destinationPath);
        return destinationPath;
      } catch (curlError) {
        await rm(tempPath, { force: true }).catch(() => {});
        throw curlError;
      }
    }
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options?: {
      parseMode?: "HTML";
      replyMarkup?: TelegramInlineKeyboardMarkup;
    }
  ): Promise<TelegramMessage> {
    return await this.call<TelegramMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: options?.parseMode,
      reply_markup: options?.replyMarkup
    }, 20_000);
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text
    }, 20_000);
  }

  async setMyCommands(
    commands: TelegramBotCommand[],
    scope?: TelegramBotCommandScope,
    languageCode?: string
  ): Promise<void> {
    await this.call("setMyCommands", {
      commands,
      scope,
      language_code: languageCode
    }, 20_000);
  }

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    if (shouldPreferCurl()) {
      return await this.callWithCurl<T>(method, body, timeoutMs, "proxy-environment");
    }

    try {
      const response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });

      const payload = (await response.json()) as TelegramResponse<T>;
      if (!response.ok || !payload.ok || payload.result === undefined) {
        throw new TelegramApiError(method, payload);
      }

      return payload.result;
    } catch (error) {
      return await this.callWithCurl<T>(method, body, timeoutMs, error);
    }
  }

  private async callWithCurl<T>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    originalError: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    const payloadText = JSON.stringify(body);
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = execFile(
        "curl",
        [
          "--silent",
          "--show-error",
          "--max-time",
          `${Math.ceil(timeoutMs / 1000)}`,
          "--header",
          "content-type: application/json",
          "--data",
          payloadText,
          url
        ],
        (error, stdout, stderr) => {
          if (error) {
            reject(error);
            return;
          }

          resolve({
            stdout,
            stderr,
            code: 0
          });
        }
      );

      child.on("error", reject);
    }).catch((curlError) => {
      throw new Error(
        `Telegram API request failed via fetch and curl: ${String(originalError)} | ${String(curlError)}`
      );
    });

    const payload = JSON.parse(result.stdout) as TelegramResponse<T>;
    if (!payload.ok || payload.result === undefined) {
      throw new TelegramApiError(method, payload);
    }

    return payload.result;
  }

  private buildFileUrl(filePath: string): string {
    return `${this.baseUrl}/file/bot${this.token}/${filePath}`;
  }

  private async downloadWithCurl(
    url: string,
    destinationPath: string,
    timeoutMs: number,
    originalError: unknown
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        "curl",
        [
          "--silent",
          "--show-error",
          "--fail",
          "--location",
          "--max-time",
          `${Math.ceil(timeoutMs / 1000)}`,
          "--output",
          destinationPath,
          url
        ],
        (error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        }
      );

      child.on("error", reject);
    }).catch((curlError) => {
      throw new Error(
        `Telegram file download failed via fetch and curl: ${String(originalError)} | ${String(curlError)}`
      );
    });
  }
}

function shouldPreferCurl(): boolean {
  return Boolean(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy
  );
}
