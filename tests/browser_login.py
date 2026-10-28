"""Optional real Chromium UI regression; isolated database and fictional names only.
uv run --no-project --with playwright==1.55.0 tests/browser_login.py
No production service, real password, microphone or paid provider is used.
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

errors = []
with tempfile.TemporaryDirectory(prefix='board-login-ui-') as directory, ExitStack() as stack:
    stack.enter_context(patch.multiple(app, DATA_DIR=directory, UPLOAD_DIR=str(Path(directory)/'uploads'), DB_PATH=str(Path(directory)/'board.db'), ADMIN_PASSWORD='fixture-parent-only', API_TOKEN='', LLM_API_KEY=''))
    app.init_db()
    with app.session_db() as conn:
        conn.executemany('INSERT INTO children (id,name) VALUES (?,?)', [(1, '小禾'), (2, '小满')])
    app.create_item({'title': '自己作业', 'kind': 'homework', 'subject': '数学', 'child_id': '1'}, None, '')
    other, _ = app.create_item({'title': '另一个本子内容', 'subject': '数学', 'child_id': '2'}, None, '')
    server = ThreadingHTTPServer(('127.0.0.1',0), app.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    stack.callback(server.server_close); stack.callback(server.shutdown)
    base = f'http://127.0.0.1:{server.server_port}'
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox'])
        parent = browser.new_page(viewport={'width': 1280, 'height': 900})
        parent.on('pageerror', lambda e: errors.append(str(e)))
        parent.goto(base + '/admin')
        parent.locator("input[name='password']").fill('fixture-parent-only')
        parent.get_by_role('button', name='登录', exact=True).click()
        expect(parent).to_have_url(base + '/admin')
        parent.get_by_role('link', name='孩子管理').click()
        password_form = parent.locator("form[action='/admin/child/password']").first
        password_form.locator("input[name='password']").fill('fixture-student-only')
        password_form.get_by_role('button', name='设置 / 更新').click()
        expect(parent.locator('body')).to_contain_text('密码已更新')
        for width in (320, 390, 834):
            context = browser.new_context(viewport={'width': width, 'height': 900}, has_touch=True, is_mobile=width<760)
            student = context.new_page()
            student.on('pageerror', lambda e: errors.append(str(e)))
            student.goto(base + '/')
            expect(student).to_have_url(base + '/login')
            student.locator('#login-name').fill('小禾')
            student.locator('#login-password').fill('fixture-student-only')
            student.get_by_role('button', name='登录', exact=True).click()
            expect(student.locator('body')).to_contain_text('自己作业')
            expect(student.locator('body')).not_to_contain_text('小满')
            expect(student.locator("a[href^='/admin']")).to_have_count(0)
            expect(student.get_by_role('button', name='退出登录')).to_be_visible()
            student.goto(base + '/register?child=2')
            expect(student.locator('#entry-child')).to_have_value('1')
            expect(student.locator('body')).not_to_contain_text('小满')
            assert student.locator("select#entry-child").count() == 0
            assert student.evaluate('document.documentElement.scrollWidth <= innerWidth')
            # Student AI review has no child selector; imported foreign draft fails server-side.
            student.locator("[data-entry='ai']").click()
            student.locator('.entry-tools summary').click()
            student.locator('#ai-json').fill('[{"title":"虚构草稿","subject":"数学","child_id":1}]')
            student.locator('#ai-json-btn').click()
            expect(student.locator('.draft-card')).to_have_count(1)
            expect(student.locator('.draft-card')).to_contain_text('本次登记给 小禾')
            expect(student.locator('.draft-card select')).to_have_count(2)
            student.locator('#ai-create-btn').click()
            expect(student.locator('#ai-status')).to_contain_text('已创建 1 条，失败 0 条')
            student.locator('#ai-json').fill('[{"title":"归属不匹配的虚构草稿","subject":"数学","child_id":2}]')
            student.locator('#ai-json-btn').click()
            expect(student.locator('.draft-error')).to_contain_text('不属于当前本子')
            expect(student.locator('.draft-card input[type="checkbox"]')).not_to_be_checked()
            student.locator('.draft-card input[type="checkbox"]').check()
            student.locator('#ai-create-btn').click()
            expect(student.locator('#ai-status')).to_contain_text('已创建 0 条，失败 1 条')
            response = student.goto(base + '/admin/children')
            assert response.status == 403
            response = student.goto(base + f'/item?id={other}')
            assert response.status == 404
            student.goto(base)
            student.get_by_role('button', name='退出登录').click()
            expect(student).to_have_url(base + '/login')
            context.close()
        # Password replacement and clear revoke a live student's cookie through UI.
        context = browser.new_context()
        student = context.new_page()
        student.goto(base + '/login')
        student.locator('#login-name').fill('小禾'); student.locator('#login-password').fill('fixture-student-only')
        student.get_by_role('button', name='登录', exact=True).click()
        parent.goto(base + '/admin/children')
        form = parent.locator("form[action='/admin/child/password']").first
        form.locator("input[name='password']").fill('fixture-replacement-only')
        form.get_by_role('button', name='设置 / 更新').click()
        student.goto(base); expect(student).to_have_url(base + '/login')
        student.locator('#login-name').fill('小禾'); student.locator('#login-password').fill('fixture-replacement-only')
        student.get_by_role('button', name='登录', exact=True).click()
        parent.locator("form[action='/admin/child/password']").first.get_by_role('button', name='清除密码').click()
        student.goto(base); expect(student).to_have_url(base + '/login')
        parent.get_by_role('button', name='退出管理').click()
        expect(parent.locator('body')).to_contain_text('家长登录')
        browser.close()
assert not errors, errors
print('PASS: real Chromium parent/student/anonymous login, mobile 320/390/tablet 834px, locked manual + AI review/create, admin/item isolation, visible logout, password update/clear revocation; no JS errors. Not real-device/Safari/HTTPS microphone validation.')
