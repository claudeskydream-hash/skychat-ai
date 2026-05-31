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
 * 修复 Claude 生成 JSON 时常见的失误。处理三类错误:
 *   1. 字符串内未转义的控制字符 (换行/制表符 → \n/\t)
 *   2. 字符串内的反斜杠后接非法转义字符 (\xxx → \\xxx, 如路径 D:\AI 应该是 D:\\AI)
 *   3. 字符串内意外的双引号 (下一个非空白字符不是 ,/}/]/:) → 转义为 \"
 * 只在字符串状态内修复; 字符串外原样保留。
 */
function sanitizeJsonControlChars(raw: string): string {
  let result = "";
  let inString = false;
  let i = 0;
  const len = raw.length;
  while (i < len) {
    const ch = raw[i] ?? "";
    if (!inString) {
      if (ch === '"') { inString = true; result += ch; i++; continue; }
      result += ch; i++; continue;
    }
    // 字符串内
    if (ch === "\\") {
      const next = raw[i + 1] ?? "";
      // JSON 合法转义: " \ / b f n r t u
      if (/[\"\\\/bfnrtu]/.test(next)) {
        result += ch + next;
        i += 2;
      } else {
        // 非法转义 (如 Windows 路径 D:\AIWorkSpace) → 自动转义反斜杠
        result += "\\\\" + next;
        i += 2;
      }
      continue;
    }
    if (ch === '"') {
      // 判定: 这是合法的字符串闭引号还是字符串内的意外引号?
      // 看下一个非空白字符: 是 , } ] : 之一 → 合法结束; 否则是字符串内的 "
      let j = i + 1;
      while (j < len && /\s/.test(raw[j] ?? "")) j++;
      const nextNonSpace = raw[j] ?? "";
      if (nextNonSpace === "," || nextNonSpace === "}" || nextNonSpace === "]" || nextNonSpace === ":" || j >= len) {
        inString = false;
        result += ch;
        i++;
        continue;
      }
      // 字符串内意外的 ", 自动转义
      result += '\\"';
      i++;
      continue;
    }
    // 控制字符
    if (ch === "\n") { result += "\\n"; i++; continue; }
    if (ch === "\r") { result += "\\r"; i++; continue; }
    if (ch === "\t") { result += "\\t"; i++; continue; }
    if (ch === "\b") { result += "\\b"; i++; continue; }
    if (ch === "\f") { result += "\\f"; i++; continue; }
    result += ch;
    i++;
  }
  return result;
}

function parseIntentBlock(rawBlock: string, source: string): ExtractedIntent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlock);
  } catch (firstErr) {
    // 兜底: sanitize 处理控制字符 / 非法反斜杠 / 字符串内未转义引号
    const sanitized = sanitizeJsonControlChars(rawBlock);
    try {
      parsed = JSON.parse(sanitized);
      if (sanitized !== rawBlock) {
        log.info(`intent JSON 已自动修复 (${source}, ${rawBlock.length - sanitized.length === 0 ? "等长" : `+${sanitized.length - rawBlock.length}字符`})`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      // 完整 raw 写入日志便于诊断 (老问题: Intent JSON 偶发损坏)
      log.warn(`intent JSON 解析失败 (${source}): 原错=${firstMsg}; 修复后错=${errMsg}  rawLen=${rawBlock.length}  raw=${rawBlock.slice(0, 1500)}${rawBlock.length > 1500 ? "...[truncated]" : ""}`);
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
