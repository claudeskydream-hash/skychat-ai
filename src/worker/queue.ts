import { EventEmitter } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createLogger } from "../logger.js";
import { getDataDir, ensureDir } from "../config.js";
import { join } from "node:path";
import type { WorkerTask, WorkerResult } from "./types.js";

const log = createLogger("worker-queue");

const QUEUE_FILE = join(getDataDir(), "worker-queue.json");
const TASK_TIMEOUT_MS = 180_000; // 3 minutes per task
const MAX_ATTEMPTS = 2;

type TaskState = "pending" | "running" | "done" | "failed";

interface QueueEntry {
  task: WorkerTask;
  state: TaskState;
  result?: WorkerResult;
}

export type TaskHandler = (task: WorkerTask) => Promise<WorkerResult>;

export class WorkerQueue extends EventEmitter {
  private entries: QueueEntry[] = [];
  private handler: TaskHandler | null = null;
  private consuming = false;

  setHandler(handler: TaskHandler): void {
    this.handler = handler;
  }

  async load(): Promise<void> {
    if (!existsSync(QUEUE_FILE)) return;
    try {
      const raw = await readFile(QUEUE_FILE, "utf-8");
      const data = JSON.parse(raw) as QueueEntry[];
      // Restore only pending/running tasks; reset running → pending
      this.entries = data
        .filter((e) => e.state === "pending" || e.state === "running")
        .map((e) => e.state === "running" ? { ...e, state: "pending" as TaskState } : e);
      if (this.entries.length > 0) {
        log.info(`从磁盘恢复 ${this.entries.length} 个待处理任务`);
        this.scheduleConsume();
      }
    } catch (err) {
      log.warn(`加载队列失败，清空: ${err instanceof Error ? err.message : err}`);
      this.entries = [];
    }
  }

  async enqueue(task: WorkerTask): Promise<string> {
    const entry: QueueEntry = { task, state: "pending" };
    this.entries.push(entry);
    await this.persist();
    const paramsSummary = JSON.stringify(task.params).slice(0, 150);
    log.info(`任务入队: ${task.id} [${task.intent}]  params=${paramsSummary}  channel=${task.replyTo.channel}  target=${task.replyTo.targetId.slice(0, 8)}…`);
    this.scheduleConsume();
    return task.id;
  }

  getState(taskId: string): TaskState {
    return this.entries.find((e) => e.task.id === taskId)?.state ?? "pending";
  }

  private scheduleConsume(): void {
    if (this.consuming) return;
    Promise.resolve().then(() => this.consume());
  }

  private async consume(): Promise<void> {
    if (this.consuming) return;
    this.consuming = true;

    while (true) {
      const entry = this.entries.find((e) => e.state === "pending");
      if (!entry) break;

      entry.state = "running";
      await this.persist();
      const waitMs = Date.now() - entry.task.createdAt;
      const startTime = Date.now();
      log.info(`执行任务: ${entry.task.id} [${entry.task.intent}] attempt=${entry.task.attempts + 1}/${MAX_ATTEMPTS} 排队等待=${waitMs}ms`);

      try {
        if (!this.handler) throw new Error("任务处理器未初始化");

        const result = await Promise.race([
          this.handler(entry.task),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`任务超时 (${TASK_TIMEOUT_MS / 1000}s)`)), TASK_TIMEOUT_MS),
          ),
        ]);

        entry.state = "done";
        entry.result = result;
        const elapsedMs = Date.now() - startTime;
        this.emit("done", entry.task, result);
        log.info(`任务完成: ${entry.task.id} ok=${result.ok} 耗时=${elapsedMs}ms reason=${result.reason ?? "-"} msg=${result.userMessage}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const elapsedMs = Date.now() - startTime;
        log.error(`任务出错: ${entry.task.id} 耗时=${elapsedMs}ms — ${msg}`);

        entry.task.attempts++;
        if (entry.task.attempts < MAX_ATTEMPTS) {
          log.info(`任务重试 (${entry.task.attempts}/${MAX_ATTEMPTS}): ${entry.task.id}`);
          entry.state = "pending";
        } else {
          const result: WorkerResult = {
            ok: false,
            userMessage: `❌ 任务失败 (已重试 ${MAX_ATTEMPTS} 次): ${msg}`,
            reason: msg,
          };
          entry.state = "failed";
          entry.result = result;
          this.emit("done", entry.task, result);
          log.error(`任务最终失败: ${entry.task.id} (已耗尽 ${MAX_ATTEMPTS} 次重试) reason=${msg}`);
        }
      }

      await this.persist();
    }

    this.consuming = false;
  }

  private async persist(): Promise<void> {
    try {
      await ensureDir(getDataDir());
      // Only persist non-terminal entries (or recent done/failed for debugging)
      const toSave = this.entries.filter((e) => e.state === "pending" || e.state === "running");
      await writeFile(QUEUE_FILE, JSON.stringify(toSave, null, 2));
    } catch (err) {
      log.warn(`队列持久化失败: ${err instanceof Error ? err.message : err}`);
    }
  }
}
