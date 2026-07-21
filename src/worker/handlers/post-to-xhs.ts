import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkerTask, WorkerCtx, WorkerResult } from "../types.js";

const SCRIPT_PATH = "C:\\Users\\Administrator\\.claude\\skills\\post-to-xhs\\scripts\\publish_pipeline.py";

// 截图兜底 — 图片链接不可达时用 Playwright 截图作为封面.
const SCREENSHOT_DIR = process.env.SKYCHAT_TEMP_DIR || "D:\\AIWorkSpace\\temp";
const PYTHON_EXE = process.env.PYTHON_EXE || "python";
const SCREENSHOT_TIMEOUT_MS = 45_000;
const XHS_TITLE_LIMIT = 38;
const XHS_CONTENT_LIMIT = 1000;

/** 小红书标题显示宽度：CJK/emoji 计2，ASCII 计1 */
function xhsDisplayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    w += (cp > 0x2E7F && cp <= 0x9FFF)   // CJK 主区
      || (cp >= 0xF900 && cp <= 0xFAFF)   // CJK 兼容
      || (cp >= 0xFF01 && cp <= 0xFF60)   // 全角
      || (cp >= 0x3000 && cp <= 0x303F)   // CJK 符号
      || (cp >= 0x1F000)                  // Emoji / 补充符号
      ? 2 : 1;
  }
  return w;
}

/** 超出限制时从末尾截断并补省略号 */
function truncateTitle(title: string): string {
  if (xhsDisplayWidth(title) <= XHS_TITLE_LIMIT) return title;
  const chars = [...title];
  while (xhsDisplayWidth(chars.join("")) > XHS_TITLE_LIMIT - 1) chars.pop();
  return chars.join("") + "…";
}

/**
 * 末行若为 "#标签1 #标签2 ..." 则视为话题行 (publish_pipeline 会从末行提取话题)。
 * 截断正文时要保留这一行，否则话题丢失。
 */
function splitTopicTail(content: string): { body: string; topicLine: string } {
  const lines = content.split(/\r?\n/);
  while (lines.length && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  if (!lines.length) return { body: content, topicLine: "" };

  const last = (lines[lines.length - 1] ?? "").trim();
  const parts = last.split(/\s+/).filter(Boolean);
  if (parts.length && parts.every((p) => /^#[^\s#]+$/.test(p))) {
    return { body: lines.slice(0, -1).join("\n").replace(/\s+$/, ""), topicLine: last };
  }
  return { body: content, topicLine: "" };
}

/**
 * 正文按 JS 字符长度 (与 publish_pipeline.py 的 len() 一致) 截断到 ≤1000 字。
 * 保留尾部 "#话题" 行，主体超出时从末尾截断补省略号。
 */
function truncateContent(content: string): string {
  if (content.length <= XHS_CONTENT_LIMIT) return content;

  const { body, topicLine } = splitTopicTail(content);
  const tail = topicLine ? "\n\n" + topicLine : "";
  const ellipsis = "…";
  const budget = XHS_CONTENT_LIMIT - tail.length - ellipsis.length;
  if (budget <= 0) {
    // 极端情况：话题行本身就快占满 1000 字，退而求次保留前 budget 字
    return content.slice(0, XHS_CONTENT_LIMIT);
  }

  const truncatedBody = body.slice(0, budget).replace(/\s+$/, "");
  return truncatedBody + ellipsis + tail;
}

/**
 * 探测图片 URL 可达性, 容忍单次网络抖动.
 *   1. HEAD (timeout=6s) — 快路径
 *   2. HEAD 失败 → GET Range bytes=0-0 (timeout=12s) — 兜底
 *      不少 CDN/反爬对 HEAD 行为不一致, Range 只取 1 字节比全量 GET 省流量.
 */
async function probeImageUrl(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(6000) });
    if (r.ok) return { ok: true };
    if (r.status >= 400 && r.status < 500 && r.status !== 405) {
      // 405 (Method Not Allowed) 在 HEAD 上常见, 留给 GET 重试; 其他 4xx 是确定性错误.
      return { ok: false, reason: `图片链接无效 (HEAD ${r.status})` };
    }
  } catch {
    // 网络抖动 / 超时 — 落到 GET 兜底
  }
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(12000),
    });
    if (r.ok || r.status === 206) return { ok: true };
    return { ok: false, reason: `图片链接无效 (GET ${r.status})` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `图片链接无法访问 (${msg})` };
  }
}

/**
 * Playwright 截图作为封面兜底.
 *
 * 返回本地图片绝对路径, 失败返回 null.
 *
 * 每次调用写入独立临时文件，避免并发任务互相覆盖。
 */
async function takeScreenshotFallback(
  imageUrls: string[],
  taskId: string,
  log: WorkerCtx["log"],
): Promise<string | null> {
  // 从 OG 图 URL 推断源网页 URL
  let pageUrl = imageUrls[0] ?? "";
  const ghMatch = pageUrl.match(/opengraph\.githubassets\.com\/\d+\/([^/?]+\/[^/?]+)/);
  if (ghMatch) pageUrl = "https://github.com/" + ghMatch[1];
  const hfMatch = pageUrl.match(/huggingface\.co\/([^/]+\/[^/?#]+)/);
  if (hfMatch) pageUrl = "https://huggingface.co/" + hfMatch[1];

  const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const screenshotPath = join(SCREENSHOT_DIR, `xhs-fallback-${safeTaskId}-${randomUUID().slice(0, 8)}.png`);
  await mkdir(SCREENSHOT_DIR, { recursive: true });
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const browserArgs = proxyUrl ? [`--proxy-server=${proxyUrl}`] : [];
  const script = [
    "from playwright.sync_api import sync_playwright",
    "import time",
    "with sync_playwright() as p:",
    `    browser = p.chromium.launch(headless=True, args=${JSON.stringify(browserArgs)})`,
    "    page = browser.new_page(viewport={'width': 1280, 'height': 800})",
    `    page.goto(${JSON.stringify(pageUrl)}, wait_until="domcontentloaded", timeout=30000)`,
    "    time.sleep(3)",
    `    page.screenshot(path=${JSON.stringify(screenshotPath)}, full_page=False)`,
    "    browser.close()",
    "    print('SCREENSHOT_OK')",
  ].join("\n");

  return new Promise((resolve) => {
    const proc = spawn(PYTHON_EXE, ["-c", script]);
    let out = "";
    let settled = false;
    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill();
      log.warn(`截图兜底超时 (${SCREENSHOT_TIMEOUT_MS}ms)`);
      finish(null);
    }, SCREENSHOT_TIMEOUT_MS);
    proc.on("error", (error) => {
      clearTimeout(timer);
      log.warn(`截图兜底无法启动: ${error.message}`);
      finish(null);
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (out.includes("SCREENSHOT_OK") && existsSync(screenshotPath)) {
        log.info("截图兜底成功: " + screenshotPath);
        finish(screenshotPath);
      } else {
        log.warn("截图兜底失败 (exit " + code + "): " + out.slice(0, 200));
        finish(null);
      }
    });
  });
}

export interface PostXhsParams {
  title: string;
  content: string;
  imageUrls?: string[];
  imagePaths?: string[];
  videoPath?: string;
  videoUrl?: string;
  account?: string;
  headless?: boolean;
}

/**
 * 处理发小红书任务 — 调用 publish_pipeline.py 驱动专用 Chrome 实例完成发布。
 *
 * 退出码：0=发布成功，1=未登录，2=其他错误
 */
export async function handlePostXhs(
  task: WorkerTask,
  ctx: WorkerCtx,
): Promise<WorkerResult> {
  const { log } = ctx;
  const params = task.params as unknown as PostXhsParams;
  const { title, content, videoPath, videoUrl, account } = params;
  // 图片来源可能被截图兜底替换, 故 let 而非 const
  let imageUrls = params.imageUrls;
  let imagePaths = params.imagePaths;
  const headless = params.headless !== false; // 默认 headless

  if (!title?.trim()) {
    return { ok: false, reason: "MISSING_TITLE", userMessage: "❌ 发小红书失败：缺少标题" };
  }
  if (!content?.trim()) {
    return { ok: false, reason: "MISSING_CONTENT", userMessage: "❌ 发小红书失败：缺少正文" };
  }
  const hasMedia = (imageUrls?.length ?? 0) > 0 || (imagePaths?.length ?? 0) > 0 || videoPath || videoUrl;
  if (!hasMedia) {
    return { ok: false, reason: "MISSING_MEDIA", userMessage: "❌ 发小红书失败：小红书图文必须包含图片或视频" };
  }

  // Pre-check image URLs before starting Chrome to fail fast on 404s.
  // 跨境 CDN (raw.githubusercontent.com 等) 单次 HEAD 8s 容易抖动 fail (2026-05-26 实测一次过/一次超时).
  // 策略: HEAD 短超时 → 失败时 GET Range 0-0 长超时兜底 → 仍失败才判 INVALID.
  // 任意一张 URL 不可达 → Playwright 截图兜底 (publish_pipeline 不支持 URL+本地混用).
  if (imageUrls?.length) {
    let anyFailed: { url: string; reason: string } | null = null;
    for (const url of imageUrls) {
      const probe = await probeImageUrl(url);
      if (!probe.ok) {
        anyFailed = { url, reason: probe.reason };
        break;
      }
    }
    if (anyFailed) {
      log.warn(`图片不可达, 用 Playwright 截图兜底 (${anyFailed.reason}): ${anyFailed.url}`);
      const fallback = await takeScreenshotFallback(imageUrls, task.id, log);
      if (!fallback) {
        return {
          ok: false,
          reason: "IMAGE_URL_INVALID",
          userMessage: `❌ 发小红书失败：图片链接不可达且截图兜底也失败了\n原始: ${anyFailed.reason}: ${anyFailed.url}`,
        };
      }
      imageUrls = undefined;
      imagePaths = [fallback];
      log.info(`已切换到 Playwright 截图封面: ${fallback}`);
    }
  }

  // 服务端兜底截断标题，防止 AI 计算宽度有误导致 publish_pipeline.py 报错退出
  const finalTitle = truncateTitle(title.trim());
  if (finalTitle !== title.trim()) {
    log.warn(`标题超限已截断: ${xhsDisplayWidth(title)} → ${xhsDisplayWidth(finalTitle)} "${finalTitle}"`);
  }

  // 同样兜底截断正文 (XHS 上限 1000 字符)
  const trimmedContent = content.trim();
  const finalContent = truncateContent(trimmedContent);
  if (finalContent !== trimmedContent) {
    log.warn(`正文超限已截断: ${trimmedContent.length} → ${finalContent.length}`);
  }

  const args: string[] = [SCRIPT_PATH, "--title", finalTitle, "--content", finalContent];

  if (headless) args.push("--headless");
  if (account) args.push("--account", account);

  if (imageUrls?.length) {
    args.push("--image-urls", ...imageUrls);
  } else if (imagePaths?.length) {
    args.push("--images", ...imagePaths);
  } else if (videoUrl) {
    args.push("--video-url", videoUrl);
  } else if (videoPath) {
    args.push("--video", videoPath);
  }

  const mediaDesc = imageUrls?.length
    ? `${imageUrls.length}张图(URL)`
    : imagePaths?.length
    ? `${imagePaths.length}张图(本地)`
    : videoUrl
    ? "视频(URL)"
    : "视频(本地)";

  log.info(`发小红书任务开始: taskId=${task.id} title="${title.slice(0, 20)}" media=${mediaDesc} headless=${headless}`);

  const { exitCode, stdout, stderr } = await runPython(args);

  const output = stdout.trim();
  const errOutput = stderr.trim();
  log.info(`publish_pipeline 退出码=${exitCode} stdout末行="${output.split("\n").pop()?.slice(0, 120) ?? ""}"`);

  // 每行单独打印，避免长 URL 被截断
  if (errOutput) {
    for (const line of errOutput.split("\n")) {
      if (line.trim()) log.warn(`publish_pipeline stderr: ${line}`);
    }
  }

  // 失败时输出完整 stdout 便于定位
  if (exitCode !== 0) {
    const stdoutLines = output.split("\n");
    const contextLines = stdoutLines.slice(-10); // 最后10行
    for (const line of contextLines) {
      if (line.trim()) log.info(`publish_pipeline stdout: ${line}`);
    }
  }

  if (exitCode === 0) {
    const publishStatusMatch = output.match(/^PUBLISH_STATUS:\s*(\w+)/m);
    const publishStatus = publishStatusMatch?.[1]?.toUpperCase() ?? "PUBLISHED";

    if (publishStatus === "DRAFT") {
      return {
        ok: false,
        reason: "DRAFT",
        userMessage: "⚠️ 小红书笔记已保存为草稿，未直接发布。请到小红书创作中心手动发布。",
      };
    }
    if (publishStatus === "UNKNOWN") {
      return {
        ok: false,
        reason: "UNKNOWN_PUBLISH",
        userMessage: "⚠️ 小红书发布结果无法确认，请到小红书创作中心检查是否已发布（可能成功也可能在草稿中）。",
      };
    }
    return { ok: true, reason: "-", userMessage: "✅ 小红书笔记已发布" };
  }

  // Chrome 起不来时 publish_pipeline 会先 headless 失败、再切 headed 也失败，
  // 退出码可能是 1 也可能是 2。无论哪种，只要 stderr 包含启动失败标志，都归类为 CHROME_LAUNCH_FAILED，
  // 避免误导用户去重新登录。
  const chromeLaunchFailed = /Chrome process exited|Failed to start Chrome|before port \d+ became available/i.test(errOutput);
  if (chromeLaunchFailed) {
    const firstErrLine = errOutput.split("\n").find((l) => l.trim()) ?? "";
    return {
      ok: false,
      reason: "CHROME_LAUNCH_FAILED",
      userMessage: `❌ 发小红书失败：专用 Chrome 启动失败（端口 9222 未就绪）。可能原因：上次 Chrome 进程残留 / profile 被占用。\n详情：${firstErrLine}`,
    };
  }

  if (exitCode === 1) {
    return { ok: false, reason: "NOT_LOGGED_IN", userMessage: "❌ 发小红书失败：请先在专用 Chrome 中登录小红书账号" };
  }

  // exitCode === 2 or other errors — 取第一条 stderr 行作为提示（完整，不截断 URL）
  const firstErrLine = errOutput.split("\n").find((l) => l.trim()) ?? "";
  const hint = firstErrLine || output.split("\n").find((l) => l.trim()) || "未知错误";
  return { ok: false, reason: "PUBLISH_FAIL", userMessage: `❌ 发小红书失败：${hint}` };
}

function runPython(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("python", args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    proc.stdout.on("data", (d: Buffer) => stdoutChunks.push(d));
    proc.stderr.on("data", (d: Buffer) => stderrChunks.push(d));

    proc.on("close", (code) => {
      resolve({
        exitCode: code ?? 2,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });

    proc.on("error", (err) => {
      resolve({ exitCode: 2, stdout: "", stderr: err.message });
    });
  });
}
