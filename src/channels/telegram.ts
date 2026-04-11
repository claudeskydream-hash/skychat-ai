import { createLogger } from "../logger.js";
import { createRequire } from "node:module";
import https from "node:https";
import type { Channel, InboundMessage, OutboundMessage, ChannelConfig, MediaAttachment } from "../types.js";

const log = createLogger("telegram");
const require = createRequire(import.meta.url);

/**
 * Telegram Bot 渠道适配器
 * 基于 grammY 框架，参照 openclaw 的 Telegram 实现模式
 *
 * 配置示例 (~/.skychat-ai/config.json):
 * {
 *   "channels": {
 *     "telegram": {
 *       "type": "telegram",
 *       "enabled": true,
 *       "token": "123456:ABCdef...",
 *       "respondToAll": false,
 *       "allowedChats": ["-1001234567890"]
 *     }
 *   }
 * }
 */
export class TelegramChannel implements Channel {
  readonly name = "telegram";

  private bot: any = null;
  private config: ChannelConfig;
  private running = false;
  private botUsername?: string;
  private token: string;

  constructor(config: ChannelConfig) {
    this.config = config;
    this.token = config.token as string;
  }

  async login(): Promise<void> {
    // Token 认证，无需登录流程（同 Discord）
  }

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    if (!this.token) {
      throw new Error(
        "Telegram Bot Token 未配置。请在 ~/.skychat-ai/config.json 的 channels.telegram.token 中设置",
      );
    }

    let grammy: any;
    try {
      // @ts-ignore — optional dependency
      grammy = await import("grammy");
    } catch {
      throw new Error("需要安装 grammY: npm i grammy");
    }

    const { Bot } = grammy;

    // 配置代理（国内访问 Telegram API 需要）
    const proxyUrl =
      (this.config.proxy as string) ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY;

    let clientConfig: any = {};
    if (proxyUrl) {
      try {
        // 使用 createRequire (CJS) 加载，确保 agent 在 ESM 下也能正常工作
        const { HttpsProxyAgent } = require("https-proxy-agent");
        const agent = new HttpsProxyAgent(proxyUrl);
        // 设置全局代理（node-fetch 在某些路径下不使用传入的 agent）
        (https as any).globalAgent = agent;
        // grammY 内部使用 node-fetch，通过 baseFetchConfig.agent 传入代理
        clientConfig = {
          baseFetchConfig: { agent },
          canReuse: true,
        };
        log.info(`使用代理: ${proxyUrl}`);
      } catch {
        log.warn("代理配置失败，将尝试直连（可能无法访问 Telegram API）");
      }
    }

    this.bot = new Bot(this.token, { client: clientConfig });
    this.running = true;

    // 获取 bot 信息，用于群聊 @mention 检测
    const me = await this.bot.api.getMe();
    this.botUsername = me.username;
    log.info(`Bot 信息: @${me.username}`);

    // ─── 文本消息 ───
    this.bot.on("message:text", async (ctx: any) => {
      const msg = ctx.message;
      if (!this.running) return;
      if (msg.from?.is_bot) return;

      const { shouldHandle, text } = this.filterMessage(msg, msg.text);
      if (!shouldHandle) return;

      onMessage({
        id: String(msg.message_id),
        channel: "telegram",
        senderId: String(msg.chat.id),
        senderName: this.buildSenderName(msg),
        text,
        replyToken: String(msg.chat.id),
        timestamp: msg.date * 1000,
      });
    });

    // ─── 图片消息 ───
    this.bot.on("message:photo", async (ctx: any) => {
      const msg = ctx.message;
      if (!this.running) return;
      if (msg.from?.is_bot) return;

      const caption = msg.caption || "";
      const { shouldHandle, text } = this.filterMessage(msg, caption);
      if (!shouldHandle) return;

      const media = await this.resolvePhotoMedia(msg);
      if (!media) return;

      onMessage({
        id: String(msg.message_id),
        channel: "telegram",
        senderId: String(msg.chat.id),
        senderName: this.buildSenderName(msg),
        text: text || "[图片]",
        media,
        replyToken: String(msg.chat.id),
        timestamp: msg.date * 1000,
      });
    });

    // ─── 语音消息 ───
    this.bot.on("message:voice", async (ctx: any) => {
      const msg = ctx.message;
      if (!this.running) return;
      if (msg.from?.is_bot) return;

      const { shouldHandle } = this.filterMessage(msg, "");
      if (!shouldHandle) return;

      const media = await this.resolveVoiceMedia(msg);
      onMessage({
        id: String(msg.message_id),
        channel: "telegram",
        senderId: String(msg.chat.id),
        senderName: this.buildSenderName(msg),
        text: "[语音消息]",
        media,
        isVoice: true,
        replyToken: String(msg.chat.id),
        timestamp: msg.date * 1000,
      });
    });

    // ─── 视频消息 ───
    this.bot.on("message:video", async (ctx: any) => {
      const msg = ctx.message;
      if (!this.running) return;
      if (msg.from?.is_bot) return;

      const caption = msg.caption || "";
      const { shouldHandle, text } = this.filterMessage(msg, caption);
      if (!shouldHandle) return;

      const media = await this.resolveVideoMedia(msg);
      onMessage({
        id: String(msg.message_id),
        channel: "telegram",
        senderId: String(msg.chat.id),
        senderName: this.buildSenderName(msg),
        text: text || "[视频]",
        media,
        replyToken: String(msg.chat.id),
        timestamp: msg.date * 1000,
      });
    });

    // ─── 文档消息 ───
    this.bot.on("message:document", async (ctx: any) => {
      const msg = ctx.message;
      if (!this.running) return;
      if (msg.from?.is_bot) return;

      const caption = msg.caption || "";
      const { shouldHandle, text } = this.filterMessage(msg, caption);
      if (!shouldHandle) return;

      const media = await this.resolveDocumentMedia(msg);
      onMessage({
        id: String(msg.message_id),
        channel: "telegram",
        senderId: String(msg.chat.id),
        senderName: this.buildSenderName(msg),
        text: text || msg.document?.file_name || "[文件]",
        media,
        replyToken: String(msg.chat.id),
        timestamp: msg.date * 1000,
      });
    });

    // ─── 贴纸消息 ───
    this.bot.on("message:sticker", async (ctx: any) => {
      const msg = ctx.message;
      if (!this.running) return;
      if (msg.from?.is_bot) return;

      const { shouldHandle } = this.filterMessage(msg, "");
      if (!shouldHandle) return;

      onMessage({
        id: String(msg.message_id),
        channel: "telegram",
        senderId: String(msg.chat.id),
        senderName: this.buildSenderName(msg),
        text: msg.sticker?.emoji ? `[贴纸 ${msg.sticker.emoji}]` : "[贴纸]",
        replyToken: String(msg.chat.id),
        timestamp: msg.date * 1000,
      });
    });

    // 启动 long polling
    await this.bot.start({
      onStart: () => {
        log.info(`已上线: @${this.botUsername}`);
      },
    });
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.bot) throw new Error("Telegram 未连接");

    const chatId = msg.replyToken || msg.targetId;
    if (!chatId) {
      log.error("无法确定回复目标");
      return;
    }

    try {
      // 发送语音（TTS 回复）
      if (msg.voice) {
        const { InputFile } = await import("grammy");
        await this.bot.api.sendAudio(chatId, new InputFile(msg.voice, "voice.mp3"));
        log.info("语音已发送");
      }

      // 发送图片媒体
      const imageMedia = msg.media?.filter((m) => m.type === "image");
      if (imageMedia?.length) {
        for (const img of imageMedia) {
          if (img.url) {
            await this.bot.api.sendPhoto(chatId, img.url);
          } else if (img.path) {
            const { InputFile } = await import("grammy");
            await this.bot.api.sendPhoto(chatId, new InputFile(img.path));
          }
        }
      }

      // 发送文本（4096 字符限制分块）
      if (msg.text) {
        const chunks = this.chunkText(msg.text, 4096);
        for (const chunk of chunks) {
          await this.bot.api.sendMessage(chatId, chunk);
        }
      }

      log.info(`已回复 (${msg.text?.length || 0} 字符)`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`发送失败: ${errMsg}`);
    }
  }

  /**
   * 发送"正在输入"状态指示器
   * Gateway 会自动检测此方法是否存在并调用
   */
  async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.api.sendChatAction(chatId, "typing");
    } catch {
      // typing 指示器失败不应影响主流程
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    log.info("已停止");
  }

  // ─── 私有方法 ───

  /**
   * 群聊消息过滤
   * 参照 openclaw 的 hasBotMention + 群聊策略
   */
  private filterMessage(
    msg: any,
    text: string,
  ): { shouldHandle: boolean; text: string } {
    const isGroup =
      msg.chat?.type === "group" || msg.chat?.type === "supergroup";

    if (!isGroup) {
      // 私聊始终响应
      return { shouldHandle: true, text };
    }

    // 群聊：检查 allowedChats 白名单
    const allowedChats = this.config.allowedChats as string[] | undefined;
    if (allowedChats?.length && !allowedChats.includes(String(msg.chat.id))) {
      return { shouldHandle: false, text };
    }

    const respondToAll = this.config.respondToAll as boolean;

    // 检测 @mention
    const mentioned = this.hasBotMention(msg, text);
    // 检测回复 bot 的消息
    const replyToBot =
      msg.reply_to_message?.from?.username === this.botUsername;

    if (!mentioned && !replyToBot && !respondToAll) {
      return { shouldHandle: false, text };
    }

    // 剥离 @mention 文本
    if (mentioned && this.botUsername) {
      text = text.replace(new RegExp(`@${this.botUsername}`, "gi"), "").trim();
    }

    return { shouldHandle: true, text };
  }

  /**
   * 检测消息中是否包含 @bot 的 mention
   * 参照 openclaw body-helpers.ts 的 hasBotMention
   */
  private hasBotMention(msg: any, text: string): boolean {
    if (!this.botUsername || !text) return false;

    const mention = `@${this.botUsername}`.toLowerCase();
    // 文本级别快速检测
    if (text.toLowerCase().includes(mention)) {
      return true;
    }
    // entity 级别精确检测
    const entities = msg.entities || msg.caption_entities || [];
    for (const ent of entities) {
      if (ent.type === "mention") {
        const slice = text.slice(ent.offset, ent.offset + ent.length);
        if (slice.toLowerCase() === mention) return true;
      }
    }
    return false;
  }

  /**
   * 构建发送者名称
   * 参照 openclaw body-helpers.ts 的 buildSenderName
   */
  private buildSenderName(msg: any): string | undefined {
    const name = [msg.from?.first_name, msg.from?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim();
    return name || msg.from?.username || undefined;
  }

  /**
   * 获取 Telegram 文件下载 URL
   * 参照 openclaw 的 resolveMedia 模式
   */
  private async resolveFileUrl(fileId: string): Promise<string | undefined> {
    try {
      const fileInfo = await this.bot.api.getFile(fileId);
      if (!fileInfo.file_path) return undefined;
      return `https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`;
    } catch (err) {
      log.warn(
        `文件下载失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  private async resolvePhotoMedia(msg: any): Promise<MediaAttachment[] | undefined> {
    const photo = msg.photo?.[msg.photo.length - 1]; // 取最高分辨率
    if (!photo) return undefined;
    const url = await this.resolveFileUrl(photo.file_id);
    if (!url) return undefined;
    return [{ type: "image", url, mimeType: "image/jpeg" }];
  }

  private async resolveVoiceMedia(msg: any): Promise<MediaAttachment[] | undefined> {
    const voice = msg.voice;
    if (!voice) return undefined;
    const url = await this.resolveFileUrl(voice.file_id);
    if (!url) return undefined;
    return [{ type: "voice", url, mimeType: voice.mime_type || "audio/ogg" }];
  }

  private async resolveVideoMedia(msg: any): Promise<MediaAttachment[] | undefined> {
    const video = msg.video;
    if (!video) return undefined;
    const url = await this.resolveFileUrl(video.file_id);
    if (!url) return undefined;
    return [{ type: "video", url, mimeType: video.mime_type || "video/mp4" }];
  }

  private async resolveDocumentMedia(msg: any): Promise<MediaAttachment[] | undefined> {
    const doc = msg.document;
    if (!doc) return undefined;
    const url = await this.resolveFileUrl(doc.file_id);
    if (!url) return undefined;
    return [
      {
        type: "file",
        url,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
      },
    ];
  }

  private chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      let breakAt = remaining.lastIndexOf("\n", maxLen);
      if (breakAt <= 0) breakAt = maxLen;
      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt);
    }
    return chunks;
  }
}
