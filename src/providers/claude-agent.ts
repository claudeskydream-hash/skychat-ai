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
  private sessions = new Map<string, string>(); // userId -> sessionId

  constructor(config: ProviderConfig) {
    this.config = config;
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
    };

    if (options?.maxTokens) {
      sdkOptions.maxTokens = options.maxTokens;
    }

    if (options?.cwd) {
      sdkOptions.cwd = options.cwd;
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
      throw err;
    }

    // Store session for continuity
    if (newSessionId) {
      this.sessions.set(sessionId, newSessionId);
    }

    const isEmpty = !result;
    if (isEmpty) {
      // 空响应时清除 session，下次请求将新建会话，避免反复 resume 坏 session
      this.sessions.delete(sessionId);
      log.warn(`Claude 返回空响应 [${Date.now() - queryStart}ms, 共${msgCount}条消息]  msgTypes=${JSON.stringify(msgTypeCounts)}  newSessionId=${newSessionId ?? "无"}  已清除 session`);
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
