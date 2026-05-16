/**
 * 把任意常见音频 (mp3/wav/m4a/...) 转成微信语音所需的 SILK_V3 格式。
 *
 * 流程：input → ffmpeg → pcm_s16le mono @ 24000Hz → silk-wasm → silk_v3
 * 若输入已经是 silk，则直接返回（仅计算时长）。
 *
 * 需要系统已安装 ffmpeg。
 */

import { spawn } from "node:child_process";
import { createLogger } from "./logger.js";

const log = createLogger("voice-encode");

/** 微信语音 silk 采样率约定 */
const SILK_SAMPLE_RATE = 24000;

export interface SilkAudio {
  /** silk_v3 字节流 */
  data: Buffer<ArrayBuffer>;
  /** 真实时长 (ms) */
  duration: number;
}

/** ffmpeg 不可用时的错误码（用于上层做更友好的提示） */
export class FfmpegMissingError extends Error {
  constructor() {
    super("未找到 ffmpeg：发送语音需要先安装 ffmpeg 并加入 PATH");
    this.name = "FfmpegMissingError";
  }
}

/**
 * 把音频 buffer 编码为 SILK_V3。失败返回 null（调用方可降级为文件发送）。
 */
export async function encodeToSilk(audio: Buffer): Promise<SilkAudio | null> {
  const silk = await import("silk-wasm");

  // 已经是 silk：直接用
  if (silk.isSilk(audio)) {
    const duration = silk.getDuration(audio);
    log.debug(`输入已是 SILK 格式，跳过转码 (${duration}ms)`);
    return { data: toNonSharedBuffer(audio), duration };
  }

  // 转 PCM
  let pcm: Buffer;
  try {
    pcm = await ffmpegToPcm(audio);
  } catch (err) {
    if (err instanceof FfmpegMissingError) {
      log.error(err.message);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`ffmpeg 转 PCM 失败: ${msg}`);
    }
    return null;
  }

  // PCM → silk
  try {
    const result = await silk.encode(pcm, SILK_SAMPLE_RATE);
    log.debug(`SILK 编码完成: ${result.data.byteLength} bytes, ${result.duration}ms`);
    return { data: toNonSharedBuffer(result.data), duration: result.duration };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`silk-wasm 编码失败: ${msg}`);
    return null;
  }
}

/** 强制把 Uint8Array / Buffer 拷到一个 NonSharedBuffer（避免 SharedArrayBuffer 类型不兼容） */
function toNonSharedBuffer(src: Uint8Array): Buffer<ArrayBuffer> {
  const out = Buffer.alloc(src.byteLength);
  out.set(src);
  return out;
}

/** 调用 ffmpeg 把任意音频转成 16-bit 单声道 24000Hz 原始 PCM */
function ffmpegToPcm(audio: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      "-vn",                       // 丢弃 video（mp3 可能带封面）
      "-f", "s16le",
      "-acodec", "pcm_s16le",
      "-ac", "1",
      "-ar", String(SILK_SAMPLE_RATE),
      "pipe:1",
    ];

    let ff;
    try {
      ff = spawn("ffmpeg", args, { windowsHide: true });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return reject(new FfmpegMissingError());
      return reject(err);
    }

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.stderr.on("data", (c: Buffer) => errChunks.push(c));

    ff.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return reject(new FfmpegMissingError());
      reject(err);
    });

    ff.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        const errMsg = Buffer.concat(errChunks).toString("utf-8");
        reject(new Error(`ffmpeg 退出码 ${code}: ${errMsg.slice(0, 300).trim()}`));
      }
    });

    ff.stdin.on("error", () => { /* 由 close 事件统一汇报 */ });
    ff.stdin.end(audio);
  });
}
