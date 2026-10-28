"""Synthetic browser integration. Optional: uv run --no-project --with playwright==1.55.0 tests/browser_voice.py
Uses isolated DB + local STT/LLM HTTP fixtures. Chromium's fake microphone creates audio;
no real microphone, private recording, provider credential or paid API is used.
"""
import json
import sys
import tempfile
import threading
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from playwright.sync_api import sync_playwright, expect
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app

OUT = Path('/tmp/school-board-voice-previews')
OUT.mkdir(exist_ok=True)
provider_calls = []
class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        provider_calls.append((self.path, body))
        if self.path.endswith('/audio/transcriptions'):
            assert b'name="file"' in body and len(body)>500
            result = {'text':'数学练习册第十页，明天交。'}
        else:
            request = json.loads(body)
            assert 'child_id=' in request['messages'][0]['content']
            # Deliberately wrong model child: page context must win.
            result = {'choices':[{'message':{'content':json.dumps([{'title':'练习册第 10 页','subject':'数学','kind':'homework','child_id':999,'due':'2026-10-29','body':'完成练习册第 10 页，带回学校。'}])}}]}
        data = json.dumps(result,ensure_ascii=False).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

errors=[]
with tempfile.TemporaryDirectory(prefix='board-voice-test-') as directory, ExitStack() as stack:
    upstream = ThreadingHTTPServer(('127.0.0.1',0),Provider)
    base_up = f'http://127.0.0.1:{upstream.server_port}/v1'
    stack.enter_context(patch.multiple(app, DATA_DIR=directory, UPLOAD_DIR=str(Path(directory)/'uploads'), DB_PATH=str(Path(directory)/'board.db'), ADMIN_PASSWORD='fixture-parent-only', API_TOKEN='', LLM_API_KEY='fixture-only', STT_API_KEY='fixture-only', LLM_BASE_URL=base_up, STT_BASE_URL=base_up))
    app.init_db()
    with app.db() as conn:
        conn.executemany('INSERT INTO children (id,name) VALUES (?,?)',[(1,'小禾'),(2,'小满')])
    app.create_item({'title':'历史共享示例','subject':'数学','child_id':'0'},None,'')
    original_page=app.page
    def preview_page(title, body):
        return original_page(title,"<aside style='font-size:12px;border:1px dashed #a8b6c6;border-radius:10px;padding:8px 12px;color:#526477'>界面预览 · 虚构孩子及作业 · 模拟语音与模型</aside>"+body)
    stack.enter_context(patch.object(app,'page',preview_page))
    board = ThreadingHTTPServer(('127.0.0.1',0),app.Handler)
    for server in (board,upstream):
        threading.Thread(target=server.serve_forever,daemon=True).start()
        stack.callback(server.server_close);stack.callback(server.shutdown)
    base=f'http://127.0.0.1:{board.server_port}'
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'])
        for width in (320,390,834,1280):
            page=browser.new_page(viewport={'width':width,'height':900},has_touch=True,is_mobile=width<760,reduced_motion='reduce')
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.request.post(base+'/admin/login', form={'password': app.ADMIN_PASSWORD})
            page.goto(base+'/register')
            expect(page.locator('h1')).to_have_text('给哪个孩子登记？')
            page.get_by_role('link',name='给小满登记',exact=True).click()
            expect(page.locator('#entry-child')).to_have_value('2')
            expect(page.locator('#manual-entry')).to_be_visible()
            assert page.locator('#registration').locator('select option[value="0"]').count()==0
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            # Every main touch target (excluding native file-picker internals) stays >=44px.
            for element in page.locator('#registration button:visible,#registration .chip:visible,#entry-child').all():
                box=element.bounding_box();assert box and box['height']>=44,(width,box,element.evaluate('(e)=>e.outerHTML'),errors)
            if width in (390,834):
                page.screenshot(path=str(OUT/f'entry-manual-{width}.png'),full_page=width>=760)
            page.locator('[data-entry="ai"]').click()
            assert page.locator('#voice-start').is_enabled()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            if width in (390,834):
                page.screenshot(path=str(OUT/f'entry-voice-{width}.png'),full_page=width>=760)
            # Real browser recorder, synthetic input, actual two-stage HTTP pipeline.
            page.locator('#voice-start').click()
            expect(page.locator('#voice-controls')).to_have_attribute('data-state','recording')
            expect(page.locator('#entry-child')).to_be_disabled()
            page.wait_for_timeout(1100)
            if width==390:
                page.locator('#voice-entry').scroll_into_view_if_needed()
                page.screenshot(path=str(OUT/'entry-recording-390.png'),full_page=False)
            calls_before=len(provider_calls)
            page.locator('#voice-submit').click()
            expect(page.locator('.draft-card')).to_have_count(1,timeout=15000)
            assert len(provider_calls)==calls_before+2
            expect(page.locator('.draft-card select').nth(2)).to_have_value('2')
            expect(page.locator('#voice-status')).to_contain_text('语音已解析')
            expect(page.locator('#ai-text')).to_have_value('数学练习册第十页，明天交。')
            assert len(app.all_items())==1  # Only pre-existing legacy item: no auto-create.
            if width in (390,834):
                page.locator('.ai-review').scroll_into_view_if_needed()
                page.screenshot(path=str(OUT/f'entry-review-{width}.png'),full_page=width>=760)
            # Switch context: manual + subsequent text/photo parse inherit it; old draft keeps child 2.
            page.locator('#entry-child').select_option('1')
            expect(page.locator('input[name="child_id"][value="1"]')).to_be_checked()
            expect(page.locator('.draft-card select').nth(2)).to_have_value('2')
            page.locator('#ai-text').fill('英语听写')
            page.locator('#ai-parse-btn').click()
            expect(page.locator('.draft-card select').nth(2)).to_have_value('1')
            page.locator('#ai-image').set_input_files({'name':'sample.png','mimeType':'image/png','buffer':b'synthetic-image'})
            page.locator('#ai-text').fill('')
            page.locator('#ai-parse-btn').click()
            expect(page.locator('#ai-parse-btn')).to_be_enabled()
            expect(page.locator('.draft-card select').nth(2)).to_have_value('1')
            # A visible correction of child attribution in a draft is honored when saving.
            page.locator('.draft-card select').nth(2).select_option('2')
            page.locator('#ai-create-btn').click()
            expect(page.locator('#ai-status')).to_contain_text('已创建 1 条')
            assert app.all_items()[0]['child_id']==2
            with app.db() as conn: conn.execute('DELETE FROM items WHERE child_id!=0')
            # Cancel means no provider submission and stops the microphone.
            before=len(provider_calls)
            page.locator('#voice-start').click()
            expect(page.locator('#voice-controls')).to_have_attribute('data-state','recording')
            page.locator('#voice-cancel').click()
            expect(page.locator('#voice-status')).to_contain_text('已取消')
            assert len(provider_calls)==before
            # Keyboard geometry simulation: resize focused viewport, no real mobile keyboard.
            if width==390:
                page.locator('#ai-text').focus()
                page.set_viewport_size({'width':width,'height':460})
                expect(page.locator('body')).to_have_class('entry-keyboard')
                expect(page.locator('.bottomnav')).to_be_hidden()
            page.close()
        # Denied permission fallback and file-upload auto-parse.
        page=browser.new_page(viewport={'width':390,'height':844})
        page.request.post(base+'/admin/login', form={'password': app.ADMIN_PASSWORD})
        page.add_init_script("navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('denied','NotAllowedError'))")
        page.goto(base+'/register?child=1');page.locator('[data-entry="ai"]').click();page.locator('#voice-start').click()
        expect(page.locator('#voice-status')).to_contain_text('权限未获允许')
        expect(page.locator('#entry-child')).to_be_enabled()
        page.locator('#voice-file').set_input_files({'name':'voice.wav','mimeType':'audio/wav','buffer':b'x'*1000})
        expect(page.locator('.draft-card')).to_have_count(1)
        expect(page.locator('.draft-card select').nth(2)).to_have_value('1')
        page.close()
        # No MediaRecorder => don't offer a broken record button; file/text remain available.
        page=browser.new_page()
        page.request.post(base+'/admin/login', form={'password': app.ADMIN_PASSWORD})
        page.add_init_script('window.MediaRecorder=undefined')
        page.goto(base+'/register?child=1');page.locator('[data-entry="ai"]').click()
        expect(page.locator('#voice-start')).to_be_disabled()
        expect(page.locator('#voice-file')).to_be_enabled()
        expect(page.locator('#voice-status')).to_contain_text('不能录音')
        page.close();browser.close()
assert not errors, errors
print('PASS: 320/390/834/1280 touch-layout, recorder -> STT -> AI -> review, child inheritance/correction, text/image context, cancel, permission-denied, unsupported browser, upload auto-parse, simulated keyboard geometry; no JS errors. Preview files:',OUT)
