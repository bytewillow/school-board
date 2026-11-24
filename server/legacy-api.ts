import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { callLlmParse, validateDraft } from './ai.js';
import { apiTokenOk, hasAnyApiToken } from './auth.js';
import type { Config } from './config.js';
import { all, type DB } from './db.js';
import { contentLength, err, readForm, readJson, type Env } from './http.js';
import {
  allItems, canView, createItem, filterChild, getChildren, getSubjects, guessMime, isHidden, KINDS, legacyItemJson,
  MAX_FILE_BYTES, visibleItems, type ItemRow,
} from './items.js';

/**
 * 对外接口，保持与旧版 app.py 一致：/api、/api/lists、/api/items、/api/ai-parse、/api/ai-batch、/uploads/*、/health。
 */
export function legacyApi(db: DB, cfg: Config) {
  const app = new Hono<Env>();

  const tokenGate = (c: any) => {
    if (!hasAnyApiToken(db, cfg)) return null; // 没配置任何令牌：保留旧版的局域网匿名模式
    const token = c.req.header('x-api-token') || c.req.query('token') || '';
    return apiTokenOk(db, cfg, token) ? null : err(c, 401, 'unauthorized');
  };

  /** 新登记必须属于一个真实存在的孩子；学生只能给自己登记。令牌接口不看会话。 */
  const validEntryChild = (c: any, fields: { child_id?: unknown; child?: unknown }, tokenApi = false) => {
    const raw = String(fields.child_id ?? fields.child ?? '0').trim() || '0';
    if (!/^-?\d+$/.test(raw)) return false;
    const child = Number(raw);
    const s = c.get('session');
    if (!tokenApi && s?.role === 'student' && child !== s.child_id) return false;
    return getChildren(db).some((x) => x.id === child);
  };

  app.get('/health', (c) => c.text('ok'));

  app.get('/api', (c) => c.json({
    ok: true, post: '/api/items', lists: '/api/lists',
    ai_parse: '/api/ai-parse (login session required)',
    ai_batch: '/api/ai-batch (login session required)',
    fields: 'title(可选，不填用文件名), subject, subject_new, kind(不填时：音频->听力，PDF->学习资料，其余->通知), body, link_url, due, visible_at, pinned, child_id；可选扩展：due_time(HH:MM), est_minutes, steps(JSON 数组或按行分隔)',
    example: 'curl -F "file=@数学练习.pdf" -F "subject=数学" -F "child_id=1" http://HOST:8765/api/items',
  }));

  app.get('/api/lists', (c) => tokenGate(c) || c.json({
    ok: true,
    children: getChildren(db).map((x) => ({ id: x.id, name: x.name })),
    subjects: getSubjects(db),
    kinds: Object.entries(KINDS).map(([code, label]) => ({ code, label })),
  }));

  app.get('/api/items', (c) => {
    const denied = tokenGate(c);
    if (denied) return denied;
    const child = /^-?\d+$/.test(c.req.query('child') || '') ? Number(c.req.query('child')) : 0;
    let items = filterChild(visibleItems(allItems(db)), child);
    const subject = c.req.query('subject') || '';
    if (subject) items = items.filter((i) => i.subject === subject);
    return c.json({ ok: true, items: items.map(legacyItemJson) });
  });

  app.post('/api/items', async (c) => {
    const denied = tokenGate(c);
    if (denied) return denied;
    if (contentLength(c) > MAX_FILE_BYTES + 1024 * 1024) return err(c, 413, 'file too large, max 50MB');
    const { fields, file } = await readForm(c);
    if (file && file.bytes.length > MAX_FILE_BYTES) return err(c, 413, 'file too large, max 50MB');
    if (!validEntryChild(c, fields, true)) return err(c, 400, 'invalid_child', '请选择有效的孩子；新登记不再支持共享。');
    const { id, title } = createItem(db, cfg.uploadDir, fields, file);
    return c.json({ ok: true, id, title, url: `/item?id=${id}` }, 201);
  });

  const needSession = async (c: any, next: () => Promise<void>) => {
    if (!c.get('session')) return err(c, 401, 'unauthorized');
    await next();
  };
  app.use('/api/ai-parse', needSession);
  app.use('/api/ai-batch', needSession);

  const parseCtx = (c: any, defaultChild: number | null) => {
    const s = c.get('session');
    const children = getChildren(db);
    return { cfg, subjects: getSubjects(db), children: s?.role === 'student' ? children.filter((x) => x.id === s.child_id) : children, defaultChild };
  };

  app.post('/api/ai-parse', async (c) => {
    if (contentLength(c) > MAX_FILE_BYTES + 1024 * 1024) return err(c, 413, 'image too large, max 10MB');
    const { fields, file } = await readForm(c);
    if (!validEntryChild(c, fields)) return err(c, 400, 'invalid_child', '请选择有效的孩子，再解析作业。');
    const text = (fields.text || '').trim();
    if (file && file.bytes.length > 10 * 1024 * 1024) return err(c, 413, 'image too large, max 10MB');
    if (!text && !file) return err(c, 400, 'empty input');
    const r = await callLlmParse(text, file ? { bytes: file.bytes, type: file.type } : null, parseCtx(c, Number(fields.child_id || fields.child)));
    if (!r.ok) return err(c, r.error === 'llm_not_configured' ? 503 : 502, r.error, r.message);
    return c.json({ ok: true, drafts: r.value });
  });

  app.post('/api/ai-batch', async (c) => {
    const raw = await readJson(c);
    const drafts = raw.drafts;
    if (!Array.isArray(drafts) || !drafts.length) return err(c, 400, 'empty drafts');
    const subjects = getSubjects(db), children = getChildren(db);
    const created: unknown[] = [], failed: unknown[] = [];
    drafts.forEach((rd, index) => {
      const d = validateDraft(rd, subjects, children, 0);
      if (!validEntryChild(c, d)) return failed.push({ index, draft: d, error: 'invalid_child', message: '请选择有效的孩子；新登记不再支持共享。' });
      if (!d.subject) return failed.push({ index, draft: d, error: 'subject required', message: '请选择学科' });
      const { id, title } = createItem(db, cfg.uploadDir, { title: d.title, subject: d.subject, kind: d.kind, child_id: String(d.child_id), due: d.due, body: d.body });
      created.push({ index, id, title });
    });
    return c.json({ ok: true, created, failed });
  });

  /** 附件：需要登录；学生只能拿自己本子或共享、已公开的附件。支持 Range，方便音频拖动。 */
  app.get('/uploads/*', (c) => {
    const s = c.get('session');
    if (!s) return c.redirect('/login', 303);
    let name = '';
    try { name = decodeURIComponent(new URL(c.req.url).pathname.slice('/uploads/'.length)); } catch { name = ''; }
    const path = join(cfg.uploadDir, name);
    const missing = () => c.json({ ok: false, error: 'not_found', message: '这个附件可能已被删除，回到首页重新找一下。' }, 404);
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || !existsSync(path) || !statSync(path).isFile()) return missing();
    const owners = all(db, 'SELECT * FROM items WHERE stored=?', name) as ItemRow[];
    if (s.role === 'student' && !owners.some((r) => canView(r, s) && !isHidden(r))) return missing();
    const mime = guessMime(name) || 'application/octet-stream';
    const size = statSync(path).size;
    let start = 0, end = size - 1, partial = false;
    const range = c.req.header('range') || '';
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      let valid = !!m && !!(m[1] || m[2]) && size > 0;
      if (valid && m) {
        const [, left, right] = m;
        start = left ? Number(left) : Math.max(0, size - Number(right));
        end = left && right ? Math.min(size - 1, Number(right)) : size - 1;
        valid = start <= end && start < size && (!!left || Number(right) > 0);
      }
      if (!valid) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } });
      partial = true;
    }
    const headers: Record<string, string> = {
      'Content-Type': mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1),
    };
    if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    const risky = ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/xml', 'text/xml'].includes(mime);
    if (c.req.query('download') || risky) {
      headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
      const original = owners[0]?.filename;
      if (original) headers['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(original);
    }
    if (c.req.method === 'HEAD' || size === 0) return new Response(null, { status: partial ? 206 : 200, headers });
    const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
    return new Response(stream, { status: partial ? 206 : 200, headers });
  });

  return app;
}
