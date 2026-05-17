import { spawn } from "node:child_process";
import type { WorkerTask, WorkerCtx, WorkerResult } from "../types.js";

const SCRIPT_PATH = "C:\\Users\\Administrator\\.claude\\skills\\post-to-xhs\\scripts\\publish_pipeline.py";

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

  const args: string[] = [SCRIPT_PATH, "--title", title, "--content", content];

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
