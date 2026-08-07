"""
调试：滚动发布表单容器，找到底部的发布按钮
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

# 找到表单容器，查看其滚动高度
print('\n=== 表单容器滚动信息 ===')
container_info = pub._evaluate(r"""
(() => {
    const containers = [
        '.publish-page-content',
        '.publish-vue-container',
        '.outarea.publish-c',
        '.publish-container',
        '.publish-page'
    ];
    const result = {};
    for (const sel of containers) {
        const el = document.querySelector(sel);
        if (el) {
            result[sel] = {
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
                scrollTop: el.scrollTop,
                overflow: window.getComputedStyle(el).overflow,
                overflowY: window.getComputedStyle(el).overflowY
            };
        }
    }
    return result;
})()
""")
for sel, info in container_info.items():
    print(f'  {sel}: {info}')

# 向下滚动各个容器到底部
print('\n=== 滚动表单到底部 ===')
scroll_result = pub._evaluate(r"""
(() => {
    const containers = [
        '.publish-page-content',
        '.publish-vue-container',
        '.outarea.publish-c',
        '.publish-container'
    ];
    const results = [];
    for (const sel of containers) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight) {
            el.scrollTop = el.scrollHeight;
            results.push({sel: sel, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight});
        }
    }
    // 也尝试滚动主窗口
    window.scrollTo(0, 99999);
    return results;
})()
""")
print('Scrolled:', scroll_result)
time.sleep(1)

# 再次搜索发布相关元素
print('\n=== 滚动后搜索"发布"文本元素 ===')
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
                text: text,
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
                visible: el.offsetParent !== null
            });
        }
    }
    return results;
})()
""")
print(f'Found {len(publish_els)} "发布" elements after scroll:')
for el in publish_els:
    print(' ', el)

# 检查滚动后底部的元素
print('\n=== 滚动后所有可见按钮 ===')
buttons = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('button, [role="button"], .d-button, [class*="btn"]:not(input)');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20 && el.offsetParent !== null) {
            results.push({
                tag: el.tagName,
                cls: (el.className || '').slice(0, 80),
                text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
                x: Math.round(rect.x), y: Math.round(rect.y),
                disabled: el.hasAttribute('disabled')
            });
        }
    }
    return results;
})()
""")
print(f'Total buttons after scroll: {len(buttons)}')
for b in buttons:
    print(' ', b)

# 检查 publish-page-publish-btn
print('\n=== 检查 publish-page-publish-btn ===')
pbn = pub._evaluate(r"""
(() => {
    // 检查各种可能的发布按钮容器
    const selectors = [
        '.publish-page-publish-btn',
        '[class*="publish-btn"]',
        '[class*="publishBtn"]',
        '[class*="submit"]',
        '.footer',
        '.page-footer',
        '.bottom-bar'
    ];
    const results = {};
    for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
            const el = els[0];
            results[sel] = {
                count: els.length,
                html: el.outerHTML.slice(0, 200)
            };
        }
    }
    return results;
})()
""")
for sel, info in pbn.items():
    print(f'  {sel}: {info}')
