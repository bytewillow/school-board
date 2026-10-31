"""Pure regressions for disjoint progress cohorts and AI parsing (no live AI calls)."""
from contextvars import ContextVar
from datetime import date
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


def response(drafts):
    return io.BytesIO(json.dumps({'choices': [{'message': {'content': json.dumps(drafts)}}]}).encode())


def draft(title='抄写', due='', kind='homework'):
    return {'title': title, 'subject': '语文', 'kind': kind, 'child_id': 99, 'due': due, 'body': ''}


class ProgressTests(unittest.TestCase):
    def task(self, title, due='', created='2026-10-30T12:00', done=False, kind='homework'):
        return dict(title=title, due=due, created=created, done=done, kind=kind, subject='语文', pinned=0, id=1)

    def test_periods_are_disjoint_and_use_due_before_created(self):
        items = [self.task('旧任务', '2026-10-29'), self.task('今天任务', '2026-10-30'),
                 self.task('周日任务', '2026-11-01'), self.task('无日期当天'),
                 self.task('无日期历史', created='2026-10-28T12:00'), self.task('通知', kind='notice')]
        periods = app.homework_periods(items, '2026-10-30')
        self.assertEqual([i['title'] for i in periods['today']], ['今天任务', '无日期当天'])
        self.assertEqual([i['title'] for i in periods['history']], ['旧任务', '无日期历史'])
        self.assertEqual([i['title'] for i in periods['future']], ['周日任务'])
        self.assertEqual(sum(map(len, periods.values())), 5)

    def test_rendered_periods_have_independent_denominators(self):
        items = [self.task('今天完成', '2026-10-30', done=True), self.task('今天未完成'),
                 self.task('旧任务完成', '2026-10-29', done=True), self.task('未来', '2026-11-01')]
        with patch.object(app, 'today', return_value='2026-10-30'):
            output = app.progress_widget(app.homework_summary(items), {'语文': items}, 1)
        self.assertIn("aria-label='今日进度完成率' aria-valuemin='0' aria-valuemax='100' aria-valuenow='50'", output)
        self.assertIn("aria-label='历史进度完成率' aria-valuemin='0' aria-valuemax='100' aria-valuenow='100'", output)
        self.assertIn("aria-label='未来作业完成率' aria-valuemin='0' aria-valuemax='100' aria-valuenow='0'", output)

    def test_old_completion_never_increases_today(self):
        items = [self.task('历史完成', '2026-10-29', done=True)]
        with patch.object(app, 'today', return_value='2026-10-30'):
            output = app.progress_widget(app.homework_summary(items), {'语文': items}, 1)
        self.assertIn('今天没有待统计的作业', output)
        self.assertIn("aria-label='今日进度完成率' aria-valuemin='0' aria-valuemax='100' aria-valuenow='0'", output)


class AIParseTests(unittest.TestCase):
    def setUp(self):
        self.settings = patch.multiple(app, LLM_API_KEY='fixture-not-real', get_subjects=lambda: ['语文', '数学'],
                                      view_children=lambda: [{'id': 1, 'name': '虚构孩子'}])
        self.settings.start()
        self.addCleanup(self.settings.stop)

    def parse(self, drafts, day='2026-10-30', text='语文抄写', image=None):
        with patch.object(app, 'today', return_value=day), patch('urllib.request.urlopen', return_value=response(drafts)) as call:
            result = app.call_llm_parse(text, image, 'image/png', 1)
            payload = json.loads(call.call_args.args[0].data)
        self.assertTrue(result[0], result)
        return result[2], payload

    def test_defaults_every_weekday_including_month_and_year_boundary(self):
        for day, expected in [('2026-10-26','2026-10-26'), ('2026-10-27','2026-10-27'),
                              ('2026-10-28','2026-10-28'), ('2026-10-29','2026-10-29'),
                              ('2026-10-30','2026-11-01'), ('2026-10-31','2026-10-31'),
                              ('2026-11-01','2026-11-01'), ('2027-12-31','2028-01-02')]:
            with self.subTest(day=day):
                self.assertEqual(app.ai_default_due(day), expected)
                drafts, _ = self.parse([draft()], day)
                self.assertEqual(drafts[0]['due'], expected)
                self.assertEqual(drafts[0]['child_id'], 1)

    def test_explicit_dates_win_even_friday_and_non_homework_stays_undated(self):
        drafts, payload = self.parse([draft(due='2026-10-30'), draft(due='2026-11-04'), draft(kind='notice'), draft(kind='material')])
        self.assertEqual([d['due'] for d in drafts], ['2026-10-30','2026-11-04','',''])
        self.assertIn('明确日期优先', payload['messages'][0]['content'])

    def test_image_path_uses_same_server_default(self):
        drafts, payload = self.parse([draft()], image=b'fixture-image-only')
        self.assertEqual(drafts[0]['due'], '2026-11-01')
        self.assertIsInstance(payload['messages'][1]['content'], list)

    def test_numbered_variants(self):
        for text in ['语文：1.抄写 2.背诵 3.阅读', '语文：1、抄写2、背诵3、阅读',
                     '语文：（1）抄写（2）背诵（3）阅读', '语文：(1)抄写(2)背诵(3)阅读',
                     '语文：1 抄写 2 背诵 3 阅读', '语文：1．抄写 2．背诵 3．阅读',
                     '语文：1)抄写\n2)背诵\n3)阅读']:
            with self.subTest(text=text):
                self.assertEqual(app.numbered_entries(text), ('语文：', ['抄写','背诵','阅读']))

    def test_numbers_that_are_not_task_lists_are_not_split(self):
        for text in ['完成第1、2、3题', '练习册第 1 2 3 题', '读1.5小时，写2.5页',
                     '2026-10-30', '第1课读2遍', '1.抄写', '1.抄写 3.背诵']:
            with self.subTest(text=text):
                self.assertIsNone(app.numbered_entries(text))

    def test_numbered_text_is_normalized_and_one_request_if_complete(self):
        drafts, payload = self.parse([draft('抄写'), draft('背诵'), draft('阅读')], text='语文：1、抄写2、背诵3、阅读')
        self.assertEqual(len(drafts), 3)
        self.assertEqual(payload['messages'][1]['content'], '语文：\n1. 抄写\n2. 背诵\n3. 阅读')

    def test_fallback_reparses_each_entry_preserving_context_and_dates(self):
        seen = []
        def upstream(req, **kwargs):
            payload = json.loads(req.data)
            text = payload['messages'][1]['content']
            seen.append((text, payload['messages'][0]['content']))
            if '本条独立任务：' not in text:
                return response([draft('模型错误合并')])
            if '抄写' in text:
                return response([draft('抄写', '2026-10-31')])
            return response([draft('背诵', '2026-11-02')])
        # Worker threads must inherit the student's scoped presentation context.
        token = app.VIEW_SESSION.set({'role':'student', 'child_id':1})
        self.addCleanup(app.VIEW_SESSION.reset, token)
        scoped = ContextVar('test_scope', default='missing'); scoped.set('student')
        original = app._call_llm_parse_once
        def scoped_parse(*args, **kwargs):
            self.assertEqual(scoped.get(), 'student')
            self.assertEqual(app.VIEW_SESSION.get()['child_id'], 1)
            return original(*args, **kwargs)
        with patch('urllib.request.urlopen', side_effect=upstream), patch.object(app, '_call_llm_parse_once', side_effect=scoped_parse):
            ok, _, drafts = app.call_llm_parse('语文：1.明天抄写 2.下周一背诵', None, '', 1)
        self.assertTrue(ok)
        self.assertEqual([d['title'] for d in drafts], ['抄写','背诵'])
        self.assertEqual([d['due'] for d in drafts], ['2026-10-31','2026-11-02'])
        self.assertEqual(len(seen), 3)
        self.assertTrue(all('共同背景（适用于本条）：语文：' in t for t, _ in seen[1:]))

    def test_fallback_failure_does_not_report_success_or_silently_drop_tasks(self):
        with patch.object(app, '_call_llm_parse_once', side_effect=[(True,'',[draft()]), (False,'llm_error','上游失败'), (True,'',[draft()])]):
            ok, error, result = app.call_llm_parse('语文：1.抄写 2.背诵',None,'',1)
        self.assertFalse(ok)
        self.assertEqual(error, 'llm_error')

    def test_user_cleared_date_is_respected_at_batch_validation(self):
        validated = app.validate_draft(draft(due=''), ['语文'], [{'id':1, 'name':'虚构孩子'}], 1)
        self.assertEqual(validated['due'], '')


if __name__ == '__main__':
    unittest.main()
