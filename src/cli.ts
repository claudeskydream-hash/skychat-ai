#!/usr/bin/env node

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ProviderConfig } from "./types.js";
import { loadConfig, saveConfig, getDataDir } from "./config.js";
import { Gateway } from "./gateway.js";
import { setLogLevel, initFileLogger, createLogger } from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
const VERSION = pkg.version as string;

const log = createLogger("cli");

const HELP = `
  \x1b[1mskychat-ai\x1b[0m — WeChat AI Bot

  \x1b[1m命令:\x1b[0m
    skychat-ai                        启动 (首次自动扫码登录)
    skychat-ai start                  后台运行 (daemon 模式)
    skychat-ai stop                   停止后台进程
    skychat-ai logs                   查看后台日志
    skychat-ai logout                 退出登录 (清除微信账号)
    skychat-ai set <provider> <key>   设置模型 API Key
    skychat-ai use <provider>         设置默认模型
    skychat-ai config                 查看当前配置
    skychat-ai send-text <文字> [选项]  发送文字消息到微信
    skychat-ai send <文件> [选项]      发送媒体文件到微信
    skychat-ai update                 更新到最新版
    skychat-ai help                   显示帮助

  \x1b[1m设置 API Key:\x1b[0m
    skychat-ai set qwen sk-xxx        设置通义千问 Key
    skychat-ai set deepseek sk-xxx    设置 DeepSeek Key
    skychat-ai set claude sk-xxx      设置 Claude Key
    skychat-ai set kimi sk-xxx        设置 Kimi (Moonshot) Key
    skychat-ai set openrouter sk-xxx  设置 OpenRouter Key (第三方模型)

  \x1b[1m设置默认模型:\x1b[0m
    skychat-ai use qwen               默认使用 Qwen
    skychat-ai use deepseek           默认使用 DeepSeek

  \x1b[1m发送文件:\x1b[0m
    skychat-ai send video.mp4        发送视频 (自动检测类型)
    skychat-ai send song.mp3         发送音乐/语音
    skychat-ai send photo.jpg        发送图片
    skychat-ai send report.pdf       发送文件
    skychat-ai send --all --dir ~/下载  批量发送目录下所有媒体

  \x1b[1m微信指令:\x1b[0m
    /model                           查看当前模型
    /model qwen                      切换到 Qwen
    /model google/gemini-2.5-pro     第三方模型 (via OpenRouter)
    /help                            显示帮助
`;

function printBanner(defaultProvider: string): void {
  const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    gray: "\x1b[90m",
    white: "\x1b[97m",
    orange: "\x1b[38;5;208m",
    border: "\x1b[38;5;60m",  // muted blue-gray, similar to Claude Code
  };

  const boxW = 44;
  const inner = boxW - 2;
  const b = c.border;
  const empty = `  ${b}│${c.reset}${" ".repeat(inner)}${b}│${c.reset}`;

  const displayWidth = (s: string) => {
    const stripped = s.replace(/\x1b\[[0-9;]*m/g, "");
    let w = 0;
    for (const ch of stripped) {
      const code = ch.codePointAt(0)!;
      w += (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ? 2 : 1;
    }
    return w;
  };
  const center = (s: string) => {
    const w = displayWidth(s);
    const left = Math.floor((inner - w) / 2);
    const right = inner - w - left;
    return `  ${b}│${c.reset}${" ".repeat(left)}${s}${" ".repeat(right)}${b}│${c.reset}`;
  };
  // Title embedded in top border, centered
  const titleText = ` SkyChat AI v${VERSION} `;
  const titleLen = titleText.length;
  const sideL = Math.floor((inner - titleLen) / 2);
  const sideR = inner - titleLen - sideL;
  const topBorder = `  ${b}╭${"─".repeat(sideL)}${c.reset}${c.bold}${c.white}${titleText}${c.reset}${b}${"─".repeat(sideR)}╮${c.reset}`;

  // Icons: Cloud holding a holy sword
  const icons = [
    `${c.orange}       /\\${c.reset}`,
    `${c.white}   _.${c.reset}${c.dim}.'${c.reset}${c.orange}\\  /${c.reset}${c.dim}'.${c.reset}${c.white}._${c.reset}`,
    `${c.white} .'    ${c.orange}|  |${c.white}    '.${c.reset}`,
    `${c.white}/  @   ${c.orange}|::|${c.white}   @ \\${c.reset}`,
    `${c.white}| ~~~  ${c.orange}|::|${c.white}  ~~~ |${c.reset}`,
    `${c.white} \\____${c.orange}|  |${c.white}____/${c.reset}`,
    `${c.white}    ${c.dim}\\_${c.orange}+--${c.white}+_/${c.dim}/${c.reset}`,
    `${c.dim}      |  |${c.reset}`,
    `${c.dim}     _|  |_${c.reset}`,
    `${c.dim}    /______\\${c.reset}`,
  ];

  const welcome = `${c.bold}${c.white}Welcome!${c.reset}`;
  const cwd = `${c.dim}cwd: ${process.cwd()}${c.reset}`;
  const info = defaultProvider
    ? `${c.dim}model: ${defaultProvider} · type /help in chat${c.reset}`
    : `${c.dim}type /help in chat${c.reset}`;

  console.log();
  console.log(topBorder);
  console.log(empty);
  console.log(center(welcome));
  console.log(empty);
  for (const line of icons) {
    console.log(center(line));
  }
  console.log(empty);
  console.log(center(info));
  console.log(center(cwd));
  console.log(`  ${b}╰${"─".repeat(inner)}╯${c.reset}`);
  console.log();
}

/** Check if a provider has any usable auth: config key, env var, or provider-specific auth */
function isProviderReady(prov: ProviderConfig): boolean {
  // Config API key
  if (prov.apiKey) return true;
  // Environment variable
  const envKey = (prov as Record<string, unknown>).apiKeyEnv as string | undefined;
  if (envKey && process.env[envKey]) return true;
  // Provider-specific: claude-agent uses ~/.claude auth
  if (prov.type === "claude-agent") {
    return existsSync(join(homedir(), ".claude")) || !!process.env.ANTHROPIC_API_KEY;
  }
  return false;
}

async function autoUpdate(currentVersion: string): Promise<void> {
  // Skip in daemon mode
  if (process.env.WAI_DAEMON) return;

  try {
    const { execSync } = await import("node:child_process");
    const latest = execSync("npm view skychat-ai version", {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    if (!latest || latest === currentVersion) return;

    // Compare semver: only update if latest is newer
    const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number) as [number, number, number];
    const [cMaj, cMin, cPat] = parse(currentVersion);
    const [lMaj, lMin, lPat] = parse(latest);
    const isNewer = lMaj > cMaj
      || (lMaj === cMaj && lMin > cMin)
      || (lMaj === cMaj && lMin === cMin && lPat > cPat);
    if (!isNewer) return;

    console.log(`\x1b[36m⟳\x1b[0m 发现新版本 v${currentVersion} → v${latest}，正在更新...`);
    execSync("npm i -g skychat-ai@latest", { stdio: "inherit", timeout: 60000 });
    console.log(`\x1b[32m✓\x1b[0m 更新完成，正在重启...\n`);

    // Re-exec with the new version
    const { spawnSync } = await import("node:child_process");
    spawnSync(process.execPath, [process.argv[1]!, ...process.argv.slice(2)], {
      stdio: "inherit",
    });
    process.exit(0);
  } catch {
    // Update check failed silently — don't block startup
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const logLevel = (process.env.WAI_LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error";
  setLogLevel(logLevel);

  // File logging: always write to D:\AIWorkSpace\Log (or WAI_LOG_DIR override)
  const logDir = process.env.WAI_LOG_DIR || "D:\\AIWorkSpace\\Log";
  initFileLogger(logDir);
  // Print log file location so it's easy to tail or inspect
  const today = new Date().toISOString().slice(0, 10);
  const { join: pathJoin } = await import("node:path");
  const logFile = pathJoin(logDir, `skychat-${today}.log`);
  console.log(`\x1b[2m  日志文件: ${logFile}\x1b[0m`);

  if (command === "--version" || command === "-v") {
    console.log(`skychat-ai v${VERSION}`);
    process.exit(0);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  const config = await loadConfig();

  switch (command) {
    case "set": {
      const provider = args[1];
      const apiKey = args[2];

      if (!provider || !apiKey) {
        console.log("用法: skychat-ai set <provider> <key>");
        console.log("示例: skychat-ai set qwen sk-xxx");
        process.exit(1);
      }

      if (!config.providers[provider]) {
        console.log(`未知模型: ${provider}`);
        console.log(`可用: ${Object.keys(config.providers).join(", ")}`);
        process.exit(1);
      }

      // Strip smart quotes, BOM, whitespace that Windows clipboard may inject
      const cleanKey = apiKey.replace(/[\u200B-\u200D\uFEFF\u201C\u201D\u2018\u2019\u00AB\u00BB"']/g, "").trim();
      if (cleanKey !== apiKey) {
        console.log("\x1b[33m⚠\x1b[0m 已自动清理 API Key 中的特殊引号字符");
      }
      config.providers[provider]!.apiKey = cleanKey;

      // Auto-switch default if current default has no key
      if (config.defaultProvider !== provider && !isProviderReady(config.providers[config.defaultProvider]!)) {
        config.defaultProvider = provider;
        console.log(`\x1b[36mℹ\x1b[0m 默认模型已自动切换到 ${provider}`);
      }

      await saveConfig(config);
      console.log(`\x1b[32m✓\x1b[0m 已保存 ${provider} 的 API Key`);
      break;
    }

    case "use": {
      const provider = args[1];

      if (!provider) {
        console.log(`当前默认模型: ${config.defaultProvider}`);
        console.log(`可用: ${Object.keys(config.providers).join(", ")}`);
        break;
      }

      if (!config.providers[provider]) {
        console.log(`未知模型: ${provider}`);
        console.log(`可用: ${Object.keys(config.providers).join(", ")}`);
        process.exit(1);
      }

      config.defaultProvider = provider;
      await saveConfig(config);
      console.log(`\x1b[32m✓\x1b[0m 默认模型已切换到 ${provider}`);
      break;
    }

    case "update": {
      const { execSync } = await import("node:child_process");
      console.log(`正在更新 skychat-ai... (当前 v${VERSION})`);
      try {
        execSync("npm i -g skychat-ai@latest", { stdio: "inherit" });
        // Read the newly installed version
        let newVersion = "latest";
        try {
          newVersion = execSync("npm info skychat-ai version", { encoding: "utf-8" }).trim();
        } catch { /* ignore */ }
        console.log(`\x1b[32m✓\x1b[0m 更新完成 v${VERSION} → v${newVersion}`);
      } catch {
        console.error("\x1b[31m✗\x1b[0m 更新失败，请手动执行: npm i -g skychat-ai@latest");
        process.exit(1);
      }
      break;
    }

    case "start": {
      const pidFile = join(getDataDir(), "daemon.pid");
      const logFile = join(getDataDir(), "daemon.log");

      if (existsSync(pidFile)) {
        const oldPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        try {
          process.kill(oldPid, 0);
          console.log(`\x1b[33m⚠\x1b[0m 已有进程在运行 (PID: ${oldPid})`);
          console.log(`  停止: skychat-ai stop`);
          console.log(`  日志: skychat-ai logs`);
          process.exit(1);
        } catch {
          unlinkSync(pidFile);
        }
      }

      const { spawn } = await import("node:child_process");
      const { openSync } = await import("node:fs");

      const out = openSync(logFile, "a");
      const child = spawn(process.execPath, [join(__dirname, "cli.js")], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
        env: { ...process.env, WAI_DAEMON: "1" },
      });

      const { writeFileSync } = await import("node:fs");
      writeFileSync(pidFile, String(child.pid));
      child.unref();

      console.log(`\x1b[32m✓\x1b[0m 已在后台启动 (PID: ${child.pid})`);
      console.log(`  日志: skychat-ai logs`);
      console.log(`  停止: skychat-ai stop`);
      break;
    }

    case "stop": {
      const pidPath = join(getDataDir(), "daemon.pid");
      if (!existsSync(pidPath)) {
        console.log("没有运行中的后台进程");
        process.exit(1);
      }

      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try {
        process.kill(pid, "SIGTERM");
        unlinkSync(pidPath);
        console.log(`\x1b[32m✓\x1b[0m 已停止后台进程 (PID: ${pid})`);
      } catch {
        unlinkSync(pidPath);
        console.log("进程已不存在，已清理 PID 文件");
      }
      break;
    }

    case "logs": {
      const logPath = join(getDataDir(), "daemon.log");
      if (!existsSync(logPath)) {
        console.log("没有日志文件");
        process.exit(1);
      }

      const follow = args.includes("-f") || args.includes("--follow");
      const { readFileSync, statSync, watchFile, unwatchFile, createReadStream } = await import("node:fs");

      // Show last 100 lines
      const content = readFileSync(logPath, "utf-8");
      const lines = content.split("\n");
      process.stdout.write(lines.slice(-101).join("\n"));

      if (follow) {
        let position = statSync(logPath).size;
        const check = () => {
          let newSize: number;
          try { newSize = statSync(logPath).size; } catch { return; }
          if (newSize > position) {
            const stream = createReadStream(logPath, { start: position, encoding: "utf-8" });
            stream.on("data", (chunk) => process.stdout.write(String(chunk)));
            stream.on("end", () => { position = newSize; });
          }
        };
        watchFile(logPath, { interval: 500 }, check);
        process.on("SIGINT", () => { unwatchFile(logPath); process.exit(0); });
      }
      break;
    }

    case "logout": {
      const { getAccountsDir } = await import("./config.js");
      const { rmSync } = await import("node:fs");
      const accountsDir = getAccountsDir();
      const target = args[1]?.toLowerCase(); // e.g. "skychat-ai logout whatsapp"

      const channelData: Record<string, { files?: string[]; dirs?: string[] }> = {
        weixin: { files: ["weixin.json", "weixin-sync.json", "weixin-tokens.json", "weixin-guide-sent.json"] },
        whatsapp: { dirs: ["whatsapp-auth"] },
      };

      const channels = target && channelData[target]
        ? { [target]: channelData[target] }
        : channelData; // no arg = logout all

      if (target && !channelData[target]) {
        console.log(`未知渠道: ${target}（可选: ${Object.keys(channelData).join(", ")}）`);
        break;
      }

      let cleared = false;
      for (const [chName, data] of Object.entries(channels)) {
        for (const f of data.files || []) {
          const p = join(accountsDir, f);
          if (existsSync(p)) {
            unlinkSync(p);
            cleared = true;
          }
        }
        for (const d of data.dirs || []) {
          const p = join(accountsDir, d);
          if (existsSync(p)) {
            rmSync(p, { recursive: true, force: true });
            cleared = true;
          }
        }
        if (cleared) {
          console.log(`\x1b[32m✓\x1b[0m ${chName} 已退出登录，下次启动将重新扫码`);
        }
      }
      if (!cleared) {
        console.log("当前没有已登录的账号");
      }
      break;
    }

    case "config": {
      // Hide API keys in output
      const display = JSON.parse(JSON.stringify(config));
      for (const p of Object.values(display.providers)) {
        const prov = p as Record<string, unknown>;
        if (prov.apiKey && typeof prov.apiKey === "string") {
          prov.apiKey = prov.apiKey.slice(0, 6) + "..." + prov.apiKey.slice(-4);
        }
      }
      console.log(JSON.stringify(display, null, 2));
      break;
    }

    case "send-text": {
      const { sendText, getDefaultTargetUser, getKnownUsers } = await import("./send-media.js");

      const sendArgs = args.slice(1);
      let text: string | undefined;
      let toUserId: string | undefined;

      for (let i = 0; i < sendArgs.length; i++) {
        const arg = sendArgs[i];
        if (arg === "--to" && sendArgs[i + 1]) {
          toUserId = sendArgs[++i];
        } else if (arg && !arg.startsWith("--")) {
          text = arg;
        }
      }

      if (!text) {
        console.error("\x1b[31m✗\x1b[0m 请指定文字内容");
        console.error("用法: skychat-ai send-text <文字> [--to <用户ID>]");
        process.exit(1);
      }

      if (!toUserId) {
        const defaultUser = getDefaultTargetUser();
        if (defaultUser) {
          toUserId = defaultUser;
        } else {
          const users = getKnownUsers();
          if (users.length === 0) {
            console.error("\x1b[31m✗\x1b[0m 未找到联系人，请使用 --to <用户ID> 指定接收者");
            process.exit(1);
          } else {
            console.error(`\x1b[33m⚠\x1b[0m 检测到 ${users.length} 个联系人，请使用 --to 指定:`);
            for (const u of users) {
              const masked = u.length > 6 ? u.slice(0, 4) + "****" + u.slice(-3) : u;
              console.error(`    ${masked}`);
            }
            process.exit(1);
          }
        }
      }

      const targetLabel = toUserId.length > 6 ? toUserId.slice(0, 4) + "****" + toUserId.slice(-3) : toUserId;
      console.log(`\x1b[1m发送文字\x1b[0m → ${targetLabel}`);
      console.log(`  内容: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);
      console.log();

      const result = await sendText({ text, toUserId });
      if (result.success) {
        console.log(`\x1b[32m✓\x1b[0m 文字已发送`);
      } else {
        console.error(`\x1b[31m✗\x1b[0m 发送失败: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case "send": {
      const { sendMedia, sendAllMedia, getDefaultTargetUser, getKnownUsers, detectMediaType } = await import("./send-media.js");

      // 解析参数
      const sendArgs = args.slice(1);
      let filePath: string | undefined;
      let toUserId: string | undefined;
      let forceType: string | undefined;
      let sendAll = false;
      let dirPath: string | undefined;
      let caption: string | undefined;

      for (let i = 0; i < sendArgs.length; i++) {
        const arg = sendArgs[i];
        if (arg === "--to" && sendArgs[i + 1]) {
          toUserId = sendArgs[++i];
        } else if (arg === "--type" && sendArgs[i + 1]) {
          forceType = sendArgs[++i];
        } else if (arg === "--all") {
          sendAll = true;
        } else if (arg === "--dir" && sendArgs[i + 1]) {
          dirPath = sendArgs[++i];
        } else if (arg === "--caption" && sendArgs[i + 1]) {
          caption = sendArgs[++i];
        } else if (arg && !arg.startsWith("--")) {
          filePath = arg;
        }
      }

      // 确定目标用户
      if (!toUserId) {
        const defaultUser = getDefaultTargetUser();
        if (defaultUser) {
          toUserId = defaultUser;
        } else {
          const users = getKnownUsers();
          if (users.length === 0) {
            console.error("\x1b[31m✗\x1b[0m 未找到联系人，请使用 --to <用户ID> 指定接收者");
            process.exit(1);
          } else {
            console.error(`\x1b[33m⚠\x1b[0m 检测到 ${users.length} 个联系人，请使用 --to 指定:`);
            for (const u of users) {
              const masked = u.length > 6 ? u.slice(0, 4) + "****" + u.slice(-3) : u;
              console.error(`    ${masked}`);
            }
            process.exit(1);
          }
        }
      }

      const targetLabel = toUserId.length > 6 ? toUserId.slice(0, 4) + "****" + toUserId.slice(-3) : toUserId;

      if (sendAll) {
        // 批量发送模式
        const targetDir = dirPath || filePath || ".";
        console.log(`\x1b[1m发送目录下所有媒体文件\x1b[0m → ${targetLabel}`);
        console.log(`  目录: ${targetDir}`);
        if (forceType) console.log(`  类型过滤: ${forceType}`);
        console.log();

        const results = await sendAllMedia(targetDir, toUserId, {
          typeFilter: (forceType as "image" | "video" | "voice" | "file" | "auto" | undefined) ?? "auto",
          caption,
          onProgress: (msg) => console.log(msg),
        });
        process.exit(results.every(r => r.success) ? 0 : 1);
      } else {
        // 单文件发送
        if (!filePath) {
          console.error("\x1b[31m✗\x1b[0m 请指定文件路径");
          console.error("用法: skychat-ai send <文件路径> [--to <用户ID>] [--type <类型>]");
          process.exit(1);
        }

        // 解析为绝对路径
        const { resolve } = await import("node:path");
        filePath = resolve(filePath);

        const typeLabel = (() => {
          const t = forceType && forceType !== "auto" ? forceType : undefined;
          if (t) return t;
          const mt = detectMediaType(filePath);
          switch (mt) {
            case 1: return "图片";
            case 2: return "视频";
            case 3: return "文件";
            case 4: return "语音";
            default: return "文件";
          }
        })();

        console.log(`\x1b[1m发送${typeLabel}\x1b[0m → ${targetLabel}`);
        console.log(`  文件: ${filePath}`);
        console.log();

        const result = await sendMedia({
          filePath,
          toUserId,
          mediaType: (forceType as "auto" | "image" | "video" | "voice" | "file" | undefined) ?? "auto",
          caption,
          onProgress: (msg) => console.log(`  ${msg}`),
        });

        if (result.success) {
          console.log(`\n\x1b[32m✓\x1b[0m ${result.mediaType}已发送 (${(result.fileSize / 1024 / 1024).toFixed(2)} MB)`);
        } else {
          console.error(`\n\x1b[31m✗\x1b[0m 发送失败: ${result.error}`);
          process.exit(1);
        }
      }
      break;
    }

    default: {
      // Auto-update check
      await autoUpdate(VERSION);

      // Check which providers have API keys configured
      const configured: string[] = [];
      for (const [name, prov] of Object.entries(config.providers)) {
        if (isProviderReady(prov)) {
          configured.push(name);
        }
      }

      // Auto-switch: if default provider has no key but another does, switch to it
      if (configured.length > 0 && !configured.includes(config.defaultProvider)) {
        config.defaultProvider = configured[0]!;
        await saveConfig(config);
        console.log(`\x1b[36mℹ\x1b[0m 默认模型已自动切换到 ${config.defaultProvider} (已配置 Key)`);
        console.log();
      }

      printBanner(configured.length > 0 ? config.defaultProvider : "");

      if (configured.length === 0) {
        console.log(`\x1b[2m  尚未配置 API Key，请运行 skychat-ai set <模型> <key>\x1b[0m`);
        console.log();
      } else {
        console.log(`\x1b[32m✓\x1b[0m 可用模型: ${configured.join(", ")}`);
        console.log();
      }

      const gateway = new Gateway(config);
      gateway.init();

      const shutdown = async () => {
        await gateway.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await gateway.start();
      break;
    }
  }
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
