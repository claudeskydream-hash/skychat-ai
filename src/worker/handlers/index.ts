import type { WorkerTask, WorkerCtx, WorkerResult, IntentName } from "../types.js";
import { handlePostTweet } from "./post-to-x.js";
import { handlePostXhs } from "./post-to-xhs.js";

type Handler = (task: WorkerTask, ctx: WorkerCtx) => Promise<WorkerResult>;

const HANDLERS: Partial<Record<IntentName, Handler>> = {
  post_tweet: handlePostTweet,
  post_xhs: handlePostXhs,
};

export async function dispatch(task: WorkerTask, ctx: WorkerCtx): Promise<WorkerResult> {
  const handler = HANDLERS[task.intent];
  if (!handler) {
    return {
      ok: false,
      reason: "UNKNOWN_INTENT",
      userMessage: `❌ 未知任务类型: ${task.intent}`,
    };
  }
  return handler(task, ctx);
}
