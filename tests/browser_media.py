"""Optional actual Chromium media regression; start tools/preview.py first.
uv run --no-project --with playwright==1.55.0 tests/browser_media.py
"""
import json
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:8766'
OUT = Path(__file__).resolve().parents[1] / 'docs' / 'previews'
items = json.load(urlopen(BASE + '/api/items'))['items']
ids = {item['title']: item['id'] for item in items}
def item_path(prefix):
    return BASE + '/item?id=' + str(next(value for key, value in ids.items() if key.startswith(prefix))) + '&child=1'
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    for width in (1440, 390, 320):
        page = browser.new_page(viewport={'width': width, 'height': 900 if width > 700 else 844}, is_mobile=width < 700, has_touch=width < 700)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.request.post(BASE + '/admin/login', form={'password': 'preview-only-not-for-deployment'})
        page.goto(item_path('虚构示例 · 图形一'))
        page.locator('.image-open').click()
        dialog = page.locator('.media-viewer')
        expect(dialog.locator('.viewer-status')).to_contain_text('第 1 / 2 张')
        expect(dialog.locator('.viewer-prev')).to_be_disabled()
        page.keyboard.press('ArrowRight')
        expect(dialog.locator('.viewer-status')).to_contain_text('第 2 / 2 张')
        expect(dialog.locator('.viewer-next')).to_be_disabled()
        dialog.locator('.viewer-plus').click()
        expect(dialog.locator('.viewer-zoom')).to_have_text('125%')
        dialog.locator('.viewer-fit').click()
        dialog.locator('input').fill('1'); dialog.locator('input').press('Tab')
        expect(dialog.locator('.viewer-status')).to_contain_text('第 1 / 2 张')
        # Touch gesture uses the same handlers as a physical finger; native-device testing remains separate.
        dialog.locator('.viewer-stage').evaluate("el => {el.dispatchEvent(new TouchEvent('touchstart',{touches:[new Touch({identifier:1,target:el,clientX:260,clientY:300})]}));el.dispatchEvent(new TouchEvent('touchend',{changedTouches:[new Touch({identifier:1,target:el,clientX:60,clientY:310})]}));}")
        expect(dialog.locator('.viewer-status')).to_contain_text('第 2 / 2 张')
        assert page.evaluate('document.body.style.overflow') == 'hidden'
        if width != 320: page.screenshot(path=str(OUT / ('image-' + ('desktop' if width > 700 else 'mobile') + '.png')))
        page.keyboard.press('Escape')
        expect(dialog).to_have_count(0)
        expect(page.locator('.image-open')).to_be_focused()
        assert page.evaluate('document.body.style.overflow') != 'hidden'
        page.goto(item_path('虚构示例 · 阅读练习'))
        page.locator('.media-open').click()
        dialog = page.locator('.media-viewer')
        expect(dialog.locator('.viewer-status')).to_have_text('第 1 / 2 页', timeout=30000)
        assert dialog.locator('canvas').evaluate('el => el.width > 50 && el.height > 50')
        dialog.locator('.viewer-next').click()
        expect(dialog.locator('.viewer-status')).to_have_text('第 2 / 2 页')
        expect(dialog.locator('.viewer-next')).to_be_disabled()
        dialog.locator('input').fill('1'); dialog.locator('input').press('Tab')
        expect(dialog.locator('.viewer-status')).to_have_text('第 1 / 2 页')
        dialog.locator('.viewer-plus').click()
        expect(dialog.locator('.viewer-status')).to_have_text('第 1 / 2 页')
        expect(dialog.locator('.viewer-zoom')).to_have_text('125%')
        dialog.locator('.viewer-fit').click()
        expect(dialog.locator('.viewer-zoom')).to_have_text('100%')
        expect(dialog.locator('.viewer-status')).to_have_text('第 1 / 2 页')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, 'pdf overflow')
        if width != 320: page.screenshot(path=str(OUT / ('pdf-' + ('desktop' if width > 700 else 'mobile') + '.png')))
        dialog.locator('.viewer-close').click(); expect(dialog).to_have_count(0)
        # Real media load/play/seek/speed and AB state, not only HTML assertions.
        page.goto(item_path('虚构示例 · 12 秒试听音'))
        expect(page.locator('.audio-duration')).to_have_text('00:12')
        page.locator('.audio-play').click()
        page.wait_for_function('document.querySelector("audio").currentTime > .05')
        page.locator('.audio-play').click()
        page.locator('.audio-rate').select_option('1.5')
        assert page.locator('audio').evaluate('a => a.playbackRate') == 1.5
        page.locator('.audio-seek').fill('250')
        assert abs(page.locator('audio').evaluate('a => a.currentTime') - 3) < .1
        page.locator('.audio-practice summary').click()
        page.locator('.audio-a').click()
        page.locator('audio').evaluate('a => a.currentTime = 6')
        page.locator('.audio-b').click()
        expect(page.locator('.audio-ab')).to_contain_text('区间复读已开启')
        page.locator('audio').evaluate('a => {a.currentTime = 6.2;a.dispatchEvent(new Event("timeupdate"));}')
        assert abs(page.locator('audio').evaluate('a => a.currentTime') - 3) < .1
        page.locator('.audio-clear').click()
        page.locator('.audio-b').click()
        expect(page.locator('.audio-status')).to_contain_text('请先设置 A')
        page.locator('.audio-loop').click()
        expect(page.locator('.audio-loop')).to_have_attribute('aria-pressed', 'true')
        page.locator('.audio-native').click()
        assert page.locator('audio').evaluate('a => a.controls')
        page.locator('.audio-native').click()
        page.locator('.audio-a').click()
        page.locator('audio').evaluate('a => a.currentTime = 7')
        page.locator('.audio-b').click()
        expect(page.locator('.audio-ab')).to_contain_text('区间复读已开启')
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, 'audio overflow')
        if width != 320: page.screenshot(path=str(OUT / ('audio-' + ('desktop' if width > 700 else 'mobile') + '.png')), full_page=True)
        page.close()
    # Corrupt PDF, broken image and failed audio fetch all retain usable fallback links.
    page = browser.new_page(service_workers='block')
    page.request.post(BASE + '/admin/login', form={'password': 'preview-only-not-for-deployment'})
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(item_path('虚构示例 · 阅读练习'))
    page.route('**/uploads/*.pdf', lambda route: route.fulfill(status=200, body=b'not a pdf', content_type='application/pdf'))
    page.locator('.media-open').click()
    expect(page.locator('.viewer-status')).to_contain_text('无法显示此文件')
    expect(page.locator('.viewer-original')).to_have_attribute('href', __import__('re').compile('/uploads/'))
    page.keyboard.press('Escape')
    page.route('**/uploads/*.png', lambda route: route.abort())
    page.goto(item_path('虚构示例 · 图形一'))
    page.locator('.image-open').click()
    expect(page.locator('.viewer-status')).to_contain_text('无法显示此文件')
    page.keyboard.press('Escape')
    page.route('**/uploads/*.wav', lambda route: route.abort())
    page.goto(item_path('虚构示例 · 12 秒试听音'))
    expect(page.locator('.audio-status')).to_contain_text('音频加载失败')
    assert page.locator('audio').evaluate('a => a.controls')
    page.close()
    native = browser.new_page(java_script_enabled=False)
    native.request.post(BASE + '/admin/login', form={'password': 'preview-only-not-for-deployment'})
    native.goto(item_path('虚构示例 · 12 秒试听音'))
    assert native.locator('audio').evaluate('a => a.hasAttribute("controls")')
    native.goto(item_path('虚构示例 · 阅读练习'))
    expect(native.locator('.media-open')).to_have_attribute('href', __import__('re').compile('/uploads/'))
    native.close(); browser.close()
assert not errors, errors
print('PASS: real image gallery, PDF canvas render/page/jump/zoom, keyboard/gesture/close/focus, 320/390px and desktop; audio play/seek/speed/loop/AB; load failure and no-JS fallback; no JS errors')
