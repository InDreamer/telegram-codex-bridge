import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TelegramApi } from "./api.js";

function withEnvironment<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const originalValues = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    originalValues.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return run().finally(() => {
    for (const [key, value] of originalValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

async function writeCurlStub(binDir: string): Promise<void> {
  const filePath = join(binDir, process.platform === "win32" ? "curl.cmd" : "curl");
  const content = process.platform === "win32"
    ? "@echo off\r\necho curl transport failed 1>&2\r\nexit /b 7\r\n"
    : "#!/usr/bin/env bash\necho 'curl transport failed' >&2\nexit 7\n";
  await writeFile(filePath, content, "utf8");
  if (process.platform !== "win32") {
    await chmod(filePath, 0o755);
  }
}

test("TelegramApi surfaces curl transport failures before JSON parsing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ctb-telegram-api-test-"));
  const binDir = join(root, "bin");
  const operations: unknown[] = [];

  try {
    await mkdir(binDir, { recursive: true });
    await writeCurlStub(binDir);

    const pathValue = process.platform === "win32"
      ? `${binDir};${process.env.PATH ?? ""}`
      : `${binDir}:${process.env.PATH ?? ""}`;

    await withEnvironment(
      {
        PATH: pathValue,
        HTTPS_PROXY: "http://proxy.internal:8080"
      },
      async () => {
        const api = new TelegramApi("test-token", "https://api.telegram.org", {
          performanceRecorder: {
            recordOperation: async (event: unknown) => {
              operations.push(event);
            }
          }
        } as any);

        await assert.rejects(api.getMe(), (error: unknown) => {
          const message = String(error);
          assert.match(message, /curl transport failed/u);
          assert.doesNotMatch(message, /Unexpected end of JSON input/u);
          return true;
        });

        assert.equal(operations.length, 1);
        assert.match(JSON.stringify(operations[0]), /"category":"telegram_api"/u);
        assert.match(JSON.stringify(operations[0]), /"name":"getMe"/u);
        assert.match(JSON.stringify(operations[0]), /"outcome":"error"/u);
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TelegramApi sends pin and unpin requests with the expected payload", async () => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const bodyText = Buffer.concat(chunks).toString("utf8");
    requests.push({
      method: req.url?.split("/").pop() ?? "",
      body: JSON.parse(bodyText)
    });

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const api = new TelegramApi("test-token", `http://127.0.0.1:${address.port}`);

    await api.pinChatMessage("chat-1", 123, { disableNotification: true });
    await api.unpinChatMessage("chat-1", 123);

    assert.deepEqual(requests, [
      {
        method: "pinChatMessage",
        body: {
          chat_id: "chat-1",
          message_id: 123,
          disable_notification: true
        }
      },
      {
        method: "unpinChatMessage",
        body: {
          chat_id: "chat-1",
          message_id: 123
        }
      }
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("TelegramApi sends native rich Markdown with reply markup", async () => {
  const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    requests.push({
      method: req.url?.split("/").pop() ?? "",
      body: JSON.parse(Buffer.concat(chunks).toString("utf8"))
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      result: { message_id: 42, date: 0, chat: { id: 1, type: "private" } }
    }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    const api = new TelegramApi("test-token", `http://127.0.0.1:${address.port}`);
    const result = await api.sendRichMessage("chat-1", {
      markdown: "| Name | State |\n| --- | --- |\n| Worker | Ready |"
    }, {
      replyMarkup: {
        inline_keyboard: [[{ text: "Continue", callback_data: "continue" }]]
      }
    });

    assert.equal(result.message_id, 42);
    assert.deepEqual(requests, [{
      method: "sendRichMessage",
      body: {
        chat_id: "chat-1",
        rich_message: {
          markdown: "| Name | State |\n| --- | --- |\n| Worker | Ready |"
        },
        reply_markup: {
          inline_keyboard: [[{ text: "Continue", callback_data: "continue" }]]
        }
      }
    }]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("TelegramApi records successful fetch operations", async () => {
  const operations: unknown[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      result: {
        id: 1,
        is_bot: true,
        first_name: "BridgeBot"
      }
    })
  })) as unknown as typeof fetch;

  try {
    await withEnvironment({
      HTTPS_PROXY: undefined,
      https_proxy: undefined,
      HTTP_PROXY: undefined,
      http_proxy: undefined,
      ALL_PROXY: undefined,
      all_proxy: undefined
    }, async () => {
      const api = new TelegramApi("test-token", "https://api.telegram.org", {
        performanceRecorder: {
          recordOperation: async (event: unknown) => {
            operations.push(event);
          }
        }
      } as any);

      const user = await api.getMe();

      assert.equal(user.id, 1);
      assert.equal(operations.length, 1);
      assert.match(JSON.stringify(operations[0]), /"category":"telegram_api"/u);
      assert.match(JSON.stringify(operations[0]), /"name":"getMe"/u);
      assert.match(JSON.stringify(operations[0]), /"transport":"fetch"/u);
      assert.match(JSON.stringify(operations[0]), /"outcome":"ok"/u);
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TelegramApi sends document uploads with expected form fields", async () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; method: string; chatId: string | null; caption: string | null; parseMode: string | null }> = [];
  const root = await mkdtemp(join(tmpdir(), "ctb-telegram-api-send-document-"));
  const filePath = join(root, "report.txt");

  await writeFile(filePath, "hello-report", "utf8");

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = init?.body as FormData;
    fetchCalls.push({
      url: String(url),
      method: init?.method ?? "GET",
      chatId: String(form.get("chat_id")),
      caption: String(form.get("caption")),
      parseMode: String(form.get("parse_mode"))
    });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: {
          message_id: 42,
          date: 0,
          chat: { id: 1, type: "private" }
        }
      })
    } as Response;
  }) as typeof fetch;

  try {
    await withEnvironment({
      HTTPS_PROXY: undefined,
      https_proxy: undefined,
      HTTP_PROXY: undefined,
      http_proxy: undefined,
      ALL_PROXY: undefined,
      all_proxy: undefined
    }, async () => {
      const api = new TelegramApi("test-token", "https://api.telegram.org");
      const result = await (api as any).sendDocument("chat-1", filePath, {
        caption: "Here you go",
        parseMode: "HTML",
        fileName: "export.txt"
      });
      assert.equal(result.message_id, 42);
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.method, "POST");
    assert.match(fetchCalls[0]?.url ?? "", /\/sendDocument$/u);
    assert.equal(fetchCalls[0]?.chatId, "chat-1");
    assert.equal(fetchCalls[0]?.caption, "Here you go");
    assert.equal(fetchCalls[0]?.parseMode, "HTML");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
