"""
查找 xhs-publish-btn Web Component 的 Shadow DOM 内部结构
"""
import sys, time, base64
sys.path.insert(0, 'scripts')
sys.stdout.reconfigure(encoding='utf-8')
from cdp_publish import XiaohongshuPublisher, SELECTORS

pub = XiaohongshuPublisher(host='127.0.0.1', port=9222)
pub.connect()

pub._navigate('https://creator.xiaohongshu.com/publish/publish?source=official')
time.sleep(3)

pub._send("Emulation.setDeviceMetricsOverride", {
    "width": 1440, "height": 900, "deviceScaleFactor": 1, "mobile": False
})
time.sleep(1)

pub._click_tab(SELECTORS["image_text_tab"], SELECTORS["image_text_tab_text"])
time.sleep(2)

img_path = r'C:\Users\Administrator\AppData\Local\Temp\debug_xhs.jpg'
node_id = pub._query_node_id(SELECTORS["upload_input"])
if not node_id:
    node_id = pub._query_node_id(SELECTORS["upload_input_alt"])
pub._send("DOM.setFileInputFiles", {"nodeId": node_id, "files": [img_path]})
print('File submitted, waiting 12s...')
time.sleep(12)

pub._fill_title('测试标题')
pub._fill_content('测试正文')
time.sleep(2)

# 检查 xhs-publish-btn 的 shadow DOM
print('\n=== xhs-publish-btn Shadow DOM ===')
shadow_info = pub._evaluate(r"""
(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (!el) return 'xhs-publish-btn not found';
    const shadow = el.shadowRoot;
    if (!shadow) return 'no shadowRoot, innerHTML: ' + el.innerHTML.slice(0, 500);
    // 获取 shadow DOM 内容
    const allInShadow = shadow.querySelectorAll('*');
    const results = [];
    for (const node of allInShadow) {
        const rect = node.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            results.push({
                tag: node.tagName,
                cls: (node.className || '').toString().slice(0, 60),
                text: (node.innerText || node.textContent || '').trim().slice(0, 40),
                x: Math.round(rect.x), y: Math.round(rect.y),
                w: Math.round(rect.width), h: Math.round(rect.height)
            });
        }
    }
    return results;
})()
""")
if isinstance(shadow_info, list):
    print(f'Shadow DOM has {len(shadow_info)} elements:')
    for el in shadow_info:
        print(' ', el)
else:
    print(shadow_info)

# 检查 xhs-publish-btn 直接内容（非 shadow）
print('\n=== xhs-publish-btn innerHTML ===')
innerHTML = pub._evaluate(r"""
(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (!el) return 'not found';
    return el.innerHTML.slice(0, 1000);
})()
""")
print(innerHTML)

# 获取 xhs-publish-btn 的位置
print('\n=== xhs-publish-btn 位置 ===')
pos = pub._evaluate(r"""
(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
})()
""")
print('Position:', pos)

# 尝试直接点击 xhs-publish-btn 中心
if pos and isinstance(pos, dict):
    cx = pos['x'] + pos['w'] // 2
    cy = pos['y'] + pos['h'] // 2
    print(f'\n=== 点击 xhs-publish-btn 中心 ({cx}, {cy}) ===')
    # 先截图
    result = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
    with open(r'C:\Users\Administrator\AppData\Local\Temp\xhs_before_click.png', 'wb') as f:
        f.write(base64.b64decode(result.get("data", "")))
    print('Before-click screenshot saved')

    pub._send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1})
    pub._send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cx, "y": cy, "button": "left", "clickCount": 1})
    time.sleep(3)

    result2 = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
    with open(r'C:\Users\Administrator\AppData\Local\Temp\xhs_after_click.png', 'wb') as f:
        f.write(base64.b64decode(result2.get("data", "")))
    print('After-click screenshot saved')

    # 检查当前 URL
    url = pub._send("Runtime.evaluate", {"expression": "window.location.href"})
    print('Current URL:', url.get("result", {}).get("value", ""))
