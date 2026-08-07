"""
调试：滚动 .publish-page 容器到底部，然后找发布按钮
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

# 滚动 .publish-page 到底部
print('\n=== 滚动 .publish-page 容器 ===')
scroll_result = pub._evaluate(r"""
(() => {
    const el = document.querySelector('.publish-page');
    if (!el) return 'not found';
    const before = el.scrollTop;
    el.scrollTop = 99999;
    const after = el.scrollTop;
    return {before, after, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight};
})()
""")
print('Scroll result:', scroll_result)
time.sleep(1)

# 搜索所有包含"发布"的元素（包括viewport外）
print('\n=== 搜索所有"发布"相关元素（含 viewport 外）===')
all_publish = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        // 直接获取元素自己的文本（不包含子元素）
        let ownText = '';
        for (const node of el.childNodes) {
            if (node.nodeType === 3) {  // TEXT_NODE
                ownText += node.textContent;
            }
        }
        ownText = ownText.trim();
        const fullText = (el.innerText || el.textContent || '').trim();

        if ((fullText === '发布' || fullText === '发布笔记' || fullText === '立即发布') &&
            el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') {
            const rect = el.getBoundingClientRect();
            results.push({
                tag: el.tagName,
                cls: (el.className || '').slice(0, 60),
                text: fullText,
                x: Math.round(rect.x), y: Math.round(rect.y),
                inViewport: rect.y >= 0 && rect.y < window.innerHeight
            });
        }
    }
    return results;
})()
""")
print(f'Found {len(all_publish)} elements:')
for el in all_publish:
    print(' ', el)

# 检查 .publish-page 底部的内容
print('\n=== .publish-page 底部元素（offsetTop > 1300）===')
bottom_els = pub._evaluate(r"""
(() => {
    const page = document.querySelector('.publish-page');
    if (!page) return 'no .publish-page';
    const all = page.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        if (el.offsetTop > 1300) {
            const text = (el.innerText || el.textContent || '').trim().slice(0, 60);
            if (text) {
                results.push({
                    tag: el.tagName,
                    cls: (el.className || '').slice(0, 60),
                    text: text,
                    offsetTop: el.offsetTop,
                    h: el.offsetHeight
                });
            }
        }
    }
    return results;
})()
""")
print(f'Elements near bottom:')
if isinstance(bottom_els, list):
    for el in bottom_els[:20]:
        print(' ', el)
else:
    print(bottom_els)

# 检查滚动后可见的按钮
print('\n=== 滚动后可见按钮 ===')
buttons = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('button, [role="button"], .d-button, [class*="btn"]');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20 && el.offsetParent !== null) {
            results.push({
                tag: el.tagName,
                cls: (el.className || '').slice(0, 80),
                text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50),
                x: Math.round(rect.x), y: Math.round(rect.y)
            });
        }
    }
    return results;
})()
""")
print(f'Total buttons: {len(buttons)}')
for b in buttons:
    print(' ', b)

# 截图检查当前页面状态（用 MCP 或 JS）
print('\n=== 当前 viewport 截图信息（文本描述）===')
viewport_els = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.y >= 0 && rect.y < window.innerHeight && rect.width > 30 && rect.height > 15) {
            const text = (el.innerText || '').trim().slice(0, 40);
            if (text && !el.querySelector('*')) {  // 叶节点
                results.push({
                    tag: el.tagName,
                    cls: (el.className || '').slice(0, 40),
                    text: text,
                    x: Math.round(rect.x), y: Math.round(rect.y)
                });
            }
        }
    }
    return results.slice(0, 30);
})()
""")
print('Visible leaf elements:')
for el in viewport_els:
    print(' ', el)
