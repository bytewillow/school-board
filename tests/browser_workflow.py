"""Optional browser regression: uv run --no-project --with playwright==1.55.0 tests/browser_workflow.py
Run tools/preview.py on localhost:8766 first. Chromium must be installed.
"""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:8766'
OUT = Path(__file__).resolve().parents[1] / 'docs' / 'previews'
OUT.mkdir(parents=True, exist_ok=True)
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
    for width in (390, 320):
        mobile = browser.new_page(viewport={'width': width, 'height': 844}, is_mobile=True,
                                  device_scale_factor=1, has_touch=True, reduced_motion='reduce')
        mobile.on('pageerror', lambda e: errors.append(str(e)))
        for name, path in [('notebooks', '/'), ('binder', '/?child=2'), ('register', '/register?child=2')]:
            mobile.goto(BASE + path)
            assert mobile.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, path, 'horizontal overflow')
            if width == 390:
                mobile.screenshot(path=str(OUT / (name + '-mobile.png')), full_page=False)
        mobile.close()
    page = browser.new_page(viewport={'width': 1440, 'height': 640}, reduced_motion='reduce')
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(BASE)
    expect(page.locator('.notebook')).to_have_count(2)
    page.screenshot(path=str(OUT / 'notebooks-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 1440, 'height': 1080})
    page.locator("a[href='/?child=1']").first.click()
    expect(page.locator('body')).to_contain_text('接下来要做')
    page.screenshot(path=str(OUT / 'binder-desktop.png'), full_page=True)
    page.goto(BASE + '/register?child=1')
    expect(page.locator('#manual-entry')).to_be_visible()
    expect(page.locator('#ai-entry')).to_be_hidden()
    expect(page.locator("input[name='child_id'][value='1']")).to_be_checked()
    page.locator("[data-entry='ai']").click()
    expect(page.locator('#manual-entry')).to_be_hidden()
    expect(page.locator('#ai-parse-btn')).to_be_disabled()
    page.locator('#ai-entry summary').click()
    page.locator('#ai-json').fill(json.dumps([
        {'title': '浏览器成功草稿', 'subject': '数学', 'child_id': 1},
        {'title': '暂不创建', 'subject': '语文', 'child_id': 1},
        {'title': '缺学科草稿', 'child_id': 1}], ensure_ascii=False))
    page.locator('#ai-json-btn').click()
    expect(page.locator('.draft-card')).to_have_count(3)
    page.locator('.draft-card').nth(1).locator("input[type='checkbox']").uncheck()
    page.locator('#ai-create-btn').click()
    expect(page.locator('#ai-status')).to_contain_text('已创建 1 条，失败 1 条')
    expect(page.locator('.draft-card')).to_have_count(2)
    expect(page.locator('.draft-card.has-error')).to_have_count(1)
    expect(page.locator('.draft-card.has-error .draft-error')).to_contain_text('请选择学科')
    page.locator('.draft-card.has-error select').nth(0).select_option('数学')
    page.locator('#ai-create-btn').click()
    expect(page.locator('#ai-status')).to_contain_text('已创建 1 条，失败 0 条')
    expect(page.locator('.draft-card')).to_have_count(1)
    # A disconnected response must not erase drafts or encourage blind repeat submission.
    page.locator('.draft-card input[type="checkbox"]').check()
    page.route('**/api/ai-batch', lambda route: route.abort('connectionfailed'))
    page.locator('#ai-create-btn').click()
    expect(page.locator('#ai-status')).to_contain_text('创建结果未确认')
    expect(page.locator('#ai-create-btn')).to_be_disabled()
    expect(page.locator('.draft-card')).to_have_count(1)
    browser.close()
assert not errors, errors
print('PASS: desktop/mobile routes, 320/390px overflow, registration selection, AI partial failure + retry + unchecked drafts, uncertain write retention; no browser JS errors')
