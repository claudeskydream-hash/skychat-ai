export type IntentName = "post_tweet" | "post_xhs" | "delete_tweet";

export interface WorkerTask {
  id: string;
  intent: IntentName;
  params: Record<string, unknown>;
  replyTo: {
    channel: string;
    targetId: string;
    replyToken?: string;
  };
  state?: { step: number; data?: unknown };
  attempts: number;
  createdAt: number;
}

export interface PostTweetParams {
  text: string;
  imagePath?: string;
  videoPath?: string;
}

export interface DeleteTweetParams {
  keyword: string;
}

export interface WorkerResult {
  ok: boolean;
  userMessage: string;
  reason?: string;
}

export interface IMcpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface WorkerCtx {
  mcp: IMcpClient;
  log: {
    debug: (msg: string) => void;
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}
