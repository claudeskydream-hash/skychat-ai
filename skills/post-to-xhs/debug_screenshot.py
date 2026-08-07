"""
通过 CDP 截取 XHS 发布页截图
"""
import sys, time, base64
sys.path.insert(0, 'scripts')
sys.stdout.reconfigure(encoding='utf-8')
from cdp_publish import XiaohongshuPublisher, SELECTORS

pub = XiaohongshuPublisher(host='127.0.0.1', port=9222)
pub.connect()

pub._navigate('https://creator.xiaohongshu.com/publish/publish?source=official')
time.sleep(3)

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

# 截图当前状态（无滚动）
result = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
screenshot_b64 = result.get("data", "")
output_path = r'C:\Users\Administrator\AppData\Local\Temp\xhs_state1.png'
with open(output_path, 'wb') as f:
    f.write(base64.b64decode(screenshot_b64))
print(f'Screenshot 1 saved: {output_path}')

# 设置视口更大
pub._send("Emulation.setDeviceMetricsOverride", {
    "width": 1440,
    "height": 900,
    "deviceScaleFactor": 1,
    "mobile": False
})
time.sleep(1)

# 截图更大视口
result2 = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
screenshot_b64_2 = result2.get("data", "")
output_path2 = r'C:\Users\Administrator\AppData\Local\Temp\xhs_state2.png'
with open(output_path2, 'wb') as f:
    f.write(base64.b64decode(screenshot_b64_2))
print(f'Screenshot 2 (large viewport) saved: {output_path2}')

# 查看扩展视口后的"发布"元素
time.sleep(1)
publish_els = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text === '发布' || text === '发布笔记' || text === '立即发布') {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0) {
                results.push({
                    tag: el.tagName,
                    cls: (el.className || '').slice(0, 60),
                    text: text,
                    x: Math.round(rect.x), y: Math.round(rect.y),
                    w: Math.round(rect.width), h: Math.round(rect.height)
                });
            }
        }
    }
    return results;
})()
""")
print('\n发布元素（大视口后）:')
for el in publish_els:
    print(' ', el)

# 搜索右侧预览面板内容
preview_content = pub._evaluate(r"""
(() => {
    const preview = document.querySelector('.publish-page-preview');
    if (!preview) return 'no preview panel';
    const all = preview.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 15 && el.offsetParent !== null) {
            const text = (el.innerText || '').trim().slice(0, 40);
            if (text) {
                results.push({
                    tag: el.tagName,
                    cls: (el.className || '').slice(0, 60),
                    text: text,
                    x: Math.round(rect.x), y: Math.round(rect.y)
                });
            }
        }
    }
    return results.slice(0, 30);
})()
""")
print('\n右侧预览面板内容:')
if isinstance(preview_content, list):
    for el in preview_content:
        print(' ', el)
else:
    print(preview_content)
