import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import type { Provider, ProviderOptions, ProviderConfig } from "../types.js";

const log = createLogger("claude");

const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Bash", "WebSearch", "WebFetch"];

/** Strip smart quotes, BOM, and whitespace that Windows clipboard may inject into API keys */
function sanitizeKey(key: string): string {
  return key.replace(/[\u200B-\u200D\uFEFF\u201C\u201D\u2018\u2019\u00AB\u00BB"']/g, "").trim();
}

export class ClaudeAgentProvider implements Provider {
  readonly name = "claude-agent";
  private config: ProviderConfig;
  private sessions = new Map<string, string>(); // sessionKey -> SDK sessionId
  private memoryDir?: string;
  private sessionsFile?: string;

  constructor(config: ProviderConfig, memoryDir?: string) {
    this.config = config;
    if (memoryDir) {
      this.memoryDir = memoryDir;
      this.sessionsFile = join(memoryDir, "sessions.json");
      this.loadSessions();
    }
  }

  /** Load the persisted sessionKey→sessionId map from the memory directory */
  private loadSessions(): void {
    if (!this.memoryDir || !this.sessionsFile) return;
    try {
      if (!existsSync(this.memoryDir)) {
        mkdirSync(this.memoryDir, { recursive: true });
      }
      if (existsSync(this.sessionsFile)) {
        const obj = JSON.parse(readFileSync(this.sessionsFile, "utf-8")) as Record<string, string>;
        for (const [key, val] of Object.entries(obj)) {
          if (typeof val === "string") this.sessions.set(key, val);
        }
        log.info(`已从 ${this.sessionsFile} 加载 ${this.sessions.size} 条会话记忆`);
      }
    } catch (err) {
      log.warn(`加载会话记忆失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Persist the sessionKey→sessionId map to the memory directory */
  private persistSessions(): void {
    if (!this.sessionsFile) return;
    try {
      writeFileSync(this.sessionsFile, JSON.stringify(Object.fromEntries(this.sessions), null, 2));
    } catch (err) {
      log.warn(`保存会话记忆失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async query(
    prompt: string,
    sessionId: string,
    options?: ProviderOptions,
  ): Promise<string> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    // Use project-configured API key if available, otherwise SDK falls back to ~/.claude
    const rawKey = this.config.apiKey || process.env.ANTHROPIC_API_KEY;
    if (rawKey) {
      process.env.ANTHROPIC_API_KEY = sanitizeKey(rawKey);
    }

    // Support custom base URL (e.g. GLM Anthropic-compatible endpoint)
    const baseUrl = this.config.baseUrl as string | undefined;
    if (baseUrl) {
      process.env.ANTHROPIC_BASE_URL = baseUrl;
    }

    const allowedTools = options?.allowedTools
      || (this.config.allowedTools as string[])
      || DEFAULT_TOOLS;

    const existingSession = this.sessions.get(sessionId);
    const sdkOptions: Record<string, unknown> = {
      allowedTools,
      permissionMode: "acceptEdits" as const,
      settingSources: ["user", "project"],
      skills: "all",
    };

    if (options?.maxTokens) {
      sdkOptions.maxTokens = options.maxTokens;
    }

    if (options?.cwd) {
      sdkOptions.cwd = options.cwd;
    } else if (this.memoryDir) {
      // Fixed working directory: SDK always operates from the memory directory
      sdkOptions.cwd = this.memoryDir;
    }

    // Resume existing session for conversation continuity
    if (existingSession) {
      sdkOptions.resume = existingSession;
    }

    if (options?.systemPrompt) {
      sdkOptions.systemPrompt = options.systemPrompt;
    }

    const promptPreview = prompt.replace(/\s+/g, " ").slice(0, 120);
    log.info(`Querying Claude (session: ${sessionId.slice(0, 8)}..., resume=${existingSession ? existingSession.slice(0, 8) + "…" : "新会话"}, allowedTools=${allowedTools.length}, prompt="${promptPreview}${prompt.length > 120 ? "…" : ""}")`);

    let result = "";
    let newSessionId: string | undefined;
    let msgCount = 0;
    const msgTypeCounts: Record<string, number> = {};
    const queryStart = Date.now();

    try {
      for await (const message of query({
        prompt,
        options: sdkOptions as any,
      })) {
        msgCount++;
        const msgType = `${(message as any)?.type ?? "?"}${(message as any)?.subtype ? ":" + (message as any).subtype : ""}`;
        msgTypeCounts[msgType] = (msgTypeCounts[msgType] || 0) + 1;

        // Capture session ID from init message
        if (isInitMessage(message)) {
          newSessionId = message.session_id;
        }

        // Capture result text
        if (isResultMessage(message)) {
          result = message.result;
        }

        // Capture assistant text messages for streaming
        if (isAssistantMessage(message)) {
          // accumulate text from assistant messages
          const textContent = extractText(message);
          if (textContent) {
            result = textContent;
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Claude query failed [${Date.now() - queryStart}ms, ${msgCount}条消息]: ${errMsg}  msgTypes=${JSON.stringify(msgTypeCounts)}`);

      // 错误分两类：
      //   A. server 明确告知 session 失效 → 清掉旧 session 用新会话重试 (恢复)
      //   B. 纯认证错误 (403 / Failed to authenticate) → 不要清 session 重试
      //      因为根因通常是 Claude CLI 凭证问题，新会话也会 403,
      //      之前的逻辑反而把唯一能用的旧 session 也清掉，越救越坏 (2026-05-26 事故).
      const isSessionInvalid = /invalid.*session|session.*not found|session.*expired/i.test(errMsg);
      const isAuthError = /403|Failed to authenticate|Request not allowed/i.test(errMsg);
      if (existingSession && isSessionInvalid) {
        log.warn(`session 已失效 (${errMsg.slice(0, 80)}), 清除后以新会话重试...`);
        this.sessions.delete(sessionId);
        this.persistSessions();
        return this.query(prompt, sessionId, options);
      }
      if (isAuthError) {
        log.warn(`认证失败 (${existingSession ? "resume" : "新会话"}): 通常是 Claude CLI 凭证 / OAuth token 过期。不清 session, 请人工 \`claude login\` 或检查 ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN`);
      }
      throw err;
    }

    // Store session for continuity
    if (newSessionId) {
      this.sessions.set(sessionId, newSessionId);
      this.persistSessions();
    }

    const isEmpty = !result;
    if (isEmpty) {
      this.sessions.delete(sessionId);
      this.persistSessions();
      log.warn(`Claude 返回空响应 [${Date.now() - queryStart}ms, 共${msgCount}条消息]  msgTypes=${JSON.stringify(msgTypeCounts)}  newSessionId=${newSessionId ?? "无"}  已清除 session`);
      // 若本次是 resume 旧 session，自动以新 session 重试一次（context 过长时 GLM 易返回空）
      if (existingSession) {
        log.info(`空响应来自 resume 会话，自动新建 session 重试...`);
        return this.query(prompt, sessionId, options);
      }
      result = "(No response from Claude)";
    }

    log.info(`Response: ${result.length} chars [${Date.now() - queryStart}ms, ${msgCount}条消息]  msgTypes=${JSON.stringify(msgTypeCounts)}`);
    return result;
  }
}

// ── Message type guards ──

function isInitMessage(msg: any): msg is { type: "system"; subtype: "init"; session_id: string } {
  return msg?.type === "system" && msg?.subtype === "init" && typeof msg?.session_id === "string";
}

function isResultMessage(msg: any): msg is { result: string } {
  return typeof msg?.result === "string";
}

function isAssistantMessage(msg: any): msg is { type: "assistant"; message: { content: unknown[] } } {
  return msg?.type === "assistant" && msg?.message?.content;
}

function extractText(msg: any): string | null {
  if (!msg?.message?.content) return null;
  const parts: string[] = [];
  for (const block of msg.message.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}
