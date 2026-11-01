"""Isolated Chromium upgrade/celebration regression; fictional data, no production access.
uv run --no-project --with playwright==1.55.0 tests/browser_pwa_completion.py
"""
import sys, tempfile, threading, socket
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app

OUT = Path(__file__).resolve().parents[1] / 'docs/previews'
errors = []
with tempfile.TemporaryDirectory(prefix='board-pwa-') as directory, ExitStack() as stack:
    stack.enter_context(patch.multiple(app, DATA_DIR=directory, UPLOAD_DIR=str(Path(directory)/'uploads'),
        DB_PATH=str(Path(directory)/'board.db'), ADMIN_PASSWORD='fixture-parent-only', API_TOKEN='', LLM_API_KEY=''))
    app.init_db()
    with app.session_db() as conn:
        conn.execute('INSERT INTO children(id,name) VALUES(1,?)', ('小禾',))
    ids = [app.create_item({'title': '虚构练习 '+str(i), 'kind': 'homework', 'subject': '数学',
        'child_id': '1', 'due': app.today(), 'body': '全部为虚构示例数据'}, None, '')[0] for i in range(4)]
    original = app.page
    app.page = lambda title, body: original(title, "<aside class='muted'>界面预览 · 全部为虚构示例数据</aside>" + body)
    stack.callback(setattr, app, 'page', original)
    # First install a worker that always returns the old stylesheet for the unversioned URL.
    # New versioned URLs and no-store requests must not reuse it.
    old_worker = b"""self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/static/paper.css' && !new URL(e.request.url).search)e.respondWith(new Response('body{--fixture-old:yes}',{headers:{'Content-Type':'text/css','Cache-Control':'public,max-age=86400'}}));});"""
    phase = {'old': True}
    class UpgradeHandler(app.Handler):
        def do_GET(self):
            if phase.get('offline'):
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            if self.path == '/sw.js' and phase['old']:
                self.send_response(200); self.send_header('Content-Type','application/javascript')
                self.send_header('Cache-Control','public,max-age=86400'); self.send_header('Content-Length',str(len(old_worker)))
                self.end_headers(); self.wfile.write(old_worker); return
            super().do_GET()
    server = ThreadingHTTPServer(('127.0.0.1',0), UpgradeHandler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    stack.callback(server.server_close); stack.callback(server.shutdown)
    base = f'http://127.0.0.1:{server.server_port}'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        context = browser.new_context(viewport={'width':390,'height':844}, locale='zh-CN')
        page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
        page.request.post(base+'/admin/login', form={'password':'fixture-parent-only'})
        page.goto(base+'/?child=1')
        page.wait_for_function('navigator.serviceWorker.controller !== null')
        page.reload()
        # The installed old worker does serve stale bare CSS, but rendered page loads its versioned URL.
        assert 'fixture-old' in page.evaluate("fetch('/static/paper.css').then(r=>r.text())")
        assert page.locator('link[href*="paper.css?v="]').count() == 1
        assert page.evaluate("getComputedStyle(document.body).getPropertyValue('--fixture-old')").strip() == ''
        # Upgrade while an edit draft is open. Worker replacement must not reload or discard it.
        page.goto(base+f'/item?id={ids[0]}&child=1')
        page.get_by_role('link',name='修改',exact=True).click()
        page.locator('#edit-body').fill('尚未保存的虚构草稿')
        phase['old'] = False
        page.evaluate('navigator.serviceWorker.getRegistration().then(r=>r.update())')
        expect(page.locator('.pwa-update')).to_be_visible(timeout=15000)
        expect(page.locator('#edit-body')).to_have_value('尚未保存的虚构草稿')
        assert app.get_item(ids[0])['body'] == '全部为虚构示例数据'
        # Current worker bypasses the browser HTTP cache; no stale CSS marker remains.
        assert 'fixture-old' not in page.evaluate("fetch('/static/paper.css').then(r=>r.text())")
        page.keyboard.press('Escape'); page.locator('.pwa-update button').click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        expect(page.locator('.pwa-update')).to_have_count(0)
        # Real confirmed completion; full-screen animation is noninteractive and one-shot.
        page.get_by_role('button',name='标为已完成',exact=False).click()
        expect(page.locator('.completion-celebration')).to_be_visible()
        assert app.get_item(ids[0])['done'] == 1
        expect(page.locator('.confetti')).to_have_count(100)
        assert page.locator('.completion-celebration').evaluate("e=>getComputedStyle(e).pointerEvents") == 'none'
        page.wait_for_timeout(1200)
        page.screenshot(path=str(OUT/'completion-confetti-390.png'))
        # Interact immediately through the overlay: edit remains usable.
        page.get_by_role('link',name='修改',exact=True).click()
        expect(page.locator('#edit-title')).to_be_visible(); page.keyboard.press('Escape')
        page.reload(); expect(page.locator('.completion-celebration')).to_have_count(0)
        page.get_by_role('button',name='取消完成',exact=False).click()
        expect(page.locator('.completion-celebration')).to_have_count(0)
        assert app.get_item(ids[0])['done'] == 0
        # Reduced motion: warm confirmation, no falling particles.
        page.emulate_media(reduced_motion='reduce')
        page.get_by_role('button',name='标为已完成',exact=False).click()
        expect(page.locator('.completion-cheer')).to_be_visible()
        expect(page.locator('.confetti')).to_have_count(0)
        page.screenshot(path=str(OUT/'completion-reduced-motion-390.png'))
        # The list's existing completion action uses the same confirmed success path.
        page.emulate_media(reduced_motion='no-preference')
        page.goto(base+'/?child=1&subject='+app.quote('数学'))
        row = page.locator('.row').filter(has=page.get_by_role('link',name='虚构练习 3',exact=True))
        row.get_by_role('button',name='标为已完成',exact=False).click()
        expect(page.locator('.confetti')).to_have_count(100)
        assert app.get_item(ids[3])['done'] == 1
        # Unknown/failed submission neither celebrates nor retries.
        page.goto(base+f'/item?id={ids[1]}&child=1')
        page.route('**/done', lambda route: route.fulfill(status=500, content_type='application/json', body='{"ok":false}'))
        page.get_by_role('button',name='标为已完成',exact=False).click()
        expect(page.get_by_text('完成状态未确认，请刷新查看后再操作。',exact=False)).to_be_visible()
        expect(page.locator('.completion-celebration')).to_have_count(0)
        assert app.get_item(ids[1])['done'] == 0
        page.unroute('**/done')
        # Simulate an origin transport failure (Chromium offline emulation does not reliably
        # propagate to SW requests). Never fabricate a successful homework page on failure.
        phase['offline'] = True
        result = page.evaluate("fetch('/?child=1').then(async r=>({status:r.status,text:await r.text()}))")
        assert result['status'] == 503 and '离线了' in result['text'], result
        phase['offline'] = False; context.close()
        # JS-free fallback keeps title -> detail -> full edit navigation and completion POST.
        context = browser.new_context(java_script_enabled=False, viewport={'width':320,'height':844})
        page = context.new_page(); page.request.post(base+'/admin/login',form={'password':'fixture-parent-only'})
        page.goto(base+'/?child=1&subject='+app.quote('数学'))
        page.get_by_role('link',name='虚构练习 2',exact=True).click()
        expect(page).to_have_url(base+f'/item?id={ids[2]}&child=1')
        page.get_by_role('link',name='修改',exact=True).click()
        expect(page.locator('#edit-title')).to_have_value('虚构练习 2')
        page.go_back(); page.get_by_role('button',name='标为已完成',exact=False).click()
        assert app.get_item(ids[2])['done'] == 1
        context.close(); browser.close()
assert not errors, errors
print('PASS: service worker upgrade, stale asset bypass, draft preservation, offline 503, completion confirmation, 100-particle confetti, reduced motion, no replay/undo/failure celebration, no-JS fallback')
