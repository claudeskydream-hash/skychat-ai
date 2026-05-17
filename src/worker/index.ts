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
const VALID_INTENTS = new Set<IntentName>(["post_tweet", "post_xhs", "delete_tweet"]);

export function extractIntent(text: string): ExtractedIntent | null {
  const match = text.match(INTENT_TAG_RE);
  if (!match) return null;

  const rawBlock = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBlock);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn(`intent 标签存在但 JSON 解析失败: ${errMsg}  raw="${rawBlock.slice(0, 200)}"`);
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    log.warn(`intent JSON 不是对象: ${JSON.stringify(parsed).slice(0, 200)}`);
    return null;
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.name !== "string") {
    log.warn(`intent JSON 缺少 name 字段: ${JSON.stringify(parsed).slice(0, 200)}`);
    return null;
  }
  if (!VALID_INTENTS.has(p.name as IntentName)) {
    log.warn(`intent name="${p.name}" 不在白名单内（合法值: ${Array.from(VALID_INTENTS).join(",")}）`);
    return null;
  }
  return {
    name: p.name as IntentName,
    params: (p.params as Record<string, unknown>) || {},
  };
}

// Strip <intent>...</intent> block from AI reply text shown to user
export function stripIntentBlock(text: string): string {
  return text.replace(INTENT_TAG_RE, "").trim();
}
