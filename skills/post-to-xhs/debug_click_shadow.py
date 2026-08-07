"""
通过 CDP 进入 xhs-publish-btn 的 closed shadow root 找发布按钮并点击
"""
import sys, time, base64, json
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

# 找到 xhs-publish-btn 的 nodeId
search_result = pub._send("DOM.performSearch", {
    "query": "xhs-publish-btn",
    "includeUserAgentShadowDOM": True
})
xhs_btn_ids = pub._send("DOM.getSearchResults", {
    "searchId": search_result.get("searchId"),
    "fromIndex": 0,
    "toIndex": search_result.get("resultCount", 0)
}).get("nodeIds", [])
print(f'xhs-publish-btn nodeIds: {xhs_btn_ids}')

if not xhs_btn_ids:
    print('ERROR: xhs-publish-btn not found')
    sys.exit(1)

xhs_btn_nid = xhs_btn_ids[0]

# 获取完整节点信息，找 shadow root 的 nodeId
node_info = pub._send("DOM.describeNode", {
    "nodeId": xhs_btn_nid,
    "depth": 10,
    "pierce": True
})

# 找 shadow root nodeId
def find_shadow_root_nid(node_data):
    """递归查找 shadowRoot 的 nodeId"""
    for sr in node_data.get("shadowRoots", []):
        return sr.get("nodeId")
    for child in node_data.get("children", []):
        nid = find_shadow_root_nid(child)
        if nid:
            return nid
    return None

shadow_root_nid = find_shadow_root_nid(node_info.get("node", {}))
print(f'Shadow root nodeId: {shadow_root_nid}')

if shadow_root_nid:
    # 在 shadow root 内查找所有按钮
    print('\n=== Shadow Root 内的按钮 ===')
    sr_buttons = pub._send("DOM.querySelectorAll", {
        "nodeId": shadow_root_nid,
        "selector": "button, [class*='btn'], [class*='button']"
    })
    sr_btn_ids = sr_buttons.get("nodeIds", [])
    print(f'Found {len(sr_btn_ids)} button-like elements in shadow root')

    for bid in sr_btn_ids[:10]:
        binfo = pub._send("DOM.describeNode", {"nodeId": bid, "depth": 2})
        bnode = binfo.get("node", {})
        battrs = bnode.get("attributes", [])
        # 转 attrs 为 dict
        attrs_dict = {}
        for i in range(0, len(battrs), 2):
            attrs_dict[battrs[i]] = battrs[i+1] if i+1 < len(battrs) else ''

        # 解析 node 得到 object
        resolved = pub._send("DOM.resolveNode", {"nodeId": bid})
        obj_id = resolved.get("object", {}).get("objectId", "")

        # 获取 bounding rect
        if obj_id:
            rect_result = pub._send("Runtime.callFunctionOn", {
                "objectId": obj_id,
                "functionDeclaration": "function() { const r = this.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height, text: this.innerText || this.textContent || ''}; }",
                "returnByValue": True
            })
            rect = rect_result.get("result", {}).get("value", {})
        else:
            rect = {}

        print(f'  Button {bid}: attrs={attrs_dict}, rect={rect}')

    # 尝试找"发布"按钮（text = "发布"）
    print('\n=== 查找文本为"发布"的元素 ===')
    all_in_shadow = pub._send("DOM.querySelectorAll", {
        "nodeId": shadow_root_nid,
        "selector": "*"
    })
    all_ids = all_in_shadow.get("nodeIds", [])
    print(f'Total elements in shadow root: {len(all_ids)}')

    publish_btn_nid = None
    for eid in all_ids[:50]:  # 检查前50个
        try:
            eresolved = pub._send("DOM.resolveNode", {"nodeId": eid})
            eobj_id = eresolved.get("object", {}).get("objectId", "")
            if eobj_id:
                einfo = pub._send("Runtime.callFunctionOn", {
                    "objectId": eobj_id,
                    "functionDeclaration": "function() { return {tag: this.tagName, text: (this.innerText||this.textContent||'').trim(), cls: (this.className||'').toString().slice(0,60)}; }",
                    "returnByValue": True
                })
                edata = einfo.get("result", {}).get("value", {})
                if edata.get("text") in ("发布", "暂存离开"):
                    print(f'  Found: nodeId={eid}, {edata}')
                    if edata.get("text") == "发布":
                        publish_btn_nid = eid
        except Exception as e:
            pass  # Skip errors

    if publish_btn_nid:
        # 获取"发布"按钮的位置
        presolved = pub._send("DOM.resolveNode", {"nodeId": publish_btn_nid})
        pobj_id = presolved.get("object", {}).get("objectId", "")
        rect_result = pub._send("Runtime.callFunctionOn", {
            "objectId": pobj_id,
            "functionDeclaration": "function() { const r = this.getBoundingClientRect(); return {x: r.x, y: r.y, w: r.width, h: r.height}; }",
            "returnByValue": True
        })
        prect = rect_result.get("result", {}).get("value", {})
        print(f'\n发布按钮位置: {prect}')

        cx = int(prect.get('x', 716) + prect.get('w', 80) / 2)
        cy = int(prect.get('y', 825) + prect.get('h', 40) / 2)
        print(f'点击坐标: ({cx}, {cy})')

        # 截图 before
        result = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
        with open(r'C:\Users\Administrator\AppData\Local\Temp\xhs_shadow_before.png', 'wb') as f:
            f.write(base64.b64decode(result.get("data", "")))
        print('Before screenshot saved')

        # 点击
        pub._send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": cx, "y": cy, "button": "left", "clickCount": 1})
        pub._send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": cx, "y": cy, "button": "left", "clickCount": 1})
        time.sleep(3)

        url = pub._evaluate('window.location.href')
        print(f'URL after click: {url}')

        result2 = pub._send("Page.captureScreenshot", {"format": "png", "quality": 80})
        with open(r'C:\Users\Administrator\AppData\Local\Temp\xhs_shadow_after.png', 'wb') as f:
            f.write(base64.b64decode(result2.get("data", "")))
        print('After screenshot saved')
