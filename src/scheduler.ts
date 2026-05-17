import { createLogger } from "./logger.js";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const log = createLogger("scheduler");

const SCHEDULER_URL = "http://127.0.0.1:7700";
const SCHEDULER_DIR = join(homedir(), ".claude", "skills", "scheduler");
const FETCH_TIMEOUT_MS = 3000;

// ── 开机自动注册的任务清单 ───────────────────────────────────────────────────

const DEFAULT_TASKS: Array<{
  name: string;
  command: string;
  seconds: number;
  count: number;
}> = [
  {
    name: "定时清理google浏览器",
    command: process.platform === "win32"
      ? "taskkill /F /IM chrome.exe 2>nul"
      : "pkill -f chrome || true",
    seconds: 3600,   // 每小时
    count: 99999,    // 默认次数
  },
];

// ── HTTP 工具 ────────────────────────────────────────────────────────────────

async function schedulerFetch<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${SCHEDULER_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

async function isRunning(): Promise<boolean> {
  const r = await schedulerFetch<{ running: boolean }>("/status");
  return r?.running === true;
}

async function listTasks(): Promise<Array<{ name: string; status: string }>> {
  return await schedulerFetch<Array<{ name: string; status: string }>>("/tasks") ?? [];
}

async function addIntervalTask(task: {
  name: string;
  command: string;
  seconds: number;
  count: number;
}): Promise<boolean> {
  const r = await schedulerFetch<{ ok: boolean }>("/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "interval", ...task }),
  });
  return r?.ok === true;
}

// ── 启动调度器守护进程 ────────────────────────────────────────────────────────

async function startDaemon(): Promise<boolean> {
  log.info("调度器未运行，正在启动 daemon.py...");

  const script = join(SCHEDULER_DIR, "daemon.py");
  const child = spawn("python", [script], {
    cwd: SCHEDULER_DIR,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Wait up to 6s for port 7700 to be ready
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isRunning()) {
      log.info(`调度器已就绪 (${(i + 1) * 0.5}s)`);
      return true;
    }
  }

  log.warn("调度器启动超时（6s），跳过定时任务注册");
  return false;
}

// ── 主入口：确保调度器运行 + 注册默认任务 ────────────────────────────────────

export async function ensureSchedulerTasks(): Promise<void> {
  // 确保调度器在运行
  if (!(await isRunning())) {
    const started = await startDaemon();
    if (!started) return;
  }

  const existing = await listTasks();
  const activeNames = new Set(
    existing.filter((t) => t.status === "active").map((t) => t.name),
  );

  for (const task of DEFAULT_TASKS) {
    if (activeNames.has(task.name)) {
      log.info(`定时任务已存在: ${task.name}`);
      continue;
    }
    const ok = await addIntervalTask(task);
    if (ok) {
      log.info(`定时任务已注册: ${task.name}（每 ${task.seconds}s，最多 ${task.count} 次）`);
    } else {
      log.warn(`定时任务注册失败: ${task.name}`);
    }
  }
}
