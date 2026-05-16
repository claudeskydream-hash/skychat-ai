/**
 * skychat-ai send — 独立发送媒体文件到微信
 *
 * 支持发送：视频、音乐/语音、文件、图片
 * 自动检测媒体类型（按文件扩展名），也可手动指定
 */

import { readFileSync, existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomBytes, randomUUID, createHash, createCipheriv } from "node:crypto";
import { getAccountsDir } from "./config.js";
import { encodeToSilk, type SilkAudio } from "./voice-encode.js";

// ── 常量 ──

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "2.1.6";
const ILINK_APP_ID = "bot";
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (1 << 8) | 6; // 131334
const API_TIMEOUT_MS = 15_000;

const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"];
const VIDEO_EXTS = ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "ts", "mpg", "mpeg", "3gp"];
const VOICE_EXTS = ["mp3", "wav", "m4a", "ogg", "flac", "aac", "silk", "wma", "opus"];
const ALL_MEDIA_EXTS = [...IMAGE_EXTS, ...VIDEO_EXTS, ...VOICE_EXTS];

// ── 类型 ──

interface WeixinAccount {
  accountId: string;
  token: string;
  baseUrl: string;
  userId?: string;
}

export interface SendMediaOptions {
  /** 要发送的文件路径 */
  filePath: string;
  /** 目标微信用户 ID */
  toUserId: string;
  /** 媒体类型：auto 自动检测，或手动指定 image/video/voice/file */
  mediaType?: "auto" | "image" | "video" | "voice" | "file";
  /** 可选文字说明 */
  caption?: string;
  /** 进度回调 */
  onProgress?: (stage: string) => void;
}

export interface SendMediaResult {
  success: boolean;
  filePath: string;
  mediaType: string;
  fileSize: number;
  error?: string;
}

// ── AES-ECB 辅助 ──

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

// ── 工具函数 ──

function randomUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function generateClientId(): string {
  return `wai-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** 屏蔽用户 ID：a859bd6ccf43@im.bot → a859****bot */
function maskId(id: string): string {
  if (id.length <= 6) return id;
  return id.slice(0, 4) + "****" + id.slice(-3);
}

/** 根据文件扩展名检测媒体类型 */
export function detectMediaType(filePath: string): number {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  if (IMAGE_EXTS.includes(ext)) return UploadMediaType.IMAGE;
  if (VIDEO_EXTS.includes(ext)) return UploadMediaType.VIDEO;
  if (VOICE_EXTS.includes(ext)) return UploadMediaType.VOICE;
  return UploadMediaType.FILE;
}

/** 获取媒体类型标签 */
function mediaTypeLabel(type: number): string {
  switch (type) {
    case UploadMediaType.IMAGE: return "图片";
    case UploadMediaType.VIDEO: return "视频";
    case UploadMediaType.VOICE: return "语音";
    case UploadMediaType.FILE: return "文件";
    default: return "未知";
  }
}

// ── 账号管理 ──

/** 加载微信账号 */
export function loadWeixinAccount(): WeixinAccount {
  const accountFile = join(getAccountsDir(), "weixin.json");
  if (!existsSync(accountFile)) {
    throw new Error("未登录微信，请先运行 skychat-ai 扫码登录");
  }
  const raw = readFileSync(accountFile, "utf-8");
  return JSON.parse(raw) as WeixinAccount;
}

/** 获取默认目标用户（从 tokens 文件读取最后联系的用户） */
export function getDefaultTargetUser(): string | null {
  const tokensFile = join(getAccountsDir(), "weixin-tokens.json");
  if (!existsSync(tokensFile)) return null;
  try {
    const data = JSON.parse(readFileSync(tokensFile, "utf-8"));
    const keys = Object.keys(data);
    return keys.length === 1 ? keys[0]! : null;
  } catch {
    return null;
  }
}

/** 获取所有已知用户 ID */
export function getKnownUsers(): string[] {
  const tokensFile = join(getAccountsDir(), "weixin-tokens.json");
  if (!existsSync(tokensFile)) return [];
  try {
    const data = JSON.parse(readFileSync(tokensFile, "utf-8"));
    return Object.keys(data);
  } catch {
    return [];
  }
}

// ── 微信 API 调用 ──

async function weixinApi(
  account: WeixinAccount,
  path: string,
  body: unknown,
  opts: { method?: string; timeout?: number } = {},
): Promise<any> {
  const url = `${account.baseUrl.replace(/\/$/, "")}/${path}`;
  const method = opts.method || "POST";
  const bodyStr = body ? JSON.stringify(body) : undefined;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "Authorization": `Bearer ${account.token}`,
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
  if (bodyStr) headers["Content-Length"] = String(Buffer.byteLength(bodyStr, "utf-8"));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout || API_TIMEOUT_MS);

  try {
    const res = await fetch(url, { method, headers, body: bodyStr, signal: controller.signal });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ret: -999, errmsg: `HTTP ${res.status}: ${text.slice(0, 200)}` }; }
  } finally { clearTimeout(timer); }
}

// ── CDN 上传管线 ──

async function getUploadUrl(
  account: WeixinAccount,
  params: {
    filekey: string; mediaType: number; toUserId: string;
    rawsize: number; rawfilemd5: string; filesize: number; aeskey: string;
  },
): Promise<{ upload_full_url?: string; upload_param?: string }> {
  const res = await weixinApi(account, "ilink/bot/getuploadurl", {
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
    throw new Error(`获取上传地址失败: ${res.errmsg || JSON.stringify(res)}`);
  }
  return { upload_full_url: res.upload_full_url, upload_param: res.upload_param };
}

async function uploadBufferToCdn(
  buf: Buffer,
  uploadFullUrl: string | undefined,
  uploadParam: string | undefined,
  filekey: string,
  aeskey: Buffer,
  label: string,
): Promise<string> {
  const ciphertext = encryptAesEcb(buf, aeskey);

  let cdnUrl: string;
  if (uploadFullUrl?.trim()) {
    cdnUrl = uploadFullUrl.trim();
  } else if (uploadParam) {
    cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  } else {
    throw new Error(`${label}: CDN 上传地址缺失`);
  }

  const res = await fetch(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errMsg = res.headers.get("x-error-message") ?? `status ${res.status}`;
    throw new Error(`${label}: CDN 上传失败 ${res.status}: ${errMsg}`);
  }

  const downloadParam = res.headers.get("x-encrypted-param");
  if (!downloadParam) throw new Error(`${label}: CDN 响应缺少 x-encrypted-param`);

  return downloadParam;
}

// ── 发送消息 ──

async function sendMediaMessage(
  account: WeixinAccount,
  toUserId: string,
  uploadResult: { filekey: string; downloadParam: string; aeskey: Buffer; fileSize: number; fileSizeCiphertext: number },
  mediaType: number,
  fileName: string,
  caption?: string,
  voiceDurationMs?: number,
): Promise<void> {
  // 先发送文字说明
  if (caption?.trim()) {
    await weixinApi(account, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: caption.trim() } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }, { timeout: API_TIMEOUT_MS });
  }

  // 构建媒体消息体
  const aesKeyBase64 = Buffer.from(uploadResult.aeskey.toString("hex")).toString("base64");
  let item: any;

  switch (mediaType) {
    case UploadMediaType.IMAGE:
      item = {
        type: MessageItemType.IMAGE,
        image_item: {
          media: {
            encrypt_query_param: uploadResult.downloadParam,
            aes_key: aesKeyBase64,
            encrypt_type: 1,
          },
          mid_size: uploadResult.fileSizeCiphertext,
        },
      };
      break;
    case UploadMediaType.VIDEO:
      item = {
        type: MessageItemType.VIDEO,
        video_item: {
          media: {
            encrypt_query_param: uploadResult.downloadParam,
            aes_key: aesKeyBase64,
            encrypt_type: 1,
          },
          video_size: uploadResult.fileSizeCiphertext,
        },
      };
      break;
    case UploadMediaType.VOICE: {
      // 时长以 silk 编码器返回为准；缺省时按 silk_v3 24kHz ≈ 25kbps 粗估
      const playtime = voiceDurationMs ?? Math.round((uploadResult.fileSize * 8) / 25000 * 1000);
      item = {
        type: MessageItemType.VOICE,
        voice_item: {
          media: {
            encrypt_query_param: uploadResult.downloadParam,
            aes_key: aesKeyBase64,
            encrypt_type: 1,
          },
          encode_type: 4, // silk_v3
          playtime,
        },
      };
      break;
    }
    case UploadMediaType.FILE:
    default:
      item = {
        type: MessageItemType.FILE,
        file_item: {
          media: {
            encrypt_query_param: uploadResult.downloadParam,
            aes_key: aesKeyBase64,
            encrypt_type: 1,
          },
          file_name: fileName,
          len: String(uploadResult.fileSize),
        },
      };
      break;
  }

  const res = await weixinApi(account, "ilink/bot/sendmessage", {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: generateClientId(),
      message_type: 2,
      message_state: 2,
      item_list: [item],
    },
    base_info: { channel_version: CHANNEL_VERSION },
  }, { timeout: API_TIMEOUT_MS });

  if (res.ret && res.ret !== 0) {
    throw new Error(`发送失败: ${res.errmsg || JSON.stringify(res)}`);
  }
}

// ── 主函数 ──

/** 发送单个媒体文件到微信 */
export async function sendMedia(options: SendMediaOptions): Promise<SendMediaResult> {
  const { filePath, toUserId, caption, onProgress } = options;

  try {
    // 加载账号
    onProgress?.("加载微信账号...");
    const account = loadWeixinAccount();

    // 验证文件
    if (!existsSync(filePath)) {
      return { success: false, filePath, mediaType: "unknown", fileSize: 0, error: `文件不存在: ${filePath}` };
    }

    // 检测媒体类型
    let mediaType = detectMediaType(filePath);
    if (options.mediaType && options.mediaType !== "auto") {
      const typeMap: Record<string, number> = {
        image: UploadMediaType.IMAGE,
        video: UploadMediaType.VIDEO,
        voice: UploadMediaType.VOICE,
        file: UploadMediaType.FILE,
      };
      mediaType = typeMap[options.mediaType] ?? UploadMediaType.FILE;
    }

    // 读取文件
    const stat = await import("node:fs/promises").then(m => m.stat(filePath));
    const fileSize = stat.size;
    onProgress?.(`读取文件 (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);
    const originalBuffer = await readFile(filePath);
    let buffer = originalBuffer;

    if (fileSize > 25 * 1024 * 1024) {
      onProgress?.(`⚠️ 文件较大 (${(fileSize / 1024 / 1024).toFixed(1)} MB)，上传可能需要一些时间...`);
    }

    // 语音：先转 SILK_V3（微信 CDN 拒收 mp3/wav/aac 等非 silk 格式）
    let voiceDurationMs: number | undefined;
    if (mediaType === UploadMediaType.VOICE) {
      onProgress?.("转码为 SILK_V3...");
      const silk: SilkAudio | null = await encodeToSilk(buffer);
      if (!silk) {
        return {
          success: false, filePath, mediaType: "语音", fileSize: 0,
          error: "SILK 转码失败（请确认已安装 ffmpeg 并加入 PATH）",
        };
      }
      buffer = silk.data;
      voiceDurationMs = silk.duration;
      onProgress?.(`SILK 编码完成 (${(buffer.length / 1024).toFixed(1)} KB, ${(silk.duration / 1000).toFixed(1)}s)`);
    }

    // 单次"上传 + 发消息"流程
    const uploadAndSend = async (
      payload: Buffer,
      mt: number,
      durMs: number | undefined,
    ): Promise<number> => {
      const rawsize = payload.length;
      const rawfilemd5 = createHash("md5").update(payload).digest("hex");
      const filesize = aesEcbPaddedSize(rawsize);
      const filekey = randomBytes(16).toString("hex");
      const aeskey = randomBytes(16);

      onProgress?.("获取上传地址...");
      const uploadUrlResp = await getUploadUrl(account, {
        filekey, mediaType: mt, toUserId, rawsize, rawfilemd5, filesize,
        aeskey: aeskey.toString("hex"),
      });

      onProgress?.(`上传到 CDN (${(filesize / 1024 / 1024).toFixed(2)} MB)...`);
      const downloadParam = await uploadBufferToCdn(
        payload, uploadUrlResp.upload_full_url, uploadUrlResp.upload_param,
        filekey, aeskey, mediaTypeLabel(mt),
      );

      onProgress?.("发送消息...");
      await sendMediaMessage(account, toUserId, {
        filekey, downloadParam, aeskey, fileSize: rawsize, fileSizeCiphertext: filesize,
      }, mt, basename(filePath), caption, durMs);

      return rawsize;
    };

    let finalMediaType = mediaType;
    let sentBytes: number;
    try {
      sentBytes = await uploadAndSend(buffer, mediaType, voiceDurationMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 微信 Bot 平台禁止 bot 发语音（CDN 永远返回 -5102019），降级为文件发送
      const isVoiceBlocked = mediaType === UploadMediaType.VOICE
        && /-5102019|CDN 上传失败 500/.test(msg);
      if (!isVoiceBlocked) throw err;

      onProgress?.("⚠️ 微信 Bot 平台拒收语音 (-5102019)，自动降级为文件发送...");
      finalMediaType = UploadMediaType.FILE;
      sentBytes = await uploadAndSend(originalBuffer, UploadMediaType.FILE, undefined);
    }

    onProgress?.(`✓ ${mediaTypeLabel(finalMediaType)}已发送 → ${maskId(toUserId)} (${(sentBytes / 1024 / 1024).toFixed(2)} MB)`);

    return { success: true, filePath, mediaType: mediaTypeLabel(finalMediaType), fileSize: sentBytes };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, filePath, mediaType: mediaTypeLabel(detectMediaType(filePath)), fileSize: 0, error: errorMsg };
  }
}

// ── 发送纯文字 ──

export interface SendTextOptions {
  /** 要发送的文字内容 */
  text: string;
  /** 目标微信用户 ID */
  toUserId: string;
}

export interface SendTextResult {
  success: boolean;
  error?: string;
}

/** 发送纯文字消息到微信 */
export async function sendText(options: SendTextOptions): Promise<SendTextResult> {
  const { text, toUserId } = options;

  try {
    const account = loadWeixinAccount();

    const res = await weixinApi(account, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: generateClientId(),
        message_type: 2,
        message_state: 2,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text: text.trim() } }],
      },
      base_info: { channel_version: CHANNEL_VERSION },
    }, { timeout: API_TIMEOUT_MS });

    if (res.ret && res.ret !== 0) {
      return { success: false, error: `发送失败: ${res.errmsg || JSON.stringify(res)}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 批量发送目录下的媒体文件 */
export async function sendAllMedia(
  dirPath: string,
  toUserId: string,
  opts?: {
    typeFilter?: "image" | "video" | "voice" | "file" | "auto";
    caption?: string;
    onProgress?: (stage: string) => void;
  },
): Promise<SendMediaResult[]> {
  const files = await readdir(dirPath);
  const results: SendMediaResult[] = [];

  // 按扩展名过滤
  const mediaFiles = files.filter(f => {
    const ext = f.toLowerCase().split(".").pop() ?? "";
    if (!ALL_MEDIA_EXTS.includes(ext)) return false;
    if (opts?.typeFilter && opts.typeFilter !== "auto") {
      const typeMap: Record<string, number> = {
        image: UploadMediaType.IMAGE,
        video: UploadMediaType.VIDEO,
        voice: UploadMediaType.VOICE,
        file: UploadMediaType.FILE,
      };
      const target = typeMap[opts.typeFilter];
      return detectMediaType(f) === target;
    }
    return true;
  });

  if (mediaFiles.length === 0) {
    opts?.onProgress?.("目录中没有找到可发送的媒体文件");
    return results;
  }

  opts?.onProgress?.(`找到 ${mediaFiles.length} 个文件，开始发送...`);

  for (let i = 0; i < mediaFiles.length; i++) {
    const f = mediaFiles[i]!;
    const fullPath = join(dirPath, f);
    opts?.onProgress?.(`\n[${i + 1}/${mediaFiles.length}] ${f}`);

    const result = await sendMedia({
      filePath: fullPath,
      toUserId,
      mediaType: opts?.typeFilter ?? "auto",
      caption: i === 0 ? opts?.caption : undefined,
      onProgress: opts?.onProgress,
    });
    results.push(result);
  }

  const success = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  opts?.onProgress?.(`\n✅ 完成: ${success} 成功${failed > 0 ? `, ${failed} 失败` : ""}`);

  return results;
}
