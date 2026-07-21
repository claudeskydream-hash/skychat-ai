# Codex 调用 SkyChat 微信发送接口

本文记录本机 SkyChat-AI Webhook 的用途、调用方式和 2026-06-04 实测结果。

## 运行条件

SkyChat daemon 需要处于运行状态：

```powershell
skychat-ai start
```

本机 Webhook 地址：

```text
http://127.0.0.1:4800
```

鉴权密钥存放在：

```text
C:\Users\Administrator\.skychat-ai\config.json
```

字段路径为：

```json
{
  "webhook": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 4800,
    "secret": "..."
  }
}
```

不要把 `secret` 写进文档或提交记录；调用脚本会自动读取配置。

## 推荐调用方式

Codex 直接调用工作区里的 PowerShell helper：

```powershell
& 'D:\CodexWorkSpace\scripts\send-wechat.ps1' -Text '要发给微信的文字'
```

发送本地文件：

```powershell
& 'D:\CodexWorkSpace\scripts\send-wechat.ps1' `
  -Text '这是一张测试图片' `
  -FilePath 'D:\path\to\image.png' `
  -MediaType image
```

`-MediaType` 可选值：

```text
auto, image, video, voice, file
```

如果只有一个已知微信联系人，可以省略 `-TargetId`。如果后续有多个联系人，需要显式传：

```powershell
& 'D:\CodexWorkSpace\scripts\send-wechat.ps1' -Text 'Hello' -TargetId '<微信用户ID>'
```

## 原始 HTTP API

健康检查：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4800/health'
```

发送文字：

```powershell
$config = Get-Content "$env:USERPROFILE\.skychat-ai\config.json" -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $($config.webhook.secret)" }
$body = @{ text = 'Hello from Codex' } | ConvertTo-Json -Compress
Invoke-RestMethod -Uri 'http://127.0.0.1:4800/send' -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
```

只上传到微信 CDN，不发送媒体消息：

```powershell
& 'D:\CodexWorkSpace\scripts\send-wechat.ps1' `
  -FilePath 'D:\path\to\video.mp4' `
  -MediaType video `
  -UploadOnly
```

返回字段中的 `downloadEncryptedQueryParam` 是发视频/文件消息时要填进 `media.encrypt_query_param` 的 CDN 参数；`cdnDownloadUrl` 是调试用下载地址。注意 CDN 内容是 AES-128-ECB 加密后的密文，普通浏览器直接打开不等于可播放公网视频链接，还需要 `aeskey` 解密或由微信客户端按媒体消息解析。

上传到 CDN 后，把返回链接和 AES key 作为普通文本发到微信：

```powershell
& 'D:\CodexWorkSpace\scripts\send-wechat.ps1' `
  -Text '视频已上传，下面是 CDN 返回参数' `
  -FilePath 'D:\path\to\video.mp4' `
  -MediaType video `
  -AsLink
```

这条路径适合“先把视频上传到微信 CDN，再把返回链接发给我”的需求。注意该链接仍是微信 CDN 的加密资源地址，更多用于调试和转交参数，不是普通公开视频外链。

发送本地文件：

```powershell
$body = @{
  text = '图片说明'
  filePath = 'D:\path\to\image.png'
  mediaType = 'image'
} | ConvertTo-Json -Compress

Invoke-RestMethod -Uri 'http://127.0.0.1:4800/send' -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
```

## 2026-06-04 实测结果

测试素材位于：

```text
D:\CodexWorkSpace\temp\skychat-media-test
```

已通过：

| 类型 | 调用方式 | 结果 |
| --- | --- | --- |
| 文字 | `-Text` | 成功 |
| 图片 | `-FilePath test-image.png -MediaType image` | 成功 |
| 声音/音频文件 | `-FilePath test-audio.wav -MediaType file` | 成功，作为文件发送 |

条件通过 / 未通过：

| 类型 | 调用方式 | 微信返回 |
| --- | --- | --- |
| 真语音消息 | `-FilePath test-audio.wav -MediaType voice` | `ret=-2` |
| 普通文件 `.txt` / `.zip` | `-MediaType file` | `ret=-2` |
| 视频 `.mp4` 直接媒体消息 | `-MediaType video` | CDN 上传成功；`sendmessage` 对 caption 和 `video_item` 均返回 `ret=-2` |
| 视频 `.mp4` 仅上传 CDN | `-MediaType video -UploadOnly` | 成功，返回 `downloadEncryptedQueryParam`、`aeskey`、`cdnDownloadUrl` |
| 视频 `.mp4` 上传后发链接文本 | `-MediaType video -AsLink` | 成功，微信收到 CDN 参数文本 |

说明：

- Webhook 代码已支持 `filePath + mediaType` 参数。
- 对文件、视频、语音发送时，接口会自动尝试读取 `weixin-tokens.json` 中保存的 `context_token`；如果返回 `ret=-2`，会再重试一次不带 token。
- `ret=-2` 通常表示 `context_token` 过期或当前微信 Bot 会话状态不允许该类 `sendmessage`。让目标微信用户给 bot 发一条新消息后，token 会刷新；如果刷新后仍失败，先用 `-AsLink` 兜底。
- 如果只是要发一段声音，当前可行方式是把音频作为文件发送：`-MediaType file`。

## 链路日志

媒体上传和发送会生成统一 trace id，格式为：

```text
[media:4717813e]
```

一次视频发送会按同一个 trace 串起这些节点：

```text
webhook send request
load weixin account
read file
getuploadurl request
getuploadurl ok
cdn upload start
cdn upload ok
sendmessage start
send caption result
send media result
webhook send response
```

查看最近媒体链路：

```powershell
Select-String -Path 'D:\AIWorkSpace\Log\skychat-2026-06-04.log' `
  -Pattern '\[media:' |
  Select-Object -Last 80 |
  ForEach-Object { $_.Line }
```

只看某一次 trace：

```powershell
Select-String -Path 'D:\AIWorkSpace\Log\skychat-2026-06-04.log' `
  -Pattern '\[media:4717813e\]'
```

2026-06-04 复测结论：

- 直接视频媒体消息：`getuploadurl` 成功、CDN 上传成功、`sendmessage` 返回 `ret=-2`；重试不带 token 后仍为 `ret=-2`。
- 上传后发送 CDN 链接文本：成功，日志中可见 `send cdn-link text ok`。

## 故障排查

查看 daemon 是否监听：

```powershell
Get-NetTCPConnection -LocalPort 4800
```

查看 SkyChat 日志：

```powershell
skychat-ai logs
```

常见错误：

| 错误 | 含义 | 处理 |
| --- | --- | --- |
| `Unauthorized` | 缺少或错误的 Bearer token | 检查 `~\.skychat-ai\config.json` 的 `webhook.secret` |
| `targetId is required` | 已知联系人不止一个或没有联系人 | 调用时传 `-TargetId` |
| `ret=-2` | 微信 iLink Bot API 拒绝该消息或会话 token 失效 | 让用户先给 bot 发一条微信消息刷新 token；视频可先用 `-AsLink` 兜底 |
