import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { dueAt, isoDate, isoDateTime, pad } from '../shared/dates.js';
import {
  apiTokenStatus, childrenWithPasswordState, DUMMY_HASH, generateApiToken, passwordHash, passwordMatches,
  revokeChildSessions, revokeSession, safeEqual, sessionCookie, startSession, type Session,
} from './auth.js';
import type { Config } from './config.js';
import { all, one, run, tx, type DB } from './db.js';
import { contentLength, err, readForm, readJson, type Env } from './http.js';
import {
  allItems, appItemJson, appItemsJson, canView, createItem, editAllowed, ensureSubject, filterChild, getChildren, getItem, getSubjects,
  isHidden, KINDS, MAX_FILE_BYTES, setDone, updateItem, visibleItems, type ItemRow,
} from './items.js';
import { getPrefs, setPrefs } from './prefs.js';
import { dailyReminder, dueReminder, makeSender, sendToChild, vapidKeys } from './push.js';
import { computeStats } from './stats.js';

const stamp = (d: Date) => isoDateTime(d) + ':' + pad(d.getSeconds());

/** 新界面用的 JSON 接口（/app-api/*），只认网页登录会话，不接受 API 令牌。 */
export function appApi(db: DB, cfg: Config) {
  const app = new Hono<Env>();
  const S = (c: any): Session => c.get('session');

  // ---------- 登录 ----------
  app.post('/login', async (c) => {
    const b = await readJson(c);
    const row = one(db, 'SELECT id, password_hash FROM children WHERE name=?', String(b.name || '').trim());
    const ok = passwordMatches(String(b.password || ''), row?.password_hash || DUMMY_HASH);
    if (!row?.password_hash || !ok) return err(c, 401, 'bad_login', '名字或密码不对');
    c.header('Set-Cookie', startSession(c, db, 'student', row.id));
    return c.json({ ok: true });
  });

  app.post('/admin-login', async (c) => {
    const b = await readJson(c);
    if (!safeEqual(String(b.password || ''), cfg.adminPassword)) return err(c, 401, 'bad_login', '管理密码不对');
    c.header('Set-Cookie', startSession(c, db, 'parent'));
    return c.json({ ok: true });
  });

  app.post('/logout', (c) => {
    revokeSession(c, db);
    c.header('Set-Cookie', sessionCookie(c, '', true), { append: true });
    c.header('Set-Cookie', 'admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0', { append: true });
    return c.json({ ok: true });
  });

  app.use('*', async (c, next) => {
    if (!c.get('session')) return err(c, 401, 'unauthorized', '请先登录');
    await next();
  });

  /** 学生固定是自己；家长必须指定一个存在的孩子。返回 null 表示无效。 */
  const childOf = (c: any, raw?: unknown): number | null => {
    const s = S(c);
    if (s.role === 'student') return s.child_id;
    const id = Number(raw ?? c.req.query('child'));
    return Number.isInteger(id) && getChildren(db).some((x) => x.id === id) ? id : null;
  };
  const itemsFor = (s: Session, child: number): ItemRow[] => {
    const list = filterChild(allItems(db), child);
    return s.role === 'student' ? visibleItems(list) : list;
  };
  const viewable = (s: Session, it: ItemRow | undefined): it is ItemRow => canView(it, s) && !(s.role === 'student' && isHidden(it!));

  // ---------- 基本信息 ----------
  app.get('/me', (c) => {
    const s = S(c);
    const children = getChildren(db);
    return c.json({
      ok: true, role: s.role, child_id: s.child_id,
      children: s.role === 'student' ? children.filter((x) => x.id === s.child_id) : children,
      subjects: getSubjects(db),
      kinds: Object.entries(KINDS).map(([code, label]) => ({ code, label })),
      features: { ai: !!cfg.llm.key },
      push: { publicKey: vapidKeys(db, cfg).publicKey },
      now: new Date().toISOString(),
    });
  });

  /** 家长的本子封面：每本显示未完成、逾期、今天截止和下一项。 */
  app.get('/notebooks', (c) => {
    if (S(c).role !== 'parent') return err(c, 403, 'forbidden');
    const now = new Date(), today = isoDate(now);
    const all_ = visibleItems(allItems(db));
    return c.json({
      ok: true,
      notebooks: getChildren(db).map((ch) => {
        const hw = filterChild(all_, ch.id).filter((i) => i.kind === 'homework' && !i.done);
        const dated = hw.filter((i) => dueAt(i.due || '', i.due_time)).sort((a, b) => dueAt(a.due!, a.due_time)!.getTime() - dueAt(b.due!, b.due_time)!.getTime());
        const next = dated.find((i) => dueAt(i.due!, i.due_time)! >= now) || dated[0] || hw[0];
        return {
          id: ch.id, name: ch.name, undone: hw.length,
          overdue: dated.filter((i) => dueAt(i.due!, i.due_time)! < now).length,
          today: hw.filter((i) => i.due === today).length,
          next: next ? { id: next.id, title: next.title, subject: next.subject, due: next.due || '', due_time: next.due_time } : null,
        };
      }),
    });
  });

  // ---------- 作业 ----------
  app.get('/items', (c) => {
    const s = S(c), child = childOf(c);
    if (child === null) return err(c, 400, 'invalid_child', '请选择有效的孩子');
    const items = itemsFor(s, child);
    // 列表只带未完成、置顶和最近 120 天的内容；统计用全部历史在服务端算好。
    const since = isoDate(new Date(Date.now() - 120 * 86400000));
    const recent = c.req.query('all') === '1' ? items : items.filter((i) => !i.done || i.pinned || (i.due || '') >= since || (i.created || '') >= since);
    return c.json({ ok: true, child_id: child, items: appItemsJson(db, recent), prefs: getPrefs(db, child), stats: computeStats(db, items, child) });
  });

  app.get('/items/:id', (c) => {
    const it = getItem(db, Number(c.req.param('id')));
    if (!viewable(S(c), it)) return err(c, 404, 'not_found', '没找到这条内容');
    return c.json({ ok: true, item: appItemJson(db, it) });
  });

  app.post('/items', async (c) => {
    if (contentLength(c) > MAX_FILE_BYTES + 1024 * 1024) return err(c, 413, 'too_large', '单个文件最大 50MB，请压缩或拆分后再登记。');
    const { fields, file } = await readForm(c);
    if (file && file.bytes.length > MAX_FILE_BYTES) return err(c, 413, 'too_large', '单个文件最大 50MB，请压缩或拆分后再登记。');
    const s = S(c);
    const raw = String(fields.child_id ?? '').trim();
    const child = /^\d+$/.test(raw) ? Number(raw) : -1;
    if ((s.role === 'student' && child !== s.child_id) || !getChildren(db).some((x) => x.id === child)) return err(c, 400, 'invalid_child', '请选择有效的孩子');
    if (!(fields.title || '').trim() && !file && !(fields.body || '').trim()) return err(c, 400, 'title_required', '写下作业内容');
    if (fields.subject && !getSubjects(db).includes(fields.subject)) return err(c, 400, 'bad_subject', '学科不存在，请先在管理里添加');
    if (s.role === 'student') { delete fields.visible_at; delete fields.subject_new; }
    fields.kind = fields.kind || 'homework';
    const { id } = createItem(db, cfg.uploadDir, fields, file);
    return c.json({ ok: true, item: appItemJson(db, getItem(db, id)!) }, 201);
  });

  app.patch('/items/:id', async (c) => {
    const s = S(c), it = getItem(db, Number(c.req.param('id')));
    if (!editAllowed(it, s)) return err(c, 404, 'not_found', '没找到这条内容，或者它不属于你的本子');
    const b = await readJson(c);
    if (s.role === 'student') delete b.visible_at;
    const e = updateItem(db, it, b, s);
    if (e) return err(c, 400, 'invalid', e);
    return c.json({ ok: true, item: appItemJson(db, getItem(db, it.id)!) });
  });

  app.delete('/items/:id', (c) => {
    const it = getItem(db, Number(c.req.param('id')));
    if (!editAllowed(it, S(c))) return err(c, 404, 'not_found', '没找到这条内容，或者它不属于你的本子');
    if (it.stored) try { unlinkSync(join(cfg.uploadDir, it.stored)); } catch { /* 文件已经不在 */ }
    tx(db, () => {
      run(db, 'DELETE FROM steps WHERE item_id=?', it.id);
      run(db, 'DELETE FROM focus_sessions WHERE item_id=?', it.id);
      run(db, 'DELETE FROM items WHERE id=?', it.id);
    });
    return c.json({ ok: true });
  });

  /** 明确传入目标状态，重复提交结果一样（离线补发也安全）。共享作业的完成状态所有本子共用，与旧版一致。 */
  app.post('/items/:id/done', async (c) => {
    const s = S(c), it = getItem(db, Number(c.req.param('id')));
    if (!viewable(s, it)) return err(c, 404, 'not_found', '没找到这条内容');
    const b = await readJson(c);
    if (typeof b.done !== 'boolean') return err(c, 400, 'bad_request', 'done 必须是 true 或 false');
    if (!!it.done !== b.done) setDone(db, it.id, b.done);
    if (b.done) run(db, 'UPDATE steps SET done=1 WHERE item_id=?', it.id);
    return c.json({ ok: true, done: b.done, item: appItemJson(db, getItem(db, it.id)!) });
  });

  app.post('/items/:id/steps/:sid', async (c) => {
    const s = S(c), it = getItem(db, Number(c.req.param('id')));
    if (!viewable(s, it)) return err(c, 404, 'not_found', '没找到这条内容');
    const b = await readJson(c);
    if (typeof b.done !== 'boolean') return err(c, 400, 'bad_request', 'done 必须是 true 或 false');
    const r = run(db, 'UPDATE steps SET done=? WHERE id=? AND item_id=?', b.done ? 1 : 0, Number(c.req.param('sid')), it.id);
    if (!r.changes) return err(c, 404, 'not_found', '没有这一步');
    const steps = all(db, 'SELECT done FROM steps WHERE item_id=?', it.id);
    const allDone = steps.length > 0 && steps.every((x) => x.done);
    if (allDone !== !!it.done) setDone(db, it.id, allDone);
    return c.json({ ok: true, item: appItemJson(db, getItem(db, it.id)!) });
  });

  /** 记一次专注。分钟数由客户端按实际计时算好，最多 3 小时。 */
  app.post('/items/:id/focus', async (c) => {
    const s = S(c), it = getItem(db, Number(c.req.param('id')));
    if (!viewable(s, it)) return err(c, 404, 'not_found', '没找到这条内容');
    const b = await readJson(c);
    const minutes = Math.round(Number(b.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 180) return err(c, 400, 'bad_minutes', '专注时长不对');
    const child = s.role === 'student' ? s.child_id : it.child_id || childOf(c, b.child_id) || 0;
    const started = new Date(Number(b.started) || Date.now() - minutes * 60000);
    run(db, 'INSERT INTO focus_sessions (item_id, child_id, started, minutes) VALUES (?,?,?,?)', it.id, child, isoDateTime(started), minutes);
    return c.json({ ok: true, item: appItemJson(db, getItem(db, it.id)!) });
  });

  // ---------- 偏好与统计 ----------
  app.get('/prefs', (c) => {
    const child = childOf(c);
    return child === null ? err(c, 400, 'invalid_child') : c.json({ ok: true, prefs: getPrefs(db, child) });
  });
  app.put('/prefs', async (c) => {
    const child = childOf(c);
    if (child === null) return err(c, 400, 'invalid_child');
    const b = await readJson(c);
    return c.json({ ok: true, prefs: setPrefs(db, child, b) });
  });

  // ---------- 推送 ----------
  app.post('/push/subscribe', async (c) => {
    const b = await readJson(c);
    const sub = b.subscription || {};
    const child = childOf(c, b.child_id);
    if (child === null) return err(c, 400, 'invalid_child');
    if (typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return err(c, 400, 'bad_subscription', '订阅信息不完整');
    run(db, 'INSERT OR REPLACE INTO push_subs VALUES (?,?,?,?,?,?)', sub.endpoint, String(sub.keys.p256dh), String(sub.keys.auth), child, S(c).role, isoDateTime(new Date()));
    return c.json({ ok: true });
  });

  app.post('/push/unsubscribe', async (c) => {
    const b = await readJson(c);
    run(db, 'DELETE FROM push_subs WHERE endpoint=?', String(b.endpoint || ''));
    run(db, 'DELETE FROM push_queue WHERE endpoint=?', String(b.endpoint || ''));
    return c.json({ ok: true });
  });

  /** 立刻发一条真推送，用来确认这台设备能收到。 */
  app.post('/push/test', async (c) => {
    const b = await readJson(c);
    const child = childOf(c, b.child_id);
    if (child === null) return err(c, 400, 'invalid_child');
    const now = new Date(), prefs = getPrefs(db, child);
    const items = filterChild(visibleItems(allItems(db)), child);
    let payload;
    if (b.kind === 'daily') {
      payload = dailyReminder(items, now, prefs.lockDetail) || { title: '今天的作业都写完了', body: '明天见。', url: '/', tag: 'daily' };
    } else {
      const next = items.filter((i) => i.kind === 'homework' && !i.done && dueAt(i.due || '', i.due_time) && dueAt(i.due!, i.due_time)! > now)
        .sort((a, b2) => dueAt(a.due!, a.due_time)!.getTime() - dueAt(b2.due!, b2.due_time)!.getTime())[0];
      payload = next
        ? dueReminder(next, all(db, 'SELECT done FROM steps WHERE item_id=?', next.id), prefs.lockDetail, now)
        : { title: '推送测试', body: '这台设备可以收到作业簿的提醒了。', url: '/', tag: 'test' };
    }
    const sent = await sendToChild(db, makeSender(db, cfg), child, payload);
    return sent ? c.json({ ok: true, sent }) : err(c, 400, 'no_subscription', '这个本子还没有设备打开提醒');
  });

  /** 专注结束提醒：页面切到后台后计时器会停，所以由服务器在结束时刻推一条。同一设备同一 tag 只保留最新一条。 */
  app.post('/push/schedule', async (c) => {
    const b = await readJson(c);
    const at = new Date(Number(b.at_ms));
    const endpoint = String(b.endpoint || '');
    const tag = String(b.tag || 'focus').slice(0, 40);
    if (!one(db, 'SELECT 1 FROM push_subs WHERE endpoint=?', endpoint)) return err(c, 400, 'no_subscription', '这台设备还没有打开提醒');
    if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60000 || at.getTime() > Date.now() + 4 * 3600000) return err(c, 400, 'bad_time');
    const payload = { title: String(b.title || '专注时间到').slice(0, 80), body: String(b.body || '').slice(0, 200), url: String(b.url || '/').startsWith('/') ? String(b.url || '/') : '/', tag };
    tx(db, () => {
      run(db, 'DELETE FROM push_queue WHERE endpoint=? AND tag=? AND sent=0', endpoint, tag);
      run(db, 'INSERT INTO push_queue (endpoint, tag, at, payload) VALUES (?,?,?,?)', endpoint, tag, stamp(at), JSON.stringify(payload));
    });
    return c.json({ ok: true });
  });

  app.post('/push/cancel', async (c) => {
    const b = await readJson(c);
    run(db, 'DELETE FROM push_queue WHERE endpoint=? AND tag=? AND sent=0', String(b.endpoint || ''), String(b.tag || 'focus'));
    return c.json({ ok: true });
  });

  // ---------- 家长管理 ----------
  const admin = new Hono<Env>();
  admin.use('*', async (c, next) => {
    if (S(c).role !== 'parent') return err(c, 403, 'forbidden', '只有家长能管理');
    await next();
  });

  admin.get('/overview', (c) => {
    const counts = new Map(all(db, 'SELECT subject, COUNT(*) AS n FROM items GROUP BY subject').map((r) => [r.subject, Number(r.n)]));
    const perChild = new Map(all(db, 'SELECT child_id, COUNT(*) AS n FROM items GROUP BY child_id').map((r) => [r.child_id, Number(r.n)]));
    return c.json({
      ok: true,
      children: childrenWithPasswordState(db).map((ch) => ({ ...ch, items: perChild.get(ch.id) || 0 })),
      shared_items: perChild.get(0) || 0,
      subjects: getSubjects(db).map((name) => ({ name, items: counts.get(name) || 0 })),
      token: apiTokenStatus(db, cfg),
      upcoming_hidden: allItems(db).filter((i) => isHidden(i)).length,
    });
  });

  admin.post('/children', async (c) => {
    const name = String((await readJson(c)).name || '').trim().slice(0, 30);
    if (!name) return err(c, 400, 'name_required', '写下孩子的名字');
    if (one(db, 'SELECT 1 FROM children WHERE name=?', name)) return err(c, 400, 'duplicate', '已经有这个名字了');
    const { id } = run(db, 'INSERT INTO children (name) VALUES (?)', name);
    return c.json({ ok: true, id }, 201);
  });

  admin.patch('/children/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!one(db, 'SELECT 1 FROM children WHERE id=?', id)) return err(c, 404, 'not_found', '孩子不存在');
    const b = await readJson(c);
    if (b.name !== undefined) {
      const name = String(b.name).trim().slice(0, 30);
      if (!name) return err(c, 400, 'name_required', '名字不能为空');
      const dup = one(db, 'SELECT id FROM children WHERE name=?', name);
      if (dup && dup.id !== id) return err(c, 400, 'duplicate', '已经有这个名字了');
      run(db, 'UPDATE children SET name=? WHERE id=?', name, id);
    }
    if (b.clearPassword === true) {
      run(db, "UPDATE children SET password_hash='' WHERE id=?", id);
      revokeChildSessions(db, id);
    } else if (b.password !== undefined) {
      if (String(b.password).length < 6) return err(c, 400, 'weak_password', '密码至少需要 6 位');
      run(db, 'UPDATE children SET password_hash=? WHERE id=?', passwordHash(String(b.password)), id);
      revokeChildSessions(db, id);
    }
    return c.json({ ok: true });
  });

  /** 删除孩子：他的内容变成共享（不删数据），会话、偏好、推送订阅一并清掉。与旧版一致。 */
  admin.delete('/children/:id', (c) => {
    const id = Number(c.req.param('id'));
    tx(db, () => {
      run(db, 'UPDATE items SET child_id=0 WHERE child_id=?', id);
      revokeChildSessions(db, id);
      run(db, 'DELETE FROM prefs WHERE scope=?', `child:${id}`);
      run(db, 'DELETE FROM push_subs WHERE child_id=?', id);
      run(db, 'DELETE FROM children WHERE id=?', id);
    });
    return c.json({ ok: true });
  });

  admin.post('/subjects', async (c) => {
    const name = String((await readJson(c)).name || '').trim().slice(0, 20);
    if (!name) return err(c, 400, 'name_required', '写下学科名');
    ensureSubject(db, name);
    return c.json({ ok: true, subjects: getSubjects(db) });
  });

  admin.delete('/subjects/:name', (c) => {
    const name = c.req.param('name');
    if (Number(one(db, 'SELECT COUNT(*) AS n FROM items WHERE subject=?', name).n) > 0) return err(c, 400, 'in_use', '这个学科下还有内容，不能删除');
    run(db, 'DELETE FROM subjects WHERE name=?', name);
    return c.json({ ok: true, subjects: getSubjects(db) });
  });

  admin.post('/token', (c) => c.json({ ok: true, token: generateApiToken(db) }));
  admin.delete('/token', (c) => { run(db, 'DELETE FROM api_tokens'); return c.json({ ok: true }); });

  /** 导出全部数据（不含会话、令牌、推送订阅），附件只给路径，用来备份或核对。 */
  admin.get('/export', (c) => {
    c.header('Content-Disposition', `attachment; filename="school-board-${isoDate(new Date())}.json"`);
    return c.json({
      format: 'school-board-export', version: 2, exported: new Date().toISOString(),
      children: getChildren(db), subjects: all(db, 'SELECT * FROM subjects ORDER BY ord, name'),
      items: all(db, 'SELECT * FROM items ORDER BY id'), steps: all(db, 'SELECT * FROM steps ORDER BY item_id, ord'),
      focus_sessions: all(db, 'SELECT * FROM focus_sessions ORDER BY id'), prefs: all(db, 'SELECT * FROM prefs'),
    });
  });

  app.route('/admin', admin);
  return app;
}
