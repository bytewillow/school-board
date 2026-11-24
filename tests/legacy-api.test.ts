// 对外接口与旧版 app.py 保持一致：路径、参数、状态码、返回字段。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { run } from '../server/db.js';
import { form, PNG, setup } from './helpers.js';

test('没配置任何令牌时保留局域网匿名模式；/api/lists 格式不变', async () => {
  const t = setup();
  t.addChild('小雨');
  const r = await t.req('/api/lists');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ['children', 'kinds', 'ok', 'subjects']);
  assert.deepEqual(body.children, [{ id: 1, name: '小雨' }]);
  assert.equal(body.subjects[0], '语文');
  assert.deepEqual(body.kinds[0], { code: 'notice', label: '通知' });
});

test('环境变量令牌：没带 401，请求头或 ?token= 都可以', async () => {
  const t = setup({ API_TOKEN: 'env-token-123' });
  assert.equal((await t.req('/api/lists')).status, 401);
  assert.deepEqual(await (await t.req('/api/lists')).json(), { ok: false, error: 'unauthorized' });
  assert.equal((await t.req('/api/lists', { headers: { 'X-API-Token': 'env-token-123' } })).status, 200);
  assert.equal((await t.req('/api/items?token=env-token-123')).status, 200);
  assert.equal((await t.req('/api/items', { headers: { 'X-API-Token': 'wrong' } })).status, 401);
});

test('管理页生成的令牌只存哈希，生成新的旧的失效，吊销后回到匿名模式', async () => {
  const t = setup();
  const cookie = await t.loginParent();
  const a = (await (await t.json('/app-api/admin/token', {}, { cookie })).json()).token;
  assert.match(a, /^sb_/);
  assert.equal((await t.req('/api/lists')).status, 401);
  assert.equal((await t.req('/api/lists', { headers: { 'X-API-Token': a } })).status, 200);
  const b = (await (await t.json('/app-api/admin/token', {}, { cookie })).json()).token;
  assert.equal((await t.req('/api/lists', { headers: { 'X-API-Token': a } })).status, 401);
  assert.equal((await t.req('/api/lists', { headers: { 'X-API-Token': b } })).status, 200);
  assert.ok(!JSON.stringify(t.db.prepare('SELECT * FROM api_tokens').all()).includes(b));
  await t.req('/app-api/admin/token', { method: 'DELETE', cookie });
  assert.equal((await t.req('/api/lists')).status, 200);
});

test('令牌接口不因网页会话绕过令牌', async () => {
  const t = setup({ API_TOKEN: 'env-token-123' });
  const cookie = await t.loginParent();
  assert.equal((await t.req('/api/items', { cookie })).status, 401);
});

test('POST /api/items：表单、JSON 都行，返回 201 {ok,id,title,url}', async () => {
  const t = setup();
  const kid = t.addChild('小雨');
  const r = await t.req('/api/items', { method: 'POST', body: form({ subject: '数学', child_id: String(kid), title: '练习册 P42', kind: 'homework', due: '2026-11-25' }) });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { ok: true, id: 1, title: '练习册 P42', url: '/item?id=1' });
  const j = await t.json('/api/items', { subject: '语文', child_id: kid, body: '背诵《春》第三段\n家长签字' });
  assert.equal(j.status, 201);
  assert.equal((await j.json()).title, '背诵《春》第三段');
  const row = t.db.prepare('SELECT * FROM items WHERE id=2').get() as any;
  assert.equal(row.kind, 'notice');
});

test('新登记必须属于真实孩子：缺失、0、不存在都 400', async () => {
  const t = setup();
  t.addChild('小雨');
  for (const child of [undefined, '0', '99', 'abc']) {
    const fields: Record<string, string> = { subject: '数学', title: 'x' };
    if (child !== undefined) fields.child_id = child;
    const r = await t.req('/api/items', { method: 'POST', body: form(fields) });
    assert.equal(r.status, 400, `child=${child}`);
    assert.equal((await r.json()).error, 'invalid_child');
  }
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as any).n, 0);
});

test('上传：中文文件名保留；.pic_hd 按真实类型改名；PDF 算资料、音频算听力', async () => {
  const t = setup();
  const kid = String(t.addChild('小雨'));
  await t.req('/api/items', { method: 'POST', body: form({ subject: '数学', child_id: kid }, { name: '490.pic_hd', type: 'application/octet-stream', bytes: PNG }) });
  await t.req('/api/items', { method: 'POST', body: form({ subject: '语文', child_id: kid }, { name: '阅读 材料.pdf', type: 'application/pdf', bytes: readFileSync(join(import.meta.dirname, 'fixtures/reading.pdf')) }) });
  await t.req('/api/items', { method: 'POST', body: form({ subject: '英语', child_id: kid }, { name: 'Unit4 听力.wav', type: 'audio/wav', bytes: readFileSync(join(import.meta.dirname, 'fixtures/sample.wav')) }) });
  const rows = t.db.prepare('SELECT title, filename, kind, mime, stored FROM items ORDER BY id').all() as any[];
  assert.deepEqual(rows.map((r) => [r.title, r.filename, r.kind]), [['490', '490.png', 'notice'], ['阅读 材料', '阅读 材料.pdf', 'material'], ['Unit4 听力', 'Unit4 听力.wav', 'listening']]);
  assert.match(rows[0].stored, /^[0-9a-f]{16}\.png$/);
  assert.equal(rows[0].mime, 'image/png');
});

test('文件超过 50MB 返回 413，不建空条目', async () => {
  const t = setup();
  const kid = String(t.addChild('小雨'));
  const big = new Uint8Array(50 * 1024 * 1024 + 1);
  const r = await t.req('/api/items', { method: 'POST', body: form({ subject: '数学', child_id: kid }, { name: 'big.pdf', type: 'application/pdf', bytes: big }) });
  assert.equal(r.status, 413);
  assert.deepEqual(await r.json(), { ok: false, error: 'file too large, max 50MB' });
  assert.equal((t.db.prepare('SELECT COUNT(*) AS n FROM items').get() as any).n, 0);
});

test('GET /api/items：字段与旧版一致；按孩子筛选包含共享；不返回未公开内容；可按学科筛选', async () => {
  const t = setup();
  const a = t.addChild('小雨'), b = t.addChild('小风');
  const ins = (title: string, child: number, subject = '数学', visible = '') =>
    run(t.db, "INSERT INTO items (title, subject, kind, created, child_id, visible_at) VALUES (?,?,'homework','2026-11-20T10:00',?,?)", title, subject, child, visible);
  ins('共享', 0); ins('小雨的', a); ins('小风的', b); ins('答案', a, '数学', '2999-01-01T00:00'); ins('语文的', a, '语文');
  const all = (await (await t.req('/api/items')).json()).items;
  assert.deepEqual(Object.keys(all[0]).sort(), ['body', 'child_id', 'done', 'due', 'file_url', 'filename', 'id', 'kind', 'link_url', 'subject', 'title', 'url']);
  assert.ok(!all.some((i: any) => i.title === '答案'));
  const mine = (await (await t.req(`/api/items?child=${a}`)).json()).items.map((i: any) => i.title).sort();
  assert.deepEqual(mine, ['共享', '小雨的', '语文的'].sort());
  const math = (await (await t.req(`/api/items?child=${a}&subject=数学`)).json()).items.map((i: any) => i.title).sort();
  assert.deepEqual(math, ['共享', '小雨的'].sort());
});

test('/api 索引仍然列出各接口', async () => {
  const t = setup();
  const r = await (await t.req('/api')).json();
  assert.equal(r.post, '/api/items');
  assert.equal(r.lists, '/api/lists');
  assert.ok(r.ai_parse && r.ai_batch && r.ai_voice && r.fields && r.example);
});

test('三个 /api/ai-* 都要网页登录', async () => {
  const t = setup();
  for (const p of ['/api/ai-parse', '/api/ai-batch', '/api/ai-voice']) {
    const r = await t.json(p, {});
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { ok: false, error: 'unauthorized' });
  }
});

test('ai-batch：逐条返回原请求序号；学生只能给自己；没学科的不建；用户清空的日期保持为空', async () => {
  const t = setup();
  const a = t.addChild('小雨', 'secret1'), b = t.addChild('小风', 'secret2');
  const cookie = await t.loginStudent('小雨', 'secret1');
  const r = await (await t.json('/api/ai-batch', { drafts: [
    { title: '抄写', subject: '语文', kind: 'homework', child_id: a, due: '' },
    { title: '别人的', subject: '数学', child_id: b },
    { title: '没学科', subject: '不存在', child_id: a },
    { title: '背诵', subject: '语文', child_id: a, due: '2026-11-30' },
  ] }, { cookie })).json();
  assert.deepEqual(r.created.map((c: any) => [c.index, c.title]), [[0, '抄写'], [3, '背诵']]);
  assert.deepEqual(r.failed.map((f: any) => [f.index, f.error]), [[1, 'invalid_child'], [2, 'subject required']]);
  const due = (t.db.prepare("SELECT due FROM items WHERE title='抄写'").get() as any).due;
  assert.equal(due, '');
  assert.equal((await t.json('/api/ai-batch', { drafts: [] }, { cookie })).status, 400);
});

test('ai-parse：没配置模型 503；学生给别的孩子解析 400；空输入 400', async () => {
  const t = setup();
  const a = t.addChild('小雨', 'secret1'), b = t.addChild('小风');
  const cookie = await t.loginStudent('小雨', 'secret1');
  assert.equal((await t.req('/api/ai-parse', { method: 'POST', cookie, body: form({ child_id: String(b), text: '数学作业' }) })).status, 400);
  assert.equal((await t.req('/api/ai-parse', { method: 'POST', cookie, body: form({ child_id: String(a) }) })).status, 400);
  const r = await t.req('/api/ai-parse', { method: 'POST', cookie, body: form({ child_id: String(a), text: '数学作业' }) });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'llm_not_configured');
});

test('ai-parse：编号任务被模型合并时逐条重新解析，保留共同背景；作业默认截止日由服务器填', async () => {
  const t = setup({ LLM_API_KEY: 'test-key' });
  const a = t.addChild('小雨', 'secret1');
  const cookie = await t.loginStudent('小雨', 'secret1');
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const text = JSON.parse(String(init.body)).messages[1].content;
    seen.push(text);
    const out = !text.includes('本条独立任务：') ? [{ title: '合并了', subject: '语文', kind: 'homework' }]
      : text.includes('抄写') ? [{ title: '抄写', subject: '语文', kind: 'homework', due: '2026-12-01' }] : [{ title: '背诵', subject: '语文', kind: 'homework' }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const r = await (await t.req('/api/ai-parse', { method: 'POST', cookie, body: form({ child_id: String(a), text: '语文：1.抄写 2.背诵' }) })).json();
    assert.equal(r.ok, true);
    assert.deepEqual(r.drafts.map((d: any) => d.title), ['抄写', '背诵']);
    assert.equal(r.drafts[0].due, '2026-12-01');
    assert.match(r.drafts[1].due, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.drafts.every((d: any) => d.child_id === a));
    assert.equal(seen.length, 3);
    assert.equal(seen[0], '语文：\n1. 抄写\n2. 背诵');
    assert.ok(seen.slice(1).every((s) => s.includes('共同背景（适用于本条）：语文：')));
  } finally {
    globalThis.fetch = original;
  }
});

test('附件：要登录；Range 206 / 416；学生拿不到别人的附件；HTML 加 CSP sandbox 当下载', async () => {
  const t = setup();
  const a = t.addChild('小雨', 'secret1'), b = t.addChild('小风');
  await t.req('/api/items', { method: 'POST', body: form({ subject: '英语', child_id: String(a) }, { name: 'a.wav', type: 'audio/wav', bytes: readFileSync(join(import.meta.dirname, 'fixtures/sample.wav')) }) });
  await t.req('/api/items', { method: 'POST', body: form({ subject: '数学', child_id: String(b) }, { name: 'b.png', type: 'image/png', bytes: PNG }) });
  await t.req('/api/items', { method: 'POST', body: form({ subject: '数学', child_id: String(a) }, { name: 'x.html', type: 'text/html', bytes: new TextEncoder().encode('<script>alert(1)</script>') }) });
  const [wav, png, html] = (t.db.prepare('SELECT stored FROM items ORDER BY id').all() as any[]).map((r) => r.stored);
  const anon = await t.req('/uploads/' + wav);
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get('location'), '/login');
  const cookie = await t.loginStudent('小雨', 'secret1');
  const part = await t.req('/uploads/' + wav, { cookie, headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/192044`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await t.req('/uploads/' + wav, { cookie, headers: { Range: 'bytes=999999-' } })).status, 416);
  assert.equal((await t.req('/uploads/' + png, { cookie })).status, 404);
  const h = await t.req('/uploads/' + html, { cookie });
  assert.equal(h.headers.get('content-security-policy'), "sandbox; default-src 'none'");
  assert.match(h.headers.get('content-disposition') || '', /^attachment; filename\*=UTF-8''x\.html$/);
  assert.equal((await t.req('/uploads/..%2Fboard.db', { cookie })).status, 404);
});

test('显式跨站的写请求 403；/api/items 保留命令行用法', async () => {
  const t = setup();
  const kid = t.addChild('小雨');
  const cookie = await t.loginParent();
  const evil = await t.json('/app-api/admin/children', { name: '坏人' }, { cookie, headers: { Origin: 'https://evil.test' } });
  assert.equal(evil.status, 403);
  const same = await t.json('/app-api/admin/children', { name: '小云' }, { cookie, headers: { Origin: 'http://board.test' } });
  assert.equal(same.status, 201);
  const api = await t.req('/api/items', { method: 'POST', headers: { Origin: 'https://agent.test' }, body: form({ subject: '数学', child_id: String(kid), title: 'x' }) });
  assert.equal(api.status, 201);
});
