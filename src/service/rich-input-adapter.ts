import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import type { CodexAppServerClient, UserInput } from "../codex/app-server.js";
import type { BridgeConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { BridgePaths } from "../paths.js";
import { commandExists, runCommand } from "../process.js";
import type { BridgeStateStore } from "../state/store.js";
import type { TelegramApi, TelegramMessage } from "../telegram/api.js";
import type { SessionRow } from "../types.js";
import { normalizeAndTruncate, normalizeWhitespace } from "../util/text.js";
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
  safeSendMessage: (chatId: string, text: string) => Promise<boolean>;
}

export class RichInputAdapter {
  private readonly pendingRichInputComposers = new Map<string, PendingRichInputComposer>();
  private lastCachePruneAt = 0;
  private voiceTaskQueue: Promise<void> = Promise.resolve();
  private pendingVoiceTaskCount = 0;
  private realtimeVoiceModelId: string | null | undefined = undefined;

  constructor(private readonly deps: RichInputAdapterDeps) {}

  resetRuntimeCaches(): void {
    this.realtimeVoiceModelId = undefined;
  }

  hasPendingRichInputComposer(chatId: string): boolean {
    return this.pendingRichInputComposers.has(chatId);
  }

  async cancelPendingRichInputComposer(chatId: string): Promise<boolean> {
    if (!this.pendingRichInputComposers.has(chatId)) {
      return false;
    }

    this.pendingRichInputComposers.delete(chatId);
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
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
      return;
    }

    const parsed = splitStructuredInputCommand(args);
    if (!parsed.value) {
      await this.deps.safeSendMessage(chatId, "用法：/local_image <图片路径> :: 任务说明");
      return;
    }

    const imagePath = resolve(activeSession.projectPath, parsed.value);
    if (!await isReadableImagePath(imagePath)) {
      await this.deps.safeSendMessage(chatId, "这个本地图片路径不可用，请确认文件存在且是常见图片格式。");
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
      await this.deps.safeSendMessage(chatId, "当前没有活动会话。");
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
      await this.deps.safeSendMessage(chatId, "请先发送 /new 选择项目。");
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
      await this.deps.safeSendMessage(chatId, "请先发送 /new 选择项目。");
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

      await this.deps.safeSendMessage(chatId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    this.pendingRichInputComposers.set(chatId, {
      sessionId: session.sessionId,
      inputs,
      promptLabel
    });
    await this.deps.safeSendMessage(chatId, `已记录${promptLabel}，请继续发送任务说明，或发送 /cancel 取消。`);
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
    if (!session || session.telegramChatId !== task.chatId || session.archived) {
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
      if (!currentSession || currentSession.telegramChatId !== task.chatId || currentSession.archived) {
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
          await this.deps.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
        }
        return;
      }

      if (steerAvailability.kind === "interaction_pending") {
        await this.deps.sendPendingInteractionBlockNotice(chatId);
        return;
      }

      await this.deps.safeSendMessage(chatId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    await this.deps.startTextTurn(chatId, session, transcript, {
      sourceKind: "voice",
      transcript
    });
  }

  private async submitRichInputs(chatId: string, session: SessionRow, input: UserInput[]): Promise<void> {
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
          await this.deps.safeSendMessage(chatId, "Codex 服务暂时不可用，请稍后重试。");
        }
        return;
      }

      if (steerAvailability.kind === "interaction_pending") {
        await this.deps.sendPendingInteractionBlockNotice(chatId);
        return;
      }

      await this.deps.safeSendMessage(chatId, "当前项目仍在执行，请等待完成或发送 /interrupt。");
      return;
    }

    await this.deps.startStructuredTurn(chatId, session, input);
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
}

function splitStructuredInputCommand(args: string): { value: string; prompt: string | null } {
  const separatorIndex = args.indexOf("::");
  if (separatorIndex === -1) {
    return {
      value: args.trim(),
      prompt: null
    };
  }

  return {
    value: args.slice(0, separatorIndex).trim(),
    prompt: args.slice(separatorIndex + 2).trim() || null
  };
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
