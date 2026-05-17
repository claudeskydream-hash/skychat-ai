import { createConnection } from "node:net";
import { execSync, spawn } from "node:child_process";

const MCP_PORT = 12306;
const CHROME_EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LAUNCH_TIMEOUT_MS = 30_000;        // max wait for TCP port 12306 to open
const POLL_INTERVAL_MS = 2_000;          // TCP port check interval
const SSE_PROBE_URL = `http://127.0.0.1:${MCP_PORT}/sse`;
const SSE_PROBE_TIMEOUT_MS = 3_000;      // single SSE probe timeout
const SSE_READY_TIMEOUT_MS = 60_000;     // max wait for extension to auto-connect after port opens
const SSE_READY_INTERVAL_MS = 2_000;     // SSE probe interval while waiting for extension

type Logger = { info: (s: string) => void; warn: (s: string) => void };

/** Check whether port 12306 is accepting connections */
export function isChromeMcpPortOpen(timeout = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: "127.0.0.1", port: MCP_PORT });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeout);
    sock.on("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/** Return true if a chrome.exe process is running */
function isChromeRunning(): boolean {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', {
      encoding: "utf-8",
      shell: "cmd.exe",
      timeout: 3000,
    });
    return out.toLowerCase().includes("chrome.exe");
  } catch {
    return false;
  }
}

export interface ExtProbeResult {
  ok: boolean;
  reason: string;       // 简要原因（成功时记 HTTP 状态 + content-type）
  elapsedMs: number;
}

/**
 * Probe whether the chrome-mcp extension has actually connected to its native bridge.
 * TCP port 12306 may accept connections (the bridge process is running) even when the
 * extension is not yet "Connected" via the popup. In that case GET /sse never returns
 * headers and the SDK connect will hang. We detect this with a fast preflight.
 */
export async function probeChromeMcpExt(): Promise<ExtProbeResult> {
  const start = Date.now();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), SSE_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(SSE_PROBE_URL, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
    resp.body?.cancel().catch(() => {});
    const ct = resp.headers.get("content-type") || "";
    const elapsedMs = Date.now() - start;
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}`, elapsedMs };
    if (!ct.toLowerCase().includes("text/event-stream")) {
      return { ok: false, reason: `content-type=${ct || "(空)"}`, elapsedMs };
    }
    return { ok: true, reason: `HTTP ${resp.status} ct=${ct}`, elapsedMs };
  } catch (err) {
    const elapsedMs = Date.now() - start;
    if (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message))) {
      return { ok: false, reason: `预检超时 ${SSE_PROBE_TIMEOUT_MS}ms`, elapsedMs };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg, elapsedMs };
  } finally {
    clearTimeout(t);
  }
}

/** Backwards-compatible boolean version */
export async function isChromeMcpExtConnected(): Promise<boolean> {
  return (await probeChromeMcpExt()).ok;
}

/**
 * Poll the SSE probe until the extension finishes its native messaging handshake
 * and the bridge starts serving event-stream responses.
 *
 * Right after Chrome launches, the bridge process opens TCP port 12306 quickly,
 * but the extension still needs time to: load SW → ensureNativeConnected →
 * native handshake → SERVER_STARTED. During this window /sse will not return
 * a real event-stream response (or returns wrong content-type / no headers).
 */
export async function waitForChromeMcpExtReady(
  log: Logger,
  timeoutMs = SSE_READY_TIMEOUT_MS,
): Promise<{ ok: boolean; lastReason: string; waitedMs: number }> {
  const start = Date.now();
  const deadline = start + timeoutMs;
  let lastReason = "(尚未探测)";
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const probe = await probeChromeMcpExt();
    if (probe.ok) {
      const waited = Date.now() - start;
      log.info(`SSE 就绪 [attempt=${attempt} 等待=${waited}ms ${probe.reason}]`);
      return { ok: true, lastReason: probe.reason, waitedMs: waited };
    }
    lastReason = probe.reason;
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) break;
    log.info(`SSE 未就绪 [attempt=${attempt} ${probe.reason} 探测=${probe.elapsedMs}ms 剩余=${remaining}s]`);
    await new Promise<void>((r) => setTimeout(r, SSE_READY_INTERVAL_MS));
  }
  return { ok: false, lastReason, waitedMs: Date.now() - start };
}

/** Poll port 12306 until it opens or deadline passes */
async function waitForPort(timeoutMs: number, log: Logger): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isChromeMcpPortOpen()) return true;
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) break;
    log.info(`等待 chrome-mcp 端口 12306 开放... (剩余 ${remaining}s)`);
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Ensure chrome-mcp is fully ready (TCP port open AND extension SSE handshake done).
 * If Chrome is not running, launches it and waits for both stages.
 */
export async function ensureChrome(
  log: Logger,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const chromeRunning = isChromeRunning();
  const portAlreadyOpen = await isChromeMcpPortOpen();

  if (portAlreadyOpen) {
    log.info("chrome-mcp 端口 12306 已就绪，快速预检扩展连接...");
    const quick = await probeChromeMcpExt();
    if (quick.ok) {
      log.info(`chrome-mcp 已就绪（${quick.reason}, ${quick.elapsedMs}ms）`);
      return { ok: true };
    }
    log.warn(`端口已开但扩展未就绪 (${quick.reason} ${quick.elapsedMs}ms)，进入轮询等待...`);
  } else {
    log.info(`chrome-mcp 端口 12306 未开放 | Chrome 进程: ${chromeRunning ? "运行中" : "未运行"}`);
    if (!chromeRunning) {
      // 必须传一个起始 URL：现代 Chrome 扩展 service worker 是 lazy 激活的，
      // 没有标签页/事件触发的话 onStartup 监听器不会跑 → 扩展不会自动 connectNative。
      // 同时屏蔽首次运行/默认浏览器对话框，避免 UI 阻塞扩展启动。
      const launchArgs = [
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ];
      log.info(`正在启动 Chrome: ${CHROME_EXE} ${launchArgs.join(" ")}`);
      try {
        spawn(CHROME_EXE, launchArgs, { detached: true, stdio: "ignore" }).unref();
      } catch (err) {
        return {
          ok: false,
          message: `Chrome 启动失败: ${err instanceof Error ? err.message : err}`,
        };
      }
    }

    log.info(`等待 chrome-mcp 端口开放（最多 ${LAUNCH_TIMEOUT_MS / 1000}s）...`);
    const portReady = await waitForPort(LAUNCH_TIMEOUT_MS, log);
    if (!portReady) {
      const hint = chromeRunning
        ? "Chrome 已在运行，但 chrome-mcp 扩展未开放端口"
        : `Chrome 已启动，但 chrome-mcp 扩展未在 ${LAUNCH_TIMEOUT_MS / 1000}s 内开放端口`;
      return { ok: false, message: `❌ ${hint}，请检查扩展是否安装并启用` };
    }
    log.info("chrome-mcp 端口已开放，等待扩展自动连接 native bridge...");
  }

  // 端口开放后，给扩展时间走完 SW startup → ensureNativeConnected → SERVER_STARTED 流程
  const wait = await waitForChromeMcpExtReady(log);
  if (wait.ok) {
    log.info(`chrome-mcp 已就绪（扩展自动连接完成, 等待=${wait.waitedMs}ms）`);
    return { ok: true };
  }
  log.warn(`扩展自动连接超时: 最后状态=${wait.lastReason} 总等待=${wait.waitedMs}ms`);
  return {
    ok: false,
    message:
      `❌ chrome-mcp 扩展在 ${SSE_READY_TIMEOUT_MS / 1000}s 内未完成自动连接 (${wait.lastReason})：请打开 Chrome → 点击扩展图标 → Connect`,
  };
}
