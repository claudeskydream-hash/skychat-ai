import { randomUUID } from "node:crypto";
import { createLogger } from "../logger.js";
import { WorkerQueue } from "./queue.js";
import { WorkerMcpClient } from "./mcp-client.js";
import { dispatch } from "./handlers/index.js";
import type { WorkerTask, IntentName, WorkerResult } from "./types.js";

const log = createLogger("worker");

export type SendReply = (
  channel: string,
  targetId: string,
  replyToken: string | undefined,
  text: string,
) => Promise<void>;

export class Worker {
  private queue = new WorkerQueue();
  private mcp = new WorkerMcpClient();
  private sendReply: SendReply;

  constructor(sendReply: SendReply) {
    this.sendReply = sendReply;
    this.queue.setHandler((task) => dispatch(task, { mcp: this.mcp, log }));
    this.queue.on("done", (task: WorkerTask, result: WorkerResult) => {
      this.onTaskDone(task, result);
    });
  }

  async start(): Promise<void> {
    await this.queue.load();
    log.info("Worker 已启动");
  }

  async shutdown(): Promise<void> {
    await this.mcp.disconnect();
    log.info("Worker 已停止");
  }

  async enqueue(params: {
    intent: IntentName;
    params: Record<string, unknown>;
    channel: string;
    targetId: string;
    replyToken?: string;
  }): Promise<string> {
    const task: WorkerTask = {
      id: randomUUID().slice(0, 8),
      intent: params.intent,
      params: params.params,
      replyTo: {
        channel: params.channel,
        targetId: params.targetId,
        replyToken: params.replyToken,
      },
      attempts: 0,
      createdAt: Date.now(),
    };
    return this.queue.enqueue(task);
  }

  private async onTaskDone(task: WorkerTask, result: WorkerResult): Promise<void> {
    const { channel, targetId, replyToken } = task.replyTo;
    const sendStart = Date.now();
    try {
      await this.sendReply(channel, targetId, replyToken, result.userMessage);
      const totalMs = Date.now() - task.createdAt;
      log.info(`结果已发回 ${channel}:${targetId.slice(0, 8)}…  发回耗时=${Date.now() - sendStart}ms  端到端=${totalMs}ms  ok=${result.ok}`);
    } catch (err) {
      log.error(`发回结果失败 [${Date.now() - sendStart}ms]: taskId=${task.id} ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── Intent extraction helper (used by gateway) ──────────────────────────────

export interface ExtractedIntent {
  name: IntentName;
  params: Record<string, unknown>;
}

const INTENT_TAG_RE = /<intent>\s*([\s\S]*?)\s*<\/intent>/i;
const INTENT_CLOSE_TAG_RE = /<\/intent>/i;
const INTENT_OPEN_TAG_RE = /<intent>/i;
const VALID_INTENTS = new Set<IntentName>(["post_tweet", "post_xhs", "delete_tweet"]);

/**
 * 从一段文本里找到最末尾、与之前 `{` 配对的 JSON 对象字符串。
 * 容错用：当模型只输出了 `</intent>` 而漏掉了 `<intent>` 开标签时，
 * 我们从闭标签前的内容里反向定位一个看起来像 intent payload 的 JSON。
 */
function findTrailingJsonObject(text: string): string | null {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.endsWith("}")) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "}") depth++;
    else if (ch === "{") {
      depth--;
      if (depth === 0) return trimmed.slice(i);
    }
  }
  return null;
}

/**
 * 修复 Claude 生成 JSON 时常见的失误：字符串里直接放了真实换行 / 制表符，
 * 而不是 `\n` / `\t` 转义。这会让 `JSON.parse` 报 "Bad control character"。
 * 只转义字符串内部、未经 `\\` 转义的控制字符；其它字符原样保留。
 */
function sanitizeJsonControlChars(raw: string): string {
  let result = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i] ?? "";
    if (escape) {
      result += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      result += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString) {
      if (ch === "\n") { result += "\\n"; continue; }
      if (ch === "\r") { result += "\\r"; continue; }
      if (ch === "\t") { result += "\\t"; continue; }
      if (ch === "\b") { result += "\\b"; continue; }
      if (ch === "\f") { result += "\\f"; continue; }
    }
    result += ch;
  }
  return result;
}

function parseIntentBlock(rawBlock: string, source: string): ExtractedIntent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlock);
  } catch (firstErr) {
    // 兜底：Claude 偶发在字符串内放真实换行/制表符，先转义再解析一次
    const sanitized = sanitizeJsonControlChars(rawBlock);
    if (sanitized !== rawBlock) {
      try {
        parsed = JSON.parse(sanitized);
        log.info(`intent JSON 控制字符已自动修复 (${source})`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.warn(`intent JSON 解析失败 (${source}, 已尝试控制字符修复): ${errMsg}  raw="${rawBlock.slice(0, 200)}"`);
        return null;
      }
    } else {
      const errMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      log.warn(`intent JSON 解析失败 (${source}): ${errMsg}  raw="${rawBlock.slice(0, 200)}"`);
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") {
    log.warn(`intent JSON 不是对象 (${source}): ${JSON.stringify(parsed).slice(0, 200)}`);
    return null;
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.name !== "string") {
    log.warn(`intent JSON 缺少 name 字段 (${source}): ${JSON.stringify(parsed).slice(0, 200)}`);
    return null;
  }
  if (!VALID_INTENTS.has(p.name as IntentName)) {
    log.warn(`intent name="${p.name}" 不在白名单内 (${source})（合法值: ${Array.from(VALID_INTENTS).join(",")}）`);
    return null;
  }
  return {
    name: p.name as IntentName,
    params: (p.params as Record<string, unknown>) || {},
  };
}

export function extractIntent(text: string): ExtractedIntent | null {
  // 1) 正常路径: 完整的 <intent>...</intent> 标签对
  const match = text.match(INTENT_TAG_RE);
  if (match) {
    return parseIntentBlock(match[1] ?? "", "full-tag");
  }

  // 2) 容错: 只有 </intent> 闭标签 (模型有时会漏写开标签或被前文污染)
  //    从闭标签前的内容里向后扫一个完整 JSON 对象作为 payload。
  const closeMatch = text.match(INTENT_CLOSE_TAG_RE);
  if (closeMatch && !INTENT_OPEN_TAG_RE.test(text)) {
    const before = text.slice(0, closeMatch.index ?? 0);
    const jsonBlock = findTrailingJsonObject(before);
    if (jsonBlock) {
      log.warn(`intent 缺少开标签但有闭标签，尝试从闭标签前回溯 JSON 解析 (raw="${jsonBlock.slice(0, 120)}")`);
      const intent = parseIntentBlock(jsonBlock, "close-tag-fallback");
      if (intent) return intent;
    }
  }

  return null;
}

// Strip <intent>...</intent> block from AI reply text shown to user.
// 同时容错处理只有闭标签的情况，移除 "..json.. </intent>" 这段。
export function stripIntentBlock(text: string): string {
  if (INTENT_TAG_RE.test(text)) {
    return text.replace(INTENT_TAG_RE, "").trim();
  }
  const closeMatch = text.match(INTENT_CLOSE_TAG_RE);
  if (closeMatch && !INTENT_OPEN_TAG_RE.test(text)) {
    const before = text.slice(0, closeMatch.index ?? 0);
    const jsonBlock = findTrailingJsonObject(before);
    if (jsonBlock) {
      const startIdx = before.lastIndexOf(jsonBlock);
      const afterClose = text.slice((closeMatch.index ?? 0) + closeMatch[0].length);
      return (text.slice(0, startIdx) + afterClose).trim();
    }
    // 没找到 JSON 时仅移除孤立的闭标签
    return text.replace(INTENT_CLOSE_TAG_RE, "").trim();
  }
  return text.trim();
}
