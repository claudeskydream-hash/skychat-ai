"""
找底部"发布"按钮的真实 DOM 位置（用 TreeWalker 扫描所有文本节点）
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

# 用 TreeWalker 找包含"发布"的文本节点和其父元素
print('\n=== TreeWalker 扫描文本节点 ===')
text_nodes = pub._evaluate(r"""
(() => {
    const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
            acceptNode: (node) => {
                const text = node.textContent.trim();
                if (text === '发布' || text === '发布笔记') {
                    return NodeFilter.FILTER_ACCEPT;
                }
                return NodeFilter.FILTER_REJECT;
            }
        }
    );
    const results = [];
    let node;
    while ((node = walker.nextNode())) {
        const parent = node.parentElement;
        const gp = parent ? parent.parentElement : null;
        const rect = parent ? parent.getBoundingClientRect() : null;
        results.push({
            text: node.textContent.trim(),
            parentTag: parent ? parent.tagName : '',
            parentCls: parent ? (parent.className || '').toString().slice(0, 60) : '',
            gpTag: gp ? gp.tagName : '',
            gpCls: gp ? (gp.className || '').toString().slice(0, 60) : '',
            x: rect ? Math.round(rect.x) : 0,
            y: rect ? Math.round(rect.y) : 0,
            w: rect ? Math.round(rect.width) : 0,
            h: rect ? Math.round(rect.height) : 0
        });
    }
    return results;
})()
""")
print(f'Found {len(text_nodes)} text nodes with "发布":')
for n in text_nodes:
    print(' ', n)

# 检查 xhs-publish-btn 的父元素和兄弟元素
print('\n=== xhs-publish-btn 父/兄弟元素 ===')
sibling_info = pub._evaluate(r"""
(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (!el) return 'not found';
    const parent = el.parentElement;
    const result = {
        parentTag: parent ? parent.tagName : '',
        parentCls: parent ? (parent.className || '').toString().slice(0, 80) : '',
        children: [],
        siblings: []
    };
    if (parent) {
        for (const child of parent.children) {
            const rect = child.getBoundingClientRect();
            result.children.push({
                tag: child.tagName,
                cls: (child.className || '').toString().slice(0, 60),
                text: (child.innerText || child.textContent || '').trim().slice(0, 40),
                x: Math.round(rect.x), y: Math.round(rect.y),
                w: Math.round(rect.width), h: Math.round(rect.height)
            });
        }
    }
    // 检查 el 自己的 children (渲染内容)
    for (const child of el.children) {
        const rect = child.getBoundingClientRect();
        result.siblings.push({
            tag: child.tagName,
            cls: (child.className || '').toString().slice(0, 60),
            text: (child.innerText || child.textContent || '').trim().slice(0, 40),
            x: Math.round(rect.x), y: Math.round(rect.y)
        });
    }
    return result;
})()
""")
print(sibling_info)

# 直接在 y > 780 范围内查找所有元素（无论可见性）
print('\n=== 页面底部所有元素（offsetTop > 780，包含 xhs-publish-btn 内部）===')
all_bottom = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('*');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.y > 780 && rect.y < 920) {
            results.push({
                tag: el.tagName,
                cls: el.className ? el.className.toString().slice(0, 60) : '',
                text: (el.innerText || el.textContent || '').trim().slice(0, 40),
                x: Math.round(rect.x), y: Math.round(rect.y),
                w: Math.round(rect.width), h: Math.round(rect.height),
                visible: el.offsetParent !== null
            });
        }
    }
    return results;
})()
""")
print(f'Found {len(all_bottom)} elements at y=780-920:')
for el in all_bottom:
    print(' ', el)

# 直接尝试点击"发布"按钮的近似位置（从截图估算）
# 截图 1440x900, 发布按钮在右下约 x=716, y=825
print('\n=== 直接点击"发布"按钮位置 (716, 825) ===')
pub._send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": 716, "y": 825, "button": "left", "clickCount": 1})
pub._send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": 716, "y": 825, "button": "left", "clickCount": 1})
time.sleep(3)

result3 = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
with open(r'C:\Users\Administrator\AppData\Local\Temp\xhs_after_direct_click.png', 'wb') as f:
    f.write(base64.b64decode(result3.get("data", "")))
print('Screenshot after direct click saved')

url_after = pub._evaluate('window.location.href')
print(f'URL after click: {url_after}')
