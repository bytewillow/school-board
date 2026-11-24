// 登录、会话、权限，以及在旧版数据库上直接升级。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createApp } from '../server/app.js';
import { passwordHash } from '../server/auth.js';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { setup } from './helpers.js';

test('学生登录：成功发 HttpOnly / SameSite=Lax / 30 天 cookie；名字不存在和密码错误提示一样', async () => {
  const t = setup();
  t.addChild('小雨', 'secret1');
  t.addChild('没密码');
  const ok = await t.json('/app-api/login', { name: '小雨', password: 'secret1' });
  assert.equal(ok.status, 200);
  const c = ok.headers.getSetCookie()[0];
  assert.match(c, /^sb_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
  const msgs = [];
  for (const b of [{ name: '小雨', password: 'wrong' }, { name: '不存在', password: 'secret1' }, { name: '没密码', password: '' }]) {
    const r = await t.json('/app-api/login', b);
    assert.equal(r.status, 401);
    msgs.push((await r.json()).message);
  }
  assert.deepEqual(new Set(msgs), new Set(['名字或密码不对']));
});

test('经 HTTPS 代理时 cookie 加 Secure；会话库里只存哈希；退出后失效', async () => {
  const t = setup();
  t.addChild('小雨', 'secret1');
  const r = await t.json('/app-api/login', { name: '小雨', password: 'secret1' }, { headers: { 'X-Forwarded-Proto': 'https' } });
  const raw = r.headers.getSetCookie()[0];
  assert.match(raw, /; Secure$/);
  const token = raw.split(';')[0].split('=')[1];
  const rows = t.db.prepare('SELECT token_hash FROM sessions').all() as any[];
  assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
  const cookie = `sb_session=${token}`;
  assert.equal((await t.req('/app-api/me', { cookie })).status, 200);
  const out = await t.json('/app-api/logout', {}, { cookie });
  assert.ok(out.headers.getSetCookie().some((x) => x.startsWith('sb_session=; ') && x.includes('Max-Age=0')));
  assert.equal((await t.req('/app-api/me', { cookie })).status, 401);
});

test('旧版的 admin cookie 继续当家长', async () => {
  const t = setup();
  const legacy = createHash('sha256').update('parent-pass').digest('hex');
  const me = await (await t.req('/app-api/me', { cookie: `admin=${legacy}` })).json();
  assert.equal(me.role, 'parent');
  assert.equal((await t.req('/app-api/me', { cookie: 'admin=nope' })).status, 401);
});

test('改密码、清密码、删孩子都会让这个孩子的旧登录失效；改名保留密码', async () => {
  const t = setup();
  const kid = t.addChild('小雨', 'secret1');
  const parent = await t.loginParent();
  let s = await t.loginStudent('小雨', 'secret1');
  await t.req(`/app-api/admin/children/${kid}`, { method: 'PATCH', cookie: parent, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '林小雨' }) });
  assert.equal((await t.req('/app-api/me', { cookie: s })).status, 200);
  assert.equal((await t.json('/app-api/login', { name: '林小雨', password: 'secret1' })).status, 200);
  const weak = await t.req(`/app-api/admin/children/${kid}`, { method: 'PATCH', cookie: parent, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '123' }) });
  assert.equal(weak.status, 400);
  await t.req(`/app-api/admin/children/${kid}`, { method: 'PATCH', cookie: parent, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'newpass1' }) });
  assert.equal((await t.req('/app-api/me', { cookie: s })).status, 401);
  s = await t.loginStudent('林小雨', 'newpass1');
  await t.req(`/app-api/admin/children/${kid}`, { method: 'DELETE', cookie: parent });
  assert.equal((await t.req('/app-api/me', { cookie: s })).status, 401);
});

test('学生：看不到别人的、看不到未公开的；共享的能看能完成但不能改删；不能进管理', async () => {
  const t = setup();
  const a = t.addChild('小雨', 'secret1'), b = t.addChild('小风');
  const ins = (title: string, child: number, visible = '') => (t.db.prepare("INSERT INTO items (title, subject, kind, created, child_id, visible_at, due) VALUES (?,?,'homework','2026-11-20T10:00',?,?,'2026-11-30')").run(title, '数学', child, visible) as any).lastInsertRowid as number;
  const mine = ins('我的', a), other = ins('别人的', b), shared = ins('共享', 0), hidden = ins('答案', a, '2999-01-01T00:00');
  const s = await t.loginStudent('小雨', 'secret1');
  const list = (await (await t.req(`/app-api/items?child=${b}`, { cookie: s })).json()).items.map((i: any) => i.title).sort();
  assert.deepEqual(list, ['共享', '我的'].sort());
  assert.equal((await t.req(`/app-api/items/${other}`, { cookie: s })).status, 404);
  assert.equal((await t.req(`/app-api/items/${hidden}`, { cookie: s })).status, 404);
  assert.equal((await t.json(`/app-api/items/${shared}/done`, { done: true }, { cookie: s })).status, 200);
  const patchShared = await t.req(`/app-api/items/${shared}`, { method: 'PATCH', cookie: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '改' }) });
  assert.equal(patchShared.status, 404);
  assert.equal((await t.req(`/app-api/items/${shared}`, { method: 'DELETE', cookie: s })).status, 404);
  const move = await t.req(`/app-api/items/${mine}`, { method: 'PATCH', cookie: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ child_id: b }) });
  assert.equal(move.status, 400);
  assert.equal((await t.req('/app-api/admin/overview', { cookie: s })).status, 403);
  const create = await t.req('/app-api/items', { method: 'POST', cookie: s, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ child_id: b, subject: '数学', title: 'x' }) });
  assert.equal(create.status, 400);
});

test('家长：能看到未公开的（带 hidden 标记）、能把作业移到别的本子', async () => {
  const t = setup();
  const a = t.addChild('小雨'), b = t.addChild('小风');
  const p = await t.loginParent();
  const created = await (await t.json('/app-api/items', { child_id: a, subject: '数学', title: '答案', kind: 'answer', visible_at: '2999-01-01T08:00' }, { cookie: p })).json();
  assert.equal(created.item.hidden, true);
  const moved = await (await t.req(`/app-api/items/${created.item.id}`, { method: 'PATCH', cookie: p, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ child_id: b }) })).json();
  assert.equal(moved.item.child_id, b);
  assert.equal((await t.req('/app-api/items', { cookie: p })).status, 400);
});

test('完成是“明确目标状态”，重复提交结果一样；步骤全做完自动完成；记录完成时间', async () => {
  const t = setup();
  const a = t.addChild('小雨', 'secret1');
  const s = await t.loginStudent('小雨', 'secret1');
  const it = (await (await t.json('/app-api/items', { child_id: a, subject: '数学', title: '练习', due: '2026-11-30', due_time: '21:00', est_minutes: 40, steps: ['第一步', '第二步'] }, { cookie: s })).json()).item;
  assert.equal(it.steps.length, 2);
  assert.equal(it.est_minutes, 40);
  for (let i = 0; i < 2; i++) {
    const r = await (await t.json(`/app-api/items/${it.id}/done`, { done: true }, { cookie: s })).json();
    assert.equal(r.item.done, true);
  }
  assert.match((t.db.prepare('SELECT done_at FROM items WHERE id=?').get(it.id) as any).done_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  await t.json(`/app-api/items/${it.id}/done`, { done: false }, { cookie: s });
  await t.json(`/app-api/items/${it.id}/steps/${it.steps[0].id}`, { done: true }, { cookie: s });
  let r = await (await t.json(`/app-api/items/${it.id}/steps/${it.steps[1].id}`, { done: true }, { cookie: s })).json();
  assert.equal(r.item.done, true);
  r = await (await t.json(`/app-api/items/${it.id}/steps/${it.steps[1].id}`, { done: false }, { cookie: s })).json();
  assert.equal(r.item.done, false);
  assert.equal((await t.json(`/app-api/items/${it.id}/done`, { done: 'yes' }, { cookie: s })).status, 400);
  const f = await (await t.json(`/app-api/items/${it.id}/focus`, { minutes: 25 }, { cookie: s })).json();
  assert.equal(f.item.focus_minutes, 25);
});

/** 旧版 app.py 的建表语句和数据，原样照搬。 */
function legacyDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'sb-legacy-'));
  mkdirSync(join(dir, 'uploads'));
  writeFileSync(join(dir, 'uploads', 'abcd1234abcd1234.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const db = new DatabaseSync(join(dir, 'board.db'));
  db.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '其他', kind TEXT NOT NULL DEFAULT 'notice',
    body TEXT DEFAULT '', link_url TEXT DEFAULT '', filename TEXT DEFAULT '', stored TEXT DEFAULT '', mime TEXT DEFAULT '',
    created TEXT NOT NULL, due TEXT DEFAULT '', visible_at TEXT DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
    child_id INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE TABLE subjects (name TEXT PRIMARY KEY, ord INTEGER)');
  db.exec("CREATE TABLE children (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, password_hash TEXT DEFAULT '')");
  db.exec('CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, role TEXT NOT NULL, child_id INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)');
  db.exec('CREATE TABLE api_tokens (token_hash TEXT PRIMARY KEY, created TEXT NOT NULL)');
  db.prepare('INSERT INTO children (name, password_hash) VALUES (?,?)').run('小雨', passwordHash('secret1'));
  db.prepare("INSERT INTO subjects VALUES ('科学', 99)").run();
  db.prepare("INSERT INTO items (title, subject, kind, created, due, child_id, done, stored, filename, mime) VALUES ('旧作业','数学','homework','2026-10-01T18:00','2026-10-02',1,1,'abcd1234abcd1234.png','图.png','image/png')").run();
  db.prepare("INSERT INTO items (title, subject, kind, created, child_id) VALUES ('旧通知','科学','notice','2026-10-01T18:00',0)").run();
  // 旧版 datetime.now().isoformat() 带微秒的本地时间
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const created = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.123456`;
  db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(createHash('sha256').update('old-session-token').digest('hex'), 'student', 1, created);
  db.prepare('INSERT INTO api_tokens VALUES (?,?)').run(createHash('sha256').update('sb_oldtoken').digest('hex'), '2026-10-01T18:00');
  db.close();
  return dir;
}

test('直接在旧库上启动：先备份，只加不删；旧数据、旧登录、旧令牌都还能用', async () => {
  const dir = legacyDataDir();
  const cfg = loadConfig({ DATA_DIR: dir, SCHEDULER: '0', WEB_DIR: join(dir, 'web') } as NodeJS.ProcessEnv);
  const db = openDb(cfg.dbPath);
  assert.ok(existsSync(join(dir, 'board.db.v1-backup')));
  const cols = (db.prepare('PRAGMA table_info(items)').all() as any[]).map((r) => r.name);
  for (const c of ['title', 'subject', 'kind', 'body', 'link_url', 'filename', 'stored', 'mime', 'created', 'due', 'visible_at', 'pinned', 'done', 'child_id', 'due_time', 'est_minutes', 'remind', 'done_at']) assert.ok(cols.includes(c), c);
  const subjects = (db.prepare('SELECT name FROM subjects ORDER BY ord, name').all() as any[]).map((r) => r.name);
  assert.equal(subjects[0], '语文');
  assert.ok(subjects.includes('科学'));
  const app = createApp(db, cfg);
  const me = await (await app.request('http://board.test/app-api/me', { headers: { Cookie: 'sb_session=old-session-token' } })).json();
  assert.equal(me.role, 'student');
  const items = await (await app.request('http://board.test/app-api/items', { headers: { Cookie: 'sb_session=old-session-token' } })).json();
  assert.deepEqual(items.items.map((i: any) => i.title).sort(), ['旧作业', '旧通知'].sort());
  const old = items.items.find((i: any) => i.title === '旧作业');
  assert.equal(old.done, true);
  assert.equal(old.due_time, '');
  assert.equal(old.file_url, '/uploads/abcd1234abcd1234.png');
  assert.equal((await app.request('http://board.test/api/lists', { headers: { 'X-API-Token': 'sb_oldtoken' } })).status, 200);
  assert.equal((await app.request('http://board.test/uploads/abcd1234abcd1234.png', { headers: { Cookie: 'sb_session=old-session-token' } })).status, 200);
  db.close();
  // 第二次启动不再覆盖备份
  writeFileSync(join(dir, 'board.db.v1-backup'), 'keep');
  openDb(cfg.dbPath).close();
  assert.equal(readFileSync(join(dir, 'board.db.v1-backup'), 'utf8'), 'keep');
});

test('导入另一份数据目录：孩子按名字合并、附件复制、重复导入会跳过', async () => {
  const { importDataDir } = await import('../server/import.js');
  const src = legacyDataDir();
  const t = setup();
  t.addChild('小雨');
  const r1 = importDataDir(t.db, t.cfg.uploadDir, src);
  assert.equal(r1.children, 0);
  assert.equal(r1.items, 2);
  assert.equal(r1.files, 1);
  const row = t.db.prepare("SELECT child_id, stored FROM items WHERE title='旧作业'").get() as any;
  assert.equal(row.child_id, 1);
  assert.ok(existsSync(join(t.cfg.uploadDir, row.stored)));
  assert.ok((t.db.prepare("SELECT password_hash FROM children WHERE name='小雨'").get() as any).password_hash);
  const r2 = importDataDir(t.db, t.cfg.uploadDir, src);
  assert.equal(r2.items, 0);
  assert.equal(r2.skipped, 2);
});
