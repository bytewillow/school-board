"""Touch-focused edit/deadline regression using an isolated fictional database.
uv run --no-project --with playwright==1.55.0 tests/browser_child_edit.py
No production service or real child data is accessed.
"""
import sys
import tempfile
import threading
from contextlib import ExitStack
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app

OUT = Path(__file__).resolve().parents[1] / 'docs' / 'previews'
OUT.mkdir(parents=True, exist_ok=True)
errors = []
with tempfile.TemporaryDirectory(prefix='board-child-edit-ui-') as directory, ExitStack() as stack:
    stack.enter_context(patch.multiple(app, DATA_DIR=directory, UPLOAD_DIR=str(Path(directory)/'uploads'),
        DB_PATH=str(Path(directory)/'board.db'), ADMIN_PASSWORD='fixture-parent-only', API_TOKEN='', LLM_API_KEY=''))
    app.init_db()
    with app.session_db() as conn:
        conn.executemany('INSERT INTO children (id,name,password_hash) VALUES (?,?,?)',
            [(1, '小禾', app.password_hash('fixture-student-only')), (2, '小满', '')])
    own, _ = app.create_item({'title': '数学练习册第十页', 'kind': 'homework', 'subject': '数学',
        'child_id': '1', 'due': app.today(), 'body': '全部为虚构示例数据，仅验证界面。'}, None, '')
    other, _ = app.create_item({'title': '另一本子任务', 'kind': 'homework', 'subject': '数学', 'child_id': '2'}, None, '')
    shared, _ = app.create_item({'title': '历史共享任务', 'kind': 'homework', 'subject': '数学', 'child_id': '0'}, None, '')
    original_page = app.page
    app.page = lambda title, body: original_page(title, "<aside class='muted'>界面预览 · 全部为虚构示例数据</aside>" + body)
    stack.callback(setattr, app, 'page', original_page)
    server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    stack.callback(server.server_close); stack.callback(server.shutdown)
    base = f'http://127.0.0.1:{server.server_port}'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        for role in ('parent', 'student'):
            for width in (320, 390, 834, 1440):
                context = browser.new_context(viewport={'width': width, 'height': 960},
                    has_touch=width<1000, is_mobile=width<700, locale='zh-CN')
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                if role == 'parent':
                    page.request.post(base + '/admin/login', form={'password': 'fixture-parent-only'})
                else:
                    page.request.post(base + '/login', form={'name': '小禾', 'password': 'fixture-student-only'})
                notebook_url = base + '/?child=1&subject=' + app.quote('数学')
                page.goto(notebook_url)
                row = page.locator('.row').filter(has=page.get_by_role('link', name='数学练习册第十页', exact=True))
                edit = row.get_by_role('link', name='数学练习册第十页', exact=True)
                expect(edit).to_be_visible()
                summary = row.locator('.quick-due > summary')
                summary.click()
                for control in [edit, summary, row.get_by_role('button', name='今天', exact=True),
                                row.get_by_role('button', name='明天', exact=True)]:
                    box = control.bounding_box()
                    assert box['height'] >= 44, (role, width, box)
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (role, width, 'overflow')
                popover = row.locator('.quick-due-form').bounding_box()
                assert popover['x'] >= 0 and popover['x'] + popover['width'] <= width, (role, width, popover)
                if role == 'parent' and width in (390, 834):
                    page.screenshot(path=str(OUT / f'child-quick-due-{width}.png'), full_page=True)
                row.get_by_role('button', name='明天', exact=True).click()
                expect(page).to_have_url(notebook_url)
                expected = dict((k,v) for k,_,v in app.due_presets())['tomorrow']
                assert app.get_item(own)['due'] == expected
                row.locator('.quick-due > summary').click()
                with page.expect_navigation():
                    row.locator('input[type=date]').fill('2026-12-05')
                assert app.get_item(own)['due'] == '2026-12-05'
                row.locator('.quick-due > summary').click()
                row.get_by_role('button', name='清空', exact=True).click()
                assert app.get_item(own)['due'] == ''
                edit.click()
                expect(page).to_have_url(base + f'/item?id={own}&child=1')
                expect(page.get_by_role('dialog')).to_have_count(0)
                if role == 'parent' and width == 390:
                    page.screenshot(path=str(OUT / 'homework-detail-390.png'))
                expect(page.get_by_text('全部为虚构示例数据，仅验证界面。', exact=True)).to_be_visible() if role == 'parent' and width == 320 else None
                page.get_by_role('link', name='修改', exact=True).click()
                expect(page.locator('#edit-title')).to_have_value('数学练习册第十页')
                expect(page.get_by_role('dialog', name='修改作业')).to_be_visible()
                if role == 'parent' and width in (390, 834):
                    page.screenshot(path=str(OUT / f'child-edit-dialog-{width}.png'))
                page.locator('#edit-body').fill('虚构任务内容已修改')
                expected = dict((k,v) for k,_,v in app.due_presets())['sunday']
                page.locator('#edit-due').fill(expected)
                assert app.get_item(own)['due'] == ''  # Full edit remains a draft until Save.
                page.get_by_role('button', name='保存修改', exact=True).click()
                expect(page).to_have_url(base + f'/item?id={own}&child=1')
                assert app.get_item(own)['due'] == expected
                assert app.get_item(own)['body'] == '虚构任务内容已修改'
                assert app.get_item(own)['done'] == 0
                page.get_by_role('link', name='修改', exact=True).click()
                page.locator('#edit-body').fill('不应保存的修改')
                page.keyboard.press('Escape')
                expect(page.get_by_role('dialog')).to_have_count(0)
                assert app.get_item(own)['body'] == '虚构任务内容已修改'
                expect(page.get_by_role('link', name='数学练习册第十页')).to_be_visible()
                page.goto(base + f'/item?id={own}&child=1')
                page.locator('.quick-due > summary').click()
                page.wait_for_function("(() => {const d=document.querySelector('.quick-due[open]');if(!d)return false;const b=d.querySelector('form').getBoundingClientRect();return b.width > 0 && b.x >= 0 && b.right <= innerWidth;})()")
                bounds = page.locator('.quick-due-form').bounding_box()
                assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width, (role, width, 'detail', bounds)
                page.keyboard.press('Escape')
                expect(page.locator('.quick-due')).not_to_have_attribute('open', '')
                if role == 'student':
                    assert page.request.post(base+'/item/due', form={'id': str(other), 'preset': 'today'}).status == 404
                    assert page.request.post(base+'/item/due', form={'id': str(shared), 'preset': 'today'}).status == 404
                context.close()
        # No JavaScript: ordinary links, preset POSTs and custom date forms still work.
        context = browser.new_context(java_script_enabled=False, viewport={'width':320,'height':844})
        page = context.new_page()
        page.request.post(base + '/admin/login', form={'password': 'fixture-parent-only'})
        page.goto(base + '/?child=1')
        row = page.locator('.row').filter(has=page.get_by_role('link', name='数学练习册第十页', exact=True))
        row.locator('.quick-due > summary').click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no-JS overflow'
        row.get_by_role('button', name='今天', exact=True).click()
        assert app.get_item(own)['due'] == app.today()
        expect(page).to_have_url(base + '/?child=1')
        context.close(); browser.close()
assert not errors, errors
print('PASS: parent/student at 320/390/834/1440px, quick presets/custom/clear, full edit, child context, permissions, no-JS, no overflow or JS errors')
