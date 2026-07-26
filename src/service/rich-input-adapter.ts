import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import type { CodexAppServerClient, UserInput } from "../codex/app-server.js";
import type { BridgeConfig } from "../config.js";
import type { BridgeCommandActionView } from "../core/interaction-model/bridge-actions.js";
import type { InboundUserMediaEvent, ResolvedMediaAsset } from "../core/interaction-model/media.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { commandExists, runCommand } from "../process.js";
import type { BridgeStateStore } from "../state/store.js";
import type { TelegramApi, TelegramInlineKeyboardMarkup, TelegramMessage } from "../telegram/api.js";
import { buildBridgeCommandReplyMarkup } from "../telegram/ui.js";
import type { SessionRow } from "../types.js";
import { normalizeAndTruncate, normalizeWhitespace, splitStructuredInputCommand, truncateText } from "../util/text.js";
import { asRecord, getArray, getString } from "../util/untyped.js";

const TELEGRAM_IMAGE_CACHE_DIRNAME = "telegram-images";
const TELEGRAM_IMAGE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_CACHE_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const TELEGRAM_VOICE_CACHE_DIRNAME = "telegram-voice";
const OPENAI_AUDIO_TRANSCRIPT_URL = "https://api.openai.com/v1/audio/transcriptions";
const VOICE_PCM_SAMPLE_RATE = 16_000;
const VOICE_PCM_NUM_CHANNELS = 1;
const VOICE_PCM_BYTES_PER_SAMPLE = 2;
const VOICE_REALTIME_CHUNK_BYTES = 32_000;
const VOICE_REALTIME_WAIT_TIMEOUT_MS = 30_000;
const VOICE_REALTIME_POLL_INTERVAL_MS = 1_000;
const VOICE_REALTIME_TRANSCRIPTION_PROMPT = "请逐字转写收到的语音，只返回转写文本，不要解释。";
const ATTACHMENT_CONTENT_CHAR_LIMIT = 12_000;
const TEXTUAL_ATTACHMENT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".yaml", ".yml", ".xml", ".csv", ".ts", ".tsx", ".js", ".jsx",
  ".mjs", ".cjs", ".py", ".sh", ".bash", ".zsh", ".log", ".ini", ".cfg", ".conf"
]);
const TEXTUTIL_ATTACHMENT_EXTENSIONS = new Set([
  ".doc", ".docx", ".rtf", ".rtfd", ".odt", ".html", ".htm", ".webarchive"
]);

interface PendingRichInputComposer {
  sessionId: string;
  inputs: UserInput[];
  promptLabel: string;
}

interface VoiceTranscriptionResult {
  transcript: string;
  source: "openai" | "realtime";
}

interface VoiceProcessingTask {
  chatId: string;
  sessionId: string;
  messageId: number;
  telegramFileId: string;
}

interface RegisteredAttachment {
  attachmentId: string;
  sessionId: string;
  filename: string;
  localPath: string;
  kind: ResolvedMediaAsset["descriptor"]["kind"];
  sha256: string | null;
  createdAt: string;
}

interface PendingAutoAttachState {
  sessionId: string;
  attachmentIds: string[];
}

export type RichInputTurnAvailability =
  | {
      kind: "available";
      threadId: string;
      turnId: string;
    }
  | {
      kind: "interaction_pending";
    }
  | {
      kind: "busy";
    };

interface RichInputAdapterDeps {
  getStore: () => BridgeStateStore | null;
  preferBridgeCommandButtons: boolean;
  getApi: () => Pick<TelegramApi, "getFile" | "downloadFile"> | null;
  ensureAppServerAvailable: () => Promise<CodexAppServerClient>;
  fetchAllModels: () => Promise<NonNullable<Awaited<ReturnType<CodexAppServerClient["listModels"]>>["data"]>>;
  extractFinalAnswerFromHistory: (
    appServer: CodexAppServerClient,
    threadId: string,
    turnId: string
  ) => Promise<string | null>;
  logger: Logger;
  config: Pick<
    BridgeConfig,
    "voiceInputEnabled" | "voiceOpenaiApiKey" | "voiceOpenaiTranscribeModel" | "voiceFfmpegBin"
  >;
  paths: Pick<BridgePaths, "cacheDir">;
  getUiLanguage: () => "zh" | "en";
  isStopping: () => boolean;
  sleep: (delayMs: number) => Promise<void>;
  getBlockedTurnSteerAvailability: (chatId: string, session: SessionRow) => RichInputTurnAvailability;
  sendPendingInteractionBlockNotice: (chatId: string) => Promise<void>;
  reanchorAcceptedTurnContinuation: (chatId: string, sessionId: string) => Promise<void>;
  startTextTurn: (
    chatId: string,
    session: SessionRow,
    text: string,
    options?: {
      sourceKind: "voice";
      transcript: string;
    }
  ) => Promise<void>;
  startStructuredTurn: (chatId: string, session: SessionRow, input: UserInput[]) => Promise<void>;
  safeSendMessage: (chatId: string, text: string, replyMarkup?: TelegramInlineKeyboardMarkup) => Promise<boolean>;
}

export class RichInputAdapter {
  private readonly pendingRichInputComposers = new Map<string, PendingRichInputComposer>();
  private readonly attachmentsBySessionId = new Map<string, RegisteredAttachment[]>();
  private readonly pendingAutoAttachByChatId = new Map<string, PendingAutoAttachState>();
  private lastCachePruneAt = 0;
  private voiceTaskQueue: Promise<void> = Promise.resolve();
  private pendingVoiceTaskCount = 0;
  private realtimeVoiceModelId: string | null | undefined = undefined;

  constructor(private readonly deps: RichInputAdapterDeps) {}

  private buildBridgeCommandActionsReplyMarkup(actions: BridgeCommandActionView[]): TelegramInlineKeyboardMarkup | undefined {
    if (!this.deps.preferBridgeCommandButtons || actions.length === 0) {
      return undefined;
    }

    return buildBridgeCommandReplyMarkup(actions, this.deps.getUiLanguage(), { chunkSize: 2 });
  }

  private buildCancelReplyMarkup(): TelegramInlineKeyboardMarkup | undefined {
    return this.buildBridgeCommandActionsReplyMarkup([{ command: "cancel" }]);
  }

  private buildBusyTurnReplyMarkup(includeHub = false): TelegramInlineKeyboardMarkup | undefined {
    return this.buildBridgeCommandActionsReplyMarkup([
      { command: "interrupt", style: "primary" },
      ...(includeHub ? [{ command: "hub" as const }] : [])
    ]);
  }

  resetRuntimeCaches(): void {
    this.realtimeVoiceModelId = undefined;
  }

  hasPendingRichInputComposer(chatId: string): boolean {
    return this.pendingRichInputComposers.has(chatId);
  }

  clearPendingAutoAttach(chatId: string): boolean {
    return this.pendingAutoAttachByChatId.delete(chatId);
  }

  resetPendingTransientState(chatId: string): void {
    this.pendingRichInputComposers.delete(chatId);
    this.pendingAutoAttachByChatId.delete(chatId);
  }

  async cancelPendingRichInputComposer(chatId: string): Promise<boolean> {
    const hadComposer = this.pendingRichInputComposers.has(chatId);
    const hadAutoAttach = this.pendingAutoAttachByChatId.has(chatId);
    if (!hadComposer && !hadAutoAttach) {
      return false;
    }

    this.pendingRichInputComposers.delete(chatId);
    this.pendingAutoAttachByChatId.delete(chatId);
    await this.deps.safeSendMessage(chatId, "已取消待发送的结构化输入。");
    return true;
  }

  async handlePendingRichInputPrompt(chatId: string, text: string): Promise<void> {
    const store = this.deps.getStore();
    const pending = this.pendingRichInputComposers.get(chatId);
    if (!store || !pending) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== pending.sessionId) {
      this.pendingRichInputComposers.delete(chatId);
      await this.deps.safeSendMessage(chatId, "当前会话已经变化，请重新发送结构化输入。");
      return;
    }

    const prompt = text.trim();
    if (!prompt) {
      await this.deps.safeSendMessage(chatId, `请继续发送要和${pending.promptLabel}一起交给 Codex 的说明。`);
      return;
    }

    this.pendingRichInputComposers.delete(chatId);
    await this.submitRichInputs(chatId, activeSession, [
      ...pending.inputs,
      { type: "text", text: prompt }
    ]);
  }

  async handleLocalImage(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.deps.safeSendMessage(chatId, "用法：/local_image <图片路径> :: 任务说明");
      return;
    }

    const imagePath = resolve(activeSession.projectPath, parsed.value);
    if (!await isReadableImagePath(imagePath)) {
      await this.deps.safeSendMessage(chatId, "This 本地图片路径不可用，请确认文件存在且是常见图片格式。");
      return;
    }

    await this.submitOrQueueRichInput(chatId, activeSession, [{
      type: "localImage",
      path: imagePath
    }], parsed.prompt, `本地图片：${basename(imagePath)}`);
  }

  async handleMention(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.deps.safeSendMessage(chatId, "用法：/mention <path> :: 任务说明");
      return;
    }

    const { name, path } = parseMentionValue(parsed.value);
    await this.submitOrQueueRichInput(chatId, activeSession, [{
      type: "mention",
      name,
      path
    }], parsed.prompt, `引用：${name}`);
  }

  async handleAttach(chatId: string, args: string): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "No active sessions.");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.deps.safeSendMessage(chatId, "用法：/attach <附件ID> :: 任务说明");
      return;
    }

    const attachment = this.findAttachment(activeSession.sessionId, parsed.value);
    if (!attachment) {
      await this.deps.safeSendMessage(chatId, `找不到附件：${parsed.value}`);
      return;
    }

    this.pendingAutoAttachByChatId.delete(chatId);
    const attachmentInputs = await this.buildAttachmentInputs(attachment);
    if (attachmentInputs.length === 0) {
      await this.deps.safeSendMessage(chatId, `当前无法把附件 ${attachment.filename} 转成 Codex 可读输入。`);
      return;
    }
    await this.submitOrQueueRichInput(chatId, activeSession, attachmentInputs, parsed.prompt, `附件：${attachment.filename}`);
  }

  async handleAutoAttachText(chatId: string, text: string): Promise<boolean> {
    const store = this.deps.getStore();
    if (!store) {
      return false;
    }

    const pending = this.pendingAutoAttachByChatId.get(chatId);
    if (!pending) {
      return false;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession || activeSession.sessionId !== pending.sessionId) {
      this.pendingAutoAttachByChatId.delete(chatId);
      return false;
    }

    const attachments = pending.attachmentIds
      .map((attachmentId) => this.findAttachment(activeSession.sessionId, attachmentId))
      .filter((attachment): attachment is RegisteredAttachment => Boolean(attachment));
    if (attachments.length === 0) {
      this.pendingAutoAttachByChatId.delete(chatId);
      return false;
    }

    const attachmentInputs = await this.buildAttachmentInputsForAttachments(attachments);
    if (attachmentInputs.length === 0) {
      this.pendingAutoAttachByChatId.delete(chatId);
      await this.deps.safeSendMessage(chatId, "最近附件暂时无法自动转成 Codex 可读输入，请改用支持文本提取的文件，或稍后再试。");
      return false;
    }

    const submitted = await this.submitRichInputs(chatId, activeSession, [
      ...attachmentInputs,
      { type: "text", text }
    ]);
    if (submitted) {
      this.pendingAutoAttachByChatId.delete(chatId);
    }
    return true;
  }

  async handleVoiceMessage(chatId: string, message: TelegramMessage): Promise<void> {
    const store = this.deps.getStore();
    const api = this.deps.getApi();
    if (!store || !api?.getFile || !api?.downloadFile) {
      return;
    }

    if (!this.deps.config.voiceInputEnabled) {
      await this.deps.safeSendMessage(chatId, "未启用语音输入。");
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "Please send /new first to select a project.");
      return;
    }

    const voice = message.voice;
    if (!voice) {
      return;
    }

    this.enqueueVoiceProcessingTask({
      chatId,
      sessionId: activeSession.sessionId,
      messageId: message.message_id,
      telegramFileId: voice.file_id
    });
    await this.deps.safeSendMessage(
      chatId,
      this.pendingVoiceTaskCount > 1
        ? `已收到语音，正在排队转写。前方还有 ${this.pendingVoiceTaskCount - 1} 条语音。`
        : "已收到语音，正在转写。"
    );
  }

  async handlePhotoMessage(chatId: string, message: TelegramMessage): Promise<void> {
    const store = this.deps.getStore();
    const api = this.deps.getApi();
    if (!store || !api?.getFile || !api?.downloadFile) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "Please send /new first to select a project.");
      return;
    }

    const photo = message.photo?.at(-1);
    if (!photo) {
      return;
    }

    try {
      const file = await api.getFile(photo.file_id);
      if (!file.file_path) {
        await this.deps.safeSendMessage(chatId, "暂时无法读取这张图片，请稍后重试。");
        return;
      }

      const localImagePath = await this.cacheTelegramPhoto(message.message_id, photo.file_id, file.file_path, file);
      if (!localImagePath) {
        await this.deps.safeSendMessage(chatId, "暂时无法读取这张图片，请稍后重试。");
        return;
      }

      await this.submitOrQueueRichInput(
        chatId,
        activeSession,
        [{ type: "localImage", path: localImagePath }],
        (message.caption ?? "").trim() || null,
        "图片"
      );
    } catch {
      await this.deps.safeSendMessage(chatId, "暂时无法读取这张图片，请稍后重试。");
    }
  }

  async handleInboundMediaEvent(chatId: string, event: InboundUserMediaEvent): Promise<void> {
    const store = this.deps.getStore();
    if (!store) {
      return;
    }

    const activeSession = store.getActiveSession(chatId);
    if (!activeSession) {
      await this.deps.safeSendMessage(chatId, "Please send /new first to select a project.");
      return;
    }

    const resolvedImages = event.media.filter((asset) => asset.status === "resolved" && asset.descriptor.kind === "image");
    const resolvedFiles = event.media.filter((asset) => asset.status === "resolved" && asset.descriptor.kind === "file");
    const unresolved = event.media.filter((asset) => asset.status === "unresolved");

    const registeredFiles = resolvedFiles.length > 0
      ? await this.sendAttachmentReceipt(chatId, activeSession.sessionId, resolvedFiles)
      : [];

    if (unresolved.length > 0) {
      await this.sendUnresolvedMediaNotice(chatId, unresolved);
    }

    const imageInputs: UserInput[] = resolvedImages
      .map((asset) => asset.localPath)
      .filter((path): path is string => Boolean(path))
      .map((path) => ({
        type: "localImage" as const,
        path
      }));

    if (event.text) {
      const attachmentInputs = registeredFiles.length > 0
        ? await this.buildAttachmentInputsForAttachments(registeredFiles)
        : [];
      if (imageInputs.length > 0 || attachmentInputs.length > 0) {
        const submitted = await this.submitRichInputs(chatId, activeSession, [
          ...imageInputs,
          ...attachmentInputs,
          { type: "text", text: event.text }
        ]);
        if (submitted && registeredFiles.length > 0) {
          this.pendingAutoAttachByChatId.delete(chatId);
        }
        return;
      }
    }

    if (imageInputs.length > 0) {
      await this.submitOrQueueRichInput(
        chatId,
        activeSession,
        imageInputs,
        event.text,
        imageInputs.length > 1 ? `${imageInputs.length} 张图片` : "图片"
      );
      return;
    }

    if (event.text) {
      await this.submitTextInput(chatId, activeSession, event.text);
    }
  }

  async submitOrQueueRichInput(
    chatId: string,
    session: SessionRow,
    inputs: UserInput[],
    prompt: string | null,
    promptLabel: string
  ): Promise<void> {
    if (prompt) {
      await this.submitRichInputs(chatId, session, [
        ...inputs,
        { type: "text", text: prompt }
      ]);
      return;
    }

    const steerAvailability = this.deps.getBlockedTurnSteerAvailability(chatId, session);
    if (session.status === "running" && steerAvailability.kind !== "available") {
      if (steerAvailability.kind === "interaction_pending") {
        await this.deps.sendPendingInteractionBlockNotice(chatId);
        return;
      }

      await this.deps.safeSendMessage(chatId, "Project running. Wait or send /interrupt.", this.buildBusyTurnReplyMarkup());
      return;
    }

    this.pendingRichInputComposers.set(chatId, {
      sessionId: session.sessionId,
      inputs,
      promptLabel
    });
    await this.deps.safeSendMessage(
      chatId,
      `已记录${promptLabel}，请继续发送任务说明，或发送 /cancel 取消。`,
      this.buildCancelReplyMarkup()
    );
  }

  private enqueueVoiceProcessingTask(task: VoiceProcessingTask): void {
    this.pendingVoiceTaskCount += 1;
    const runTask = async () => {
      try {
        await this.processQueuedVoiceTask(task);
      } finally {
        this.pendingVoiceTaskCount = Math.max(0, this.pendingVoiceTaskCount - 1);
      }
    };
    this.voiceTaskQueue = this.voiceTaskQueue.then(runTask, runTask);
  }

  private async processQueuedVoiceTask(task: VoiceProcessingTask): Promise<void> {
    const store = this.deps.getStore();
    const api = this.deps.getApi();
    if (this.deps.isStopping() || !store || !api?.getFile || !api?.downloadFile) {
      return;
    }

    const session = store.getSessionById(task.sessionId);
    if (!session || session.chatId !== task.chatId || session.archived) {
      await this.deps.safeSendMessage(task.chatId, "这条语音对应的会话已不可用，请重新选择会话后再试。");
      return;
    }

    let localVoicePath: string | null = null;
    try {
      const file = await api.getFile(task.telegramFileId);
      if (!file.file_path) {
        await this.deps.safeSendMessage(task.chatId, "暂时无法读取这段语音，请稍后重试。");
        return;
      }

      localVoicePath = await this.cacheTelegramVoice(task.messageId, task.telegramFileId, file.file_path, file);
      if (!localVoicePath) {
        await this.deps.safeSendMessage(task.chatId, "暂时无法读取这段语音，请稍后重试。");
        return;
      }

      let transcription: VoiceTranscriptionResult | null = null;
      if (this.deps.config.voiceOpenaiApiKey.trim()) {
        try {
          transcription = await this.transcribeVoiceWithOpenAi(localVoicePath);
        } catch (error) {
          await this.deps.logger.warn("openai voice transcription failed", {
            chatId: task.chatId,
            sessionId: session.sessionId,
            error: `${error}`
          });
          await this.deps.safeSendMessage(task.chatId, "OpenAI 语音转写失败，正在尝试 realtime 兜底。");
        }
      }

      if (!transcription) {
        try {
          transcription = await this.transcribeVoiceWithRealtime(session, localVoicePath);
        } catch (error) {
          await this.deps.logger.warn("realtime voice transcription failed", {
            chatId: task.chatId,
            sessionId: session.sessionId,
            error: `${error}`
          });
          await this.deps.safeSendMessage(task.chatId, `语音输入失败：${normalizeWhitespace(`${error}`)}`);
          return;
        }
      }

      const currentSession = store.getSessionById(task.sessionId);
      if (!currentSession || currentSession.chatId !== task.chatId || currentSession.archived) {
        await this.deps.safeSendMessage(task.chatId, "语音已转写，但对应会话已不可用，请重新发送。");
        return;
      }

      await this.deps.safeSendMessage(task.chatId, `语音转写：${transcription.transcript}`);
      await this.submitVoiceTranscript(task.chatId, currentSession, transcription.transcript);
    } catch (error) {
      await this.deps.logger.warn("voice message handling failed", {
        chatId: task.chatId,
        sessionId: session.sessionId,
        error: `${error}`
      });
      await this.deps.safeSendMessage(task.chatId, "暂时无法处理这段语音，请稍后重试。");
    } finally {
      if (localVoicePath) {
        await rm(localVoicePath, { force: true }).catch(() => {});
      }
    }
  }

  private async submitVoiceTranscript(chatId: string, session: SessionRow, transcript: string): Promise<void> {
    if (session.status === "running") {
      const steerAvailability = this.deps.getBlockedTurnSteerAvailability(chatId, session);
      if (steerAvailability.kind === "available") {
        try {
          const appServer = await this.deps.ensureAppServerAvailable();
          await appServer.steerTurn({
            threadId: steerAvailability.threadId,
            expectedTurnId: steerAvailability.turnId,
            input: [{ type: "text", text: transcript }]
          });
          await this.deps.reanchorAcceptedTurnContinuation(chatId, session.sessionId);
        } catch (error) {
          await this.deps.logger.warn("voice turn steer failed", {
            chatId,
            sessionId: session.sessionId,
            threadId: steerAvailability.threadId,
            turnId: steerAvailability.turnId,
            error: `${error}`
          });
          await this.deps.safeSendMessage(chatId, "Codex unavailable, try again.");
        }
        return;
      }

      if (steerAvailability.kind === "interaction_pending") {
        await this.deps.sendPendingInteractionBlockNotice(chatId);
        return;
      }

      await this.deps.safeSendMessage(chatId, "Project running. Wait or send /interrupt.", this.buildBusyTurnReplyMarkup());
      return;
    }

    await this.deps.startTextTurn(chatId, session, transcript, {
      sourceKind: "voice",
      transcript
    });
  }

  private async submitTextInput(chatId: string, session: SessionRow, text: string): Promise<boolean> {
    if (session.status === "running") {
      const steerAvailability = this.deps.getBlockedTurnSteerAvailability(chatId, session);
      if (steerAvailability.kind === "available") {
        try {
          const appServer = await this.deps.ensureAppServerAvailable();
          await appServer.steerTurn({
            threadId: steerAvailability.threadId,
            expectedTurnId: steerAvailability.turnId,
            input: [{ type: "text", text }]
          });
          await this.deps.reanchorAcceptedTurnContinuation(chatId, session.sessionId);
        } catch (error) {
          await this.deps.logger.warn("text turn steer failed for inbound media event", {
            chatId,
            sessionId: session.sessionId,
            threadId: steerAvailability.threadId,
            turnId: steerAvailability.turnId,
            error: `${error}`
          });
          await this.deps.safeSendMessage(chatId, "Codex unavailable, try again.");
          return false;
        }
        return true;
      }

      if (steerAvailability.kind === "interaction_pending") {
        await this.deps.sendPendingInteractionBlockNotice(chatId);
        return false;
      }

      await this.deps.safeSendMessage(chatId, "Project running. Wait or send /interrupt.", this.buildBusyTurnReplyMarkup());
      return false;
    }

    await this.deps.startTextTurn(chatId, session, text);
    return true;
  }

  private async submitRichInputs(chatId: string, session: SessionRow, input: UserInput[]): Promise<boolean> {
    if (session.status === "running") {
      const steerAvailability = this.deps.getBlockedTurnSteerAvailability(chatId, session);
      if (steerAvailability.kind === "available") {
        try {
          const appServer = await this.deps.ensureAppServerAvailable();
          await appServer.steerTurn({
            threadId: steerAvailability.threadId,
            expectedTurnId: steerAvailability.turnId,
            input
          });
          await this.deps.reanchorAcceptedTurnContinuation(chatId, session.sessionId);
        } catch (error) {
          await this.deps.logger.warn("turn steer failed", {
            chatId,
            sessionId: session.sessionId,
            threadId: steerAvailability.threadId,
            turnId: steerAvailability.turnId,
            error: `${error}`
          });
          await this.deps.safeSendMessage(chatId, "Codex unavailable, try again.");
          return false;
        }
        return true;
      }

      if (steerAvailability.kind === "interaction_pending") {
        await this.deps.sendPendingInteractionBlockNotice(chatId);
        return false;
      }

      await this.deps.safeSendMessage(chatId, "Project running. Wait or send /interrupt.", this.buildBusyTurnReplyMarkup());
      return false;
    }

    await this.deps.startStructuredTurn(chatId, session, input);
    return true;
  }

  private async transcribeVoiceWithOpenAi(localVoicePath: string): Promise<VoiceTranscriptionResult> {
    const audioBytes = await readFile(localVoicePath);
    const formData = new FormData();
    formData.append("model", this.deps.config.voiceOpenaiTranscribeModel);
    formData.append("file", new Blob([audioBytes], {
      type: "audio/ogg"
    }), basename(localVoicePath));

    const response = await fetch(OPENAI_AUDIO_TRANSCRIPT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.deps.config.voiceOpenaiApiKey}`
      },
      body: formData,
      signal: AbortSignal.timeout(60_000)
    });

    if (!response.ok) {
      const bodyText = normalizeWhitespace(await response.text());
      throw new Error(bodyText || `OpenAI transcription failed: ${response.status}`);
    }

    const payload = asRecord(await response.json());
    const transcript = normalizeWhitespace(getString(payload, "text") ?? "");
    if (!transcript) {
      throw new Error("OpenAI transcription returned empty text");
    }

    return {
      transcript,
      source: "openai"
    };
  }

  private async transcribeVoiceWithRealtime(
    session: SessionRow,
    localVoicePath: string
  ): Promise<VoiceTranscriptionResult> {
    const realtimeModelId = await this.getRealtimeVoiceModelId();
    if (!realtimeModelId) {
      throw new Error("当前 Codex 模型不支持 realtime 音频输入。");
    }

    if (!await commandExists(this.deps.config.voiceFfmpegBin)) {
      throw new Error(`系统里找不到 ffmpeg：${this.deps.config.voiceFfmpegBin}`);
    }

    const appServer = await this.deps.ensureAppServerAvailable();
    const tempThread = await appServer.startThread({
      cwd: session.projectPath,
      model: realtimeModelId
    });
    const tempThreadId = tempThread.thread.id;
    const existingTurns = await appServer.readThread(tempThreadId, true);
    const existingTurnIds = new Set(
      getArray(asRecord(existingTurns.thread), "turns")
        .map((turn) => getString(turn, "id"))
        .filter((turnId): turnId is string => Boolean(turnId))
    );
    const pcmPath = `${localVoicePath}.${randomUUID()}.pcm`;

    try {
      await this.convertVoiceToPcm(localVoicePath, pcmPath);
      const pcmBytes = await readFile(pcmPath);

      await appServer.startThreadRealtime({
        threadId: tempThreadId,
        prompt: VOICE_REALTIME_TRANSCRIPTION_PROMPT
      });

      for (let offset = 0; offset < pcmBytes.length; offset += VOICE_REALTIME_CHUNK_BYTES) {
        const chunk = pcmBytes.subarray(offset, Math.min(offset + VOICE_REALTIME_CHUNK_BYTES, pcmBytes.length));
        if (chunk.length === 0) {
          continue;
        }

        await appServer.appendThreadRealtimeAudio(tempThreadId, {
          data: chunk.toString("base64"),
          sampleRate: VOICE_PCM_SAMPLE_RATE,
          numChannels: VOICE_PCM_NUM_CHANNELS,
          samplesPerChannel: Math.floor(chunk.length / (VOICE_PCM_BYTES_PER_SAMPLE * VOICE_PCM_NUM_CHANNELS))
        });
      }

      await appServer.stopThreadRealtime(tempThreadId);
      const turnId = await this.waitForRealtimeTurnCompletion(appServer, tempThreadId, existingTurnIds);
      const transcript = normalizeWhitespace(await this.deps.extractFinalAnswerFromHistory(appServer, tempThreadId, turnId) ?? "");
      if (!transcript) {
        throw new Error("realtime transcription returned empty text");
      }

      return {
        transcript,
        source: "realtime"
      };
    } finally {
      await rm(pcmPath, { force: true }).catch(() => {});
      await appServer.stopThreadRealtime(tempThreadId).catch(() => {});
      await appServer.archiveThread(tempThreadId).catch(() => {});
    }
  }

  private async getRealtimeVoiceModelId(): Promise<string | null> {
    if (this.realtimeVoiceModelId !== undefined) {
      return this.realtimeVoiceModelId;
    }

    const models = await this.deps.fetchAllModels();
    const realtimeModel = models.find((model) => (model.inputModalities ?? []).includes("audio")) ?? null;
    this.realtimeVoiceModelId = realtimeModel?.id ?? null;
    return this.realtimeVoiceModelId;
  }

  private async waitForRealtimeTurnCompletion(
    appServer: CodexAppServerClient,
    threadId: string,
    existingTurnIds: Set<string>
  ): Promise<string> {
    const deadline = Date.now() + VOICE_REALTIME_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const thread = await appServer.readThread(threadId, true);
      const turns = getArray(asRecord(thread.thread), "turns")
        .map((turn) => asRecord(turn))
        .filter((turn): turn is Record<string, unknown> => Boolean(turn));
      const candidateTurns = turns.filter((turn) => {
        const turnId = getString(turn, "id");
        if (!turnId) {
          return false;
        }
        return !existingTurnIds.has(turnId);
      });

      const completedTurn = candidateTurns.find((turn) => getString(turn, "status") === "completed");
      if (completedTurn) {
        const completedTurnId = getString(completedTurn, "id");
        if (completedTurnId) {
          return completedTurnId;
        }
      }

      const failedTurn = candidateTurns.find((turn) => {
        const status = getString(turn, "status");
        return status === "failed" || status === "interrupted";
      });
      if (failedTurn) {
        throw new Error(`realtime transcription turn ${getString(failedTurn, "status") ?? "failed"}`);
      }

      await this.deps.sleep(VOICE_REALTIME_POLL_INTERVAL_MS);
    }

    throw new Error("realtime transcription timed out");
  }

  private async convertVoiceToPcm(inputPath: string, outputPath: string): Promise<void> {
    const result = await runCommand(this.deps.config.voiceFfmpegBin, [
      "-y",
      "-i",
      inputPath,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      `${VOICE_PCM_NUM_CHANNELS}`,
      "-ar",
      `${VOICE_PCM_SAMPLE_RATE}`,
      outputPath
    ]);

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || "ffmpeg conversion failed");
    }
  }

  private async cacheTelegramPhoto(
    messageId: number,
    fileId: string,
    filePath: string,
    file?: { file_id: string; file_path?: string }
  ): Promise<string | null> {
    const api = this.deps.getApi();
    if (!api) {
      return null;
    }

    const cacheDir = await this.ensureTelegramImageCacheDir();
    void this.pruneTelegramCacheDir(cacheDir).catch(async (error) => {
      await this.deps.logger.warn("telegram image cache cleanup failed", {
        cacheDir,
        error: `${error}`
      });
    });

    const targetPath = join(cacheDir, `${messageId}-${randomUUID()}${getTelegramFileExtension(filePath, ".jpg")}`);
    return await api.downloadFile(fileId, targetPath, file);
  }

  private async cacheTelegramVoice(
    messageId: number,
    fileId: string,
    filePath: string,
    file?: { file_id: string; file_path?: string }
  ): Promise<string | null> {
    const api = this.deps.getApi();
    if (!api) {
      return null;
    }

    const cacheDir = await this.ensureTelegramVoiceCacheDir();
    void this.pruneTelegramCacheDir(cacheDir).catch(async (error) => {
      await this.deps.logger.warn("telegram voice cache cleanup failed", {
        cacheDir,
        error: `${error}`
      });
    });

    const targetPath = join(cacheDir, `${messageId}-${randomUUID()}${getTelegramFileExtension(filePath, ".ogg")}`);
    return await api.downloadFile(fileId, targetPath, file);
  }

  private async ensureTelegramImageCacheDir(): Promise<string> {
    const cacheDir = join(this.deps.paths.cacheDir, TELEGRAM_IMAGE_CACHE_DIRNAME);
    await mkdir(cacheDir, { recursive: true });
    return cacheDir;
  }

  private async ensureTelegramVoiceCacheDir(): Promise<string> {
    const cacheDir = join(this.deps.paths.cacheDir, TELEGRAM_VOICE_CACHE_DIRNAME);
    await mkdir(cacheDir, { recursive: true });
    return cacheDir;
  }

  private async pruneTelegramCacheDir(cacheDir: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastCachePruneAt < TELEGRAM_CACHE_PRUNE_INTERVAL_MS) {
      return;
    }

    this.lastCachePruneAt = now;
    const cutoffMs = now - TELEGRAM_IMAGE_CACHE_MAX_AGE_MS;
    const entries = await readdir(cacheDir, { withFileTypes: true });

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile()) {
        return;
      }

      const entryPath = join(cacheDir, entry.name);
      try {
        const fileStats = await stat(entryPath);
        if (fileStats.mtimeMs < cutoffMs) {
          await rm(entryPath, { force: true });
        }
      } catch {
        return;
      }
    }));
  }

  private async sendAttachmentReceipt(
    chatId: string,
    sessionId: string,
    assets: ResolvedMediaAsset[]
  ): Promise<RegisteredAttachment[]> {
    const registered = assets.map((asset) => this.registerAttachment(sessionId, asset));
    this.pendingAutoAttachByChatId.set(chatId, {
      sessionId,
      attachmentIds: registered.map((item) => item.attachmentId)
    });
    const summary = registered
      .map((item) => `- ${item.filename} (${item.attachmentId})`)
      .join("\n");
    await this.deps.safeSendMessage(
      chatId,
      registered.length === 1
        ? `已接收文件附件：\n${summary}\n下一条消息会自动带上最近附件；也可用 /attach <附件ID> :: 任务说明；发送 /cancel 可取消。`
        : `已接收 ${registered.length} more files附件：\n${summary}\n下一条消息会自动带上最近附件；也可用 /attach <附件ID> :: 任务说明；发送 /cancel 可取消。`,
      this.buildCancelReplyMarkup()
    );
    return registered;
  }

  private registerAttachment(sessionId: string, asset: ResolvedMediaAsset): RegisteredAttachment {
    const existing = this.attachmentsBySessionId.get(sessionId) ?? [];
    const attachmentIdBase = asset.sha256 ? `att-${asset.sha256.slice(0, 10)}` : `att-${randomUUID().slice(0, 10)}`;
    const duplicate = existing.find((entry) => entry.sha256 && entry.sha256 === asset.sha256);
    if (duplicate) {
      return duplicate;
    }

    const registered: RegisteredAttachment = {
      attachmentId: existing.some((entry) => entry.attachmentId === attachmentIdBase)
        ? `${attachmentIdBase}-${existing.length + 1}`
        : attachmentIdBase,
      sessionId,
      filename: asset.descriptor.filename ?? basename(asset.localPath ?? "attachment.bin"),
      localPath: asset.localPath ?? "",
      kind: asset.descriptor.kind,
      sha256: asset.sha256,
      createdAt: asset.resolvedAt ?? new Date().toISOString()
    };
    existing.push(registered);
    this.attachmentsBySessionId.set(sessionId, existing);
    return registered;
  }

  private async sendUnresolvedMediaNotice(chatId: string, assets: ResolvedMediaAsset[]): Promise<void> {
    if (
      assets.length === 1
      && assets[0]?.descriptor.kind === "image"
      && assets[0].descriptor.platformRef?.platform === "telegram"
    ) {
      await this.deps.safeSendMessage(chatId, "暂时无法读取这张图片，请稍后重试。");
      return;
    }

    const lines = assets.map((asset) => {
      const name = asset.descriptor.filename ?? asset.descriptor.kind;
      return `- ${name}: ${asset.failureReason ?? "unknown"}`;
    }).join("\n");
    await this.deps.safeSendMessage(chatId, `以下附件未能完成解析：\n${lines}`);
  }

  private findAttachment(sessionId: string, attachmentId: string): RegisteredAttachment | null {
    return this.attachmentsBySessionId.get(sessionId)?.find((entry) => entry.attachmentId === attachmentId) ?? null;
  }

  private async buildAttachmentInputsForAttachments(attachments: RegisteredAttachment[]): Promise<UserInput[]> {
    return (await Promise.all(
      attachments.map(async (attachment) => await this.buildAttachmentInputs(attachment))
    )).flat();
  }

  private async buildAttachmentInputs(attachment: RegisteredAttachment): Promise<UserInput[]> {
    const extracted = await this.extractAttachmentText(attachment);
    if (!extracted) {
      return [];
    }

    return [{
      type: "text",
      text: extracted
    }];
  }

  private async extractAttachmentText(attachment: RegisteredAttachment): Promise<string | null> {
    const extension = extname(attachment.filename).toLowerCase();
    let content: string | null = null;

    if (TEXTUAL_ATTACHMENT_EXTENSIONS.has(extension)) {
      content = normalizeWhitespacePreservingLines(await readFile(attachment.localPath, "utf8"));
    } else if (extension === ".pdf") {
      content = await this.extractPdfText(attachment.localPath);
    } else if (TEXTUTIL_ATTACHMENT_EXTENSIONS.has(extension)) {
      content = await this.extractTextWithTextutil(attachment.localPath);
    }

    const normalized = content ? content.trim() : "";
    if (!normalized) {
      return null;
    }

    const truncated = truncateText(normalized, ATTACHMENT_CONTENT_CHAR_LIMIT);
    return truncated === normalized
      ? `以下是附件《${attachment.filename}》的提取内容：\n\n${truncated}`
      : `以下是附件《${attachment.filename}》的提取内容（已截断)：\n\n${truncated}`;
  }

  private async extractPdfText(filePath: string): Promise<string | null> {
    if (!await commandExists("pdftotext")) {
      return null;
    }

    const result = await runCommand("pdftotext", [
      "-layout",
      "-nopgbrk",
      filePath,
      "-"
    ]);
    if (result.exitCode !== 0) {
      return null;
    }
    return normalizeWhitespacePreservingLines(result.stdout);
  }

  private async extractTextWithTextutil(filePath: string): Promise<string | null> {
    if (!await commandExists("textutil")) {
      return null;
    }

    const result = await runCommand("textutil", [
      "-convert",
      "txt",
      "-stdout",
      filePath
    ]);
    if (result.exitCode !== 0) {
      return null;
    }
    return normalizeWhitespacePreservingLines(result.stdout);
  }

}

function normalizeWhitespacePreservingLines(text: string): string {
  return text
    .split(/\r?\n/gu)
    .map((line) => line.replace(/\s+/gu, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function parseMentionValue(value: string): {
  name: string;
  path: string;
} {
  const separatorIndex = value.indexOf("|");
  if (separatorIndex !== -1) {
    const explicitName = value.slice(0, separatorIndex).trim();
    const explicitPath = value.slice(separatorIndex + 1).trim();
    if (explicitName && explicitPath) {
      return {
        name: explicitName,
        path: explicitPath
      };
    }
  }

  return {
    name: deriveMentionName(value),
    path: value.trim()
  };
}

function deriveMentionName(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (/^[a-z]+:\/\//iu.test(trimmed)) {
    const withoutScheme = trimmed.replace(/^[a-z]+:\/\//iu, "");
    const tail = withoutScheme.split("/").filter(Boolean).at(-1);
    return tail ?? trimmed;
  }

  const base = basename(trimmed);
  return base || trimmed;
}

async function isReadableImagePath(imagePath: string): Promise<boolean> {
  if (!/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif)$/iu.test(imagePath)) {
    return false;
  }

  try {
    await access(imagePath);
    return true;
  } catch {
    return false;
  }
}

function getTelegramFileExtension(filePath: string, fallback: string): string {
  const extension = extname(filePath).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/iu.test(extension) ? extension : fallback;
}
