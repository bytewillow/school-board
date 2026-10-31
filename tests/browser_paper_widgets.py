"""Optional Chromium paper-widget regression. Uses tools/preview.py's isolated, fictional data.
Start that server, then run:
uv run --no-project --with playwright==1.55.0 tests/browser_paper_widgets.py
"""
import json
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:8766'
OUT = Path(__file__).resolve().parents[1] / 'docs' / 'previews'
OUT.mkdir(parents=True, exist_ok=True)
items = json.load(urlopen(BASE + '/api/items'))['items']
audio_id = next(i['id'] for i in items if i['title'].startswith('虚构示例 · 12 秒试听音'))
errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    # This modifies the temporary preview DB only, to exercise separate today/history/future denominators.
    seed = browser.new_page()
    seed.request.post(BASE + '/admin/login', form={'password': 'preview-only-not-for-deployment'})
    for item in [i for i in items if i['child_id'] == 1 and i['kind'] == 'homework'][:2]:
        if not item['done']:
            seed.request.post(BASE + '/done', form={'id': str(item['id'])})
    seed.close()
    for width in (1440, 834, 390, 320):
        page = browser.new_page(viewport={'width': width, 'height': 1000 if width > 700 else 920},
                                is_mobile=width < 700, has_touch=width < 1000, reduced_motion='reduce')
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.request.post(BASE + '/admin/login', form={'password': 'preview-only-not-for-deployment'})
        page.goto(BASE + '/?child=1')
        expect(page.locator('[data-progress-period=today] [role=progressbar]')).to_have_attribute('aria-valuenow', '33')
        expect(page.locator('[data-progress-period=today] .progress-description')).to_have_text('已完成 1 / 3 项作业')
        expect(page.locator('[data-progress-period=history] .progress-description')).to_have_text('已完成 0 / 1 项作业')
        expect(page.locator('[data-progress-period=future] .progress-description')).to_have_text('已完成 1 / 1 项作业')
        page.locator('[data-progress-period=history] summary').click()
        expect(page.locator('[data-progress-period=history] [role=progressbar]')).to_be_visible()
        page.locator('[data-progress-period=history] summary').click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, 'dashboard overflow')
        expect(page.locator('.focus-toggle')).to_be_enabled()
        page.locator('[data-minutes="15"]').click()
        expect(page.locator('.focus-time')).to_have_text('15:00')
        page.locator('.focus-toggle').click()
        expect(page.locator('.focus-time')).not_to_have_text('15:00')
        page.locator('.focus-toggle').click()
        paused = page.locator('.focus-time').inner_text()
        page.wait_for_timeout(600)
        expect(page.locator('.focus-time')).to_have_text(paused)
        page.reload()
        expect(page.locator('.focus-time')).to_have_text(paused)
        expect(page.locator('.focus-status')).to_contain_text('已暂停')
        page.locator('.focus-reset').click()
        expect(page.locator('.focus-time')).to_have_text('15:00')
        page.locator('[data-minutes="25"]').click()
        # The three primary touch controls must stay comfortably tappable.
        for selector in ('.focus-toggle', '.focus-reset', '[data-minutes="15"]'):
            rect = page.locator(selector).bounding_box()
            assert rect['height'] >= 44 and rect['width'] >= 44, (width, selector, rect)
        if width in (1440, 390):
            page.screenshot(path=str(OUT / ('paper-dashboard-' + ('desktop' if width > 700 else 'mobile') + '.png')), full_page=True)
        page.goto(BASE + '/item?id=' + str(audio_id) + '&child=1')
        expect(page.locator('.audio-duration')).to_have_text('00:12')
        page.locator('.audio-play').click()
        page.wait_for_function('document.querySelector("audio").currentTime > .05')
        expect(page.locator('.listening-player')).to_have_class('listening-player is-playing')
        page.locator('.audio-play').click()
        expect(page.locator('.listening-player')).not_to_have_class('listening-player is-playing')
        page.locator('.audio-rate').select_option('1.5')
        assert page.locator('audio').evaluate('el => el.playbackRate') == 1.5
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (width, 'audio overflow')
        if width in (1440, 390):
            page.screenshot(path=str(OUT / ('paper-audio-' + ('desktop' if width > 700 else 'mobile') + '.png')), full_page=True)
        page.close()
    # Exercise completion instantly using Chromium's virtual clock, rather than wait 15 minutes.
    page = browser.new_page()
    page.clock.install()
    page.request.post(BASE + '/admin/login', form={'password': 'preview-only-not-for-deployment'})
    page.goto(BASE + '/?child=1')
    page.locator('[data-minutes="15"]').click()
    page.locator('.focus-toggle').click()
    page.clock.fast_forward(900001)
    expect(page.locator('.focus-time')).to_have_text('00:00')
    expect(page.locator('.focus-status')).to_have_text('时间到，休息一下吧')
    expect(page.locator('.focus-toggle')).to_have_text('再专注一轮')
    page.locator('.focus-toggle').click()
    expect(page.locator('.focus-time')).to_have_text('15:00')
    page.close()
    browser.close()
assert not errors, errors
print('Paper widgets: progress, timer start/pause/reset/persistence/finish/restart and audio passed at 320/390/834/1440px; no page errors.')
