import { execFile } from "child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { agent } from "claw-agent-sdk";
import { createLogger } from "../logger.js";
import type { Provider, ProviderConfig, ProviderOptions, ProviderResponse } from "../types.js";

const log = createLogger("claw-agent");

/**
 * 跨平台 bash 工具 — 覆盖 claw-agent-sdk 内置的 /bin/sh 版本。
 * SDK 内置 bash 在 Windows 上调用 /bin/sh 立即 ENOENT，导致工具调用 2~9ms 失败，
 * 模型据此回复"无法执行命令"。这里换成平台原生 shell。
 */
const BLOCKED_PATTERNS = [
  /\brm\s+-rf\s+[/~]/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
];
const isWindows = process.platform === "win32";
const SHELL_BIN = isWindows ? (process.env.ComSpec || "cmd.exe") : "/bin/sh";
const BASH_TIMEOUT = 30_000;
const AUTH_REFRESH_TIMEOUT = 60_000;

function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") || path.startsWith("~\\")
    ? resolve(homedir(), path.slice(2))
    : path;
}

function isAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|invalid_authentication_error|api key.*(?:invalid|expired)/i.test(message);
}

function createCrossPlatformBashTool(cwd: string) {
  return {
    name: "bash",
    description: "Execute a shell command and return its output. Cross-platform (Windows cmd / POSIX sh). Has a timeout and blocks dangerous commands.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
    async execute(params: Record<string, unknown>): Promise<string> {
      const command = String(params.command ?? "");
      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
          return `Blocked: command matches dangerous pattern "${pattern.source}"`;
        }
      }
      return new Promise<string>((resolve) => {
        const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];
        execFile(
          SHELL_BIN,
          args,
          { cwd, timeout: BASH_TIMEOUT, maxBuffer: 1024 * 1024, env: { ...process.env } },
          (error, stdout, stderr) => {
            if (error) {
              const wasKilled = "killed" in error && error.killed === true;
              const msg = wasKilled
                ? `Command timed out after ${BASH_TIMEOUT}ms`
                : error.message;
              resolve(stderr ? `Error: ${msg}\nStderr: ${stderr}` : `Error: ${msg}`);
              return;
            }
            const output = stdout.trim();
            const errOutput = stderr.trim();
            if (errOutput && output) resolve(`${output}\n---stderr---\n${errOutput}`);
            else resolve(output || errOutput || "(no output)");
          },
        );
      });
    },
  };
}

// 内置 bash 不可用（写死 /bin/sh），手动列出其余可用工具。
const SAFE_BUILTIN_TOOLS = ["read", "write", "glob", "grep", "web_fetch", "web_search"];

/**
 * summarize_url 工具 — 把 ~/.claude/skills/content-summary 的能力暴露给非 Claude 模型。
 * claw-agent-sdk 不支持 skill 系统，所以把脚本路由封装成 OpenAI function calling 工具。
 * - GitHub repo URL → python github_summary.py
 * - 其他 URL → node md-page.js (defuddle)
 */
const GITHUB_SUMMARY_PY = "C:\\Users\\Administrator\\.claude\\skills\\content-summary\\scripts\\github_summary.py";
const MD_PAGE_JS = "D:\\AIWorkSpace\\GitHubTools\\MD-This-Page\\md-page.js";
const SUMMARIZE_TIMEOUT = 180_000;
const SUMMARIZE_MAX_CHARS = 30_000;

function isGithubRepoUrl(url: string): boolean {
  const m = url.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+)(\/(tree\/[^?]+)?)?\/?$/i);
  if (!m) return false;
  // 排除 /blob/、/issues/、/pull/、/wiki 等子路径
  return !/\/(blob|issues|pull|pulls|wiki|releases|actions|commits)\b/i.test(url);
}

function createSummarizeUrlTool(cwd: string) {
  return {
    name: "summarize_url",
    description: "抓取并清洗指定 URL 的正文，返回干净 Markdown 供你直接总结。自动判断类型：GitHub 仓库主页用 API+浅克隆扫描（含元信息/commit/目录树/依赖），其他网页/文章/帖子用 defuddle 抽正文。比手动调 bash 更稳定可靠，遇到 URL 内容总结任务务必优先用此工具。",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整 URL，必须以 http:// 或 https:// 开头" },
      },
      required: ["url"],
    },
    async execute(params: Record<string, unknown>): Promise<string> {
      const url = String(params.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return `Error: 无效 URL（必须 http/https 开头）: ${url}`;
      }
      const isRepo = isGithubRepoUrl(url);
      const cmd = isRepo ? "python" : "node";
      const args = isRepo
        ? [GITHUB_SUMMARY_PY, url, "--no-clone"]
        : [MD_PAGE_JS, url];
      const env = { ...process.env, PYTHONIOENCODING: "utf-8" };
      log.info(`summarize_url(${isRepo ? "github" : "page"}): ${url}`);
      return new Promise<string>((resolve) => {
        execFile(
          cmd,
          args,
          { cwd, timeout: SUMMARIZE_TIMEOUT, maxBuffer: 4 * 1024 * 1024, env },
          (error, stdout, stderr) => {
            if (error && !stdout) {
              const wasKilled = "killed" in error && error.killed === true;
              const msg = wasKilled
                ? `Command timed out after ${SUMMARIZE_TIMEOUT}ms`
                : error.message;
              resolve(`Error: ${msg}${stderr ? `\nStderr: ${stderr.slice(0, 500)}` : ""}`);
              return;
            }
            let text = stdout;
            if (text.length > SUMMARIZE_MAX_CHARS) {
              text = text.slice(0, SUMMARIZE_MAX_CHARS) + `\n\n...(已截断，原 ${stdout.length} 字符；如需更多请向用户索取章节范围)`;
            }
            resolve(text || stderr.trim() || "(no output)");
          },
        );
      });
    },
  };
}

/**
 * Claw Agent Provider — 通过 claw-agent-sdk 让任何模型获得 Agent 能力
 * 替代 openai-compatible，内置搜索、文件操作等工具
 */
export class ClawAgentProvider implements Provider {
  readonly name: string;
  private config: ProviderConfig;
  private memoryDir?: string;

  constructor(name: string, config: ProviderConfig, memoryDir?: string) {
    this.name = name;
    this.config = config;
    this.memoryDir = memoryDir;
  }

  private async resolveApiKey(): Promise<string> {
    const credentialFile = this.config.credentialFile as string | undefined;
    if (credentialFile) {
      const field = (this.config.credentialField as string | undefined) || "access_token";
      const credentials = JSON.parse(await readFile(expandHome(credentialFile), "utf8")) as Record<string, unknown>;
      const token = credentials[field];
      if (typeof token === "string" && token.length > 0) return token;
      throw new Error(`${this.name}: credential field "${field}" is empty`);
    }
    return this.config.apiKey || process.env[(this.config.apiKeyEnv as string) || ""] || "";
  }

  private async refreshAuthentication(attempt: number): Promise<void> {
    const command = this.config.authRefreshCommand as string | undefined;
    if (!command) {
      throw new Error(`${this.name}: authentication expired and authRefreshCommand is not configured`);
    }
    const args = (this.config.authRefreshArgs as string[] | undefined) || [];
    log.warn(`认证失败，正在刷新凭据并重试 (${attempt})...`);
    await new Promise<void>((resolvePromise, reject) => {
      execFile(
        expandHome(command),
        args,
        {
          cwd: this.memoryDir || process.cwd(),
          timeout: AUTH_REFRESH_TIMEOUT,
          maxBuffer: 1024 * 1024,
          env: { ...process.env },
        },
        (error) => {
          if (error) reject(new Error(`${this.name}: credential refresh failed: ${error.message}`));
          else resolvePromise();
        },
      );
    });
  }

  async query(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): Promise<string> {
    const model = options?.model || (this.config.model as string);
    log.info(`Querying ${this.name} (model: ${model}, session: ${sessionId.slice(0, 8)}...)`);

    const userAgent = this.config.userAgent as string | undefined;
    const originalFetch = userAgent ? global.fetch : undefined;
    if (userAgent && originalFetch) {
      global.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("User-Agent", userAgent);
        return originalFetch(input, { ...init, headers });
      };
    }

    const maxAuthRetries = Math.max(0, Math.min(3, Number(this.config.maxAuthRetries ?? 3)));
    const cwd = options?.cwd || this.memoryDir || process.cwd();
    let result;
    try {
      for (let attempt = 0; ; attempt++) {
        const apiKey = await this.resolveApiKey();
        if (!apiKey) throw new Error(`${this.name}: API Key 未设置`);
        const ai = agent({
          provider: {
            baseUrl: this.config.baseUrl as string,
            apiKey,
            model,
          },
          tools: SAFE_BUILTIN_TOOLS,
          extraTools: [createCrossPlatformBashTool(cwd), createSummarizeUrlTool(cwd)],
          maxTurns: 10,
          maxTokens: (options?.maxTokens as number) || (this.config.maxTokens as number) || 4096,
          systemPrompt: options?.systemPrompt || (this.config.systemPrompt as string) || undefined,
          cwd,
        });
        try {
          result = await ai.run(prompt);
          break;
        } catch (error) {
          if (!isAuthenticationError(error) || attempt >= maxAuthRetries) throw error;
          await this.refreshAuthentication(attempt + 1);
        }
      }
    } finally {
      if (originalFetch) global.fetch = originalFetch;
    }

    // 打印工具调用日志
    for (const step of result.steps) {
      log.info(`工具调用: ${step.tool}(${JSON.stringify(step.input).slice(0, 100)}) [${step.duration}ms]`);
    }

    if (result.usage.totalTokens > 0) {
      log.info(`Tokens: ${result.usage.promptTokens} in / ${result.usage.completionTokens} out`);
    }
    log.info(`Response: ${result.text.length} chars, ${result.steps.length} tool calls, ${result.duration}ms`);

    return result.text;
  }

  async *stream(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): AsyncIterable<ProviderResponse> {
    const apiKey = await this.resolveApiKey();
    if (!apiKey) {
      throw new Error(`${this.name}: API Key 未设置`);
    }

    const model = options?.model || (this.config.model as string);
    log.info(`Streaming ${this.name} (model: ${model}, session: ${sessionId.slice(0, 8)}...)`);

    const userAgent = this.config.userAgent as string | undefined;
    const originalFetch = userAgent ? global.fetch : undefined;
    if (userAgent && originalFetch) {
      global.fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("User-Agent", userAgent);
        return originalFetch(input, { ...init, headers });
      };
    }

    const cwd = options?.cwd || this.memoryDir || process.cwd();
    const ai = agent({
      provider: {
        baseUrl: this.config.baseUrl as string,
        apiKey,
        model,
      },
      tools: SAFE_BUILTIN_TOOLS,
      extraTools: [createCrossPlatformBashTool(cwd), createSummarizeUrlTool(cwd)],
      maxTurns: 10,
      maxTokens: (options?.maxTokens as number) || (this.config.maxTokens as number) || 4096,
      systemPrompt: options?.systemPrompt || (this.config.systemPrompt as string) || undefined,
      cwd,
    });

    try {
      for await (const chunk of ai.stream(prompt)) {
        if (chunk.type === "text" && chunk.text) {
          yield { text: chunk.text, done: false };
        }
        if (chunk.type === "tool_start") {
          log.info(`工具调用: ${chunk.tool}`);
        }
        if (chunk.type === "tool_end" && chunk.step) {
          log.info(`工具完成: ${chunk.tool} [${chunk.step.duration}ms]`);
        }
        if (chunk.type === "done") {
          yield { text: "", done: true };
        }
      }
    } finally {
      if (originalFetch) global.fetch = originalFetch;
    }
  }
}
