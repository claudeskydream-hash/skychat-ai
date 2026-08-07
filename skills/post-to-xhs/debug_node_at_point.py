"""
用 CDP DOM.getNodeForLocation 找坐标处的真实 DOM 节点
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

# 用 DOM.getNodeForLocation 找特定坐标处的节点
test_points = [
    (716, 825, '发布按钮预期位置'),
    (580, 825, '暂存离开预期位置'),
    (671, 855, '上次点击位置'),
    (671, 810, 'xhs-publish-btn 上部'),
]

for x, y, label in test_points:
    print(f'\n=== 坐标 ({x}, {y}) - {label} ===')
    try:
        result = pub._send("DOM.getNodeForLocation", {
            "x": x, "y": y,
            "includeUserAgentShadowDOM": True,
            "ignorePointerEventsNone": True
        })
        node_id_at_point = result.get("nodeId", 0)
        backend_node_id = result.get("backendNodeId", 0)
        print(f'nodeId={node_id_at_point}, backendNodeId={backend_node_id}')

        if node_id_at_point:
            # 获取节点信息
            node_info = pub._send("DOM.describeNode", {
                "nodeId": node_id_at_point,
                "depth": 2
            })
            node = node_info.get("node", {})
            print(f'  tag: {node.get("nodeName")}')
            print(f'  attrs: {node.get("attributes", [])}')
            children = node.get("children", [])
            if children:
                print(f'  children: {len(children)}')
                for c in children[:3]:
                    print(f'    - {c.get("nodeName")}: {c.get("nodeValue", "")[:40] or c.get("attributes", [])}')
    except Exception as e:
        print(f'Error: {e}')

# 检查 xhs-publish-btn 的属性（可能有 slot 或 data 属性）
print('\n=== xhs-publish-btn 完整属性 ===')
btn_attrs = pub._evaluate(r"""
(() => {
    const el = document.querySelector('xhs-publish-btn');
    if (!el) return 'not found';
    const result = {
        outerHTML: el.outerHTML.slice(0, 500),
        attributes: {},
        childrenCount: el.children.length,
        childNodes: el.childNodes.length
    };
    for (const attr of el.attributes) {
        result.attributes[attr.name] = attr.value.slice(0, 100);
    }
    return result;
})()
""")
print(btn_attrs)

# 检查是否有 iframe
print('\n=== 页面 iframe 列表 ===')
iframes = pub._evaluate(r"""
(() => {
    const iframes = document.querySelectorAll('iframe');
    const result = [];
    for (const f of iframes) {
        const rect = f.getBoundingClientRect();
        result.push({src: f.src.slice(0, 80), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height)});
    }
    return result;
})()
""")
print(f'Found {len(iframes)} iframes:', iframes)

# 截图看当前状态
result = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
with open(r'C:\Users\Administrator\AppData\Local\Temp\xhs_node_debug.png', 'wb') as f:
    f.write(base64.b64decode(result.get("data", "")))
print('\nScreenshot saved to xhs_node_debug.png')
