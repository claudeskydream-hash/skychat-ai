import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { createLogger } from "../logger.js";
import type { IMcpClient } from "./types.js";

const log = createLogger("worker-mcp");

// chrome-mcp native server SSE endpoint
const CHROME_MCP_SSE_URL = "http://127.0.0.1:12306/sse";
const CONNECT_TIMEOUT_MS = 15_000;

function EXT_NOT_CONNECTED_HINT(reason: string): string {
  return `chrome-mcp 扩展未连接 (${reason})：请打开 Chrome → 点击 chrome-mcp 扩展图标 → Connect 后重试`;
}

export class WorkerMcpClient implements IMcpClient {
  private client: Client | null = null;
  private connectPromise: Promise<void> | null = null;

  async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    this.connectPromise = this.doConnect();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async doConnect(): Promise<void> {
    const startAll = Date.now();
    log.info(`正在连接 chrome-mcp @ ${CHROME_MCP_SSE_URL} ...`);

    // 注：扩展就绪性由调用方（chrome.ts:ensureChrome 的 waitForChromeMcpExtReady）保证。
    // 这里只用 SDK 自带的 abort + 10s 超时兜底。

    const transport = new SSEClientTransport(new URL(CHROME_MCP_SSE_URL));
    const client = new Client(
      { name: "skychat-worker", version: "1.0.0" },
      { capabilities: {} },
    );

    let timedOut = false;
    const sdkStart = Date.now();
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn(`SDK connect 超过 ${CONNECT_TIMEOUT_MS / 1000}s 未完成 (实际 ${Date.now() - sdkStart}ms)，主动关闭 transport`);
      // transport.close() 会 abort 内部 EventSource 的 fetch，使 client.connect 立即 reject
      transport.close().catch(() => {});
    }, CONNECT_TIMEOUT_MS);

    try {
      await client.connect(transport);
    } catch (err) {
      if (timedOut) {
        throw new Error(EXT_NOT_CONNECTED_HINT(`SDK connect 超时 (${CONNECT_TIMEOUT_MS / 1000}s)`));
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`SDK connect 失败 [${Date.now() - sdkStart}ms]: ${msg}`);
      throw new Error(`chrome-mcp 连接失败: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    this.client = client;
    const serverInfo = client.getServerVersion?.();
    const serverDesc = serverInfo ? `${serverInfo.name ?? "?"} v${serverInfo.version ?? "?"}` : "(无版本信息)";
    log.info(`chrome-mcp 连接成功 @ ${CHROME_MCP_SSE_URL}  服务端=${serverDesc}  SDK耗时=${Date.now() - sdkStart}ms  总耗时=${Date.now() - startAll}ms`);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    // 第一次尝试；遇到连接级错误（典型："No transport found for sessionId"、"Not connected" 等
    // 说明缓存的 client / SSE session 已被 bridge 回收）时自动重连并重试一次。
    return this.callToolWithRetry(name, args, 1);
  }

  private async callToolWithRetry(
    name: string,
    args: Record<string, unknown>,
    retriesLeft: number,
  ): Promise<string> {
    await this.ensureConnected();
    if (!this.client) throw new Error("chrome-mcp 未连接");

    const argsSummary = JSON.stringify(args, (_k, v) =>
      typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v,
    );
    log.info(`→ MCP ${name}  args=${argsSummary}`);

    const callStart = Date.now();
    try {
      const result = await this.client.callTool({ name, arguments: args });
      const texts: string[] = [];
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (item.type === "text" && typeof item.text === "string") {
            texts.push(item.text);
          }
        }
      }
      const out = texts.join("\n") || JSON.stringify(result.content);
      log.info(`← MCP ${name}  [${Date.now() - callStart}ms]  result=${out.slice(0, 200)}${out.length > 200 ? "…" : ""}`);
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isStaleSession = /No transport found for sessionId|Not connected|SSE connection not established|sessionId/i.test(msg);
      log.error(`← MCP ${name}  [${Date.now() - callStart}ms]  ERROR: ${msg}${isStaleSession ? "  (sessionId 已失效)" : ""}`);

      // Reset cached client so the next ensureConnected creates a fresh SSE transport
      await this.forceClose();

      if (isStaleSession && retriesLeft > 0) {
        log.warn(`MCP ${name} 因 session 失效，自动重连重试 (剩余=${retriesLeft})`);
        return this.callToolWithRetry(name, args, retriesLeft - 1);
      }
      throw err;
    }
  }

  /** Close current SSE transport (if any) and clear cached client */
  private async forceClose(): Promise<void> {
    if (this.client) {
      try { await this.client.close(); } catch { /* ignore */ }
      this.client = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.close();
      } catch {}
      this.client = null;
    }
  }
}
