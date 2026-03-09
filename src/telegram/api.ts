import { execFile } from "node:child_process";

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

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
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
    }
  ): Promise<void> {
    await this.call("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: options?.replyMarkup
    }, 20_000);
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text
    }, 20_000);
  }

  async setMyCommands(commands: TelegramBotCommand[], scope?: TelegramBotCommandScope): Promise<void> {
    await this.call("setMyCommands", {
      commands,
      scope
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
        throw new Error(payload.description ?? `Telegram API request failed: ${method}`);
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
      throw new Error(payload.description ?? `Telegram API request failed: ${method}`);
    }

    return payload.result;
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
