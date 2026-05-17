# MCP Worker 架构设计文档 — 让 bot 真的能发推

> 目标：让 skychat-ai bot 收到"发推/操作浏览器"类指令时，能稳定地完成多步 MCP 工具调用，不被扩展状态、模型工具调用能力、并发抢占等问题卡住。

---

## 0. 背景与动机

### 0.1 当前现象
2026-05-16 / 17 两次实测：用户通过微信向 bot 发"发推 + GitHub 链接"，bot 收到消息、识别意图、生成推文文案 — **但没把推真的发出去**。

### 0.2 三个真凶（按发现顺序）
1. **chrome-mcp 扩展的 unload bug**（已修复，2026-05-17）
   - `content-scripts/element-picker.js` 在所有页面注入 `window.addEventListener('unload', ...)`，触发 Chrome Permissions Policy violation
   - 每个页签累积错误，service worker 状态紊乱
   - 修复：`unload` → `pagehide`，已 patch 源码并重新构建部署
2. **bot 用的 GLM Claude 兼容接口工具调用支持有限**
   - 即便 systemPrompt 写明"必须调工具"，模型仍倾向于纯文本回复
   - GLM 后端对 ClaudeAgentSDK 暴露的工具列表理解、参数构造、状态机连续调用的稳定性远低于真 Anthropic Claude
3. **多 MCP 客户端可能争抢扩展**
   - bot 在调时，Claude Code（我）同时连同一扩展会失败
   - chrome-mcp 是否真的不支持多客户端，源码层未确认，但现象上存在干扰

### 0.3 单 Worker 架构能解决什么 / 不能解决什么

| 问题 | 单 Worker 是否解决 |
|------|------|
| chrome-mcp 扩展不支持多客户端 | ✅ 彻底解决（永远只有一个客户端）|
| GLM 工具调用能力弱 | ✅ Worker 可以用真 Anthropic Claude / deepseek 等更稳的模型 |
| 多步状态机断点续传 | ✅ Worker 持久化任务状态，挂了能续 |
| 跨渠道复用发推逻辑 | ✅ Worker 服务化后 telegram/discord 都能调 |
| Chrome MCP 扩展 service worker 自身被回收 | ❌ 这是扩展层问题，Worker 解决不了（unload bug 修复才能缓解）|
| 用户图片传递 | ⚠️ Worker 架构本身不解决，但流程更清晰：bot 把图存到约定路径，告诉 Worker 路径 |

---

## 1. 三个候选方案

### 方案 A：独立 Node Worker 进程（重，最干净）

```
[skychat-ai bot]                       [Worker daemon (新)]
  ↓ 识别"发推"意图                       端口 5500
  ↓ POST /task {intent, params}    ─→   ├─ 内存任务队列
  ↓                                     ├─ 串行消费（独占 chrome MCP）
  ↓ 监听 callback                ←─    ├─ Claude Agent SDK (真 Anthropic / GLM-4-plus)
  ↓ 把结果发回微信                       └─ chrome MCP via 12306
```

**新增**：1 个 Node 守护进程 + 进程间通信

**优点**：进程隔离最好；崩溃互不影响；以后接更多渠道直接复用
**缺点**：进程数 +1（用户明确反对方向）；维护成本最高

---

### 方案 B：复用 scheduler 进程跑 worker 命令

scheduler 现状：Python + apscheduler，跑 `subprocess.run(shell, timeout=300)`，端口 7700。

```
[skychat-ai bot]
  ↓ POST /tasks {type:"once", command:"node worker-cli.js --task=...", exclusive:true}
[scheduler (Python)]
  ↓ apscheduler 调度 once trigger
  ↓ subprocess.run("node worker-cli.js ...")
[worker-cli.js (一次性 Node 子进程)]
  ↓ 启动 → 跑完任务 → 退出
  ↓ chrome MCP via 12306
```

**新增**：1 个 Node CLI 入口 + scheduler 加 "exclusive task" 串行队列概念

**优点**：复用 scheduler 的持久化、HTTP、PID 管理、重启恢复
**缺点**：
- scheduler 跨语言（Python ↔ Node）通信麻烦
- 每次发推启一个 Node 子进程，启动开销 1-2 秒
- scheduler 默认线程池并行，要给"exclusive"任务加锁逻辑，scheduler 复杂度涨
- scheduler 本来是给"定时关 Chrome"这种短命令设计的，硬塞复杂 agent 偏离初衷

---

### 方案 C ⭐ 推荐：skychat-ai 内嵌 Worker 模块（不增加进程）

```
[skychat-ai 守护进程（已有）]
  ├─ gateway.ts           入站消息分发（已有）
  ├─ providers/           AI 推理（已有）
  ├─ channels/            微信/TG/...（已有）
  └─ worker/              ★ 新增：工具调用串行队列
      ├─ queue.ts         单消费者队列
      ├─ handlers/        intent → 具体执行（如 post-to-x.ts）
      └─ mcp-client.ts    唯一的 chrome MCP 客户端（共享给 handler）
```

**新增**：skychat-ai 内一个新模块（约 500 行 TS），无独立进程

**数据流**：
1. bot 收到微信"发推 ..."消息
2. AI provider 识别意图，**不再让模型直接调 chrome MCP 工具**，而是让它输出结构化 intent JSON：`{intent:"post_tweet", text:..., image:...}`
3. gateway 把 intent 推入 worker queue
4. worker queue 单消费者串行消费 → 内置 handler 跑 7 步状态机
5. 完成后通过 channel.send 把结果回给用户

**为什么这是最优解**：
- ✅ **彻底单客户端**：进程内只有一个 chrome MCP client 实例，bot 推理流程不再直接调 chrome 工具
- ✅ **不增加进程**：用户明确反对的硬约束
- ✅ **bot 推理可继续并行**：发推任务进队列后立即返回"已收到，正在发"，bot 能继续接下一条消息
- ✅ **工具调用稳定**：handler 是写死的 TS 代码（不是 LLM 调工具），不依赖模型能力
- ✅ **断点续传可加**：handler 跑到 step 5 挂了，下次重启从 step 5 续
- ✅ **跨渠道复用**：worker 在 gateway 层，所有 channel 共享
- ⚠️ 失去进程隔离：worker crash 会拖死 skychat-ai —— 通过 try/catch + 单 task timeout 缓解

---

## 2. 推荐方案（C）详细设计

### 2.1 模块结构

```
src/worker/
├── queue.ts              # 单消费者队列（FIFO，串行）
├── mcp-client.ts         # chrome MCP 客户端单例（连 12306）
├── handlers/
│   ├── post-to-x.ts      # 发推（7 步状态机）
│   ├── post-to-xhs.ts    # 小红书（占位，后续接）
│   └── index.ts          # intent → handler 映射
├── types.ts              # WorkerTask、IntentName 类型定义
└── index.ts              # 对外暴露 enqueue() / shutdown()
```

### 2.2 任务类型定义（types.ts 简化版）

```typescript
export type IntentName = 'post_tweet' | 'post_xhs' | 'delete_tweet';

export interface WorkerTask {
  id: string;                   // 唯一 ID（uuid）
  intent: IntentName;
  params: Record<string, unknown>;
  // 回调：完成后给谁、怎么发回结果
  replyTo: {
    channel: string;            // weixin / telegram / discord
    targetId: string;
  };
  // 状态机持久化
  state?: { step: number; data?: unknown };
  attempts: number;
  createdAt: number;
}

export interface PostTweetParams {
  text: string;                 // ≤ 280 UTF-16 chars
  imagePath?: string;           // 本地绝对路径（图片）
  videoPath?: string;           // 本地绝对路径（视频）
}
```

### 2.3 队列契约（queue.ts 关键行为）

- **FIFO** + **单消费者**：同一时刻只有 1 个 task 在 handler 里跑
- 每个 task 有 **超时**（默认 180s），超时强制结束并标 failed
- task 失败重试上限 2 次，重试时带 `attempts++`
- 队列持久化到 `~/.skychat-ai/worker-queue.json`，进程重启后恢复未完成 task
- 公开 API：
  ```typescript
  enqueue(task: WorkerTask): Promise<string>     // 返回 taskId
  status(taskId: string): TaskState              // pending/running/done/failed
  on('done', (task, result) => ...)              // 完成事件
  ```

### 2.4 Handler 接口（handlers/post-to-x.ts 关键签名）

```typescript
export async function handlePostTweet(
  task: WorkerTask,
  ctx: WorkerCtx                  // 提供 mcp client + logger
): Promise<WorkerResult> {
  const { text, imagePath } = task.params as PostTweetParams;
  const mcp = ctx.mcp;

  // 1. 找 / 准备 x.com tab
  const tabs = await mcp.callTool('get_windows_and_tabs', {});
  let tabId = findXTab(tabs);
  if (!tabId) tabId = await openXTab(mcp);

  // 2. 检查登录
  const login = await mcp.callTool('chrome_javascript', {
    tabId, code: `return !!document.querySelector('[data-testid="SideNav_NewTweet_Button"]');`,
  });
  if (!login) return { ok: false, reason: 'NOT_LOGGED_IN', userMessage: '请先登录 X 账号' };

  // 3-7. 跑 post-to-x skill 的 7 步状态机（写死，不依赖 LLM）
  await navigateToCompose(mcp, tabId);
  await writeText(mcp, tabId, text);
  if (imagePath) {
    await clickMediaButton(mcp, tabId);
    await uploadFile(mcp, tabId, imagePath);
    await waitUploadComplete(mcp, tabId);
  }
  await clickTweet(mcp, tabId);
  await verifyPosted(mcp, tabId);

  return { ok: true, userMessage: '✅ 推文已发布' };
}
```

每个内部函数都是 **小、独立、可测试** 的步骤，对应 skill.md 里已经验证过的 7 步。

### 2.5 与 gateway 的集成点

在 `gateway.ts` 的 `processMessage` 流程加 worker hook：

```typescript
// gateway.ts 伪代码
const aiResult = await provider.query(prompt, sessionKey, options);

// 检测 AI 输出里是否带 intent JSON（或固定标记 <intent>...</intent>）
const intent = extractIntent(aiResult);
if (intent) {
  const taskId = await this.worker.enqueue({
    id: uuid(),
    intent: intent.name,
    params: intent.params,
    replyTo: { channel: msg.channel, targetId: msg.senderId },
    attempts: 0,
    createdAt: Date.now(),
  });
  // 先回复"已收到，正在发"
  await channel.send({ targetId: msg.senderId, text: `📋 任务已排队 #${taskId.slice(0,6)}` });
  return;
}

// 否则照旧用 AI 回复发回
await channel.send({ targetId: msg.senderId, text: aiResult });
```

### 2.6 systemPrompt 配套修改

当前 systemPrompt 在教 bot 直接调工具；新架构下应改为：

```
当用户消息属于以下意图时，请在回复末尾输出固定格式的 JSON（不要直接调用工具）：

发推（post_tweet）：
<intent>
{"name":"post_tweet","params":{"text":"...","imagePath":"D:\\..." 或省略}}
</intent>

删推（delete_tweet）：
<intent>
{"name":"delete_tweet","params":{"keyword":"..."}}
</intent>

JSON 之外可以加一句中文确认给用户看，但**必须**包含完整的 <intent> 块。
其他对话照常用文字回答。
```

好处：GLM 模型只需要输出结构化 JSON（这个能力它有），不需要稳定的工具调用。

---

## 3. 媒体（图片/视频）传递问题

### 3.1 问题
微信图片由 weixin channel 解密为 **base64 data URL**，目前不会传给 `claude-agent` provider（`claude-agent.ts` 没读 `options.media`）。bot 拿不到图片本身，就算把 intent 输出对了，imagePath 也是空的。

### 3.2 方案

在 `weixin.ts` 入站消息处理里，**自动把图片落盘**：

```typescript
// weixin.ts 新增
async function persistImagesToFiles(content) {
  if (!content.media?.length) return [];
  const paths = [];
  for (const m of content.media) {
    if (m.type !== 'image' || !m.url?.startsWith('data:')) continue;
    const filename = `wx_inbound_${Date.now()}_${randomId()}.jpg`;
    const fullPath = path.join(TMP_INBOUND_DIR, filename);
    fs.writeFileSync(fullPath, Buffer.from(base64Part(m.url), 'base64'));
    paths.push(fullPath);
  }
  return paths;
}
```

落盘后把路径以文本形式拼到 prompt 里：

```
[用户消息]
发推带图：分享一个新发现 https://github.com/...

[附带媒体文件]
- D:\AIWorkSpace\skychat-ai-data\inbound\wx_inbound_1747...jpg
```

bot 模型看到这一行就能在 intent 里把 imagePath 填对。

---

## 4. 落地步骤（分阶段实施）

### Phase 0 — 前置验证（半天，可选）
**目的**：先确认 unload bug 修复后 bot 是否真的能直接发推（如果能，就省下 Phase 1-3 的工作）

| 步骤 | 操作 |
|------|------|
| 0.1 | 用户重载 chrome-mcp 扩展（已部署修复版）|
| 0.2 | 用微信发"发推带图..." 给 bot |
| 0.3 | tail daemon.log 看有没有工具调用日志 |
| 0.4 | 看推文有没有真发出去 |

**判断**：
- 发出去了 → unload bug 是真凶，**可以不上 Worker 架构**，只把 systemPrompt 教学得更好即可
- 没发出去 → 继续 Phase 1

### Phase 1 — Worker 模块骨架（1 天）

| 文件 | 工作 |
|------|------|
| `src/worker/types.ts` | 定义 WorkerTask / IntentName / Params 类型 |
| `src/worker/queue.ts` | 实现单消费者队列（FIFO + 串行 + 超时 + 重试）|
| `src/worker/mcp-client.ts` | 封装 chrome-mcp 12306 客户端（单例）|
| `src/worker/index.ts` | 对外暴露 enqueue / on('done') |
| `src/worker/handlers/index.ts` | intent → handler 路由 |
| `src/gateway.ts` | 加 `extractIntent` + `worker.enqueue` 调用 |

### Phase 2 — post-to-x handler（1 天）

| 步骤 | 工作 |
|------|------|
| 2.1 | `handlers/post-to-x.ts` 把 skill.md 的 7 步逻辑搬过来变成 TS 函数 |
| 2.2 | 用 `D:\AIWorkSpace\temp\supertonic_xhs.jpg` 跑端到端测试 |
| 2.3 | 加 step 持久化（用于断点续传，可选）|

### Phase 3 — 微信图片落盘（半天）

| 步骤 | 工作 |
|------|------|
| 3.1 | `channels/weixin.ts` 加 `persistImagesToFiles` |
| 3.2 | 修改入站 prompt 注入媒体文件路径 |
| 3.3 | 添加图片清理 cron（24h 删除旧文件，避免堆积）|

### Phase 4 — systemPrompt 改造 + 端到端测试（半天）

| 步骤 | 工作 |
|------|------|
| 4.1 | 改 `config.json` 的 systemPrompt 为 intent JSON 输出格式 |
| 4.2 | 重启 skychat-ai |
| 4.3 | 微信发"发推带图：xxx" 端到端测试 |
| 4.4 | 失败用例：未登录 X / 网络中断 / 字数超限 等 |

**合计**：Phase 1+2+3+4 ≈ **3 天工作量**。

---

## 5. scheduler 复用情况说明

> 用户问："worker 能不能跟 scheduler 进程封装到一起？"

**结论：不建议在 scheduler 里跑 worker 任务**，但可以单向利用 scheduler 做辅助。

| 维度 | scheduler 适合 | worker 适合 |
|------|--------|--------|
| 任务长度 | 短命令（subprocess 5min 超时）| 中等（30s-3min 工具链）|
| 执行体 | shell 命令 | LLM intent + 多步工具调用 |
| 语言 | Python（apscheduler）| Node（chrome MCP 客户端）|
| 并行模型 | 默认线程池并行 | 必须串行（独占 MCP）|
| 持久化目标 | 定时任务定义 | 任务执行状态/断点 |

跨语言、并行模型差异、任务复杂度差异都很大。强合并会让两个组件互相拖累。

**辅助使用方式**：worker 完成后想"6 小时后自动删图片"这种事，调 scheduler 的 once trigger 就好。两个组件各司其职、互相通过 HTTP 调用，不是合进同一个进程。

---

## 6. 风险与回滚

### 6.1 风险
| 风险 | 缓解 |
|------|------|
| Worker handler 写死后，每加一种"发 X" 都要写代码（不像 LLM 通用）| 接受，因为这类操作本来就需要稳定性优先 |
| GLM 输出的 intent JSON 格式不稳定 | systemPrompt 强约束 + 解析失败时回退到普通文本回复 |
| chrome MCP 扩展 service worker 被回收 | 已通过 unload bug 修复缓解；Worker 调用前检查连接，断了主动 keepalive |
| 队列持久化文件损坏 | 启动时校验，损坏的 task 直接 drop，记日志 |
| skychat-ai 进程崩溃带走 worker | 用 PM2 或 nssm 加守护，重启时从 worker-queue.json 续传 |

### 6.2 回滚
所有改动都在 skychat-ai 项目内，回滚=`git revert` 或恢复改前 commit。config.json 备份已留在 `~/.skychat-ai/config.json.bak.*`。

---

## 7. 决策点（明天再看）

读完后需要拍板的：

1. **是否要 Phase 0 先验证 unload 修复**？
   - 选"是"省时间，可能发现根本不用上 Worker
   - 选"否"直接动 Phase 1

2. **intent 输出格式**：JSON-in-tag (`<intent>...</intent>`) vs JSON-only-line vs tool-call-style ？
   - 推荐 JSON-in-tag，最容易稳定提取

3. **handler 是写死 7 步代码 vs 让 worker 内部再起一个 LLM agent 跑 skill**？
   - 推荐写死，稳定性优先
   - 写 LLM agent 灵活但又回到工具调用稳定性问题

4. **media 落盘目录**？
   - 推荐 `D:\AIWorkSpace\skychat-ai-data\inbound\` (与 skychat-ai 配置目录隔离)

---

## 8. 相关文件位置（实施时直接打开）

| 内容 | 路径 |
|------|------|
| skychat-ai 源码 | `D:\AIWorkSpace\skychat-ai\src\` |
| 现有 gateway | `D:\AIWorkSpace\skychat-ai\src\gateway.ts` |
| weixin channel | `D:\AIWorkSpace\skychat-ai\src\channels\weixin.ts` |
| claude-agent provider | `D:\AIWorkSpace\skychat-ai\src\providers\claude-agent.ts` |
| skychat-ai 配置 | `C:\Users\Administrator\.skychat-ai\config.json` |
| post-to-x skill（移植参考）| `C:\Users\Administrator\.claude\skills\post-to-x\skill.md` |
| chrome-mcp 扩展源码 | `D:\AIWorkSpace\GitHubProject\mcp-chrome\app\chrome-extension\` |
| chrome-mcp 已部署扩展 | `D:\AIWorkSpace\GitHubProject\mcp-chrome-extension\` |
| scheduler 源码 | `C:\Users\Administrator\.claude\skills\scheduler\daemon.py` |
| 本设计文档 | `D:\AIWorkSpace\ReadMarkDown\2026-05-17_mcp_worker_architecture_design.md` |
