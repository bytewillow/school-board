// 日期规则、编号拆分、打卡统计、推送提醒。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aiDefaultDue, dueAt, effectiveRemind, parseDate, remindAt } from '../shared/dates.js';
import { numberedEntries, validateDraft } from '../server/ai.js';
import { run } from '../server/db.js';
import { allItems } from '../server/items.js';
import { setPrefs } from '../server/prefs.js';
import { dailyReminder, tick } from '../server/push.js';
import { computeStats } from '../server/stats.js';
import { setup } from './helpers.js';

test('AI 默认截止日：当天；周五登记则周日；跨月跨年都对', () => {
  for (const [day, want] of [['2026-10-26', '2026-10-26'], ['2026-10-27', '2026-10-27'], ['2026-10-28', '2026-10-28'], ['2026-10-29', '2026-10-29'],
    ['2026-10-30', '2026-11-01'], ['2026-10-31', '2026-10-31'], ['2026-11-01', '2026-11-01'], ['2027-12-31', '2028-01-02']]) {
    assert.equal(aiDefaultDue(parseDate(day)!), want, day);
  }
});

test('编号任务的各种写法都能拆开', () => {
  for (const text of ['语文：1.抄写 2.背诵 3.阅读', '语文：1、抄写2、背诵3、阅读', '语文：（1）抄写（2）背诵（3）阅读', '语文：(1)抄写(2)背诵(3)阅读',
    '语文：1 抄写 2 背诵 3 阅读', '语文：1．抄写 2．背诵 3．阅读', '语文：1)抄写\n2)背诵\n3)阅读']) {
    assert.deepEqual(numberedEntries(text), ['语文：', ['抄写', '背诵', '阅读']], text);
  }
});

test('题号、小数、日期、不连续编号不误拆', () => {
  for (const text of ['完成第1、2、3题', '练习册第 1 2 3 题', '读1.5小时，写2.5页', '2026-10-30', '第1课读2遍', '1.抄写', '1.抄写 3.背诵']) {
    assert.equal(numberedEntries(text), null, text);
  }
});

test('草稿校验：学科、类型、孩子对不上就留空 / 用默认；日期格式不对就清空', () => {
  const d = validateDraft({ title: ' 抄写 ', subject: '体育', kind: 'play', child_id: 9, due: '明天', child_name: '小雨' }, ['语文'], [{ id: 1, name: '小雨' }], 0);
  assert.deepEqual(d, { title: '抄写', subject: '', kind: '', child_id: 1, due: '', body: '' });
  assert.equal(validateDraft(null, [], [], 3).child_id, 3);
});

test('截止时间：没写时间按 21:00；提醒默认截止前 2 小时，早上交的改成前一晚 21:00', () => {
  assert.equal(dueAt('2026-11-24', '')!.getHours(), 21);
  const prefs = { remind: true, before: 120 };
  assert.equal(effectiveRemind('', '18:00', prefs), '120');
  assert.equal(effectiveRemind('', '08:00', prefs), 'eve');
  assert.equal(effectiveRemind('60', '08:00', prefs), '60');
  assert.equal(effectiveRemind('', '18:00', { remind: false, before: 120 }), 'off');
  const eve = remindAt('2026-11-25', '08:00', '', prefs)!;
  assert.deepEqual([eve.getDate(), eve.getHours()], [24, 21]);
  assert.equal(remindAt('2026-11-24', '18:00', '', prefs)!.getHours(), 16);
});

test('连续按时天数：没作业的日子跳过，迟交的日子打断；旧数据没有完成时间算按时', () => {
  const t = setup();
  const kid = t.addChild('小雨');
  const now = new Date(2026, 10, 24, 20, 0);
  const add = (due: string, done: number, doneAt = '', dueTime = '') => run(t.db, "INSERT INTO items (title, subject, kind, created, due, due_time, done, done_at, child_id) VALUES ('x','数学','homework','2026-11-01T08:00',?,?,?,?,?)", due, dueTime, done, doneAt, kid);
  add('2026-11-24', 1, '2026-11-24T19:00');
  add('2026-11-23', 1, '');
  add('2026-11-20', 1, '2026-11-20T20:00');
  add('2026-11-19', 1, '2026-11-20T08:00');
  const st = computeStats(t.db, allItems(t.db), kid, now);
  assert.equal(st.streak, 3);
  assert.equal(st.lastLate, '2026-11-19');
  assert.equal(st.days.length, 28);
  assert.equal(st.days.find((d) => d.date === '2026-11-22')!.status, 'none');
  assert.equal(st.days.find((d) => d.date === '2026-11-25')!.status, 'future');
});

test('推送：到点发一次截止提醒（不重复）；关掉详情只发笼统文字；失效订阅自动删除；每日提醒按时发', async () => {
  const t = setup();
  const kid = t.addChild('小雨');
  run(t.db, "INSERT INTO push_subs VALUES ('https://push.test/a','k','a',?,'student','2026-11-24T10:00')", kid);
  run(t.db, "INSERT INTO push_subs VALUES ('https://push.test/gone','k','a',?,'student','2026-11-24T10:00')", kid);
  run(t.db, "INSERT INTO items (title, subject, kind, created, due, due_time, est_minutes, child_id) VALUES ('练习册 P42','数学','homework','2026-11-24T08:00','2026-11-24','18:00',40,?)", kid);
  const sent: { endpoint: string; body: any }[] = [];
  const send = async (sub: any, payload: string) => {
    if (sub.endpoint.endsWith('gone')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    sent.push({ endpoint: sub.endpoint, body: JSON.parse(payload) });
  };
  await tick(t.db, send, new Date(2026, 10, 24, 15, 59));
  assert.equal(sent.length, 0);
  await tick(t.db, send, new Date(2026, 10, 24, 16, 1));
  await tick(t.db, send, new Date(2026, 10, 24, 16, 2));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.title, '数学作业还有 2 小时截止');
  assert.match(sent[0].body.body, /练习册 P42，约 40 分钟/);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM push_subs").get() as any).n, 1);

  setPrefs(t.db, kid, { lockDetail: false, dailyAt: '17:30' });
  await tick(t.db, send, new Date(2026, 10, 24, 17, 31));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.title, '今晚有 1 项作业，约 40 分钟');
  assert.equal(sent[1].body.body, '打开作业簿看看先写哪项');
});

test('每日提醒：今晚没作业就不发', () => {
  assert.equal(dailyReminder([], new Date(), true), null);
});

test('专注结束提醒：按设定时刻推给那台设备，同一 tag 只保留最新一条', async () => {
  const t = setup();
  const kid = t.addChild('小雨', 'secret1');
  const s = await t.loginStudent('小雨', 'secret1');
  const sub = { endpoint: 'https://push.test/me', keys: { p256dh: 'k', auth: 'a' } };
  assert.equal((await t.json('/app-api/push/subscribe', { subscription: sub, child_id: kid }, { cookie: s })).status, 200);
  const at = Date.now() + 60000;
  await t.json('/app-api/push/schedule', { endpoint: sub.endpoint, tag: 'focus', at_ms: at - 30000, title: '旧的' }, { cookie: s });
  await t.json('/app-api/push/schedule', { endpoint: sub.endpoint, tag: 'focus', at_ms: at, title: '专注时间到', url: '/item/1?focus=1' }, { cookie: s });
  const sent: any[] = [];
  const send = async (_s: any, p: string) => { sent.push(JSON.parse(p)); };
  await tick(t.db, send, new Date(at - 1000));
  assert.equal(sent.length, 0);
  await tick(t.db, send, new Date(at + 1000));
  assert.deepEqual(sent.map((x) => x.title), ['专注时间到']);
  assert.equal((await t.json('/app-api/push/schedule', { endpoint: 'https://push.test/other', at_ms: at }, { cookie: s })).status, 400);
});
