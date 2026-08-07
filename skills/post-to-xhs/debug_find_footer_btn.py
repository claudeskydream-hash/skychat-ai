"""
找底部固定"发布"按钮的选择器（已知它存在于大视口截图中）
"""
import sys, time
sys.path.insert(0, 'scripts')
sys.stdout.reconfigure(encoding='utf-8')
from cdp_publish import XiaohongshuPublisher, SELECTORS

pub = XiaohongshuPublisher(host='127.0.0.1', port=9222)
pub.connect()

pub._navigate('https://creator.xiaohongshu.com/publish/publish?source=official')
time.sleep(3)

# 设置大视口
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

# 搜索所有包含"发布"文本的元素（大视口后）
print('\n=== 所有"发布"相关元素 ===')
publish_els = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text === '发布' || text === '发布笔记' || text === '立即发布') {
            const rect = el.getBoundingClientRect();
            results.push({
                tag: el.tagName,
                cls: (el.className || '').slice(0, 80),
                id: el.id || '',
                text: text,
                x: Math.round(rect.x), y: Math.round(rect.y),
                w: Math.round(rect.width), h: Math.round(rect.height),
                visible: el.offsetParent !== null,
                position: window.getComputedStyle(el).position
            });
        }
    }
    return results;
})()
""")
print(f'Found {len(publish_els)} elements:')
for el in publish_els:
    print(' ', el)

# 查找底部固定/sticky元素
print('\n=== 固定定位元素 ===')
fixed_els = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const style = window.getComputedStyle(el);
        if (style.position === 'fixed' || style.position === 'sticky') {
            const rect = el.getBoundingClientRect();
            if (rect.width > 30 && rect.height > 15) {
                results.push({
                    tag: el.tagName,
                    cls: (el.className || '').slice(0, 80),
                    text: (el.innerText || '').trim().slice(0, 50),
                    position: style.position,
                    x: Math.round(rect.x), y: Math.round(rect.y),
                    w: Math.round(rect.width), h: Math.round(rect.height)
                });
            }
        }
    }
    return results;
})()
""")
print(f'Found {len(fixed_els)} fixed/sticky elements:')
for el in fixed_els:
    print(' ', el)

# 在 y > 700 区域（底部）找所有可见元素
print('\n=== y > 700 的可见元素 ===')
bottom_visible = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.y > 700 && rect.width > 20 && rect.height > 15 && el.offsetParent !== null) {
            results.push({
                tag: el.tagName,
                cls: (el.className || '').slice(0, 80),
                text: (el.innerText || el.textContent || '').trim().slice(0, 50),
                x: Math.round(rect.x), y: Math.round(rect.y),
                w: Math.round(rect.width), h: Math.round(rect.height)
            });
        }
    }
    return results;
})()
""")
print(f'Found {len(bottom_visible)} elements at y>700:')
for el in bottom_visible:
    print(' ', el)
