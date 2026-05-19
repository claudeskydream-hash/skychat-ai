import { spawn } from "node:child_process";
import type { WorkerTask, WorkerCtx, WorkerResult } from "../types.js";

const SCRIPT_PATH = "C:\\Users\\Administrator\\.claude\\skills\\post-to-xhs\\scripts\\publish_pipeline.py";
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
  const { title, content, imageUrls, imagePaths, videoPath, videoUrl, account } = params;
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
  if (errOutput) log.warn(`publish_pipeline stderr: ${errOutput.slice(0, 300)}`);

  if (exitCode === 0) {
    return { ok: true, reason: "-", userMessage: "✅ 小红书笔记已发布" };
  }

  if (exitCode === 1) {
    return { ok: false, reason: "NOT_LOGGED_IN", userMessage: "❌ 发小红书失败：请先在专用 Chrome 中登录小红书账号" };
  }

  // exitCode === 2 or other errors
  const hint = errOutput.slice(0, 200) || output.slice(0, 200) || "未知错误";
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
