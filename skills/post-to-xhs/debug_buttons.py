import sys, json, time
sys.path.insert(0, 'scripts')
sys.stdout.reconfigure(encoding='utf-8')
from cdp_publish import XiaohongshuPublisher

pub = XiaohongshuPublisher(host='127.0.0.1', port=9222)
pub.connect()

pub._navigate('https://creator.xiaohongshu.com/publish/publish?source=official')
time.sleep(2)

# 切换到图文tab
pub._click_tab('.creator-tab:nth-child(2)', '上传图文')
time.sleep(1)

# 上传图片
img_path = r'C:\Users\Administrator\AppData\Local\Temp\debug_xhs.jpg'
pub._upload_images([img_path])
time.sleep(3)

# 填标题和正文
pub._fill_title('让AI视频秒变机器人动作！video2robot')
pub._fill_content('测试正文内容')
time.sleep(2)

# 列出所有可见按钮
print('=== 当前页面按钮 ===')
js = r"""
(() => {
  const all = document.querySelectorAll('button, [role="button"]');
  const results = [];
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
      results.push({
        tag: el.tagName,
        cls: (el.className || '').slice(0, 80),
        text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        disabled: el.hasAttribute('disabled')
      });
    }
  }
  return results;
})()
"""
buttons = pub._evaluate(js)
for b in buttons:
    print(b)

print()
print('=== is_publish_button_ready():', pub._is_publish_button_ready())
