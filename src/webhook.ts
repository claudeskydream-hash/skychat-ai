import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { getAccountsDir } from "./config.js";
import { createLogger } from "./logger.js";
import type { Channel, MediaAttachment, WaiConfig } from "./types.js";
import { sendMedia, uploadMediaToCdn } from "./send-media.js";

const log = createLogger("webhook");

interface WebhookSendRequest {
  channel?: string;
  targetId?: string;
  text?: string;
  media?: MediaAttachment[];
  filePath?: string;
  mediaType?: "auto" | "image" | "video" | "voice" | "file";
  caption?: string;
  asLink?: boolean;
  replyToken?: string;
}

export class WebhookServer {
  private server: Server | null = null;

  constructor(
    private readonly config: WaiConfig,
    private readonly getChannel: (name: string) => Channel | undefined,
  ) {}

  start(): void {
    const webhook = this.config.webhook;
    if (!webhook?.enabled) return;

    const host = webhook.host || "127.0.0.1";
    const port = webhook.port || 4800;

    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`请求处理失败: ${message}`);
        this.json(res, 500, { ok: false, error: message });
      });
    });

    this.server.on("error", (err) => {
      log.error(`启动失败: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.server.listen(port, host, () => {
      const authHint = webhook.secret ? "auth=on" : "auth=off";
      log.info(`已启动 http://${host}:${port} (${authHint})`);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log.info("已停止");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (method === "GET" && url.pathname === "/health") {
      this.json(res, 200, { ok: true });
      return;
    }

    if (!this.authorized(req)) {
      this.json(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    if (method === "GET" && url.pathname === "/targets") {
      this.json(res, 200, { ok: true, targets: getKnownWeixinUsers() });
      return;
    }

    if (method === "POST" && url.pathname === "/upload") {
      const body = await readJson<WebhookSendRequest>(req);
      const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
      if (!filePath) {
        this.json(res, 400, { ok: false, error: "filePath is required" });
        return;
      }
      const targetId = body.targetId || getDefaultWeixinUser();
      if (!targetId) {
        this.json(res, 400, {
          ok: false,
          error: "targetId is required when there is not exactly one known Weixin user",
        });
        return;
      }
      const traceId = newTraceId();
      log.info(`[media:${traceId}] webhook upload request file="${filePath}" type=${body.mediaType || "auto"} target=${maskId(targetId)}`);
      const uploaded = await uploadMediaToCdn({
        filePath,
        toUserId: targetId,
        mediaType: body.mediaType || "auto",
        traceId,
      });
      log.info(`[media:${traceId}] webhook upload response file="${uploaded.fileName}" size=${uploaded.fileSize}`);
      this.json(res, 200, { ok: true, targetId: maskId(targetId), upload: uploaded });
      return;
    }

    if (method !== "POST" || (url.pathname !== "/" && url.pathname !== "/send")) {
      this.json(res, 404, { ok: false, error: "Not found" });
      return;
    }

    const body = await readJson<WebhookSendRequest>(req);
    const channelName = body.channel || "weixin";
    const channel = this.getChannel(channelName);
    if (!channel) {
      this.json(res, 404, { ok: false, error: `Channel not found: ${channelName}` });
      return;
    }

    const text = typeof body.text === "string" ? body.text.trim() : "";
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    if (!text && !body.media?.length && !filePath) {
      this.json(res, 400, { ok: false, error: "text, media, or filePath is required" });
      return;
    }

    const targetId = body.targetId || getDefaultWeixinUser();
    if (!targetId) {
      this.json(res, 400, {
        ok: false,
        error: "targetId is required when there is not exactly one known Weixin user",
      });
      return;
    }

    if (filePath) {
      const traceId = newTraceId();
      log.info(
        `[media:${traceId}] webhook send request file="${filePath}" type=${body.mediaType || "auto"} asLink=${body.asLink ? "yes" : "no"} target=${maskId(targetId)} textLen=${text.length} replyToken=${body.replyToken ? "explicit" : "auto"}`,
      );

      if (body.asLink) {
        const uploaded = await uploadMediaToCdn({
          filePath,
          toUserId: targetId,
          mediaType: body.mediaType || "auto",
          traceId,
        });
        const linkText = [
          body.caption || text || `${uploaded.mediaType}已上传到微信 CDN`,
          "",
          `文件: ${uploaded.fileName}`,
          `大小: ${(uploaded.fileSize / 1024 / 1024).toFixed(2)} MB`,
          `下载地址: ${uploaded.cdnDownloadUrl}`,
          `AES key: ${uploaded.aeskey}`,
          "",
          "注意: CDN 内容是加密密文，微信媒体消息会自动解密；浏览器直接打开通常不能直接播放。",
        ].join("\n");
        log.info(`[media:${traceId}] send cdn-link text start len=${linkText.length}`);
        await channel.send({ targetId, text: linkText, replyToken: body.replyToken });
        log.info(`[media:${traceId}] send cdn-link text ok`);
        this.json(res, 200, {
          ok: true,
          channel: channelName,
          targetId: maskId(targetId),
          sentAs: "cdn-link",
          upload: uploaded,
        });
        return;
      }

      const autoReplyToken = body.replyToken || getWeixinReplyToken(targetId) || undefined;
      let result = await sendMedia({
        filePath,
        toUserId: targetId,
        replyToken: autoReplyToken,
        mediaType: body.mediaType || "auto",
        caption: body.caption || text || undefined,
        traceId,
      });
      if (!result.success && autoReplyToken && /\bret"?\s*:\s*-2\b|ret\\?":-2/.test(result.error || "")) {
        log.warn(`[media:${traceId}] send failed with context_token ret=-2, retry without token`);
        result = await sendMedia({
          filePath,
          toUserId: targetId,
          mediaType: body.mediaType || "auto",
          caption: body.caption || text || undefined,
          traceId,
        });
      }
      if (!result.success) {
        log.warn(`[media:${traceId}] webhook send response error=${result.error || "unknown"}`);
        this.json(res, 500, { ok: false, error: result.error });
        return;
      }
      log.info(`[media:${traceId}] webhook send response ok mediaType=${result.mediaType} size=${result.fileSize}`);
      this.json(res, 200, {
        ok: true,
        channel: channelName,
        targetId: maskId(targetId),
        mediaType: result.mediaType,
        fileSize: result.fileSize,
      });
      return;
    }

    await channel.send({ targetId, text, media: body.media, replyToken: body.replyToken });

    this.json(res, 200, { ok: true, channel: channelName, targetId: maskId(targetId) });
  }

  private authorized(req: IncomingMessage): boolean {
    const webhook = this.config.webhook;
    const secret = webhook?.secret || process.env.SKYCHAT_WEBHOOK_SECRET;
    const host = webhook?.host || "127.0.0.1";
    const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
    if (!secret) return webhook?.allowNoAuth === true || (loopback && webhook?.allowNoAuth !== false);
    const header = req.headers.authorization || "";
    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(header);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

function getKnownWeixinUsers(): string[] {
  const tokensFile = join(getAccountsDir(), "weixin-tokens.json");
  if (!existsSync(tokensFile)) return [];
  try {
    const data = JSON.parse(readFileSync(tokensFile, "utf-8")) as Record<string, string>;
    return Object.keys(data);
  } catch {
    return [];
  }
}

function getDefaultWeixinUser(): string | null {
  const users = getKnownWeixinUsers();
  return users.length === 1 ? users[0]! : null;
}

function getWeixinReplyToken(userId: string): string | null {
  const tokensFile = join(getAccountsDir(), "weixin-tokens.json");
  if (!existsSync(tokensFile)) return null;
  try {
    const data = JSON.parse(readFileSync(tokensFile, "utf-8")) as Record<string, string>;
    return typeof data[userId] === "string" ? data[userId]! : null;
  } catch {
    return null;
  }
}

function newTraceId(): string {
  return randomUUID().slice(0, 8);
}

function maskId(id: string): string {
  if (id.length <= 6) return id;
  return id.slice(0, 4) + "****" + id.slice(-3);
}
