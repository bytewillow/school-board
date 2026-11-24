import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isoDateTime } from '../shared/dates.js';
import { all, one, run, tx, type DB } from './db.js';
import { ensureSubject } from './items.js';

export interface ImportReport { children: number; subjects: number; items: number; files: number; skipped: number; notes: string[] }

/**
 * 把另一份旧版（或新版）数据目录合并进当前库：孩子按名字合并，学科按名字合并，条目全部追加并改到对应孩子，附件按文件名复制。
 * 不导入会话和 API 令牌（换服务器后请重新登录、重新生成令牌）。同一份数据重复导入会被识别并跳过。
 */
export function importDataDir(db: DB, uploadDir: string, fromDir: string): ImportReport {
  const report: ImportReport = { children: 0, subjects: 0, items: 0, files: 0, skipped: 0, notes: [] };
  const srcDb = join(fromDir, 'board.db');
  if (!existsSync(srcDb)) throw new Error(`找不到 ${srcDb}`);
  const src = new DatabaseSync(srcDb, { readOnly: true });
  const cols = (t: string) => new Set((src.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((r) => r.name));
  const itemCols = cols('items');
  const has = (t: string) => !!src.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);

  tx(db, () => {
    const childMap = new Map<number, number>([[0, 0]]);
    if (has('children')) {
      const childCols = cols('children');
      for (const ch of src.prepare('SELECT * FROM children ORDER BY id').all() as any[]) {
        const existing = one(db, 'SELECT id, password_hash FROM children WHERE name=?', ch.name);
        if (existing) {
          childMap.set(ch.id, existing.id);
          if (!existing.password_hash && childCols.has('password_hash') && ch.password_hash) run(db, 'UPDATE children SET password_hash=? WHERE id=?', ch.password_hash, existing.id);
        } else {
          const { id } = run(db, 'INSERT INTO children (name, password_hash) VALUES (?,?)', ch.name, childCols.has('password_hash') ? ch.password_hash || '' : '');
          childMap.set(ch.id, id);
          report.children++;
        }
      }
    }
    if (has('subjects')) {
      for (const s of src.prepare('SELECT name FROM subjects').all() as any[]) {
        if (!one(db, 'SELECT 1 FROM subjects WHERE name=?', s.name)) report.subjects++;
        ensureSubject(db, s.name);
      }
    }
    const stepsBy = new Map<number, any[]>();
    if (has('steps')) for (const st of src.prepare('SELECT * FROM steps ORDER BY item_id, ord, id').all() as any[]) {
      if (!stepsBy.has(st.item_id)) stepsBy.set(st.item_id, []);
      stepsBy.get(st.item_id)!.push(st);
    }
    const get = (r: any, k: string, d: unknown) => (itemCols.has(k) && r[k] !== null && r[k] !== undefined ? r[k] : d);
    for (const r of src.prepare('SELECT * FROM items ORDER BY id').all() as any[]) {
      const child = childMap.get(get(r, 'child_id', 0)) ?? 0;
      if (get(r, 'child_id', 0) && !childMap.has(get(r, 'child_id', 0))) report.notes.push(`条目 ${r.id} 的孩子已不存在，导入为共享`);
      const dup = one(db, 'SELECT id FROM items WHERE title=? AND created=? AND subject=? AND child_id=? AND stored=?', r.title, r.created, r.subject, child, r.stored || '');
      if (dup) { report.skipped++; continue; }
      ensureSubject(db, r.subject || '其他');
      const { id } = run(db,
        `INSERT INTO items (title,subject,kind,body,link_url,filename,stored,mime,created,due,visible_at,pinned,done,child_id,due_time,est_minutes,remind,done_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        r.title, r.subject || '其他', r.kind || 'notice', r.body || '', r.link_url || '', r.filename || '', r.stored || '', r.mime || '',
        r.created, r.due || '', r.visible_at || '', r.pinned ? 1 : 0, r.done ? 1 : 0, child,
        get(r, 'due_time', ''), get(r, 'est_minutes', 0), get(r, 'remind', ''), get(r, 'done_at', ''));
      (stepsBy.get(r.id) || []).forEach((st, i) => run(db, 'INSERT INTO steps (item_id, ord, text, done) VALUES (?,?,?,?)', id, i, st.text, st.done ? 1 : 0));
      report.items++;
    }
  });
  src.close();

  const fromUploads = join(fromDir, 'uploads');
  if (existsSync(fromUploads)) {
    mkdirSync(uploadDir, { recursive: true });
    for (const name of readdirSync(fromUploads)) {
      const to = join(uploadDir, name);
      if (existsSync(to)) continue;
      copyFileSync(join(fromUploads, name), to);
      report.files++;
    }
  }
  const missing = all(db, "SELECT stored FROM items WHERE stored != ''").filter((r) => !existsSync(join(uploadDir, r.stored))).length;
  if (missing) report.notes.push(`有 ${missing} 个附件文件找不到，对应条目仍保留，只是打不开附件`);
  return report;
}

/**
 * 从另一台正在运行的旧版服务器导入（只能拿到 API 公开的字段）：GET /api/lists + /api/items，附件需要家长登录 cookie 才能下载。
 * 拿不到的字段：显示时间（未公开的条目 API 不返回）、置顶、创建时间（用导入时间）。
 */
export async function importFromServer(db: DB, uploadDir: string, base: string, token: string, cookie: string, fetchImpl: typeof fetch = fetch): Promise<ImportReport> {
  const report: ImportReport = { children: 0, subjects: 0, items: 0, files: 0, skipped: 0, notes: [] };
  const headers: Record<string, string> = {};
  if (token) headers['X-API-Token'] = token;
  if (cookie) headers.Cookie = cookie;
  const get = async (p: string) => {
    const r = await fetchImpl(base.replace(/\/+$/, '') + p, { headers });
    if (!r.ok) throw new Error(`${p} 返回 ${r.status}`);
    return r;
  };
  const lists: any = await (await get('/api/lists')).json();
  const items: any = await (await get('/api/items')).json();
  const childMap = new Map<number, number>([[0, 0]]);
  for (const ch of lists.children || []) {
    const ex = one(db, 'SELECT id FROM children WHERE name=?', ch.name);
    if (ex) childMap.set(ch.id, ex.id);
    else { childMap.set(ch.id, run(db, 'INSERT INTO children (name) VALUES (?)', ch.name).id); report.children++; }
  }
  for (const s of lists.subjects || []) {
    if (!one(db, 'SELECT 1 FROM subjects WHERE name=?', s)) report.subjects++;
    ensureSubject(db, s);
  }
  const now = isoDateTime(new Date());
  for (const it of (items.items || []).slice().reverse()) {
    let stored = '';
    if (it.file_url) {
      stored = decodeURIComponent(String(it.file_url).replace(/^\/uploads\//, ''));
      if (!/^[\w.-]+$/.test(stored)) stored = '';
      else if (!existsSync(join(uploadDir, stored))) {
        if (!cookie) { report.notes.push(`《${it.title}》的附件需要 --cookie 才能下载，已跳过附件`); stored = ''; }
        else {
          try {
            const r = await get(it.file_url);
            mkdirSync(uploadDir, { recursive: true });
            writeFileSync(join(uploadDir, stored), Buffer.from(await r.arrayBuffer()));
            report.files++;
          } catch (e) { report.notes.push(`《${it.title}》的附件下载失败：${(e as Error).message}`); stored = ''; }
        }
      }
    }
    const child = childMap.get(Number(it.child_id) || 0) ?? 0;
    if (one(db, 'SELECT 1 FROM items WHERE title=? AND subject=? AND child_id=? AND due=? AND stored=?', it.title, it.subject, child, it.due || '', stored)) { report.skipped++; continue; }
    run(db, `INSERT INTO items (title,subject,kind,body,link_url,filename,stored,mime,created,due,visible_at,pinned,done,child_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      it.title, it.subject, it.kind || 'notice', it.body || '', it.link_url || '', it.filename || '', stored, '', now, it.due || '', '', 0, it.done ? 1 : 0, child);
    report.items++;
  }
  report.notes.push('通过 API 导入拿不到显示时间、置顶和原创建时间；还没到显示时间的条目 API 不返回，也不会被导入。');
  return report;
}
