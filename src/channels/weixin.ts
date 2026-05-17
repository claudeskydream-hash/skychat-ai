import { createLogger } from "../logger.js";
import { getAccountsDir, getDataDir, ensureDir, loadConfig } from "../config.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, randomUUID, createDecipheriv, createCipheriv } from "node:crypto";
import { createHash } from "node:crypto";
import type { Channel, InboundMessage, OutboundMessage, ChannelConfig, MediaAttachment } from "../types.js";
import { encodeToSilk } from "../voice-encode.js";

const INBOUND_DIR = join(getDataDir(), "inbound");

const log = createLogger("weixin");

/** Mask sensitive IDs: "a859bd6ccf43@im.bot" → "a859****bot" */
function maskId(id: string): string {
  if (id.length <= 6) return id;
  return id.slice(0, 4) + "****" + id.slice(-3);
}

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "2.1.6";
const API_TIMEOUT_MS = 15_000;

// openclaw-compatible headers (required for VIDEO/FILE/VOICE sending)
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (1 << 8) | 6; // 131334

// ── Message constants (from openclaw-weixin protocol) ──
const MessageType = { USER: 1, BOT: 2 } as const;
const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

// ── Types ──

interface WeixinAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;  // base64-encoded
}

interface WeixinMessageItem {
  type: number;
  text_item?: { text: string };
  image_item?: {
    media?: CDNMedia;
    thumb_media?: CDNMedia;
    /** Raw AES key as hex string (preferred for images) */
    aeskey?: string;
    url?: string;
  };
  voice_item?: {
    media?: CDNMedia;
    /** Voice-to-text from WeChat (if available) */
    text?: string;
    encode_type?: number;
    playtime?: number;
  };
  file_item?: {
    media?: CDNMedia;
    file_name?: string;
  };
  video_item?: {
    media?: CDNMedia;
  };
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  item_list?: WeixinMessageItem[];
  create_time_ms?: number;
}

interface GetUpdatesResponse {
  ret?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

// ── CDN upload types ──

interface UploadedFileInfo {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;            // hex-encoded
  fileSize: number;           // plaintext size
  fileSizeCiphertext: number; // AES-128-ECB padded size
}

// ── AES-ECB helpers ──

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ── Weixin Channel ──

export class WeixinChannel implements Channel {
  readonly name = "weixin";

  private account: WeixinAccount | null = null;
  private syncBuf = "";
  private running = false;
  private abortController: AbortController | null = null;
  private config: ChannelConfig;
  // Cache typing_ticket per user
  private typingTickets = new Map<string, string>();
  // Last known context_token per user (for startup greeting)
  private lastTokens = new Map<string, string>();
  // In-memory cache to avoid repeated guide-sent file reads
  private guideSentCache = new Set<string>();
  // Whether startup greeting was already sent proactively
  private startupGreetingSent = false;
  // Whether no model provider has API key configured
  private noModelConfigured = false;

  constructor(config: ChannelConfig) {
    this.config = config;
  }

  // ── Session management ──

  hasSession(): boolean {
    return existsSync(this.accountFile());
  }

  sessionLabel(): string {
    let id: string | undefined;
    if (this.account) {
      id = this.account.accountId;
    } else {
      try {
        const raw = readFileSync(this.accountFile(), "utf-8");
        id = JSON.parse(raw).accountId;
      } catch {}
    }
    return id ? maskId(id) : "微信";
  }

  async clearSession(): Promise<void> {
    await this.clearAccount();
    this.account = null;
  }

  // ── Auth ──

  async login(): Promise<void> {
    const baseUrl = (this.config.baseUrl as string) || DEFAULT_BASE_URL;
    log.debug("获取二维码中...");

    const qrRes = await this.api(baseUrl, "ilink/bot/get_bot_qrcode?bot_type=3", null, {
      method: "GET",
      timeout: 10_000,
    });

    if (qrRes.ret !== 0) {
      throw new Error(`获取二维码失败: ${qrRes.errmsg || qrRes.ret}`);
    }

    const qrUrl: string = qrRes.qrcode_img_content || qrRes.data?.qrcode_img_content;
    const qrCode: string = qrRes.qrcode || qrRes.data?.qrcode;

    if (!qrUrl || !qrCode) {
      throw new Error(`二维码响应缺少字段: ${JSON.stringify(qrRes)}`);
    }

    log.info("请用微信扫描二维码:");
    console.log();
    try {
      const qrTerminal = await import("qrcode-terminal");
      (qrTerminal.default || qrTerminal).generate(qrUrl, { small: true });
    } catch {
      console.log(`  ${qrUrl}`);
    }
    console.log();

    log.info("等待扫码...");

    let attempts = 0;
    while (attempts < 60) {
      const statusRes = await this.api(
        baseUrl,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrCode)}`,
        null,
        { method: "GET", timeout: 40_000 },
      );

      const status = statusRes.data?.status || statusRes.status;

      if (status === "confirmed") {
        const data = statusRes.data || statusRes;
        const accountId: string = data.ilink_bot_id || data.bot_id;
        const token: string = data.bot_token || data.token;

        if (!accountId || !token) {
          throw new Error("登录成功但缺少凭证");
        }

        this.account = {
          accountId,
          token,
          baseUrl: data.baseurl || baseUrl,
          userId: data.ilink_user_id,
        };

        await this.saveAccount();
        log.info(`登录成功！账号: ${maskId(accountId)}`);
        return;
      }

      if (status === "scaned") {
        log.info("已扫码，等待确认...");
      }

      if (status === "expired") {
        log.warn("二维码已过期");
        throw new Error("二维码已过期");
      }

      attempts++;
      await sleep(500);
    }

    throw new Error("登录超时");
  }

  // ── Message loop ──

  async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
    if (!this.account) {
      await this.loadAccount();
    }

    if (!this.account) {
      log.info("首次使用，开始登录...");
      await this.login();
    }

    await this.loadSyncBuf();
    await this.loadLastTokens();
    this.running = true;
    log.info(`已上线 (${maskId(this.account!.accountId)})`);

    // Check if any model provider has API key configured
    const hasModel = await this.checkModelConfigured();
    if (!hasModel) {
      this.noModelConfigured = true;
      log.warn("尚未配置任何模型的 API Key");
    }

    // Send startup greeting to known users (with saved tokens)
    // Fresh scan: no tokens, greeting + guide will be sent on first message
    await this.sendStartupGreeting();

    while (this.running) {
      try {
        this.abortController = new AbortController();
        const res = await this.getUpdates();

        if (res.ret === -14) {
          log.warn("会话过期，重新登录...");
          this.account = null;
          await this.login();
          continue;
        }

        if (res.ret && res.ret !== 0) {
          log.warn(`拉取消息失败: ${res.errmsg || JSON.stringify(res)}`);
          await sleep(5000);
          continue;
        }

        if (res.get_updates_buf) {
          this.syncBuf = res.get_updates_buf;
          await this.saveSyncBuf();
        }

        if (res.msgs && res.msgs.length > 0) {
          for (const msg of res.msgs) {
            const content = this.extractContent(msg);
            if (!content || !msg.from_user_id) continue;

            // Download media: resolve encrypt_query_param → base64 data URL
            const resolvedMedia: MediaAttachment[] = [];
            for (const m of content.media) {
              if (m.url && !m.url.startsWith("data:")) {
                // Find the matching item to get aeskey
                const encryptParam = m.url;
                const item = msg.item_list?.find((i) =>
                  i.image_item?.media?.encrypt_query_param === encryptParam
                  || i.voice_item?.media?.encrypt_query_param === encryptParam
                  || i.file_item?.media?.encrypt_query_param === encryptParam
                  || i.video_item?.media?.encrypt_query_param === encryptParam,
                );

                // For images: prefer image_item.aeskey (hex), fallback to media.aes_key (base64)
                let aeskey: string | undefined;
                if (item?.image_item?.aeskey) {
                  aeskey = item.image_item.aeskey;  // hex format
                } else if (item?.image_item?.media?.aes_key) {
                  aeskey = `base64:${item.image_item.media.aes_key}`;
                } else if (item?.voice_item?.media?.aes_key) {
                  aeskey = `base64:${item.voice_item.media.aes_key}`;
                } else if (item?.file_item?.media?.aes_key) {
                  aeskey = `base64:${item.file_item.media.aes_key}`;
                } else if (item?.video_item?.media?.aes_key) {
                  aeskey = `base64:${item.video_item.media.aes_key}`;
                }

                log.debug(`下载媒体 type=${m.type}, aeskey=${aeskey ? "有" : "无"}`);
                const dataUrl = await this.downloadMedia("", aeskey, encryptParam);
                if (dataUrl) {
                  m.url = dataUrl;
                  resolvedMedia.push(m);
                } else {
                  log.warn(`媒体下载失败，跳过`);
                }
              } else {
                resolvedMedia.push(m);
              }
            }
            content.media = resolvedMedia;

            const mediaInfo = content.media.length > 0
              ? ` +${content.media.map((m) => m.type).join(",")}`
              : "";
            log.info(`收到消息 [${maskId(msg.from_user_id)}]: ${content.text.slice(0, 50)}${mediaInfo}`);
            // Save context_token for startup greeting
            if (msg.context_token && msg.from_user_id) {
              this.lastTokens.set(msg.from_user_id, msg.context_token);
              this.saveLastTokens();
            }

            // Send greeting + guide on first message after startup
            if (msg.context_token) {
              await this.maybeSendGreetingAndGuide(msg.from_user_id, msg.context_token);
            }

            // Persist inbound images to local files so the bot model can reference them by path
            const persistedPaths = await persistImagesToFiles(content.media);
            let inboundText = content.text;
            if (persistedPaths.length > 0) {
              inboundText += `\n\n[附带媒体文件]\n${persistedPaths.map((p) => `- ${p}`).join("\n")}`;
            }

            onMessage({
              id: String(msg.message_id || msg.seq || Date.now()),
              channel: "weixin",
              senderId: msg.from_user_id,
              text: inboundText,
              media: content.media.length > 0 ? content.media : undefined,
              isVoice: content.isVoice || undefined,
              replyToken: msg.context_token,
              timestamp: msg.create_time_ms || Date.now(),
            });
          }
        }
      } catch (err) {
        if (!this.running) break;
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("aborted") || message.includes("AbortError")) continue;
        log.error(`轮询出错: ${message}`);
        await sleep(3000);
      }
    }
  }

  // ── Send typing indicator ──

  async sendTyping(userId: string, contextToken?: string): Promise<void> {
    if (!this.account) return;

    try {
      // Get typing_ticket if not cached
      let ticket = this.typingTickets.get(userId);
      if (!ticket) {
        const configRes = await this.api(this.account.baseUrl, "ilink/bot/getconfig", {
          ilink_user_id: userId,
          context_token: contextToken,
          base_info: { channel_version: CHANNEL_VERSION },
        }, { timeout: 10_000 });

        ticket = configRes.typing_ticket;
        if (ticket) {
          this.typingTickets.set(userId, ticket);
        }
      }

      if (!ticket) return;

      await this.api(this.account.baseUrl, "ilink/bot/sendtyping", {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: 1,
        base_info: { channel_version: CHANNEL_VERSION },
      }, { timeout: 10_000 });

      log.debug(`已发送输入状态给 ${maskId(userId)}`);
    } catch {
      // typing 失败不影响主流程
    }
  }

  // ── Send message ──

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.account) throw new Error("未登录");

    // Try sending voice if audio buffer is provided
    if (msg.voice) {
      const sent = await this.sendVoice(msg.targetId, msg.voice, msg.replyToken);
      if (sent) return;
      log.warn("语音发送失败，降级为文本");
    }

    // Handle image media attachments
    const imageMedia = msg.media?.filter((m) => m.type === "image");
    if (imageMedia?.length) {
      for (const img of imageMedia) {
        try {
          const buffer = await this.resolveMediaBuffer(img);
          if (!buffer) {
            log.warn("图片解析失败，跳过");
            continue;
          }
          const uploaded = await this.uploadToWeixin(buffer, msg.targetId, UploadMediaType.IMAGE);
          await this.sendImageMessage(msg.targetId, uploaded, msg.text, msg.replyToken);
          // Image sent with caption, clear text to avoid duplicate
          msg = { ...msg, text: "" };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`图片发送失败: ${errMsg}`);
        }
      }
      // If text was consumed as caption, return
      if (!msg.text) return;
    }

    // Handle video media attachments
    const videoMedia = msg.media?.filter((m) => m.type === "video");
    if (videoMedia?.length) {
      for (const vid of videoMedia) {
        try {
          const buffer = await this.resolveMediaBuffer(vid);
          if (!buffer) {
            log.warn("视频解析失败，跳过");
            continue;
          }
          const uploaded = await this.uploadToWeixin(buffer, msg.targetId, UploadMediaType.VIDEO);
          await this.sendVideoMessage(msg.targetId, uploaded, msg.text, msg.replyToken);
          msg = { ...msg, text: "" };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`视频发送失败: ${errMsg}`);
        }
      }
      if (!msg.text) return;
    }

    // Handle file media attachments
    const fileMedia = msg.media?.filter((m) => m.type === "file");
    if (fileMedia?.length) {
      for (const f of fileMedia) {
        try {
          const buffer = await this.resolveMediaBuffer(f);
          if (!buffer) {
            log.warn("文件解析失败，跳过");
            continue;
          }
          const uploaded = await this.uploadToWeixin(buffer, msg.targetId, UploadMediaType.FILE);
          await this.sendFileMessage(msg.targetId, uploaded, f.fileName || "file", msg.text, msg.replyToken);
          msg = { ...msg, text: "" };
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`文件发送失败: ${errMsg}`);
        }
      }
      if (!msg.text) return;
    }

    const chunks = this.chunkText(msg.text, 4000);

    for (const chunk of chunks) {
      const body = {
        msg: {
          from_user_id: "",
          to_user_id: msg.targetId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: msg.replyToken || undefined,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      };

      const res = await this.api(
        this.account.baseUrl,
        "ilink/bot/sendmessage",
        body,
        { timeout: API_TIMEOUT_MS },
      );

      if (res.ret && res.ret !== 0) {
        log.error(`发送失败: ret=${res.ret} ${res.errmsg || JSON.stringify(res)}`);
      } else {
        log.info(`文本已发送 (${chunk.length} 字符) → ${maskId(msg.targetId)}`);
      }
    }
  }

  /** Upload voice via CDN and send as voice message */
  private async sendVoice(targetId: string, audio: Buffer, replyToken?: string): Promise<boolean> {
    if (!this.account) return false;

    try {
      // 微信 CDN 语音通道只接收 SILK_V3，先转码
      const silk = await encodeToSilk(audio);
      if (!silk) {
        log.warn("SILK 转码失败（缺少 ffmpeg？），跳过语音发送");
        return false;
      }

      const uploaded = await this.uploadToWeixin(silk.data, targetId, UploadMediaType.VOICE);

      const playtime = silk.duration;
      const body = {
        msg: {
          from_user_id: "",
          to_user_id: targetId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: replyToken || undefined,
          item_list: [{
            type: MessageItemType.VOICE,
            voice_item: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
                encrypt_type: 1,
              },
              encode_type: 4, // silk_v3
              playtime,
            },
          }],
        },
        base_info: { channel_version: CHANNEL_VERSION },
      };

      const res = await this.api(
        this.account.baseUrl,
        "ilink/bot/sendmessage",
        body,
        { timeout: API_TIMEOUT_MS },
      );

      if (res.ret && res.ret !== 0) {
        log.error(`语音发送失败: ${res.errmsg || JSON.stringify(res)}`);
        return false;
      }

      log.debug(`语音消息已发送 (${playtime}ms)`);
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`语音发送异常: ${errMsg}`);
      return false;
    }
  }

  /** Get CDN upload URL from Weixin API */
  private async getUploadUrl(params: {
    filekey: string;
    mediaType: number;
    toUserId: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  }): Promise<{ upload_full_url?: string; upload_param?: string }> {
    if (!this.account) throw new Error("未登录");

    const res = await this.api(this.account.baseUrl, "ilink/bot/getuploadurl", {
      filekey: params.filekey,
      media_type: params.mediaType,
      to_user_id: params.toUserId,
      rawsize: params.rawsize,
      rawfilemd5: params.rawfilemd5,
      filesize: params.filesize,
      no_need_thumb: true,
      aeskey: params.aeskey,
      base_info: { channel_version: CHANNEL_VERSION },
    }, { timeout: API_TIMEOUT_MS });

    if (res.ret && res.ret !== 0) {
      throw new Error(`getUploadUrl 失败: ${res.errmsg || JSON.stringify(res)}`);
    }

    return {
      upload_full_url: res.upload_full_url,
      upload_param: res.upload_param,
    };
  }

  /** Upload encrypted buffer to WeChat CDN, returns download encrypted param */
  private async uploadBufferToCdn(params: {
    buf: Buffer;
    uploadFullUrl?: string;
    uploadParam?: string;
    filekey: string;
    aeskey: Buffer;
    label: string;
  }): Promise<{ downloadParam: string }> {
    const { buf, uploadFullUrl, uploadParam, filekey, aeskey, label } = params;
    const ciphertext = encryptAesEcb(buf, aeskey);

    let cdnUrl: string;
    if (uploadFullUrl?.trim()) {
      cdnUrl = uploadFullUrl.trim();
    } else if (uploadParam) {
      cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
    } else {
      throw new Error(`${label}: CDN upload URL missing`);
    }

    log.debug(`${label}: CDN POST ciphertextSize=${ciphertext.length}`);

    const res = await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
      throw new Error(`${label}: CDN upload failed ${res.status}: ${errMsg}`);
    }

    const downloadParam = res.headers.get("x-encrypted-param");
    if (!downloadParam) {
      throw new Error(`${label}: CDN response missing x-encrypted-param`);
    }

    log.debug(`${label}: CDN upload success`);
    return { downloadParam };
  }

  /** Send an image message using a previously uploaded file */
  private async sendImageMessage(
    to: string,
    uploaded: UploadedFileInfo,
    text: string,
    replyToken?: string,
  ): Promise<void> {
    // Send text caption first if present
    if (text?.trim()) {
      await this.sendTextItem(to, text.trim(), replyToken);
    }

    // Send image item
    const imageItem = {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: uploaded.downloadEncryptedQueryParam,
          aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
          encrypt_type: 1,
        },
        mid_size: uploaded.fileSizeCiphertext,
      },
    };

    const body = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: replyToken || undefined,
        item_list: [imageItem],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };

    const res = await this.api(
      this.account!.baseUrl,
      "ilink/bot/sendmessage",
      body,
      { timeout: API_TIMEOUT_MS },
    );

    if (res.ret && res.ret !== 0) {
      log.error(`图片发送失败: ${res.errmsg || JSON.stringify(res)}`);
    } else {
      log.info(`图片已发送 → ${maskId(to)} (${uploaded.fileSize} bytes)`);
    }
  }

  /** Send a single text item message */
  private async sendTextItem(to: string, text: string, replyToken?: string): Promise<void> {
    if (!this.account) return;
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: replyToken || undefined,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };

    await this.api(this.account.baseUrl, "ilink/bot/sendmessage", body, { timeout: API_TIMEOUT_MS });
  }

  /** Generic CDN upload pipeline for any media type (image/video/file/voice) */
  private async uploadToWeixin(
    buffer: Buffer,
    toUserId: string,
    mediaType: number,
  ): Promise<UploadedFileInfo> {
    if (!this.account) throw new Error("未登录");

    const rawsize = buffer.length;
    const rawfilemd5 = createHash("md5").update(buffer).digest("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString("hex");
    const aeskey = randomBytes(16);

    log.debug(`uploadToWeixin: mediaType=${mediaType} rawsize=${rawsize} filesize=${filesize}`);

    const uploadUrlResp = await this.getUploadUrl({
      filekey,
      mediaType,
      toUserId,
      rawsize,
      rawfilemd5,
      filesize,
      aeskey: aeskey.toString("hex"),
    });

    const { downloadParam } = await this.uploadBufferToCdn({
      buf: buffer,
      uploadFullUrl: uploadUrlResp.upload_full_url,
      uploadParam: uploadUrlResp.upload_param,
      filekey,
      aeskey,
      label: `uploadMedia(type=${mediaType})`,
    });

    return {
      filekey,
      downloadEncryptedQueryParam: downloadParam,
      aeskey: aeskey.toString("hex"),
      fileSize: rawsize,
      fileSizeCiphertext: filesize,
    };
  }

  /** Send a video message using a previously uploaded file */
  private async sendVideoMessage(
    to: string,
    uploaded: UploadedFileInfo,
    text: string,
    replyToken?: string,
  ): Promise<void> {
    if (text?.trim()) {
      await this.sendTextItem(to, text.trim(), replyToken);
    }

    const body = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: replyToken || undefined,
        item_list: [{
          type: MessageItemType.VIDEO,
          video_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
              encrypt_type: 1,
            },
            video_size: uploaded.fileSizeCiphertext,
          },
        }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };

    const res = await this.api(
      this.account!.baseUrl,
      "ilink/bot/sendmessage",
      body,
      { timeout: API_TIMEOUT_MS },
    );

    if (res.ret && res.ret !== 0) {
      log.error(`视频发送失败: ${res.errmsg || JSON.stringify(res)}`);
    } else {
      log.info(`视频已发送 → ${maskId(to)} (${uploaded.fileSize} bytes)`);
    }
  }

  /** Send a file attachment message using a previously uploaded file */
  private async sendFileMessage(
    to: string,
    uploaded: UploadedFileInfo,
    fileName: string,
    text: string,
    replyToken?: string,
  ): Promise<void> {
    if (text?.trim()) {
      await this.sendTextItem(to, text.trim(), replyToken);
    }

    const body = {
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: replyToken || undefined,
        item_list: [{
          type: MessageItemType.FILE,
          file_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
              encrypt_type: 1,
            },
            file_name: fileName,
            len: String(uploaded.fileSize),
          },
        }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    };

    const res = await this.api(
      this.account!.baseUrl,
      "ilink/bot/sendmessage",
      body,
      { timeout: API_TIMEOUT_MS },
    );

    if (res.ret && res.ret !== 0) {
      log.error(`文件发送失败: ${res.errmsg || JSON.stringify(res)}`);
    } else {
      log.info(`文件已发送 → ${maskId(to)} (${fileName}, ${uploaded.fileSize} bytes)`);
    }
  }

  /** Resolve media data from various sources to a Buffer */
  private async resolveMediaBuffer(media: MediaAttachment): Promise<Buffer | null> {
    try {
      if (media.url?.startsWith("data:")) {
        // data URL: extract base64 payload
        const match = media.url.match(/^data:[^;]+;base64,(.+)$/s);
        if (match?.[1]) {
          return Buffer.from(match[1], "base64");
        }
      }

      if (media.url?.startsWith("http://") || media.url?.startsWith("https://")) {
        // Remote URL: download
        log.debug(`下载远程图片: ${media.url.slice(0, 80)}...`);
        const res = await fetch(media.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) {
          log.error(`下载图片失败: ${res.status}`);
          return null;
        }
        return Buffer.from(await res.arrayBuffer());
      }

      if (media.path || (media.url && !media.url.includes("://"))) {
        // Local file path
        const filePath = media.path || media.url!;
        log.debug(`读取本地图片: ${filePath}`);
        const { readFile: readFileFs } = await import("node:fs/promises");
        return await readFileFs(filePath);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`解析图片失败: ${errMsg}`);
    }
    return null;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    log.info("已停止");
  }

  // ── Internal ──

  private async getUpdates(): Promise<GetUpdatesResponse> {
    if (!this.account) throw new Error("未登录");

    return this.api(this.account.baseUrl, "ilink/bot/getupdates", {
      get_updates_buf: this.syncBuf,
      base_info: { channel_version: CHANNEL_VERSION },
    }, { timeout: 50_000 });
  }

  /** Download media from WeChat CDN, decrypt, and return as base64 data URL */
  async downloadMedia(_mediaId: string, aeskey?: string, encryptParam?: string): Promise<string | null> {
    if (!encryptParam) {
      log.warn("媒体缺少 encrypt_query_param，无法下载");
      return null;
    }

    try {
      // Build CDN download URL
      const cdnUrl = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptParam)}`;
      log.debug(`下载媒体: ${cdnUrl.slice(0, 80)}...`);

      const res = await fetch(cdnUrl, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        log.error(`CDN 下载失败: ${res.status} ${res.statusText}`);
        return null;
      }

      let buffer = Buffer.from(await res.arrayBuffer());
      log.debug(`CDN 下载完成: ${buffer.length} bytes`);

      // Decrypt with AES-128-ECB if aeskey is provided
      if (aeskey) {
        try {
          let key: Buffer;
          if (aeskey.startsWith("base64:")) {
            // base64-encoded key (from media.aes_key)
            const decoded = Buffer.from(aeskey.slice(7), "base64");
            // Could be raw 16 bytes or hex string of 32 chars
            if (decoded.length === 16) {
              key = decoded;
            } else if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
              key = Buffer.from(decoded.toString("ascii"), "hex");
            } else {
              throw new Error(`unexpected aes_key length: ${decoded.length}`);
            }
          } else {
            // hex-encoded key (from image_item.aeskey)
            key = Buffer.from(aeskey, "hex");
          }
          const decipher = createDecipheriv("aes-128-ecb", key, null);
          buffer = Buffer.concat([decipher.update(buffer), decipher.final()]);
          log.debug(`AES 解密完成: ${buffer.length} bytes`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn(`AES 解密失败 (尝试使用原始数据): ${errMsg}`);
        }
      }

      // Detect content type from magic bytes
      const contentType = detectImageType(buffer);
      const base64 = buffer.toString("base64");
      return `data:${contentType};base64,${base64}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`媒体下载失败: ${errMsg}`);
      return null;
    }
  }

  private extractContent(msg: WeixinMessage): { text: string; media: MediaAttachment[]; isVoice: boolean } | null {
    if (!msg.item_list?.length) return null;

    const texts: string[] = [];
    const media: MediaAttachment[] = [];
    let isVoice = false;

    for (const item of msg.item_list) {
      switch (item.type) {
        case MessageItemType.TEXT:
          if (item.text_item?.text) texts.push(item.text_item.text);
          break;
        case MessageItemType.IMAGE: {
          const img = item.image_item;
          if (img?.media?.encrypt_query_param) {
            // Use encrypt_query_param as the "url" key — downloadMedia resolves it
            media.push({ type: "image", url: img.media.encrypt_query_param });
          }
          break;
        }
        case MessageItemType.VOICE: {
          isVoice = true;
          const voice = item.voice_item;
          // WeChat may provide voice-to-text directly
          if (voice?.text) {
            texts.push(voice.text);
            log.debug(`语音自带转文字: "${voice.text.slice(0, 50)}"`);
          } else if (voice?.media?.encrypt_query_param) {
            media.push({ type: "voice", url: voice.media.encrypt_query_param });
          }
          break;
        }
        case MessageItemType.FILE: {
          const file = item.file_item;
          if (file?.media?.encrypt_query_param) {
            media.push({ type: "file", url: file.media.encrypt_query_param, fileName: file.file_name });
          }
          break;
        }
        case MessageItemType.VIDEO: {
          const video = item.video_item;
          if (video?.media?.encrypt_query_param) {
            media.push({ type: "video", url: video.media.encrypt_query_param });
          }
          break;
        }
      }
    }

    if (texts.length === 0 && media.length === 0) return null;
    const text = texts.join("\n") || (media.length > 0 ? "[媒体消息]" : "");

    return { text, media: media.length > 0 ? media : [], isVoice };
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

  private async api(
    baseUrl: string,
    path: string,
    body: unknown,
    opts: { method?: string; timeout?: number } = {},
  ): Promise<any> {
    const url = `${baseUrl.replace(/\/$/, "")}/${path}`;
    const method = opts.method || "POST";
    const bodyStr = body ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.account?.token) {
      headers["AuthorizationType"] = "ilink_bot_token";
      headers["Authorization"] = `Bearer ${this.account.token}`;
      headers["X-WECHAT-UIN"] = randomUin();
      // openclaw-compatible headers (required for VIDEO/FILE/VOICE sending)
      headers["iLink-App-Id"] = ILINK_APP_ID;
      headers["iLink-App-ClientVersion"] = String(ILINK_APP_CLIENT_VERSION);
      if (bodyStr) {
        headers["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf-8"));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || API_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });
      if (!res.ok) {
        log.warn(`HTTP ${res.status} ${res.statusText} ← ${path}`);
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        log.warn(`非 JSON 响应 ← ${path}: ${text.slice(0, 200)}`);
        return { ret: -999, errmsg: `HTTP ${res.status}: ${text.slice(0, 100)}` };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Persistence ──

  private accountFile(): string {
    return join(getAccountsDir(), "weixin.json");
  }

  private syncFile(): string {
    return join(getAccountsDir(), "weixin-sync.json");
  }

  private async saveAccount(): Promise<void> {
    await ensureDir(getAccountsDir());
    await writeFile(this.accountFile(), JSON.stringify(this.account, null, 2));
  }

  private async loadAccount(): Promise<void> {
    const path = this.accountFile();
    if (!existsSync(path)) return;
    try {
      const raw = await readFile(path, "utf-8");
      this.account = JSON.parse(raw);
      log.debug(`已加载账号: ${maskId(this.account!.accountId)}`);
    } catch {
      log.warn("加载账号失败");
    }
  }

  private async clearAccount(): Promise<void> {
    for (const file of [this.accountFile(), this.syncFile()]) {
      if (existsSync(file)) {
        await unlink(file);
      }
    }
    // Clear tokens (old session tokens won't work after re-scan)
    // Clear guide-sent so all users receive the guide again
    for (const f of ["weixin-tokens.json", "weixin-guide-sent.json"]) {
      const p = join(getAccountsDir(), f);
      if (existsSync(p)) await unlink(p);
    }
    this.guideSentCache.clear();
  }


  private async saveSyncBuf(): Promise<void> {
    await ensureDir(getAccountsDir());
    await writeFile(this.syncFile(), JSON.stringify({ get_updates_buf: this.syncBuf }));
  }

  private async loadSyncBuf(): Promise<void> {
    const path = this.syncFile();
    if (!existsSync(path)) return;
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw);
      this.syncBuf = data.get_updates_buf || "";
    } catch {
      // fresh start
    }
  }

  // ── Startup greeting ──

  private guideSentFile(): string {
    return join(getAccountsDir(), "weixin-guide-sent.json");
  }

  private async loadGuideSent(): Promise<Set<string>> {
    const path = this.guideSentFile();
    if (!existsSync(path)) return new Set();
    try {
      const raw = await readFile(path, "utf-8");
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  }

  private async saveGuideSent(sent: Set<string>): Promise<void> {
    await ensureDir(getAccountsDir());
    await writeFile(this.guideSentFile(), JSON.stringify([...sent]));
  }

  /** Check if any provider has a usable API key configured */
  private async checkModelConfigured(): Promise<boolean> {
    try {
      const config = await loadConfig();
      for (const prov of Object.values(config.providers)) {
        if (prov.apiKey) return true;
        const envKey = (prov as Record<string, unknown>).apiKeyEnv as string | undefined;
        if (envKey && process.env[envKey]) return true;
        if (prov.type === "claude-agent") {
          if (existsSync(join(homedir(), ".claude")) || process.env.ANTHROPIC_API_KEY) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Get model setup hint text (sent when no model is configured) */
  private getModelSetupHint(): string {
    const configPath = join(homedir(), ".skychat-ai", "config.json");
    return [
      "⚠️ 尚未配置 AI 模型，无法正常对话",
      "",
      "请在终端执行以下命令设置模型 API Key:",
      "  skychat-ai set qwen <你的Key>",
      "  skychat-ai set deepseek <你的Key>",
      "  skychat-ai set gpt <你的Key>",
      "",
      "设置默认模型:",
      "  skychat-ai use qwen",
      "",
      `📁 配置文件: ${configPath}`,
      "",
      "获取 API Key:",
      "  通义千问: dashscope.console.aliyun.com",
      "  DeepSeek: platform.deepseek.com",
      "  OpenAI: platform.openai.com",
      "",
      "设置完成后重新发消息即可开始对话",
    ].join("\n");
  }

  private getGuideText(): string {
    return [
      "📌 快捷指南:",
      "直接发消息即可对话",
      "",
      "切换模型:",
      "/cc → Claude  /qwen /deepseek /gpt",
      "",
      "第三方模型 (需先配置 OpenRouter Key):",
      "/model google/gemini-2.5-pro",
      "/model anthropic/claude-sonnet-4",
      "",
      "/help 查看全部指令",
      "@指南 重新查看本指南",
    ].join("\n");
  }

  /** Send greeting + guide to user on their first message (if not sent before) */
  private async maybeSendGreetingAndGuide(userId: string, token: string): Promise<void> {
    // In-memory fast check
    if (this.startupGreetingSent && this.guideSentCache.has(userId)) return;

    try {
      // Send greeting if startup greeting wasn't sent proactively
      if (!this.startupGreetingSent) {
        await this.send({
          targetId: userId,
          text: "Hey! I'm back online and ready to chat. Send me a message anytime! 👋",
          replyToken: token,
        });
        this.startupGreetingSent = true;
        await new Promise((r) => setTimeout(r, 500));
      }

      // If no model configured, send setup hint instead of normal guide
      if (this.noModelConfigured) {
        if (!this.guideSentCache.has(userId)) {
          await this.send({ targetId: userId, text: this.getModelSetupHint(), replyToken: token });
          this.guideSentCache.add(userId);
          const guideSent = await this.loadGuideSent();
          guideSent.add(userId);
          await this.saveGuideSent(guideSent);
          log.debug(`已发送模型配置提示给 ${maskId(userId)}`);
        }
        return;
      }

      // Send guide if not sent before
      if (!this.guideSentCache.has(userId)) {
        const guideSent = await this.loadGuideSent();
        if (!guideSent.has(userId)) {
          await this.send({ targetId: userId, text: this.getGuideText(), replyToken: token });
          guideSent.add(userId);
          await this.saveGuideSent(guideSent);
          log.debug(`已发送指南给 ${maskId(userId)}`);
        }
        this.guideSentCache.add(userId);
      }
    } catch {
      log.warn(`发送问候/指南失败 ${maskId(userId)}`);
    }
  }

  private async sendStartupGreeting(): Promise<void> {
    if (this.lastTokens.size === 0) {
      log.debug("无已保存的用户 token，跳过启动问候 (用户发消息时会补发指南)");
      return;
    }

    const greeting = "Hey! I'm back online and ready to chat. Send me a message anytime! 👋";
    const guideSent = await this.loadGuideSent();
    log.debug(`发送启动问候给 ${this.lastTokens.size} 个用户...`);

    for (const [userId, token] of this.lastTokens) {
      try {
        await this.send({ targetId: userId, text: greeting, replyToken: token });
        // Send model setup hint or normal guide
        if (!guideSent.has(userId)) {
          await new Promise((r) => setTimeout(r, 500));
          const text = this.noModelConfigured ? this.getModelSetupHint() : this.getGuideText();
          await this.send({ targetId: userId, text, replyToken: token });
          guideSent.add(userId);
          this.guideSentCache.add(userId);
        }
        log.debug(`已问候 ${maskId(userId)}`);
      } catch {
        log.warn(`问候失败 ${maskId(userId)} (token 可能过期)`);
      }
    }

    await this.saveGuideSent(guideSent);
    this.startupGreetingSent = true;
  }

  // ── Last token persistence ──

  private lastTokensFile(): string {
    return join(getAccountsDir(), "weixin-tokens.json");
  }

  private async saveLastTokens(): Promise<void> {
    try {
      await ensureDir(getAccountsDir());
      const data = Object.fromEntries(this.lastTokens);
      await writeFile(this.lastTokensFile(), JSON.stringify(data));
    } catch {
      // non-critical
    }
  }

  private async loadLastTokens(): Promise<void> {
    const path = this.lastTokensFile();
    if (!existsSync(path)) return;
    try {
      const raw = await readFile(path, "utf-8");
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data)) {
        if (typeof v === "string") this.lastTokens.set(k, v);
      }
      log.debug(`已加载 ${this.lastTokens.size} 个用户 token`);
    } catch {
      // fresh start
    }
  }
}

// ── Helpers ──

function randomUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function generateClientId(): string {
  return `wai-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function detectImageType(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49) return "image/webp";
  return "image/jpeg"; // default
}

/** Persist inbound image data-URLs to local files; returns absolute paths */
async function persistImagesToFiles(media: MediaAttachment[]): Promise<string[]> {
  const paths: string[] = [];
  const imageItems = media.filter((m) => m.type === "image" && m.url?.startsWith("data:"));
  if (imageItems.length === 0) return paths;

  try {
    await ensureDir(INBOUND_DIR);
    for (const m of imageItems) {
      const match = m.url!.match(/^data:([^;]+);base64,(.+)$/s);
      if (!match) continue;
      const mime = match[1]!;
      const ext = mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("webp") ? "webp" : "jpg";
      const filename = `wx_inbound_${Date.now()}_${randomBytes(4).toString("hex")}.${ext}`;
      const fullPath = join(INBOUND_DIR, filename);
      await writeFile(fullPath, Buffer.from(match[2]!, "base64"));
      paths.push(fullPath);
      log.debug(`已落盘图片: ${fullPath}`);
    }
  } catch (err) {
    log.warn(`图片落盘失败: ${err instanceof Error ? err.message : err}`);
  }

  return paths;
}
