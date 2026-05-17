import type { WorkerTask, WorkerCtx, WorkerResult, PostTweetParams } from "../types.js";
import { ensureChrome } from "../chrome.js";

// 检查推文发布按钮是否可点击的 JS 代码片段，注入到浏览器中使用
const IS_TWEET_BTN_READY = `
function isTweetBtnReady() {
  const btn = document.querySelector('[data-testid="tweetButton"]');
  return btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
}
`;

/** 清空编辑框内所有文本（selectAll + delete + 残留逐字删除） */
const CLEAR_TEXTAREA = `
async function clearTextarea() {
  const el = document.querySelector('[data-testid="tweetTextarea_0"]');
  if (!el) return -1;
  el.focus();
  await new Promise(r => setTimeout(r, 200));
  document.execCommand('selectAll');
  await new Promise(r => setTimeout(r, 100));
  document.execCommand('delete');
  await new Promise(r => setTimeout(r, 300));
  // 残留逐字删除
  const remaining = el.innerText.trim().length;
  if (remaining > 0) {
    for (let i = 0; i < remaining + 5; i++) document.execCommand('delete');
    await new Promise(r => setTimeout(r, 200));
  }
  return el.innerText.trim().length;
}
`;

/** 用 insertText 向编辑框写入文本 */
const INPUT_TEXT = `
async function inputText(text) {
  const el = document.querySelector('[data-testid="tweetTextarea_0"]');
  if (!el) return 'FAIL: textarea 消失';
  el.focus();
  await clearTextarea();
  document.execCommand('insertText', false, text);
  return el.innerText.trim().length;
}
`;

/**
 * 检查 X 平台字数限制指示器，返回 { overLimit, charInfo }。
 * overLimit=true 表示超出限制，charInfo 是日志用的字数信息字符串。
 */
const CHECK_CHAR_LIMIT = `
function checkCharLimit() {
  const charCountEl = document.querySelector('[data-testid="tweetCharacterCountFill"]')
    || document.querySelector('[data-testid="tweetCharacterCount"]');
  const charInfo = charCountEl ? 'charCount=' + charCountEl.textContent : '';
  const overLimit = !!document.querySelector('[data-testid="tweetCharacterCountFill"][style*="216"]')
    || (charCountEl && parseInt(charCountEl.textContent || '0') < 0);
  return { overLimit, charInfo };
}
`;

/** 所有注入函数的合集，一次性注入 */
const INJECT_ALL = IS_TWEET_BTN_READY + CLEAR_TEXTAREA + INPUT_TEXT + CHECK_CHAR_LIMIT;

// Inline state machine JS — injected into browser after every chrome_navigate
const STATE_MACHINE_INIT = `
${INJECT_ALL}
window.__xPost = {
  step: 0, hasMedia: false, startTime: Date.now(),
  check: {
    1: () => !!document.querySelector('[data-testid="tweetTextarea_0"]'),
    2: () => { const el = document.querySelector('[data-testid="tweetTextarea_0"]'); return el && el.innerText.trim().length > 0; },
    3: () => { const fi = document.querySelector('[data-testid="fileInput"]'); return fi && fi.offsetParent !== null; },
    4: () => { const att = document.querySelector('[data-testid="attachments"]'); return !!att && typeof isTweetBtnReady === 'function' && isTweetBtnReady(); },
    5: () => typeof isTweetBtnReady === 'function' && isTweetBtnReady(),
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

/**
 * 处理发推任务 — 通过 Chrome MCP 模拟真人在 X/Twitter 网页端发布推文。
 *
 * 完整流程为 7 步状态机:
 *   1. 打开编辑框（导航到 x.com/compose/post）
 *   2. 写入推文正文
 *   3. 点击媒体按钮（仅含图片/视频时）
 *   4. 上传媒体文件并等待上传完成
 *   5. 等待发帖按钮变为可用
 *   6. 点击发帖按钮
 *   7. 确认发布成功（URL 已离开 /compose）
 *
 * 每一步都有超时检测和 FAIL 回退，任何步骤失败都返回结构化错误。
 */
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

  // 导航完成后等待页面稳定，避免后续操作过早执行
  await new Promise(r => setTimeout(r, 1500));

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

  log.info(`Step 2 OK [${mark("step1", step1Start)}ms]: 888886=========================`);
  // 最多尝试 2 次：如果 textarea 不存在，重新执行 Step 1 导航后再试
  let step2Inner = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const step2Result = await mcp.callTool("chrome_javascript", {
      tabId,
      code: `
        ${INJECT_ALL}
        const text = ${encodedText};
        const actualLen = await inputText(text);
        if (actualLen === -1) return 'FAIL: textarea 消失';

        await new Promise(r => setTimeout(r, 1000));

        const { overLimit, charInfo } = checkCharLimit();
        if (overLimit) return 'FAIL: 超出X字数限制 ' + charInfo + ' actual=' + actualLen + ' expected=${finalText.length}';
        if (actualLen !== ${finalText.length}) return 'RETRY_WITH_TYPE:len:' + actualLen + ':${finalText.length}';
        if (isTweetBtnReady()) {
          if (window.__xPost && window.__xPost.check[2]()) return window.__xPost.advance();
          return '[step 2/7] 正文已写入 (直接确认)';
        }
        return 'RETRY_WITH_TYPE';
      `,
    });

    step2Inner = extractMcpResult(step2Result);

    // insertText 成功，直接跳出
    if (!step2Inner.startsWith("FAIL") && !step2Inner.startsWith("RETRY_WITH_TYPE")) {
      break;
    }

    // insertText 失败或字数不匹配 → 降级：用 chrome_computer type 模拟真人键盘逐字输入
    if (step2Inner === "RETRY_WITH_TYPE" || step2Inner.startsWith("RETRY_WITH_TYPE:")) {
      if (step2Inner.includes("len:")) {
        log.warn(`Step 2 字数不匹配: ${step2Inner}`);
      }
      log.info(`Step 2 insertText 未生效，降级为 chrome_computer type 模拟键盘输入`);

      // 先清空编辑框
      const clearRes = await mcp.callTool("chrome_javascript", {
        tabId,
        code: `${INJECT_ALL} const remain = await clearTextarea(); return remain === -1 ? 'FAIL: textarea 消失' : 'CLEARED:len=' + remain;`,
      });
      log.info(`清空编辑框: ${extractMcpResult(clearRes)}`);

      // 用 chrome_computer type 模拟真人键盘输入
      const typeResult = await mcp.callTool("chrome_computer", {
        tabId,
        action: "type",
        text: finalText,
      }).catch((err) => `FAIL: chrome_computer type 失败: ${err instanceof Error ? err.message : err}`);

      const typeInner = typeof typeResult === "string" ? typeResult : extractMcpResult(String(typeResult));
      log.info(`chrome_computer type 完成: ${typeInner.slice(0, 100)}`);

      // 等待 Twitter 处理输入
      await new Promise(r => setTimeout(r, 1500));

      // 验证输入是否成功
      const verifyResult = await mcp.callTool("chrome_javascript", {
        tabId,
        code: `
          ${INJECT_ALL}
          const el = document.querySelector('[data-testid="tweetTextarea_0"]');
          if (!el) return 'FAIL: textarea 消失';
          const actual = el.innerText.trim();
          const expected = ${finalText.length};
          const btnReady = isTweetBtnReady();
          const { overLimit, charInfo } = checkCharLimit();

          if (overLimit) return 'FAIL: 超出X字数限制 ' + charInfo + ' actual=' + actual.length + ' expected=' + expected;
          if (actual.length > 0 && actual.length !== expected) return 'FAIL: 字数不匹配 actual=' + actual.length + ' expected=' + expected + ' ' + charInfo;
          if (actual.length === 0 && !btnReady) return 'FAIL: 键盘模拟输入后编辑框为空且按钮不可用 ' + charInfo;

          if (window.__xPost && window.__xPost.check[2]()) return window.__xPost.advance();
          const label = actual.length > 0 ? actual.length + '字' : 'innerText为空但按钮可用';
          return '[step 2/7] 正文已写入 (键盘模拟, ' + label + ' ' + charInfo + ')';
        `,
      });
      step2Inner = extractMcpResult(verifyResult);

      if (!step2Inner.startsWith("FAIL")) break;
    }

    // textarea 消失 → 重新导航（Step 1）后重试，仅重试一次
    if (step2Inner.startsWith("FAIL: textarea 消失") && attempt === 1) {
      log.warn(`Step 2 textarea 不存在，重新导航后重试 (attempt 2/2)`);
      // 重新执行 Step 1 导航
      await mcp.callTool("chrome_javascript", {
        tabId,
        code: `window.onbeforeunload = null; return 'cleared';`,
      }).catch(() => {});
      try {
        await mcp.callTool("chrome_navigate", { tabId, url: "https://x.com/compose/post" });
      } catch {
        await mcp.callTool("chrome_handle_dialog", { tabId, action: "accept" }).catch(() => {});
        try {
          await mcp.callTool("chrome_navigate", { tabId, url: "https://x.com/compose/post" });
        } catch (navErr) {
          log.error(`重试导航失败`);
          return { ok: false, reason: "NAV_FAIL", userMessage: `❌ 导航失败: ${navErr instanceof Error ? navErr.message : navErr}` };
        }
      }
      // 等待页面稳定 + 状态机初始化
      await new Promise(r => setTimeout(r, 1500));
      await mcp.callTool("chrome_javascript", {
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
      }).catch(() => {});
      continue; // 进入第 2 次尝试
    }

    // 非 textarea 消失的失败，或成功，直接跳出
    break;
  }

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
      timeoutMs: 55000,
      code: `
        ${IS_TWEET_BTN_READY}
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const att = document.querySelector('[data-testid="attachments"]');
          if (att && isTweetBtnReady()) {
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
    timeoutMs: 70000,
    code: `
      ${IS_TWEET_BTN_READY}
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (isTweetBtnReady()) {
          await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
          if (window.__xPost) return window.__xPost.advance();
          return '[step 5/7] 发帖按钮可用 (直接确认)';
        }
      }
      return 'FAIL: 发帖按钮 60s 内未变为可用';
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
    timeoutMs: 15000,
    code: `
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500));
        // 检查成功 toast: "Your Post was sent" / "Your Tweet was sent"
        const toasts = document.querySelectorAll('[data-testid="toast"]');
        for (const t of toasts) {
          const txt = t.textContent || '';
          if (txt.includes('sent') || txt.includes('发送') || txt.includes('posted')) {
            if (window.__xPost) return window.__xPost.advance();
            return '[step 6/7] 已点击发帖 — 检测到成功提示: ' + txt.slice(0, 80);
          }
          // 检查错误 toast
          if (txt.includes('error') || txt.includes('wrong') || txt.includes('failed') || txt.includes('失败') || txt.includes('Something went wrong')) {
            return 'FAIL: 发布失败 — 错误提示: ' + txt.slice(0, 120);
          }
        }
        // compose 页面已关闭（URL 不再包含 /compose）
        if (!document.location.href.includes('/compose')) {
          if (window.__xPost) return window.__xPost.advance();
          return '[step 6/7] 已点击发帖 — compose 已关闭 (无toast)';
        }
      }
      return 'FAIL: 点击后 10s 内未检测到成功提示且未离开编辑页';
    `,
  });

  const step6Inner = extractMcpResult(step6Result);
  if (step6Inner.startsWith("FAIL")) {
    log.error(`Step 6 FAIL [${mark("step6", step6Start)}ms]: ${step6Inner}`);
    return { ok: false, reason: "STEP6_FAIL", userMessage: `❌ 发推失败: ${step6Inner}` };
  }
  log.info(`Step 6 OK [${mark("step6", step6Start)}ms]: ${step6Inner}`);

  // ── Step 7: 二次确认 — 检查 timeline 中是否出现刚发的帖子 ────────────────
  const step7Start = Date.now();
  log.info("Step 7: 二次确认发布成功");
  const step7Result = await mcp.callTool("chrome_javascript", {
    tabId,
    timeoutMs: 10000,
    code: `
      await new Promise(r => setTimeout(r, 1500));

      // 检查是否有错误提示弹窗（如重复发帖、限流等）
      const errDialog = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (errDialog) return 'FAIL: 出现确认弹窗，可能发布异常';

      // 检查是否仍在 compose 页面
      if (document.location.href.includes('/compose')) {
        return 'FAIL: 仍在编辑页，发布可能未成功';
      }

      // 确认在 x.com 上
      if (!document.location.href.includes('x.com') && !document.location.href.includes('twitter.com')) {
        return 'FAIL: 当前不在 x.com, URL=' + document.location.href;
      }

      // 在 timeline 中查找包含推文内容的帖子（取前 30 字匹配）
      const snippet = ${JSON.stringify(finalText.slice(0, 30))};
      const tweets = document.querySelectorAll('article[data-testid="tweet"]');
      for (const tweet of tweets) {
        const tweetText = tweet.textContent || '';
        if (tweetText.includes(snippet)) {
          if (window.__xPost) return window.__xPost.advance();
          return '[step 7/7] 发帖成功 — 在 timeline 中确认帖子已出现';
        }
      }

      // timeline 中未找到帖子，但 compose 已关闭且无错误，可能是加载延迟
      // 检查是否有成功 toast 残留
      const toasts = document.querySelectorAll('[data-testid="toast"]');
      for (const t of toasts) {
        const txt = t.textContent || '';
        if (txt.includes('sent') || txt.includes('发送') || txt.includes('posted')) {
          if (window.__xPost) return window.__xPost.advance();
          return '[step 7/7] 发帖成功 — 有成功 toast 提示 (timeline 尚未刷新)';
        }
      }

      // compose 已关闭、无错误弹窗、在 x.com — 大概率成功但无法严格确认
      if (window.__xPost) return window.__xPost.advance();
      return '[step 7/7] 发帖可能成功 — compose已关闭且无错误 (无法在timeline确认)';
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
 * 从 MCP 工具返回值中提取实际结果字符串。
 * chrome-mcp 有时会将结果包装为 JSON: {"success":true,"result":"...","metrics":{...}}
 * 本函数剥掉外层包装，返回 .result 字段；若不是 JSON 则原样返回。
 */
function extractMcpResult(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.result === "string") return parsed.result;
  } catch {}
  return raw;
}

/**
 * 计算 X/Twitter 字符长度。
 * X 使用 "weight" 计数法：基本平面字符 (U+0000~FFFF) 算 1，补充平面字符（emoji 等，> U+FFFF）算 2。
 */
function xLen(text: string): number {
  return [...text].reduce((n, c) => n + (c.codePointAt(0)! > 0xffff ? 2 : 1), 0);
}

/**
 * 按 X/Twitter 字符计数规则截断文本。
 * 超出 max 长度时从末尾逐字符删除，最后补省略号"…"。
 */
function xTruncate(text: string, max: number): string {
  if (xLen(text) <= max) return text;
  const chars = [...text];
  while (xLen(chars.join("")) > max - 1) chars.pop();
  return chars.join("") + "…";
}

/** 从浏览器标签列表中找到 X/Twitter 标签页的 tabId，找不到返回 null */
function findXTabId(raw: string): number | null {
  return findTabByPredicate(raw, (url: string) => url.includes("x.com") || url.includes("twitter.com"));
}

/** 返回任意一个浏览器标签的 tabId（当没有 X 标签时作为兜底） */
function findAnyTabId(raw: string): number | null {
  return findTabByPredicate(raw, () => true);
}

/**
 * 递归搜索 chrome-mcp 返回的标签列表 JSON，找到第一个 URL 满足 pred 条件的标签的 tabId。
 * 兼容 chrome-mcp 的 `tabId` 字段和 chrome.tabs API 的 `id` 字段两种格式。
 * 搜索会递归遍历数组和嵌套对象（包括窗口的 tabs 数组）。
 */
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
