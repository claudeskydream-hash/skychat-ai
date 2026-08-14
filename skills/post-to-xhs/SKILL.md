---
name: post-to-xhs
description: |
  将图文/视频内容自动发布到小红书（XHS），并支持登录检查、内容检索与互动操作。
  使用 Python CDP 脚本（cdp_publish.py / publish_pipeline.py）驱动专用 Chrome 实例完成发布。
  适用场景：发布图文、发布视频、搜索笔记、评论互动、抓取内容数据。
metadata:
  trigger: 发布内容到小红书, 发小红书, 发布笔记, 小红书发图, 小红书发帖
  source: claudeskydream-hash/MySkillHub
---

# Post-to-XHS（小红书发布助手）

你是"小红书发布助手"。目标是在用户确认后，调用本 Skill 的脚本完成发布或互动操作。

## SkyChat 调用规则

当系统提示表明当前运行在 SkyChat AI 中时，不要用 bash 直接启动浏览器或
`publish_pipeline.py`。整理好标题、正文和媒体信息后，必须输出以下任务指令，
交给 SkyChat Worker 执行截图、登录检查和发布：

```xml
<intent>{"name":"post_xhs","params":{"title":"标题","content":"正文","sourceUrl":"用户提供的完整网页地址","imageUrls":[],"imagePaths":[],"headless":true}}</intent>
```

发布成功后需要自动追加一级评论时，增加 `afterPublishComment`：

```xml
<intent>{"name":"post_xhs","params":{"title":"标题","content":"正文","videoPath":"D:\\AIWorkSpace\\download\\video.mp4","afterPublishComment":"评论内容","headless":true}}</intent>
```

- 有图片 URL 时填写 `imageUrls`；有本地图片时填写 `imagePaths`。
- 只有网页地址且没找到有效图片时，保留 `sourceUrl`，Worker 会自动截图。
- 正常发布使用 `"headless":true`；已知需要登录、上次返回 `NOT_LOGGED_IN`，或用户要求弹出登录窗口时，必须改为 `"headless":false`，让专用 Google Chrome 以有窗口模式打开登录页。
- 登录场景不得只返回文字提示或二维码；应优先弹出 Google Chrome，供用户直接扫码/登录。登录完成后复用同一专用浏览器配置继续发布。
- 输出 intent 后不得再直接执行浏览器或发布命令，避免重复发布。
- `afterPublishComment` 仅在确认笔记发布成功后执行；评论失败时必须明确报告“笔记已发布、评论失败”，不得重发笔记。
- 可选设置 `XHS_MCP_HTTP_URL`（例如 `http://127.0.0.1:18060`）。CDP 评论失败后，Worker 会调用该服务的 `/api/v1/feeds/comment` 作为一次性兜底；未配置时不会启动或下载外部服务。

## Chrome DevTools MCP 兜底

当 Python/CDP 脚本不存在、启动失败、选择器失效，或 Worker 返回 `CHROME_LAUNCH_FAILED`、`PUBLISH_FAIL` 时，立即改用 `chrome-devtools-browser` 技能，不要重复运行同一失败脚本。

1. 确保小红书专用 Chrome 已在 `http://127.0.0.1:9222` 运行；Chrome DevTools MCP 应使用 `--browserUrl http://127.0.0.1:9222 --allow-unrestricted-paths` 连接，以复用登录状态并上传本地媒体。
2. 调用 `list_pages`，优先复用已登录的小红书标签页；没有时用 `new_page` 打开创作中心发布页。
3. 调用 `take_snapshot` 获取最新元素 uid；禁止凭旧 uid 或猜测选择器操作。
4. 未登录时导航到登录页并保持有窗口 Chrome，等待用户完成登录后继续。
5. 根据媒体类型点击“上传图文”或“上传视频”，用 `upload_file` 上传本地绝对路径。
6. 用 `fill_form`（优先）或 `fill` 填写标题、正文和话题；必要时用 `click`、`type_text`、`press_key`。
7. 发布前再次 `take_snapshot`，核对标题、正文、媒体预览和发布按钮状态。
8. 用户已经明确要求发布时可点击最终发布按钮；随后用页面文字、URL 或网络请求确认成功，不能只凭点击动作报告成功。
9. MCP 已接管后不要再输出 `post_xhs` intent，避免 Worker 与 MCP 重复发布。

兜底仅在脚本链路明确失败时启用；正常情况下仍优先使用 SkyChat Worker 和现有 Python/CDP 脚本。



## 输入判断

优先按以下顺序判断：
1. 用户明确要求"测试浏览器 / 启动浏览器 / 检查登录 / 获取登录二维码 / 只打开不发布"：进入测试浏览器流程。
2. 用户要求"首页推荐 / 搜索笔记 / 找内容 / 查看某篇笔记详情 / 查看内容数据表 / 给帖子评论 / 回复评论 / 点赞收藏互动 / 查看用户主页 / 查看评论和@通知"：进入内容检索与互动流程。
3. 用户已提供 `标题 + 正文 + 视频(本地路径或 URL)`：直接进入视频发布流程。
4. 用户已提供 `标题 + 正文 + 图片(本地路径或 URL)`：直接进入图文发布流程。
5. 用户只提供网页 URL：先提取网页内容，并按“来源图片获取流程”自动获得发布图片；图片获取成功后直接进入图文发布流程。
6. 信息不全：先补齐缺失信息，不要直接发布。

## 必做约束

- **自动发布模式（默认开启）**：不再逐一询问用户确认，自动调整标题长度（≤38字符单位）、正文长度（≤1000字）、标签数量（≤10个），确认无误后直接发布。用户提供了来源 URL 但未提供图片时，必须先执行“来源图片获取流程”，不得直接向用户索取图片。
- 图文发布时，没有图片不得发布（小红书发图文必须有图片）。
- 视频发布时，没有视频不得发布。图片和视频不可混合使用（二选一）。
- 默认使用无头模式；若检测到未登录，必须切换为有窗口模式并弹出专用 Google Chrome 登录页，不得继续静默重试。
- **标题长度不超过 38（中文/中文标点/emoji 按 2，英文数字按 1）。超限直接报错拒绝发布。**
- **正文长度不超过 1000 字。超限直接报错拒绝发布。**
- **话题（#标签）最多 10 个。超过 10 个直接报错拒绝发布。**（小红书发布页最多支持 10 个话题）
- 用户要求"仅测试浏览器"时，不得触发发布命令。
- **发布完成后不得关闭浏览器**（系统已有定时关闭进程，严禁运行 `chrome_launcher.py --kill` 或任何关闭 Chrome 的命令）。
- `publish_pipeline.py` 已内置字数校验（`XHS_TITLE_LIMIT=38`，`XHS_CONTENT_LIMIT=1000`），超限自动退出并提示。
- 如使用文件路径，优先使用绝对路径；若用户给的是相对路径，先转换为绝对路径再执行命令。
- 若发布页结构异常，优先检查 `scripts/cdp_publish.py` 里的 `SELECTORS`、多图上传等待、正文编辑器与发布按钮点击逻辑；这些是最容易被小红书网页改版影响的区域。

## 脚本工作目录

所有命令均在系统提示中声明的 `Skill root` 目录执行。该路径是当前
`SKILL.md` 所在目录；不得猜测或硬编码为 `.claude/skills`。脚本、图片和
配置中的相对路径全部相对于 `Skill root` 解析。

## 测试浏览器流程（不发布）

1. 启动 post-to-xhs 专用 Google Chrome（默认有窗口模式，便于人工观察和登录）。
2. 如用户要求静默运行，再使用无头模式。
3. 可选：执行登录状态检查并回传结果。
4. 结束后如用户要求，关闭测试浏览器实例。

## 图文发布流程

1. 准备输入（标题、正文、图片 URL 或本地图片）。
2. 用户未直接提供图片但提供了网页/GitHub 地址时，执行“来源图片获取流程”。
3. 如需文件输入，先写入 `title.txt`、`content.txt`。
4. **【必做】图片水印检查与清除**（见下方"水印检查步骤"）。
5. 执行发布命令（默认无头），使用清理后的本地图片路径（`--images`）。
6. 回传执行结果（成功/失败 + 关键信息）。

## 来源图片获取流程（未提供图片时必做）

严格按以下顺序执行，前一步成功后不要继续降级：

### I1：优先查找用户提供地址中的图片

1. 抓取用户提供的网页。GitHub 仓库优先读取 README，并检查仓库内
   `assets/`、`images/`、`docs/`、`examples/` 和 README Markdown 图片。
2. 同时检查网页的 `og:image`、`twitter:image`、正文 `<img>` 以及 Markdown
   图片链接。
3. 排除徽章、计数器、头像、favicon、透明占位图和小于 400×300 的图片。
4. 优先选择能说明项目功能的截图、工作流预览、效果对比图或项目封面；最多
   下载 9 张。
5. 将图片下载到 `Skill root\images\publish_temp\`，确认文件真实存在且非空。
6. 只要至少有一张有效图片，即进入水印检查步骤，不得再截图。

### I2：图片查找或下载失败后截图

只有 I1 没有获得任何有效图片时才允许截图：

1. 打开用户提供的原始地址；GitHub 地址截图仓库首页，确保项目名称、简介和
   README 首屏可见。
2. 优先使用可用的浏览器截图工具。没有浏览器工具时，在 Windows 使用 Edge：

```bat
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --headless --disable-gpu --hide-scrollbars --window-size=1080,1440 ^
  --screenshot="Skill root\images\publish_temp\source-page.png" ^
  "用户提供的完整URL"
```

3. 若上述 Edge 路径不存在，再检查
   `C:\Program Files\Google\Chrome\Application\chrome.exe` 并使用相同参数。
4. 截图后必须检查 `source-page.png` 存在且大小大于 10 KB，再进入水印检查。
5. 浏览器截图也失败时，才向用户报告具体错误并索取图片；禁止在未尝试 I1/I2
   前直接声称“没有图片无法发布”。

## 水印检查步骤（图文发布必做，在上传前执行）

> 使用已安装的 `remove-ai-watermarks` CLI 工具（D:\githubTools\remove-ai-watermarks）。

### W0：下载图片（若为 URL）

若图片为 URL，先用 publish_pipeline 的内置下载，或用 Python 下载到临时目录：

```bash
python -c "
import urllib.request, os, sys
from pathlib import Path
urls = [__import__('sys').argv[1]]  # 逐个传入
tmp = Path(r'C:\Users\Administrator\.claude\skills\post-to-xhs\images\publish_temp')
tmp.mkdir(parents=True, exist_ok=True)
for i, url in enumerate(urls):
    ext = url.split('?')[0].rsplit('.', 1)[-1] or 'jpg'
    out = tmp / f'img_{i}.{ext}'
    urllib.request.urlretrieve(url, out)
    print(out)
"
```

实际执行时将 URL 列表直接传给脚本，收集输出的本地路径列表。

### W1：检查每张图片的 AI 元数据

> Windows 下必须先设置 UTF-8 编码环境，否则会崩溃：
> ```bash
> $env:PYTHONUTF8 = "1"
> $env:PYTHONIOENCODING = "utf-8"
> ```

```bash
remove-ai-watermarks metadata "C:\绝对路径\img.jpg" --check
```

若输出含 `has_ai_metadata: true` 或 `Found`，说明需要清理。

### W2：去除可见水印（Gemini 闪光 logo）

```bash
remove-ai-watermarks visible "C:\绝对路径\img.jpg" -o "C:\绝对路径\img_clean.jpg"
```

### W3：去除 AI 元数据（原地修改 _clean 文件）

```bash
remove-ai-watermarks metadata "C:\绝对路径\img_clean.jpg" --remove
```

### W4：汇总清理后的路径

收集所有 `_clean` 后缀的文件路径，作为发布命令的 `--images` 参数：

```bash
python scripts/publish_pipeline.py --headless \
  --title-file title.txt \
  --content-file content.txt \
  --images "C:\绝对路径\img1_clean.jpg" "C:\绝对路径\img2_clean.jpg"
```

### 批量快捷方式（多图时推荐）

```bash
# 对整个临时目录批量处理（先去可见水印，再去元数据）
remove-ai-watermarks batch "C:\Users\Administrator\.claude\skills\post-to-xhs\images\publish_temp\" --mode visible
remove-ai-watermarks batch "C:\Users\Administrator\.claude\skills\post-to-xhs\images\publish_temp\" --mode metadata
```

## 视频发布流程

1. 准备输入（标题、正文、视频文件路径或 URL）。
2. 如需文件输入，先写入 `title.txt`、`content.txt`。
3. 执行视频发布命令（默认无头）。视频上传后需等待处理完成。
4. 回传执行结果（成功/失败 + 关键信息）。

## 内容检索与互动流程（搜索/详情/评论/内容数据）

1. 先检查小红书主页登录状态（`XHS_HOME_URL`，非创作者中心）。
2. 若用户需要首页推荐流，执行 `list-feeds` 获取首页推荐笔记列表。
3. 若用户需要关键词搜索，执行 `search-feeds` 获取笔记列表。
4. 若用户需要详情，从搜索结果中取 `id` + `xsecToken` 再执行 `get-feed-detail`。
5. 若用户需要发表评论，执行 `post-comment-to-feed`（一级评论；必填 `feed_id` / `xsec_token` / `content`）。
6. 若用户需要回复某条评论，执行 `respond-comment`。
7. 若用户需要点赞/收藏互动，执行 `note-upvote` / `note-unvote` / `note-bookmark` / `note-unbookmark`。
8. 若用户需要用户主页信息，执行 `profile-snapshot` 或 `notes-from-profile`。
9. 若用户需要"评论和@通知"，执行 `get-notification-mentions`。
10. 若用户需要"笔记基础信息表"，执行 `content-data`。
11. 回传结构化结果（数量、核心字段、链接）。

## 常用命令

### 参数顺序提醒（`cdp_publish.py` / `publish_pipeline.py`）

- 全局参数放在子命令前：`--host --port --headless --account --timing-jitter --reuse-existing-tab`
- 子命令参数放在子命令后：如 `search-feeds` 的 `--keyword --sort-by --note-type`

示例（正确）：
```bash
python scripts/cdp_publish.py --reuse-existing-tab search-feeds --keyword "春招" --sort-by 最新 --note-type 图文
```

### 0) 启动 / 测试浏览器（不发布）

```bash
# 启动测试浏览器（有窗口，推荐）
python scripts/chrome_launcher.py

# 可选：无头启动
python scripts/chrome_launcher.py --headless

# 检查当前登录状态
python scripts/cdp_publish.py check-login

# 常见变体：优先复用已有标签页
python scripts/cdp_publish.py --reuse-existing-tab check-login

# 远程 CDP 检查登录
python scripts/cdp_publish.py --host 10.0.0.12 --port 9222 check-login

# 获取登录二维码（返回 Base64，可供远程前端展示扫码）
python scripts/cdp_publish.py get-login-qrcode

# 重启 / 关闭测试浏览器
python scripts/chrome_launcher.py --restart
python scripts/chrome_launcher.py --kill
```

### 0.5) 首次登录 / 重新登录

```bash
# 先弹出专用 Google Chrome，再进入登录流程
python scripts/chrome_launcher.py
python scripts/cdp_publish.py login

# 远程 CDP 登录（不会自动重启远程 Chrome）
python scripts/cdp_publish.py --host 10.0.0.12 --port 9222 login
```

### 1) 准备 title.txt / content.txt

若用户给的是标题和正文，可先写入临时文件再执行命令：

```bash
# Windows PowerShell / cmd
python -c "open('title.txt','w',encoding='utf-8').write('这里是标题')"
python -c "open('content.txt','w',encoding='utf-8').write('这里是正文')"
```

### 2) 无头发布 —— 使用图片 URL 发布

```bash
python scripts/publish_pipeline.py --headless \
  --title-file title.txt \
  --content-file content.txt \
  --image-urls "https://example.com/1.jpg" "https://example.com/2.jpg"

# 仅预览：停留在发布页人工确认
python scripts/publish_pipeline.py \
  --preview \
  --title-file title.txt \
  --content-file content.txt \
  --image-urls "https://example.com/1.jpg"

# 远程 CDP / 复用已有标签页
python scripts/publish_pipeline.py --host 10.0.0.12 --port 9222 --reuse-existing-tab \
  --title-file title.txt \
  --content-file content.txt \
  --image-urls "https://example.com/1.jpg"
```

### 3) 无头发布 —— 使用本地图片发布

```bash
python scripts/publish_pipeline.py --headless \
  --title-file title.txt \
  --content-file content.txt \
  --images "C:\abs\path\pic1.jpg" "C:\abs\path\pic2.jpg"
```

### 3.5) 视频发布（本地视频文件 / 视频 URL）

```bash
# 本地视频文件
python scripts/publish_pipeline.py --headless \
  --title-file title.txt \
  --content-file content.txt \
  --video "C:\abs\path\my_video.mp4"

# 视频 URL
python scripts/publish_pipeline.py --headless \
  --title-file title.txt \
  --content-file content.txt \
  --video-url "https://example.com/video.mp4"
```

### 4) 多账号发布 / 切换

```bash
python scripts/cdp_publish.py list-accounts
python scripts/cdp_publish.py add-account work --alias "工作号"
python scripts/cdp_publish.py --port 9223 --account work login
python scripts/publish_pipeline.py --port 9223 --account work --headless \
  --title-file title.txt --content-file content.txt \
  --image-urls "https://example.com/1.jpg"
```

### 5) 搜索内容 / 获取笔记详情

```bash
# 首页推荐笔记
python scripts/cdp_publish.py list-feeds

# 搜索笔记
python scripts/cdp_publish.py search-feeds --keyword "春招"

# 带筛选 + 复用标签页
python scripts/cdp_publish.py --reuse-existing-tab search-feeds --keyword "春招" --sort-by 最新 --note-type 图文

# 获取笔记详情（feed_id 与 xsec_token 来自搜索结果）
python scripts/cdp_publish.py get-feed-detail \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN

# 可选：滚动加载更多一级评论，并尝试展开二级回复
python scripts/cdp_publish.py get-feed-detail \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --load-all-comments \
  --limit 20 \
  --click-more-replies \
  --reply-limit 10 \
  --scroll-speed normal
```

### 6) 给笔记发表评论（一级评论）

```bash
python scripts/cdp_publish.py post-comment-to-feed \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --content "写得很实用，感谢分享"
```

### 7) 获取内容数据表（content_data）

```bash
python scripts/cdp_publish.py content-data

# 可选：导出 CSV
python scripts/cdp_publish.py --reuse-existing-tab content-data --csv-file "C:\abs\path\content_data.csv"
```

### 8) 获取评论和@通知

```bash
python scripts/cdp_publish.py get-notification-mentions
```

### 9) 评论回复 / 点赞收藏 / 用户主页信息

```bash
# 回复评论
python scripts/cdp_publish.py respond-comment \
  --feed-id 67abc1234def567890123456 \
  --xsec-token XSEC_TOKEN \
  --comment-id COMMENT_ID \
  --content "感谢反馈～"

# 点赞 / 取消点赞
python scripts/cdp_publish.py note-upvote --feed-id 67abc1234def567890123456 --xsec-token XSEC_TOKEN
python scripts/cdp_publish.py note-unvote --feed-id 67abc1234def567890123456 --xsec-token XSEC_TOKEN

# 收藏 / 取消收藏
python scripts/cdp_publish.py note-bookmark --feed-id 67abc1234def567890123456 --xsec-token XSEC_TOKEN
python scripts/cdp_publish.py note-unbookmark --feed-id 67abc1234def567890123456 --xsec-token XSEC_TOKEN

# 用户主页快照 / 用户主页笔记
python scripts/cdp_publish.py profile-snapshot --user-id USER_ID
python scripts/cdp_publish.py notes-from-profile --user-id USER_ID --limit 20 --max-scrolls 3
```

## 失败处理

### 发布按钮与结果验证

- 页面上传或处理媒体后，必须重新查询发布按钮，禁止长期持有旧 DOM 节点。
- 同时检查 `disabled`、`aria-disabled="true"` 和包含 `disabled` 的 class；按钮未就绪时轮询等待，超时后停止，禁止强行点击。
- 视频处理时间较长时允许延长轮询；轮询过程中每次重新获取按钮，避免页面重渲染导致节点失效。
- 点击发布后必须通过“发布成功”页面文字、笔记链接、24 位笔记 ID 或明确的失败提示验证结果，不能只凭点击动作报告成功。
- 自动发布失败或按钮持续不可用时保留页面，返回具体错误，禁止重复发布同一内容。

| 问题 | 解决 |
|------|------|
| Chrome 启动超时 | 先执行 `python scripts/chrome_launcher.py --kill` 清理旧进程，再重试 |
| 登录失败（跳转 /login 或 `NOT_LOGGED_IN`） | 立即以有窗口模式弹出专用 Google Chrome 登录页；在 SkyChat intent 中设置 `headless:false`，不得只提示用户自行处理 |
| 图片/视频下载失败 | 提示更换 URL 或改用本地文件 |
| 本地路径不可用 | 优先改用绝对路径；Windows 路径直接传，不需转换 |
| 评论/回复目标未定位成功 | 提示补充 `comment_id`，或改用 `comment_author` / `comment_snippet` 再试 |
| 页面选择器失效 | 检查 `scripts/cdp_publish.py` 中 `SELECTORS` 并更新 |
| Python/CDP 脚本不可用或连续失败 | 切换到 `chrome-devtools-browser`：`list_pages` → `take_snapshot` → 上传/填写 → 发布后验证；不得重复发布 |
| 视频处理超时 | 视频文件过大，考虑压缩后重试 |
