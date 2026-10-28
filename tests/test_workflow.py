"""Standard-library regression tests; never use a deployment's database."""
import hashlib
import http.client
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from datetime import date, timedelta

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class BoardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.paths = patch.multiple(app, DATA_DIR=self.tmp.name,
                                    UPLOAD_DIR=str(Path(self.tmp.name) / 'uploads'),
                                    DB_PATH=str(Path(self.tmp.name) / 'board.db'),
                                    API_TOKEN='', LLM_API_KEY='')
        self.paths.start()
        app.init_db()
        with app.db() as conn:
            conn.executemany('INSERT INTO children (id,name) VALUES (?,?)', [(1, '小禾'), (2, '小满')])
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.paths.stop()
        self.tmp.cleanup()

    def request(self, path, method='GET', data=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        conn.request(method, path, body=data, headers=headers or {})
        response = conn.getresponse()
        body = response.read().decode()
        status = response.status
        conn.close()
        return status, body

    def item(self, title='示例作业', child=1, due='', done=False, visible_at='', kind='homework'):
        item_id, _ = app.create_item({'title': title, 'subject': '数学', 'kind': kind,
                                     'child_id': str(child), 'due': due, 'visible_at': visible_at}, None, '')
        if done:
            with app.db() as conn:
                conn.execute('UPDATE items SET done=1 WHERE id=?', (item_id,))
        return item_id

    def test_static_media_allowlist(self):
        for path, mime in [('/static/voice.js', 'application/javascript'),
                           ('/static/entry.css', 'text/css'),
                           ('/static/media.js', 'application/javascript'),
                           ('/static/media.css', 'text/css'),
                           ('/static/pdfjs/pdf.mjs', 'application/javascript'),
                           ('/static/pdfjs/pdf.worker.mjs', 'application/javascript')]:
            conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
            conn.request('GET', path)
            response = conn.getresponse()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader('Content-Type'), mime)
            self.assertGreater(len(response.read()), 100)
            conn.close()
        self.assertEqual(self.request('/static/../app.py')[0], 404)

    def test_media_byte_ranges(self):
        item_id, _ = app.create_item({'subject': '英语', 'child_id': '1'}, b'0123456789', 'test.wav', 'audio/wav')
        url = '/uploads/' + app.get_item(item_id)['stored']
        for value, status, content, content_range in [('bytes=2-5', 206, b'2345', 'bytes 2-5/10'),
                                                    ('bytes=7-', 206, b'789', 'bytes 7-9/10'),
                                                    ('bytes=-3', 206, b'789', 'bytes 7-9/10'),
                                                    ('bytes=20-', 416, b'', 'bytes */10'),
                                                    ('bytes=9-2', 416, b'', 'bytes */10'),
                                                    ('bytes=0-1,4-5', 416, b'', 'bytes */10')]:
            conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
            conn.request('GET', url, headers={'Range': value})
            response = conn.getresponse()
            self.assertEqual(response.status, status)
            self.assertEqual(response.getheader('Content-Range'), content_range)
            self.assertEqual(response.read(), content)
            conn.close()

    def test_image_gallery_keeps_child_subject_visibility(self):
        for title, child, subject, visible in [('first', 1, '英语', ''), ('shared', 0, '英语', ''),
                                               ('other child', 2, '英语', ''), ('other subject', 1, '数学', ''),
                                               ('hidden', 1, '英语', '2999-01-01T00:00')]:
            app.create_item({'title': title, 'child_id': str(child), 'subject': subject, 'visible_at': visible}, b'image', title + '.png', 'image/png')
        first = next(i for i in app.all_items() if i['title'] == 'first')
        _, body = self.request('/item?id=' + str(first['id']) + '&child=1')
        import html, re
        gallery = json.loads(html.unescape(re.search(r"data-gallery='([^']+)'", body).group(1)))
        self.assertEqual([i['title'] for i in gallery], ['first', 'shared'])
        self.assertIn("href='/uploads/", body)
        self.assertNotIn("autoplay", body)

    def test_covers_count_shared_and_exclude_hidden(self):
        self.item('自己的')
        self.item('共同的', child=0)
        self.item('另一个孩子', child=2)
        self.item('不应提前显示', visible_at='2999-01-01T00:00')
        status, body = self.request('/')
        self.assertEqual(status, 200)
        self.assertEqual(body.count('<strong>2</strong> 项待完成'), 2)
        self.assertEqual(body.count('含 1 条共享内容'), 2)
        self.assertNotIn('不应提前显示', body)
        self.assertIn('/register?child=1', body)
        self.assertNotIn('setTimeout(function(){location.href=a.href;', body)

    def test_upload_unicode_filename_and_shared_detail(self):
        boundary = 'SchoolBoardTestBoundary'
        chunks = []
        for name, value in [('subject', '数学'), ('kind', 'material'), ('child_id', '2')]:
            chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="练习.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode() + b'%PDF-1.4\nexample\r\n')
        chunks.append(f'--{boundary}--\r\n'.encode())
        status, body = self.request('/api/items', 'POST', b''.join(chunks), {'Content-Type': f'multipart/form-data; boundary={boundary}'})
        self.assertEqual(status, 201)
        item = next(i for i in app.all_items() if i['id'] == json.loads(body)['id'])
        self.assertEqual((item['child_id'], item['filename'], item['title']), (2, '练习.pdf', '练习'))
        status, body = self.request('/item?id=' + str(item['id']) + '&child=2')
        self.assertEqual(status, 200)
        self.assertIn("data-type='pdf'", body)
        shared_id = self.item(title='共享说明', child=0)
        _, body = self.request('/item?id=' + str(shared_id) + '&child=1')
        self.assertIn('完成状态会同步到所有本子', body)

    def test_priority_is_overdue_today_future_undated(self):
        self.item('无日期')
        self.item('未来', due=(date.today() + timedelta(days=1)).isoformat())
        self.item('今天', due=app.today())
        self.item('逾期', due=(date.today() - timedelta(days=1)).isoformat())
        self.item('已完成', done=True)
        stats = app.homework_summary(app.visible_items(app.all_items()))
        self.assertEqual([i['title'] for i in stats['pending']], ['逾期', '今天', '未来', '无日期'])
        self.assertEqual((stats['overdue'], stats['today'], stats['undated'], stats['done']), (1, 1, 1, 1))

    def test_home_shows_three_and_pending_route_shows_all(self):
        for n in range(5):
            self.item(f'任务{n}')
        _, home = self.request('/?child=1')
        _, pending = self.request('/?child=1&pending=1')
        self.assertIn('待完成 5 项', home)
        self.assertEqual(home.count("action='/done'"), 3)
        self.assertEqual(pending.count("action='/done'"), 5)
        self.assertIn('总览', home)
        self.assertNotIn('今天的进度', home)

    def test_empty_and_single_child(self):
        with app.db() as conn:
            conn.execute('DELETE FROM children WHERE id=2')
        _, body = self.request('/')
        self.assertIn('小禾的作业登记簿', body)
        self.assertIn('没有待完成作业', body)
        self.assertNotIn("class='notebook-main'", body)
        self.assertNotIn('休息一下吧', body)

    def test_no_children_and_invalid_child(self):
        _, invalid = self.request('/?child=999')
        self.assertIn('选择孩子的登记簿', invalid)
        with app.db() as conn:
            conn.execute('DELETE FROM children')
        _, empty = self.request('/')
        self.assertIn('作业登记簿', empty)
        self.assertIn('没有待完成作业', empty)

    def test_subject_search_preserves_child_and_registration(self):
        self.item('找得到')
        self.item('另一条')
        _, body = self.request('/?child=1&subject=%E6%95%B0%E5%AD%A6&q=%E6%89%BE')
        self.assertIn('找得到', body)
        self.assertNotIn('另一条', body)
        _, empty = self.request('/?child=1&subject=%E8%8B%B1%E8%AF%AD')
        self.assertIn('/register?child=1&subject=', empty)
        self.assertIn('小禾的作业登记簿', empty)

    def test_shared_completion_unchanged_but_explained(self):
        item = self.item('共享', child=0)
        _, detail = self.request(f'/item?id={item}&child=1')
        self.assertIn('完成状态会同步到所有本子', detail)
        status, _ = self.request('/done', 'POST', f'id={item}', {'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(status, 303)
        self.assertTrue(app.get_item(item)['done'])
        _, other = self.request('/?child=2')
        self.assertIn('待完成 0 项', other)

    def test_token_free_local_compatibility(self):
        self.item()
        status, body = self.request('/api/items')
        self.assertEqual(status, 200)
        self.assertEqual(len(json.loads(body)['items']), 1)

    def test_environment_token_read_and_write(self):
        with patch.object(app, 'API_TOKEN', 'test-only-env-token'):
            for path in ['/api/items', '/api/lists']:
                self.assertEqual(self.request(path)[0], 401)
                self.assertEqual(self.request(path, headers={'X-API-Token': 'bad'})[0], 401)
                self.assertEqual(self.request(path, headers={'X-API-Token': app.API_TOKEN})[0], 200)
            self.assertEqual(self.request('/api/items', 'POST', 'title=blocked', {'Content-Type': 'application/x-www-form-urlencoded'})[0], 401)
            self.assertEqual(self.request('/api/items', 'POST', 'title=allowed&child_id=1', {'Content-Type': 'application/x-www-form-urlencoded', 'X-API-Token': app.API_TOKEN})[0], 201)
            # The website is still trusted-LAN, not made private by an API token.
            self.assertEqual(self.request('/')[0], 200)

    def test_database_token_and_revocation(self):
        token = 'test-only-database-token'
        with app.db() as conn:
            conn.execute('INSERT INTO api_tokens VALUES (?,?)', (hashlib.sha256(token.encode()).hexdigest(), app.now_dt()))
        self.assertEqual(self.request('/api/items')[0], 401)
        self.assertEqual(self.request('/api/items', headers={'X-API-Token': token})[0], 200)
        with app.db() as conn:
            conn.execute('DELETE FROM api_tokens')
        # No configured tokens returns to the documented trusted-LAN mode.
        self.assertEqual(self.request('/api/items')[0], 200)

    def test_api_read_filters_child_subject_visibility(self):
        self.item('shared', child=0)
        self.item('own')
        self.item('other', child=2)
        self.item('hidden', visible_at='2999-01-01T00:00')
        _, body = self.request('/api/items?child=1&subject=%E6%95%B0%E5%AD%A6')
        self.assertEqual({i['title'] for i in json.loads(body)['items']}, {'shared', 'own'})

    def test_batch_partial_results_have_request_indexes(self):
        drafts = [{'title': 'good', 'subject': '数学', 'child_id': 1}, {'title': 'bad', 'subject': '', 'child_id': 1}, {'title': 'also good', 'subject': '语文', 'child_id': 2}]
        status, body = self.request('/api/ai-batch', 'POST', json.dumps({'drafts': drafts}), {'Content-Type': 'application/json'})
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertEqual([i['index'] for i in result['created']], [0, 2])
        self.assertEqual(result['failed'][0]['index'], 1)
        self.assertEqual(result['failed'][0]['message'], '请选择学科')
        self.assertEqual(len(app.all_items()), 2)

    def test_registration_default_and_json_script_escaping(self):
        with app.db() as conn:
            conn.execute('UPDATE children SET name=? WHERE id=2', ('</script><script>unsafe()</script>',))
        _, body = self.request('/register?child=1')
        self.assertIn("name='child_id' required value='1' checked", body)
        self.assertIn('尚未配置模型', body)
        self.assertNotIn('</script><script>unsafe()', body)
        self.assertIn('\\u003c/script>', body)
        self.assertIn("aria-controls='manual-entry'", body)
        self.assertIn("name='visible_at'", body)

    def test_post_manual_and_scheduled_items(self):
        status, _ = self.request('/add', 'POST', 'title=New&subject=English&child_id=1&visible_at=2999-01-01T00%3A00', {'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(status, 303)
        self.assertEqual(len(app.all_items()), 1)
        self.assertFalse(app.visible_items(app.all_items()))
        status, _ = self.request('/api/ai-parse', 'POST', 'text=example&child_id=1', {'Content-Type': 'application/x-www-form-urlencoded'})
        self.assertEqual(status, 503)


    def multipart(self, fields, audio=b'fake-audio', mime='audio/webm'):
        boundary = 'VoiceTestBoundary'
        body = b''
        for key, value in fields.items():
            body += f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
        body += f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="test.webm"\r\nContent-Type: {mime}\r\n\r\n'.encode() + audio
        body += f'\r\n--{boundary}--\r\n'.encode()
        return body, {'Content-Type': f'multipart/form-data; boundary={boundary}'}

    def test_registration_context_and_no_shared_creation_option(self):
        _, global_page = self.request('/register')
        self.assertIn('给哪个孩子登记', global_page)
        self.assertNotIn("id='voice-start'", global_page)
        for cid in (1, 2):
            _, body = self.request(f'/register?child={cid}')
            self.assertIn(f"<option value='{cid}' selected>", body)
            self.assertNotIn("value='0'", body)
            self.assertNotIn("['0','共享']", body)
            _, notebook = self.request(f'/?child={cid}')
            self.assertIn(f"href='/register?child={cid}'", notebook)
            self.assertNotIn("href='/register'", notebook)
        for raw in ('999', 'bad', '-1'):
            self.assertIn('登记对象已失效', self.request('/register?child='+raw)[1])
        with app.db() as conn:
            conn.execute('DELETE FROM children WHERE id=2')
        self.assertIn("<option value='1' selected>", self.request('/register')[1])
        with app.db() as conn:
            conn.execute('DELETE FROM children')
        self.assertIn('先添加孩子', self.request('/register')[1])

    def test_new_entries_reject_missing_zero_and_invalid_child(self):
        for child in ('', '0', '999', 'bad'):
            for path in ('/api/items', '/add'):
                status, _ = self.request(path, 'POST', f'title=bad&child_id={child}', {'Content-Type':'application/x-www-form-urlencoded'})
                self.assertEqual(status, 400)
            status, body = self.request('/api/ai-batch', 'POST', json.dumps({'drafts':[{'title':'bad','subject':'数学','child_id':child}]}), {'Content-Type':'application/json'})
            self.assertFalse(json.loads(body)['created'])
        self.assertEqual(app.all_items(), [])
        children = json.loads(self.request('/api/lists')[1])['children']
        self.assertEqual([c['id'] for c in children], [1,2])
        # A pre-upgrade shared record stays intact, visible in both books, no migration.
        item = self.item('历史共享', child=0)
        app.init_db()
        self.assertEqual(app.get_item(item)['child_id'], 0)
        for cid in (1,2):
            self.assertIn('历史共享', self.request(f'/?child={cid}')[1])

    def test_stt_multipart_and_errors_do_not_disclose_upstream(self):
        from unittest.mock import MagicMock
        import urllib.error
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({'text':' 明天数学第十页 '}).encode()
        with patch.multiple(app, STT_API_KEY='fake-secret', STT_BASE_URL='https://speech.example/v1', STT_MODEL='test-stt'):
            with patch('urllib.request.urlopen', return_value=response) as urlopen:
                self.assertEqual(app.call_speech_transcribe(b'fake-audio', 'audio/mp4;codecs=aac'), (True, '', '明天数学第十页'))
                request = urlopen.call_args.args[0]
                self.assertEqual(request.full_url, 'https://speech.example/v1/audio/transcriptions')
                self.assertEqual(request.get_header('Authorization'), 'Bearer fake-secret')
                self.assertIn(b'name="file"; filename="recording.m4a"', request.data)
                self.assertIn(b'fake-audio', request.data)
                self.assertNotIn(b'fake-secret', request.data)
            for audio, mime, code in [(b'', 'audio/webm', 'empty_audio'), (b'x', 'text/plain', 'unsupported_audio'), (b'x'*(app.MAX_AUDIO_BYTES+1), 'audio/wav', 'audio_too_large')]:
                self.assertEqual(app.call_speech_transcribe(audio, mime)[1], code)
            response.__enter__.return_value.read.return_value = b'{"text":" "}'
            with patch('urllib.request.urlopen', return_value=response):
                self.assertEqual(app.call_speech_transcribe(b'x', 'audio/webm')[1], 'empty_transcript')
            with patch('urllib.request.urlopen', side_effect=RuntimeError('fake-secret upstream details')):
                result = app.call_speech_transcribe(b'x', 'audio/webm')
                self.assertNotIn('fake-secret', result[2])

    def test_voice_api_one_step_with_context_no_creation(self):
        data, headers = self.multipart({'child_id':'2'})
        with patch.multiple(app, STT_API_KEY='fake', LLM_API_KEY='fake'), patch.object(app, 'call_speech_transcribe', return_value=(True,'','数学十页')) as transcribe, patch.object(app, 'call_llm_parse', return_value=(True,'',[{'title':'数学十页','subject':'数学','child_id':2}])) as parse:
            status, body = self.request('/api/ai-voice','POST',data,headers)
            self.assertEqual(status,200)
            self.assertEqual(json.loads(body)['drafts'][0]['child_id'],2)
            transcribe.assert_called_once_with(b'fake-audio','audio/webm')
            parse.assert_called_once_with('数学十页',None,'',2)
            self.assertEqual(app.all_items(),[])
            self.assertEqual(list(Path(app.UPLOAD_DIR).iterdir()),[])
            with patch.object(app, 'call_llm_parse', return_value=(False,'llm_error','模型暂不可用')):
                status, body = self.request('/api/ai-voice','POST',data,headers)
                self.assertEqual(status,502)
                self.assertEqual(json.loads(body)['transcript'],'数学十页')
        status, body = self.request('/api/ai-voice','POST',data,headers)
        self.assertEqual(status,503)
        with patch.multiple(app, STT_API_KEY='fake', LLM_API_KEY='fake'):
            for audio,mime in [(b'','audio/webm'),(b'fake','text/plain')]:
                data,headers = self.multipart({'child_id':'1'},audio,mime)
                self.assertEqual(self.request('/api/ai-voice','POST',data,headers)[0],400)
        # Reject content length before attempting to read or send to either provider.
        conn = http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        conn.request('POST','/api/ai-voice',headers={'Content-Length':str(app.MAX_AUDIO_BYTES+65537)})
        response = conn.getresponse(); self.assertEqual(response.status,413); response.read(); conn.close()

    def test_ai_child_context_beats_model_hallucination_and_is_required(self):
        from unittest.mock import MagicMock
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({'choices':[{'message':{'content':json.dumps([{'title':'数学','subject':'数学','child_id':2,'child_name':'小满'}])}}]}).encode()
        with patch.object(app,'LLM_API_KEY','fake'), patch('urllib.request.urlopen',return_value=response):
            for child in (1,2):
                self.assertEqual(app.call_llm_parse('数学十页',None,'',child)[2][0]['child_id'],child)
                self.assertEqual(app.call_llm_parse('',b'fake-image','image/png',child)[2][0]['child_id'],child)
        with patch.object(app,'call_llm_parse',return_value=(True,'',[])) as parse:
            for path in ('/api/ai-parse','/api/ai-voice'):
                for child in ('0','999',''):
                    self.assertEqual(self.request(path,'POST',f'text=math&child_id={child}',{'Content-Type':'application/x-www-form-urlencoded'})[0],400)
            parse.assert_not_called()
        with patch.object(app,'call_llm_parse',return_value=(True,'',[])) as parse:
            self.assertEqual(self.request('/api/ai-parse','POST','text=math&child_id=1',{'Content-Type':'application/x-www-form-urlencoded'})[0],200)
            parse.assert_called_once_with('math',None,'',1)


if __name__ == '__main__':
    unittest.main()
