"""
查找 #d-portal 内部的发布按钮并点击
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

# 查找 #d-portal 内的所有元素
print('\n=== #d-portal 内部结构 ===')
portal_content = pub._evaluate(r"""
(() => {
    const portal = document.getElementById('d-portal');
    if (!portal) return 'no #d-portal';
    const all = portal.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            results.push({
                tag: el.tagName,
                cls: el.className ? el.className.toString().slice(0, 80) : '',
                text: (el.innerText || el.textContent || '').trim().slice(0, 50),
                x: Math.round(rect.x), y: Math.round(rect.y),
                w: Math.round(rect.width), h: Math.round(rect.height)
            });
        }
    }
    return results;
})()
""")
if isinstance(portal_content, list):
    print(f'Portal has {len(portal_content)} elements:')
    for el in portal_content:
        print(' ', el)
else:
    print(portal_content)

# 在 portal 内找"发布"相关元素
print('\n=== portal 内"发布"文本元素 ===')
publish_in_portal = pub._evaluate(r"""
(() => {
    const portal = document.getElementById('d-portal');
    if (!portal) return 'no portal';
    const all = portal.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text.includes('发布') || text.includes('暂存')) {
            const rect = el.getBoundingClientRect();
            results.push({
                tag: el.tagName,
                cls: el.className ? el.className.toString().slice(0, 80) : '',
                text: text.slice(0, 50),
                x: Math.round(rect.x), y: Math.round(rect.y),
                w: Math.round(rect.width), h: Math.round(rect.height)
            });
        }
    }
    return results;
})()
""")
if isinstance(publish_in_portal, list):
    print(f'Found {len(publish_in_portal)} "发布" elements in portal:')
    for el in publish_in_portal:
        print(' ', el)
else:
    print(publish_in_portal)

# 尝试用 JavaScript 直接点击 portal 内的发布按钮
print('\n=== 尝试 JS click 发布按钮 ===')
click_result = pub._evaluate(r"""
(() => {
    const portal = document.getElementById('d-portal');
    if (!portal) return 'no portal';
    // 找包含"发布"文本的元素
    const all = portal.querySelectorAll('*');
    for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text === '发布') {
            const rect = el.getBoundingClientRect();
            return {
                found: true,
                tag: el.tagName,
                cls: el.className ? el.className.toString().slice(0, 80) : '',
                x: Math.round(rect.x + rect.width/2),
                y: Math.round(rect.y + rect.height/2)
            };
        }
    }
    return {found: false};
})()
""")
print('Click result:', click_result)

if isinstance(click_result, dict) and click_result.get('found'):
    cx, cy = click_result['x'], click_result['y']
    print(f'\n发布按钮在 ({cx}, {cy})，用 CDP 鼠标事件点击...')
    pub._send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1})
    pub._send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cx, "y": cy, "button": "left", "clickCount": 1})
    time.sleep(3)
    url = pub._evaluate('window.location.href')
    print(f'URL after click: {url}')
    result = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
    with open(r'C:\Users\Administrator\AppData\Local\Temp\xhs_portal_click.png', 'wb') as f:
        f.write(base64.b64decode(result.get("data", "")))
    print('Screenshot after click saved')
