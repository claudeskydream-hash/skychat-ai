# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指导。

## 项目概述

skychat-ai 是一个多渠道 AI 聊天机器人网关，将微信、Discord、WhatsApp、Telegram 统一桥接到多种 AI 模型（Claude、Qwen、DeepSeek、GPT、Gemini 等）。既是 CLI 工具也是 npm 库。

## 常用命令

```bash
pnpm install          # 安装依赖
pnpm run build        # 编译 (tsup → dist/)
pnpm run dev          # 监听模式编译
pnpm run start        # 运行 CLI
pnpm run typecheck    # TypeScript 类型检查 (tsc --noEmit)
pnpm run clean        # 清理 dist/
```

编译产物在 `dist/`，入口为 `dist/cli.js`（带 shebang）和 `dist/index.js`（库入口）。

## 技术栈

- **语言**: TypeScript (ESM)，目标 ES2022，Node.js 22+
- **构建**: tsup（esbuild 封装），输出 ESM 格式
- **包管理**: pnpm
- **协议**: 微信 iLink Bot API、Discord (discord.js)、WhatsApp (Baileys)、Telegram (grammy)

## 架构

消息流：渠道适配层 → Gateway 网关（防抖、会话、中间件）→ AI Provider（模型路由）→ 回复用户

### 核心模块

| 文件 | 职责 |
|------|------|
| `src/cli.ts` | CLI 入口，解析命令（set/use/start/stop/send 等），daemon 模式 |
| `src/gateway.ts` | 消息网关核心：渠道/模型注册、消息防抖合并、中间件洋葱模型、指令路由（/model /skill /画 等）、图片生成 |
| `src/config.ts` | 配置管理，读写 `~/.skychat-ai/config.json`，含默认配置和迁移逻辑 |
| `src/types.ts` | 核心接口：`Channel`、`Provider`、`InboundMessage`、`OutboundMessage`、`Context`、`Middleware`、`WaiConfig` |

### 渠道层 (`src/channels/`)

每个渠道实现 `Channel` 接口（login/start/send/stop）。支持会话持久化和重新扫码。

- `weixin.ts` — 微信 iLink Bot API（官方协议）
- `discord.ts` — Discord Bot (discord.js)
- `whatsapp.ts` — WhatsApp (Baileys)
- `telegram.ts` — Telegram (grammy)

### 模型层 (`src/providers/`)

每个模型实现 `Provider` 接口（query/stream）。三种类型：

- `claude-agent.ts` — Claude Agent SDK，支持会话恢复（resume）、工具调用
- `claw-agent.ts` — claw-agent-sdk（通用 Agent，所有 OpenAI 兼容模型）
- `openai-compatible.ts` — 纯 OpenAI 兼容 API（旧版，无 Agent 能力）

### 辅助模块

- `src/mcp.ts` — MCP 客户端管理，支持 stdio/sse/streamable-http 三种传输
- `src/asr.ts` — 语音转文字 (Whisper)
- `src/tts.ts` — 文字转语音 (OpenAI / Gemini)
- `src/logger.ts` — 日志系统（控制台 + 文件）
- `src/scheduler.ts` — 定时任务调度器
- `src/send-media.ts` — 媒体文件发送（CLI send 命令）
- `src/voice-encode.ts` — 语音编码（silk-wasm）

### Worker 模块 (`src/worker/`)

AI 回复中可包含 `<intent>` 标签，网关提取后放入 Worker 队列异步执行（如发推文、发小红书）。

- `worker/index.ts` — Worker 主类，队列调度，intent 提取
- `worker/queue.ts` — 持久化任务队列
- `worker/mcp-client.ts` — Worker 专用 MCP 客户端
- `worker/chrome.ts` — Chrome 自动化操作
- `worker/handlers/` — 各 intent 处理器（post-to-x 等）

## 关键设计模式

- **中间件系统**: Koa 风格洋葱模型，`gateway.use()` 注册，`compose()` 执行
- **消息防抖**: 用户连续消息在 1.5s（文本）/ 4s（媒体）窗口内合并
- **模型路由**: 支持全局默认、per-user 路由、@模型名 临时切换、OpenRouter vendor/model 切换
- **视觉自动降级**: 图片消息自动切换到支持视觉的模型
- **配置合并**: 默认配置 + 用户配置深合并，用户覆盖优先

## 配置与数据

- 用户配置: `~/.skychat-ai/config.json`
- 账号数据: `~/.skychat-ai/accounts/`
- 运行日志: `D:\AIWorkSpace\Log\skychat-YYYY-MM-DD.log`（或 `WAI_LOG_DIR` 环境变量）
- Daemon PID: `~/.skychat-ai/daemon.pid`

## 发布

- `package.json` 中 `files` 字段限制发布内容为 `["dist", "README.md"]`
- npm 发布名为 `skychat-ai`
- CLI 入口 `dist/cli.js` 编译后自动添加 shebang 行
- tsup 配置中 `external` 排除了大型可选依赖：`discord.js`、`@whiskeysockets/baileys`、`grammy`、`https-proxy-agent`
