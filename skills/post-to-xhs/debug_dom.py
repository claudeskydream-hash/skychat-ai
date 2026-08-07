"""
精简调试脚本：提交图片后检查预览和发布按钮 DOM
"""
import sys, time
sys.path.insert(0, 'scripts')
sys.stdout.reconfigure(encoding='utf-8')
from cdp_publish import XiaohongshuPublisher, SELECTORS

pub = XiaohongshuPublisher(host='127.0.0.1', port=9222)
pub.connect()

pub._navigate('https://creator.xiaohongshu.com/publish/publish?source=official')
time.sleep(3)

# 点击图文 tab
pub._click_tab(SELECTORS["image_text_tab"], SELECTORS["image_text_tab_text"])
time.sleep(2)

# 获取 upload input node id
img_path = r'C:\Users\Administrator\AppData\Local\Temp\debug_xhs.jpg'
node_id = pub._query_node_id(SELECTORS["upload_input"])
if not node_id:
    node_id = pub._query_node_id(SELECTORS["upload_input_alt"])
print(f'upload_input node_id: {node_id}')

# 提交文件
pub._send("DOM.setFileInputFiles", {"nodeId": node_id, "files": [img_path]})
print('File submitted, waiting 15s...')
time.sleep(15)

# 检查图片预览元素
print('\n=== 图片预览 DOM ===')
preview = pub._evaluate(r"""
(() => {
    const checks = [
        '.img-preview-area .pr',
        '.img-preview-area [class*="preview"]',
        '.img-preview-area',
        '.draggable-item',
        '[class*="img-preview"]',
        '[class*="imgPreview"]',
        '[class*="imagePreview"]',
        '[class*="imageItem"]',
        'img[src*="blob:"]',
        '[class*="upload"] img',
        '[class*="preview"] img',
        '.upload-result',
        '[class*="uploadResult"]'
    ];
    const result = {};
    for (const sel of checks) {
        try {
            const els = document.querySelectorAll(sel);
            if (els.length > 0) {
                result[sel] = els.length;
            }
        } catch(e) {}
    }
    // 也检查所有 img 标签
    const imgs = document.querySelectorAll('img');
    const imgInfo = [];
    for (const img of imgs) {
        const r = img.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && img.offsetParent !== null) {
            imgInfo.push({src: img.src.slice(0,80), w: Math.round(r.width), h: Math.round(r.height), cls: img.className.slice(0,60)});
        }
    }
    result['_visible_imgs'] = imgInfo;
    return result;
})()
""")
for k, v in preview.items():
    if k == '_visible_imgs':
        print(f'  visible imgs: {len(v)} total')
        for img in v[:5]:
            print(f'    {img}')
    else:
        print(f'  {k}: {v}')

# 也填写标题检查编辑器是否出现
print('\n=== 尝试填写标题 ===')
try:
    pub._fill_title('测试标题')
    print('Title filled OK')
    time.sleep(1)
except Exception as e:
    print(f'Title fill error: {e}')

# 填写内容
print('\n=== 尝试填写正文 ===')
try:
    pub._fill_content('测试正文')
    print('Content filled OK')
    time.sleep(2)
except Exception as e:
    print(f'Content fill error: {e}')

# 检查按钮
print('\n=== 所有可见按钮 ===')
buttons = pub._evaluate(r"""
(() => {
    const all = document.querySelectorAll('button, [role="button"]');
    const results = [];
    for (const el of all) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && el.offsetParent !== null) {
            results.push({
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
print(f'Total buttons: {len(buttons)}')
for b in buttons:
    print(b)

print('\n=== _is_publish_button_ready:', pub._is_publish_button_ready())
