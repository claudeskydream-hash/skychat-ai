---
name: RedBookSkills
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

## 输入判断

优先按以下顺序判断：
1. 用户明确要求"测试浏览器 / 启动浏览器 / 检查登录 / 获取登录二维码 / 只打开不发布"：进入测试浏览器流程。
2. 用户要求"首页推荐 / 搜索笔记 / 找内容 / 查看某篇笔记详情 / 查看内容数据表 / 给帖子评论 / 回复评论 / 点赞收藏互动 / 查看用户主页 / 查看评论和@通知"：进入内容检索与互动流程。
3. 用户已提供 `标题 + 正文 + 视频(本地路径或 URL)`：直接进入视频发布流程。
4. 用户已提供 `标题 + 正文 + 图片(本地路径或 URL)`：直接进入图文发布流程。
5. 用户只提供网页 URL：先提取网页内容与图片/视频，再给出可发布草稿，等待用户确认。
6. 信息不全：先补齐缺失信息，不要直接发布。

## 必做约束

- **自动发布模式（默认开启）**：不再逐一询问用户确认，自动调整标题长度（≤38字符单位）、正文长度（≤1000字）、标签数量（≤10个），确认无误后直接发布。仅在信息严重缺失（如无图片也无视频）时才询问用户。
- 图文发布时，没有图片不得发布（小红书发图文必须有图片）。
- 视频发布时，没有视频不得发布。图片和视频不可混合使用（二选一）。
- 默认使用无头模式；若检测到未登录，切换有窗口模式登录。
- **标题长度不超过 38（中文/中文标点/emoji 按 2，英文数字按 1）。超限直接报错拒绝发布。**
- **正文长度不超过 1000 字。超限直接报错拒绝发布。**
- **话题（#标签）最多 10 个。超过 10 个直接报错拒绝发布。**（小红书发布页最多支持 10 个话题）
- 用户要求"仅测试浏览器"时，不得触发发布命令。
- **发布完成后不得关闭浏览器**（系统已有定时关闭进程，严禁运行 `chrome_launcher.py --kill` 或任何关闭 Chrome 的命令）。
- `publish_pipeline.py` 已内置字数校验（`XHS_TITLE_LIMIT=38`，`XHS_CONTENT_LIMIT=1000`），超限自动退出并提示。
- 如使用文件路径，优先使用绝对路径；若用户给的是相对路径，先转换为绝对路径再执行命令。
- 若发布页结构异常，优先检查 `scripts/cdp_publish.py` 里的 `SELECTORS`、多图上传等待、正文编辑器与发布按钮点击逻辑；这些是最容易被小红书网页改版影响的区域。

## 脚本工作目录

所有命令均在以下目录执行（Bash 工具）：
```
C:\Users\Administrator\.claude\skills\post-to-xhs
```

## 测试浏览器流程（不发布）

1. 启动 post-to-xhs 专用 Chrome（默认有窗口模式，便于人工观察）。
2. 如用户要求静默运行，再使用无头模式。
3. 可选：执行登录状态检查并回传结果。
4. 结束后如用户要求，关闭测试浏览器实例。

## 图文发布流程

1. 准备输入（标题、正文、图片 URL 或本地图片）。
2. 如需文件输入，先写入 `title.txt`、`content.txt`。
3. **【必做】图片水印检查与清除**（见下方"水印检查步骤"）。
4. 执行发布命令（默认无头），使用清理后的本地图片路径（`--images`）。
5. 回传执行结果（成功/失败 + 关键信息）。

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
# 本地 Chrome 登录
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

| 问题 | 解决 |
|------|------|
| Chrome 启动超时 | 先执行 `python scripts/chrome_launcher.py --kill` 清理旧进程，再重试 |
| 登录失败（跳转 /login） | 提示用户手动扫码登录后重试；若需远程展示二维码，改用 `get-login-qrcode` |
| 图片/视频下载失败 | 提示更换 URL 或改用本地文件 |
| 本地路径不可用 | 优先改用绝对路径；Windows 路径直接传，不需转换 |
| 评论/回复目标未定位成功 | 提示补充 `comment_id`，或改用 `comment_author` / `comment_snippet` 再试 |
| 页面选择器失效 | 检查 `scripts/cdp_publish.py` 中 `SELECTORS` 并更新 |
| 视频处理超时 | 视频文件过大，考虑压缩后重试 |
