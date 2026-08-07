"""
调试：在填表后查找"发布"相关元素（包含 div, span, a 等所有标签）
"""
import sys, time
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

print('\n=== 搜索包含"发布"文本的所有元素 ===')
publish_els = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const text = (el.innerText || el.textContent || '').trim();
        if (text === '发布' || text === '发布笔记' || text === '发布视频') {
            const rect = el.getBoundingClientRect();
            results.push({
                tag: el.tagName,
                cls: (el.className || '').slice(0, 80),
                text: text.slice(0, 30),
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                visible: el.offsetParent !== null,
                disabled: el.hasAttribute('disabled')
            });
        }
    }
    return results;
})()
""")
print(f'Found {len(publish_els)} elements with "发布" text:')
for el in publish_els:
    print(' ', el)

print('\n=== class 包含 publish 的元素 ===')
publish_cls_els = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('[class*="publish"], [class*="Publish"]');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
            results.push({
                tag: el.tagName,
                cls: (el.className || '').slice(0, 80),
                text: (el.innerText || '').trim().slice(0, 40),
                x: Math.round(rect.x),
                y: Math.round(rect.y)
            });
        }
    }
    return results;
})()
""")
print(f'Found {len(publish_cls_els)} elements with class publish:')
for el in publish_cls_els:
    print(' ', el)

print('\n=== 页面滚动高度和 body 结构 ===')
scroll_info = pub._evaluate(r"""
(() => {
    return {
        scrollHeight: document.body.scrollHeight,
        clientHeight: document.body.clientHeight,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth
    };
})()
""")
print('Scroll info:', scroll_info)

print('\n=== 所有可见的 div/span 按钮样式元素（红色背景）===')
red_els = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundColor;
        if (bg && (bg.includes('220, 0, 0') || bg.includes('255, 0, 0') || bg.includes('228, 23, 50') || bg.includes('216, 33, 52'))) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                results.push({
                    tag: el.tagName,
                    cls: (el.className || '').slice(0, 80),
                    text: (el.innerText || '').trim().slice(0, 40),
                    bg: bg,
                    x: Math.round(rect.x), y: Math.round(rect.y)
                });
            }
        }
    }
    return results;
})()
""")
print(f'Found {len(red_els)} elements with red background:')
for el in red_els:
    print(' ', el)
