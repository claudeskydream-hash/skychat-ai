"""
用 CDP DOM 方法找 xhs-publish-btn shadow root 内部节点并点击
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

# 方法1: 用 CDP DOM.querySelectorAll with pierce
print('\n=== 方法1: CDP pierce 搜索"发布"按钮 ===')
# 先获取文档
doc = pub._send("DOM.getDocument", {"depth": 1, "pierce": False})
root_id = doc.get("root", {}).get("nodeId", 0)
print(f'Root nodeId: {root_id}')

# 用 DOM.performSearch 搜索 xhs-publish-btn
search_result = pub._send("DOM.performSearch", {
    "query": "xhs-publish-btn",
    "includeUserAgentShadowDOM": True
})
search_id = search_result.get("searchId", "")
count = search_result.get("resultCount", 0)
print(f'Search results: {count} nodes for "xhs-publish-btn"')

if count > 0:
    nodes = pub._send("DOM.getSearchResults", {
        "searchId": search_id,
        "fromIndex": 0,
        "toIndex": count
    })
    xhs_btn_node_ids = nodes.get("nodeIds", [])
    print(f'Node IDs: {xhs_btn_node_ids}')

    for nid in xhs_btn_node_ids:
        # 获取详细节点信息（包含 shadowRoot）
        node_info = pub._send("DOM.describeNode", {
            "nodeId": nid,
            "depth": 5,
            "pierce": True  # pierce shadow roots
        })
        node = node_info.get("node", {})
        shadow_roots = node.get("shadowRoots", [])
        print(f'\nNode {nid}: {node.get("nodeName")}')
        print(f'  shadowRoots count: {len(shadow_roots)}')
        for sr in shadow_roots:
            print(f'  shadowRoot type: {sr.get("shadowRootType")}')
            sr_children = sr.get("children", [])
            print(f'  shadowRoot children: {len(sr_children)}')
            for child in sr_children:
                print(f'    child: {child.get("nodeName")}, attrs: {child.get("attributes", [])}')

# 方法2: 通过 DOM.performSearch 搜索 shadow root 内的按钮
print('\n=== 方法2: 搜索 shadow root 内的 button 元素 ===')
# 在 shadow root 内用 CSS 选择器查询
sr_search = pub._send("DOM.performSearch", {
    "query": "button",
    "includeUserAgentShadowDOM": True
})
sr_count = sr_search.get("resultCount", 0)
print(f'Found {sr_count} button elements (including shadow DOM)')
if sr_count > 0 and sr_count < 50:
    btn_results = pub._send("DOM.getSearchResults", {
        "searchId": sr_search.get("searchId", ""),
        "fromIndex": 0,
        "toIndex": sr_count
    })
    for bid in btn_results.get("nodeIds", []):
        try:
            binfo = pub._send("DOM.describeNode", {"nodeId": bid, "depth": 1})
            bnode = binfo.get("node", {})
            battrs = bnode.get("attributes", [])
            # 检查是否有 class 属性
            print(f'  Button {bid}: attrs={battrs[:6]}')
        except:
            pass

# 方法3: 直接用 JS dispatchEvent 在 xhs-publish-btn 上触发 click
print('\n=== 方法3: JS 合成点击事件 ===')
click_result = pub._evaluate(r"""
(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (!el) return 'not found';
    // 获取 submit-text 属性
    const submitText = el.getAttribute('submit-text');
    const submitDisabled = el.getAttribute('submit-disabled');
    console.log('xhs-publish-btn attrs:', submitText, submitDisabled);

    // 尝试直接点击元素
    el.click();
    return {clicked: true, submitText, submitDisabled};
})()
""")
print('JS click result:', click_result)
time.sleep(1)
url1 = pub._evaluate('window.location.href')
print(f'URL after JS click: {url1}')

# 方法4: 触发 submit 事件或自定义事件
print('\n=== 方法4: 发送 submit 相关自定义事件 ===')
event_result = pub._evaluate(r"""
(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (!el) return 'not found';

    // 尝试各种事件
    const events = ['submit', 'click', 'pointerdown', 'pointerup'];
    const results = [];

    // 先模拟 mousedown + mouseup
    const makeEvent = (type) => new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: el.getBoundingClientRect().x + el.getBoundingClientRect().width * 0.8,
        clientY: el.getBoundingClientRect().y + el.getBoundingClientRect().height / 2
    });

    el.dispatchEvent(makeEvent('mousedown'));
    el.dispatchEvent(makeEvent('mouseup'));
    el.dispatchEvent(makeEvent('click'));

    return 'events dispatched';
})()
""")
print('Custom events result:', event_result)
time.sleep(2)
url2 = pub._evaluate('window.location.href')
print(f'URL after custom events: {url2}')

# 截图
result = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
with open(r'C:\Users\Administrator\AppData\Local\Temp\xhs_shadow_debug.png', 'wb') as f:
    f.write(base64.b64decode(result.get("data", "")))
print('Screenshot saved')
