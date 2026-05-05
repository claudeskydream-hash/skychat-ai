#!/usr/bin/env python3
"""
每日热点新闻推送脚本
通过 skychat-ai Webhook API 将热点新闻推送到微信

用法：
    # 直接运行（使用默认配置）
    py scripts/daily_news_push.py

    # 指定参数运行
    py scripts/daily_news_push.py --webhook-url http://localhost:4800 --secret my-secret --target-id "user@im.bot"

    # 仅测试（不发送，打印到控制台）
    py scripts/daily_news_push.py --dry-run

定时任务配置（Windows 任务计划程序 / Linux crontab）：
    # 每天 9:00 执行
    # Linux: crontab -e
    0 9 * * * cd /path/to/skychat-ai && python3 scripts/daily_news_push.py >> logs/news_push.log 2>&1

    # Windows: schtasks
    schtasks /create /tn "DailyNewsPush" /tr "py C:\\path\\to\\skychat-ai\\scripts\\daily_news_push.py" /sc daily /st 09:00
"""

import argparse
import io
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime
from typing import Optional

# 修复 Windows 控制台编码问题
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


# ============================================================
# 配置
# ============================================================

DEFAULT_CONFIG = {
    # skychat-ai Webhook 地址
    "webhook_url": os.environ.get("SKYCHAT_WEBHOOK_URL", "http://localhost:4800"),
    # Webhook 认证密钥（对应 config.json 中 webhook.secret）
    "secret": os.environ.get("SKYCHAT_WEBHOOK_SECRET", ""),
    # 目标渠道
    "channel": os.environ.get("SKYCHAT_CHANNEL", "weixin"),
    # 目标用户 ID（微信 iLink 用户 ID，格式如 "a859bd6ccf43@im.bot"）
    "target_id": os.environ.get("SKYCHAT_TARGET_ID", ""),
    # 新闻源数量
    "max_news": int(os.environ.get("SKYCHAT_MAX_NEWS", "10")),
}

# 配置文件路径（优先级：环境变量 > 配置文件 > 默认值）
CONFIG_FILE = os.path.join(os.path.dirname(__file__), "news_push_config.json")


def load_config() -> dict:
    """加载配置，环境变量优先级最高"""
    config = DEFAULT_CONFIG.copy()

    # 尝试从配置文件加载
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                file_config = json.load(f)
                config.update(file_config)
        except (json.JSONDecodeError, IOError):
            pass

    return config


# ============================================================
# 新闻获取
# ============================================================

def fetch_trending_repos(limit: int = 5) -> list[dict]:
    """获取 GitHub Trending 项目（无需 API Key）"""
    repos = []
    url = "https://api.github.com/search/repositories?q=created:>%s+stars:>50&sort=stars&order=desc&per_page=%d" % (
        datetime.now().strftime("%Y-%m-%d"),
        limit,
    )
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "skychat-ai-news-push/1.0",
            "Accept": "application/vnd.github.v3+json",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for item in data.get("items", [])[:limit]:
                repos.append({
                    "name": item["full_name"],
                    "desc": (item.get("description") or "暂无描述")[:60],
                    "stars": item["stargazers_count"],
                    "lang": item.get("language") or "未知",
                    "url": item["html_url"],
                })
    except Exception as e:
        repos.append({"error": f"获取 GitHub Trending 失败: {e}"})
    return repos


def fetch_weibo_hot(limit: int = 5) -> list[dict]:
    """获取微博热搜（使用公开接口，无需 API Key）"""
    topics = []
    try:
        url = "https://weibo.com/ajax/side/hotSearch"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            realtime = data.get("data", {}).get("realtime", [])
            for item in realtime[:limit]:
                topics.append({
                    "title": item.get("note", ""),
                    "hot": item.get("num", 0),
                    "category": item.get("category", ""),
                })
    except Exception as e:
        topics.append({"error": f"获取微博热搜失败: {e}"})
    return topics


def fetch_zhihu_hot(limit: int = 5) -> list[dict]:
    """获取知乎热榜（无需 API Key）"""
    topics = []
    try:
        url = "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=%d" % limit
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for item in data.get("data", [])[:limit]:
                target = item.get("target", {})
                topics.append({
                    "title": target.get("title", ""),
                    "excerpt": (target.get("excerpt") or "")[:50],
                    "hot": item.get("detail_text", ""),
                })
    except Exception as e:
        topics.append({"error": f"获取知乎热榜失败: {e}"})
    return topics


def fetch_ithome_hot(limit: int = 5) -> list[dict]:
    """获取 IT之家 热门资讯（无需 API Key）"""
    news = []
    try:
        url = "https://m.ithome.com/api/news/newslistpage?type=0&page=1"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for item in data.get("Result", [])[:limit]:
                news.append({
                    "title": item.get("title", ""),
                    "commentCount": item.get("commentCount", 0),
                })
    except Exception as e:
        news.append({"error": f"获取 IT之家资讯失败: {e}"})
    return news


def fetch_toutiao_hot(limit: int = 5) -> list[dict]:
    """获取今日头条热榜（无需 API Key）"""
    news = []
    try:
        url = "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            for item in data.get("data", [])[:limit]:
                news.append({
                    "title": item.get("Title", ""),
                    "hot": item.get("HotValue", ""),
                })
    except Exception as e:
        news.append({"error": f"获取今日头条热榜失败: {e}"})
    return news


def fetch_36kr_hot(limit: int = 5) -> list[dict]:
    """获取 36氪 热门文章（无需 API Key）"""
    news = []
    try:
        url = "https://36kr.com/api/search-column/mainsite?per_page=%d&page=1" % limit
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            items = data.get("data", {}).get("items", [])
            for item in items[:limit]:
                entity = item.get("entity", {})
                news.append({
                    "title": entity.get("title", ""),
                    "summary": (entity.get("summary") or "")[:60],
                })
    except Exception as e:
        news.append({"error": f"获取36氪热文失败: {e}"})
    return news


# ============================================================
# 消息格式化
# ============================================================

def format_number(n) -> str:
    """格式化数字：1000 → 1k, 1000000 → 1m"""
    try:
        n = int(n)
        if n >= 1_000_000:
            return "%.1fm" % (n / 1_000_000)
        elif n >= 1_000:
            return "%.1fk" % (n / 1_000)
        return str(n)
    except (ValueError, TypeError):
        return str(n)


def build_message(github_repos: list, weibo: list, zhihu: list, ithome: list,
                  toutiao: list, kr36: list) -> str:
    """构建推送消息"""
    weekday_cn = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]
    now = datetime.now().strftime("%Y年%m月%d日 ") + weekday_cn[datetime.now().weekday()]

    lines = [
        f"📰 每日热点推送",
        f"📅 {now}",
        f"{'=' * 30}",
    ]

    # 微博热搜
    if weibo and not any("error" in w for w in weibo):
        lines.append("\n🔥 微博热搜")
        lines.append("-" * 20)
        for i, item in enumerate(weibo[:5], 1):
            if "error" in item:
                continue
            hot_str = format_number(item.get("hot", ""))
            lines.append(f"  {i}. {item['title']} ({hot_str})")

    # 知乎热榜
    if zhihu and not any("error" in z for z in zhihu):
        lines.append("\n💡 知乎热榜")
        lines.append("-" * 20)
        for i, item in enumerate(zhihu[:5], 1):
            if "error" in item:
                continue
            lines.append(f"  {i}. {item['title']}")

    # IT之家
    if ithome and not any("error" in it for it in ithome):
        lines.append("\n💻 科技资讯")
        lines.append("-" * 20)
        for i, item in enumerate(ithome[:5], 1):
            if "error" in item:
                continue
            lines.append(f"  {i}. {item['title']}")

    # GitHub Trending
    if github_repos and not any("error" in r for r in github_repos):
        lines.append("\n🚀 GitHub 热门项目")
        lines.append("-" * 20)
        for i, repo in enumerate(github_repos[:5], 1):
            if "error" in repo:
                lines.append(f"  {repo['error']}")
                continue
            stars_str = format_number(repo["stars"])
            lines.append(f"  {i}. {repo['name']} ⭐{stars_str}")
            lines.append(f"     {repo['desc']}")

    # 今日头条
    if toutiao and not any("error" in t for t in toutiao):
        lines.append("\n📱 今日头条热榜")
        lines.append("-" * 20)
        for i, item in enumerate(toutiao[:5], 1):
            if "error" in item:
                continue
            hot_str = format_number(item.get("hot", ""))
            lines.append(f"  {i}. {item['title']} ({hot_str})")

    # 36氪
    if kr36 and not any("error" in k for k in kr36):
        lines.append("\n💼 36氪热文")
        lines.append("-" * 20)
        for i, item in enumerate(kr36[:5], 1):
            if "error" in item:
                continue
            lines.append(f"  {i}. {item['title']}")

    lines.append(f"\n{'=' * 30}")
    lines.append("🤖 由 skychat-ai 自动推送")
    lines.append("📦 github.com/claudeskydream-hash/skychat-ai")

    return "\n".join(lines)


# ============================================================
# 消息推送
# ============================================================

def send_message(config: dict, text: str) -> bool:
    """通过 skychat-ai Webhook API 发送消息"""
    webhook_url = config["webhook_url"].rstrip("/")
    payload = {
        "channel": config["channel"],
        "targetId": config["target_id"],
        "text": text,
    }

    headers = {
        "Content-Type": "application/json",
    }
    if config["secret"]:
        headers["Authorization"] = f"Bearer {config['secret']}"

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        webhook_url,
        data=data,
        headers=headers,
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("ok"):
                print("[成功] 消息已推送")
                return True
            else:
                print(f"[失败] 服务器返回: {result}")
                return False
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"[失败] HTTP {e.code}: {body}")
        return False
    except urllib.error.URLError as e:
        print(f"[失败] 连接失败: {e.reason}")
        print(f"  请确认 skychat-ai 已启动且 Webhook 已开启")
        print(f"  Webhook 地址: {webhook_url}")
        return False
    except Exception as e:
        print(f"[失败] 异常: {e}")
        return False


# ============================================================
# 主流程
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="每日热点新闻推送到微信（通过 skychat-ai Webhook）")
    parser.add_argument("--webhook-url", help="skychat-ai Webhook 地址")
    parser.add_argument("--secret", help="Webhook 认证密钥")
    parser.add_argument("--channel", default="weixin", help="目标渠道 (默认: weixin)")
    parser.add_argument("--target-id", help="目标用户 ID")
    parser.add_argument("--dry-run", action="store_true", help="仅测试，打印消息不发送")
    parser.add_argument("--max-news", type=int, default=5, help="每个源最大条数 (默认: 5)")
    args = parser.parse_args()

    # 加载配置
    config = load_config()

    # 命令行参数覆盖
    if args.webhook_url:
        config["webhook_url"] = args.webhook_url
    if args.secret:
        config["secret"] = args.secret
    if args.channel:
        config["channel"] = args.channel
    if args.target_id:
        config["target_id"] = args.target_id
    if args.max_news:
        config["max_news"] = args.max_news

    print("=" * 40)
    print("  每日热点新闻推送")
    print("=" * 40)

    # 获取新闻
    print("\n📡 正在获取热点新闻...")
    github_repos = fetch_trending_repos(limit=config["max_news"])
    weibo = fetch_weibo_hot(limit=config["max_news"])
    zhihu = fetch_zhihu_hot(limit=config["max_news"])
    ithome = fetch_ithome_hot(limit=config["max_news"])
    toutiao = fetch_toutiao_hot(limit=config["max_news"])
    kr36 = fetch_36kr_hot(limit=config["max_news"])

    # 构建消息
    message = build_message(github_repos, weibo, zhihu, ithome, toutiao, kr36)

    # 测试模式
    if args.dry_run:
        print("\n📋 [测试模式] 消息内容：")
        print("-" * 40)
        print(message)
        print("-" * 40)
        print(f"\n消息长度: {len(message)} 字符")
        return

    # 检查必要配置
    if not config["target_id"]:
        print("\n❌ 错误：未配置 target_id")
        print("  请通过以下任一方式设置目标用户 ID：")
        print(f"  1. 设置环境变量: set SKYCHAT_TARGET_ID=your_user_id")
        print(f"  2. 编辑配置文件: {CONFIG_FILE}")
        print(f"  3. 命令行参数: --target-id your_user_id")
        sys.exit(1)

    # 发送消息
    print(f"\n📨 正在推送到 {config['channel']}...")
    print(f"  Webhook: {config['webhook_url']}")
    print(f"  目标用户: {config['target_id']}")

    success = send_message(config, message)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
