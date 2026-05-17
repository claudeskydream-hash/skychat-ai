import type { WorkerTask, WorkerCtx, WorkerResult, PostTweetParams } from "../types.js";
import { ensureChrome } from "../chrome.js";

// Inline state machine JS — injected into browser after every chrome_navigate
const STATE_MACHINE_INIT = `
window.__xPost = {
  step: 0, hasMedia: false, startTime: Date.now(),
  check: {
    1: () => !!document.querySelector('[data-testid="tweetTextarea_0"]'),
    2: () => { const el = document.querySelector('[data-testid="tweetTextarea_0"]'); return el && el.innerText.trim().length > 0; },
    3: () => { const fi = document.querySelector('[data-testid="fileInput"]'); return fi && fi.offsetParent !== null; },
    4: () => { const att = document.querySelector('[data-testid="attachments"]'); const btn = document.querySelector('[data-testid="tweetButton"]'); return !!att && !!btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true'; },
    5: () => { const btn = document.querySelector('[data-testid="tweetButton"]'); return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true'; },
    6: () => !document.location.href.includes('/compose'),
    7: () => document.location.href.includes('x.com') && !document.location.href.includes('/compose'),
  },
  advance() { if (this.step < 7) this.step++; return this.status(); },
  status() {
    const labels = { 0:'未开始', 1:'编辑框已打开', 2:'正文已写入', 3:'媒体按钮已点击', 4:'媒体上传完成', 5:'发帖按钮可用', 6:'已点击发帖', 7:'发帖成功' };
    return '[step ' + this.step + '/7] ' + labels[this.step] + ' (' + ((Date.now()-this.startTime)/1000).toFixed(1) + 's)';
  }
};
`;

export async function handlePostTweet(
  task: WorkerTask,
  ctx: WorkerCtx,
): Promise<WorkerResult> {
  const { mcp, log } = ctx;
  const { text, imagePath, videoPath } = task.params as unknown as PostTweetParams;
  const mediaPath = imagePath || videoPath;
  const startAll = Date.now();
  const stepTimes: Record<string, number> = {};
  const mark = (name: string, since: number) => {
    const ms = Date.now() - since;
    stepTimes[name] = ms;
    return ms;
  };

  // Validate and truncate text to 280 X chars
  const finalText = xTruncate(text, 280);
  if (finalText !== text) {
    log.warn(`推文超 280 字，已截断: ${xLen(text)} → ${xLen(finalText)}`);
  }
  log.info(`发推任务开始: taskId=${task.id} textLen=${xLen(finalText)} media=${mediaPath ?? "无"} text="${finalText.slice(0, 60)}${finalText.length > 60 ? "…" : ""}"`);

  // ── 前置检查：确保 Chrome 已启动且 chrome-mcp 端口就绪 ──────────────────
  const chromeReadyStart = Date.now();
  const chromeReady = await ensureChrome(log);
  log.info(`ensureChrome 完成 [${mark("ensureChrome", chromeReadyStart)}ms] ok=${chromeReady.ok}`);
  if (!chromeReady.ok) {
    log.warn(`发推中止: 总耗时=${Date.now() - startAll}ms reason=CHROME_NOT_READY`);
    return { ok: false, reason: "CHROME_NOT_READY", userMessage: chromeReady.message };
  }

  // ── Step 0: Find X tab ──────────────────────────────────────────────────
  const step0Start = Date.now();
  let tabId: number;
  try {
    const tabsRaw = await mcp.callTool("get_windows_and_tabs", {});
    const xTabId = findXTabId(tabsRaw);
    const anyTabId = xTabId ?? findAnyTabId(tabsRaw);
    if (anyTabId === null) {
      log.error(`Step 0 未找到任何标签 [${mark("step0", step0Start)}ms]`);
      return { ok: false, reason: "NO_TAB", userMessage: "❌ 未找到浏览器标签，请先打开 Chrome" };
    }
    tabId = anyTabId;
    log.info(`Step 0 OK [${mark("step0", step0Start)}ms]: tabId=${tabId}${xTabId ? " (X标签)" : " (非X标签，将导航)"}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Step 0 MCP 连接失败 [${mark("step0", step0Start)}ms]: ${msg}`);
    return { ok: false, reason: "MCP_CONNECT_FAIL", userMessage: `❌ 无法连接 chrome-mcp: ${msg}` };
  }

  // ── Login check ─────────────────────────────────────────────────────────
  try {
    const loginResult = await mcp.callTool("chrome_javascript", {
      tabId,
      code: `
        const hasBtn = !!document.querySelector('[data-testid="SideNav_NewTweet_Button"]');
        const hasLogin = !!document.querySelector('[data-testid="loginButton"]');
        if (hasBtn) return 'LOGGED_IN';
        if (hasLogin) return 'NOT_LOGGED_IN';
        return 'UNKNOWN:' + document.location.href;
      `,
    });
    const loginInner = extractMcpResult(loginResult);
    if (loginInner.includes("NOT_LOGGED_IN")) {
      return { ok: false, reason: "NOT_LOGGED_IN", userMessage: "❌ 请先在 Chrome 中登录 X (Twitter) 账号" };
    }
    log.info(`登录状态: ${loginInner.slice(0, 60)}`);
  } catch (err) {
    log.warn(`登录检查失败（可能不在 x.com）: ${err instanceof Error ? err.message : err}`);
  }

  // ── Step 1: Navigate to compose/post ────────────────────────────────────
  const step1Start = Date.now();
  log.info("Step 1: 导航到 compose/post");
  // Clear beforeunload handler to prevent "leave page?" dialog blocking navigation
  await mcp.callTool("chrome_javascript", {
    tabId,
    code: `window.onbeforeunload = null; return 'cleared';`,
  }).catch(() => {});

  try {
    await mcp.callTool("chrome_navigate", {
      tabId,
      url: "https://x.com/compose/post",
    });
  } catch (err) {
    // If a beforeunload dialog appeared, dismiss it and retry navigation
    log.warn(`首次 navigate 失败，尝试关闭对话框后重试: ${err instanceof Error ? err.message : err}`);
    await mcp.callTool("chrome_handle_dialog", { tabId, action: "accept" }).catch(() => {});
    try {
      await mcp.callTool("chrome_navigate", { tabId, url: "https://x.com/compose/post" });
    } catch (err2) {
      log.error(`navigate 重试仍失败 [${mark("step1", step1Start)}ms]`);
      return { ok: false, reason: "NAV_FAIL", userMessage: `❌ 导航失败: ${err2 instanceof Error ? err2.message : err2}` };
    }
  }

  // Re-init state machine after navigation (page reloads, __xPost is lost)
  const step1Result = await mcp.callTool("chrome_javascript", {
    tabId,
    timeoutMs: 12000,
    code: `
      ${STATE_MACHINE_INIT}
      for (let i = 0; i < 12; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (window.__xPost.check[1]()) return window.__xPost.advance();
      }
      return 'FAIL: 编辑框未在 6s 内出现';
    `,
  });

  const step1Inner = extractMcpResult(step1Result);
  if (step1Inner.startsWith("FAIL")) {
    log.error(`Step 1 FAIL [${mark("step1", step1Start)}ms]: ${step1Inner}`);
    return { ok: false, reason: "STEP1_FAIL", userMessage: `❌ 发推失败: ${step1Inner}` };
  }
  log.info(`Step 1 OK [${mark("step1", step1Start)}ms]: ${step1Inner}`);

  // ── Step 2: Write text ──────────────────────────────────────────────────
  const step2Start = Date.now();
  log.info("Step 2: 写入正文");
  const encodedText = JSON.stringify(finalText);
  const step2Result = await mcp.callTool("chrome_javascript", {
    tabId,
    code: `
      const el = document.querySelector('[data-testid="tweetTextarea_0"]');
      if (!el) return 'FAIL: textarea 消失';
      el.focus();
      await new Promise(r => setTimeout(r, 200));
      document.execCommand('selectAll');
      await new Promise(r => setTimeout(r, 100));
      document.execCommand('delete');
      await new Promise(r => setTimeout(r, 200));
      const text = ${encodedText};
      document.execCommand('insertText', false, text);
      await new Promise(r => setTimeout(r, 500));
      if (window.__xPost && window.__xPost.check[2]()) return window.__xPost.advance();
      if (el.innerText.trim().length > 0) return '[step 2/7] 正文已写入 (直接确认)';
      return 'FAIL: 正文写入后编辑框为空';
    `,
  });

  const step2Inner = extractMcpResult(step2Result);
  if (step2Inner.startsWith("FAIL")) {
    log.error(`Step 2 FAIL [${mark("step2", step2Start)}ms]: ${step2Inner}`);
    return { ok: false, reason: "STEP2_FAIL", userMessage: `❌ 发推失败: ${step2Inner}` };
  }
  log.info(`Step 2 OK [${mark("step2", step2Start)}ms]: ${step2Inner}`);

  if (mediaPath) {
    // ── Step 3: Click media button ──────────────────────────────────────
    const step3Start = Date.now();
    log.info("Step 3: 点击媒体按钮");
    await mcp.callTool("chrome_javascript", {
      tabId,
      code: `if (window.__xPost) window.__xPost.hasMedia = true; return 'hasMedia set';`,
    });

    try {
      await mcp.callTool("chrome_click_element", {
        tabId,
        selector: '[role="dialog"] [aria-label="添加照片或视频"], [role="dialog"] [aria-label="Add photos or video"]',
      });
    } catch (err) {
      log.error(`Step 3 点击失败 [${mark("step3", step3Start)}ms]: ${err instanceof Error ? err.message : err}`);
      return { ok: false, reason: "STEP3_CLICK_FAIL", userMessage: `❌ 无法点击媒体按钮: ${err instanceof Error ? err.message : err}` };
    }

    const step3Result = await mcp.callTool("chrome_javascript", {
      tabId,
      code: `
        await new Promise(r => setTimeout(r, 400));
        if (window.__xPost && window.__xPost.check[3]()) return window.__xPost.advance();
        const fi = document.querySelector('[data-testid="fileInput"]');
        if (fi) return '[step 3/7] 媒体按钮已点击 (直接确认)';
        return 'FAIL: fileInput 未出现';
      `,
    });

    const step3Inner = extractMcpResult(step3Result);
    if (step3Inner.startsWith("FAIL")) {
      log.error(`Step 3 FAIL [${mark("step3", step3Start)}ms]: ${step3Inner}`);
      return { ok: false, reason: "STEP3_FAIL", userMessage: `❌ 发推失败: ${step3Inner}` };
    }
    log.info(`Step 3 OK [${mark("step3", step3Start)}ms]: ${step3Inner}`);

    // ── Step 4: Upload file ───────────────────────────────────────────
    const step4Start = Date.now();
    log.info(`Step 4: 上传文件 ${mediaPath}`);
    try {
      await mcp.callTool("chrome_upload_file", {
        tabId,
        selector: '[data-testid="fileInput"]',
        filePath: mediaPath,
      });
    } catch (err) {
      log.error(`Step 4 上传调用失败 [${mark("step4", step4Start)}ms]: ${err instanceof Error ? err.message : err}`);
      return { ok: false, reason: "STEP4_UPLOAD_FAIL", userMessage: `❌ 文件上传失败: ${err instanceof Error ? err.message : err}` };
    }

    // Wait up to 60s for upload completion (attachments node + tweetButton enabled)
    const step4Result = await mcp.callTool("chrome_javascript", {
      tabId,
      timeoutMs: 65000,
      code: `
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const att = document.querySelector('[data-testid="attachments"]');
          const btn = document.querySelector('[data-testid="tweetButton"]');
          if (att && btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
            if (window.__xPost) return window.__xPost.advance();
            return '[step 4/7] 媒体上传完成 (直接确认)';
          }
        }
        return 'FAIL: 上传超时 (60s)';
      `,
    });

    const step4Inner = extractMcpResult(step4Result);
    if (step4Inner.startsWith("FAIL")) {
      log.error(`Step 4 FAIL [${mark("step4", step4Start)}ms]: ${step4Inner}`);
      return { ok: false, reason: "STEP4_FAIL", userMessage: `❌ 发推失败: ${step4Inner}` };
    }
    log.info(`Step 4 OK [${mark("step4", step4Start)}ms]: ${step4Inner}`);
  } else {
    // Skip steps 3 and 4
    await mcp.callTool("chrome_javascript", {
      tabId,
      code: `if (window.__xPost) { window.__xPost.step = 4; return window.__xPost.advance(); } return '[step 5/7] 跳过媒体';`,
    });
  }

  // ── Step 5: Wait for tweet button ───────────────────────────────────────
  const step5Start = Date.now();
  log.info("Step 5: 等待发帖按钮可用");
  const step5Result = await mcp.callTool("chrome_javascript", {
    tabId,
    timeoutMs: 35000,
    code: `
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const btn = document.querySelector('[data-testid="tweetButton"]');
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
          await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
          if (window.__xPost) return window.__xPost.advance();
          return '[step 5/7] 发帖按钮可用 (直接确认)';
        }
      }
      return 'FAIL: 发帖按钮 30s 内未变为可用';
    `,
  });

  const step5Inner = extractMcpResult(step5Result);
  if (step5Inner.startsWith("FAIL")) {
    log.error(`Step 5 FAIL [${mark("step5", step5Start)}ms]: ${step5Inner}`);
    return { ok: false, reason: "STEP5_FAIL", userMessage: `❌ 发推失败: ${step5Inner}` };
  }
  log.info(`Step 5 OK [${mark("step5", step5Start)}ms]: ${step5Inner}`);

  // ── Step 6: Click tweet button ───────────────────────────────────────────
  const step6Start = Date.now();
  log.info("Step 6: 点击发帖按钮");
  try {
    await mcp.callTool("chrome_click_element", {
      tabId,
      selector: '[data-testid="tweetButton"]',
    });
  } catch (err) {
    log.error(`Step 6 点击失败 [${mark("step6", step6Start)}ms]: ${err instanceof Error ? err.message : err}`);
    return { ok: false, reason: "STEP6_CLICK_FAIL", userMessage: `❌ 点击发帖按钮失败: ${err instanceof Error ? err.message : err}` };
  }

  const step6Result = await mcp.callTool("chrome_javascript", {
    tabId,
    code: `
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (!document.location.href.includes('/compose')) {
          if (window.__xPost) return window.__xPost.advance();
          return '[step 6/7] 已点击发帖 (直接确认)';
        }
      }
      return 'FAIL: 点击后仍停留在编辑页';
    `,
  });

  const step6Inner = extractMcpResult(step6Result);
  if (step6Inner.startsWith("FAIL")) {
    log.error(`Step 6 FAIL [${mark("step6", step6Start)}ms]: ${step6Inner}`);
    return { ok: false, reason: "STEP6_FAIL", userMessage: `❌ 发推可能失败（仍在编辑页）: ${step6Inner}` };
  }
  log.info(`Step 6 OK [${mark("step6", step6Start)}ms]: ${step6Inner}`);

  // ── Step 7: Verify success ───────────────────────────────────────────────
  const step7Start = Date.now();
  log.info("Step 7: 确认发布成功");
  const step7Result = await mcp.callTool("chrome_javascript", {
    tabId,
    code: `
      await new Promise(r => setTimeout(r, 1000));
      if (document.location.href.includes('x.com') && !document.location.href.includes('/compose')) {
        if (window.__xPost) return window.__xPost.advance();
        return '[step 7/7] 发帖成功 (直接确认)';
      }
      return 'FAIL: 当前 URL = ' + document.location.href;
    `,
  });

  const step7Inner = extractMcpResult(step7Result);
  if (step7Inner.startsWith("FAIL")) {
    log.error(`Step 7 FAIL [${mark("step7", step7Start)}ms]: ${step7Inner}`);
    return { ok: false, reason: "STEP7_FAIL", userMessage: `❌ 发推确认失败: ${step7Inner}` };
  }
  log.info(`Step 7 OK [${mark("step7", step7Start)}ms]: ${step7Inner}`);

  log.info(`发推任务完成: taskId=${task.id} 总耗时=${Date.now() - startAll}ms 分段=${JSON.stringify(stepTimes)}`);
  return { ok: true, userMessage: "✅ 推文已发布" };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * MCP tool results may be JSON-wrapped: {"success":true,"result":"FAIL: ...","metrics":{...}}
 * Extract the inner .result string so FAIL checks work correctly.
 */
function extractMcpResult(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.result === "string") return parsed.result;
  } catch {}
  return raw;
}

function xLen(text: string): number {
  return [...text].reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0);
}

function xTruncate(text: string, max: number): string {
  if (xLen(text) <= max) return text;
  const chars = [...text];
  while (xLen(chars.join("")) > max - 1) chars.pop();
  return chars.join("") + "…";
}

function findXTabId(raw: string): number | null {
  return findTabByPredicate(raw, (url: string) => url.includes("x.com") || url.includes("twitter.com"));
}

function findAnyTabId(raw: string): number | null {
  return findTabByPredicate(raw, () => true);
}

function findTabByPredicate(raw: string, pred: (url: string) => boolean): number | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  const search = (obj: unknown): number | null => {
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = search(item);
        if (r !== null) return r;
      }
    } else if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      // chrome-mcp uses `tabId`; chrome.tabs API uses `id`. Accept both.
      const tabIdValue = typeof o.tabId === "number" ? o.tabId : (typeof o.id === "number" ? o.id : null);
      if (tabIdValue !== null && typeof o.url === "string" && pred(o.url)) {
        return tabIdValue;
      }
      // Window entry: has tabs array
      if (Array.isArray(o.tabs)) {
        for (const tab of o.tabs) {
          const r = search(tab);
          if (r !== null) return r;
        }
      }
      // Recurse into all values
      for (const val of Object.values(o)) {
        const r = search(val);
        if (r !== null) return r;
      }
    }
    return null;
  };

  return search(data);
}
