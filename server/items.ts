import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isoDateTime, validDate, validDateTime, validTime } from '../shared/dates.js';
import type { Session } from './auth.js';
import { all, one, run, tx, type DB } from './db.js';

export const KINDS: Record<string, string> = {
  notice: '通知', homework: '作业', material: '学习资料', answer: '答案', listening: '听力', announcement: '提醒',
};
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface ItemRow {
  id: number; title: string; subject: string; kind: string; body: string | null; link_url: string | null;
  filename: string | null; stored: string | null; mime: string | null; created: string; due: string | null;
  visible_at: string | null; pinned: number; done: number; child_id: number;
  due_time: string; est_minutes: number; remind: string; done_at: string;
}
export interface UploadFile { bytes: Buffer; name: string; type: string }

export const nowDT = () => isoDateTime(new Date());

export function safeLink(url: unknown): string {
  const u = String(url ?? '').trim();
  return u.startsWith('http://') || u.startsWith('https://') ? u : '';
}

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/vnd.microsoft.icon',
  '.pdf': 'application/pdf', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.flac': 'audio/flac', '.aac': 'audio/aac', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.txt': 'text/plain', '.csv': 'text/csv', '.html': 'text/html', '.htm': 'text/html',
  '.xml': 'application/xml', '.xhtml': 'application/xhtml+xml', '.json': 'application/json', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/heic': '.heic',
  'image/heif': '.heif', 'image/bmp': '.bmp', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/flac': '.flac', 'video/mp4': '.mp4', 'application/pdf': '.pdf',
};

/** 和 Python os.path.splitext 一样：开头的点不算扩展名。 */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  if (i <= 0 || /^\.+$/.test(name.slice(0, i + 1))) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

export const guessMime = (name: string) => MIME_BY_EXT[splitExt(name)[1].toLowerCase()] || '';

/** 只做路径清理，保留中文、空格和原扩展名。 */
export function originalFilename(name: string): string {
  return (name || '').replace(/\\/g, '/').split('/').pop()!.trim().slice(0, 120);
}

/** 按文件头猜类型：微信图片常没有正经扩展名。 */
export function sniffMime(b: Buffer): string {
  if (!b || !b.length) return '';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === '\x89PNG') return 'image/png';
  if (b.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && ['heic', 'heix', 'hevc', 'hevx'].includes(b.subarray(8, 12).toString('latin1'))) return 'image/heic';
  if (b.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && b[1] === 0xfb)) return 'audio/mpeg';
  return '';
}

/** 返回 [显示文件名, 存盘扩展名, mime]。490.pic_hd 这类假扩展名按真实类型改名。 */
export function normalizeUpload(original: string, bytes: Buffer, partType: string): [string, string, string] {
  const [stem, rawExt] = splitExt(original);
  const ext = rawExt.toLowerCase();
  const guessed = guessMime(original);
  const picLike = /^\.pic(_hd|_th|_mid|_sm)?$/.test(ext);
  if (picLike || !ext || !guessed) {
    const raw = (partType || '').split(';')[0].trim().toLowerCase();
    const mime = EXT_BY_MIME[raw] ? raw : sniffMime(bytes);
    if (EXT_BY_MIME[mime]) return [stem + EXT_BY_MIME[mime], EXT_BY_MIME[mime], mime];
    if (picLike) return [stem, '', ''];
    return [original, ext.replace(/[^a-z0-9.]/g, '').slice(0, 10), guessed];
  }
  return [original, ext.replace(/[^a-z0-9.]/g, '').slice(0, 10), guessed];
}

export const getSubjects = (db: DB): string[] => all(db, 'SELECT name FROM subjects ORDER BY ord, name').map((r) => r.name);
export const getChildren = (db: DB): { id: number; name: string }[] => all(db, 'SELECT id, name FROM children ORDER BY id');

export function ensureSubject(db: DB, name: string): string {
  const n = (name || '').trim() || '其他';
  run(db, 'INSERT OR IGNORE INTO subjects VALUES (?,99)', n);
  return n;
}

export const getItem = (db: DB, id: number): ItemRow | undefined => (Number.isInteger(id) && id > 0 ? one(db, 'SELECT * FROM items WHERE id=?', id) : undefined);
export const allItems = (db: DB): ItemRow[] => all(db, 'SELECT * FROM items ORDER BY pinned DESC, created DESC, id DESC');
export const isHidden = (it: ItemRow, now = nowDT()) => !!it.visible_at && it.visible_at > now;
export const visibleItems = (items: ItemRow[]) => { const now = nowDT(); return items.filter((i) => !isHidden(i, now)); };
export const filterChild = (items: ItemRow[], child: number) => (child ? items.filter((i) => i.child_id === 0 || i.child_id === child) : items);

export function canView(it: ItemRow | undefined, s: Session | null): it is ItemRow {
  if (!it) return false;
  return !s || s.role !== 'student' || it.child_id === 0 || it.child_id === s.child_id;
}

/** 家长都能改；学生只能改自己本子里、已经公开的内容。共享内容（child_id=0）学生不能改删。 */
export function editAllowed(it: ItemRow | undefined, s: Session | null): it is ItemRow {
  if (!it || !s) return false;
  if (s.role === 'parent') return true;
  return s.role === 'student' && it.child_id === s.child_id && !isHidden(it);
}

export function parseSteps(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split('\n'); } catch { list = raw.split('\n'); }
  }
  if (!Array.isArray(list)) return [];
  return list.map((s) => String(typeof s === 'object' && s ? (s as any).text ?? '' : s ?? '').trim().slice(0, 200)).filter(Boolean).slice(0, 30);
}

/**
 * 新建条目，规则与旧版 create_item 一致：标题不填用文件名，再不行用正文首行或“未命名”；
 * 不填类型时音频算听力、PDF 算学习资料，其余算通知。另外接受新字段 due_time / est_minutes / remind / steps。
 */
export function createItem(db: DB, uploadDir: string, f: Record<string, string>, file?: UploadFile): { id: number; title: string } {
  let original = originalFilename(file?.name || '');
  let storedExt = '', mime = '';
  if (file && file.bytes.length) [original, storedExt, mime] = normalizeUpload(original, file.bytes, file.type);
  const stem = splitExt(original)[0].trim();
  const title = (f.title || '').trim() || stem || (f.body || '').trim().split('\n')[0].slice(0, 30).trim() || '未命名';
  const subject = ensureSubject(db, (f.subject_new || '').trim() || (f.subject || '').trim() || '其他');
  const childId = Number.parseInt(f.child_id || f.child || '0', 10) || 0;
  let stored = '';
  if (file && file.bytes.length) {
    stored = randomBytes(8).toString('hex') + storedExt;
    writeFileSync(join(uploadDir, stored), file.bytes);
    mime = mime || guessMime(original);
  }
  let kind = (f.kind || '').trim();
  if (!kind) {
    const ext = splitExt(original)[1].toLowerCase();
    if (mime.startsWith('audio/') || ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'].includes(ext)) kind = 'listening';
    else if (mime === 'application/pdf' || ext === '.pdf') kind = 'material';
    else kind = 'notice';
  }
  const dueTime = validTime(f.due_time || '') ? f.due_time : '';
  const est = Math.min(600, Math.max(0, Number.parseInt(f.est_minutes || '0', 10) || 0));
  const remind = ['off', '60', '120', '180', 'eve'].includes(f.remind || '') ? f.remind : '';
  const steps = parseSteps(f.steps);
  return tx(db, () => {
    const { id } = run(db,
      `INSERT INTO items (title,subject,kind,body,link_url,filename,stored,mime,created,due,visible_at,pinned,child_id,due_time,est_minutes,remind)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      title, subject, kind, f.body || '', safeLink(f.link_url), original, stored, mime, nowDT(),
      f.due || '', f.visible_at || '', f.pinned ? 1 : 0, childId, dueTime, est, remind);
    steps.forEach((text, i) => run(db, 'INSERT INTO steps (item_id, ord, text) VALUES (?,?,?)', id, i, text));
    return { id, title };
  });
}

export interface ItemPatch {
  title?: string; subject?: string; kind?: string; body?: string; link_url?: string; due?: string; due_time?: string;
  visible_at?: string; pinned?: boolean; est_minutes?: number; remind?: string; child_id?: number; steps?: unknown;
}

/** 校验并保存修改，返回错误文字（没有错误返回空字符串）。规则同旧版编辑页。 */
export function updateItem(db: DB, it: ItemRow, p: ItemPatch, s: Session): string {
  const next = {
    title: p.title !== undefined ? String(p.title).trim() : it.title,
    subject: p.subject ?? it.subject,
    kind: p.kind ?? it.kind,
    body: p.body ?? it.body ?? '',
    link_url: p.link_url !== undefined ? safeLink(p.link_url) : it.link_url || '',
    due: p.due !== undefined ? String(p.due).trim() : it.due || '',
    due_time: p.due_time !== undefined ? String(p.due_time).trim() : it.due_time || '',
    visible_at: p.visible_at !== undefined ? String(p.visible_at).trim() : it.visible_at || '',
    pinned: p.pinned !== undefined ? (p.pinned ? 1 : 0) : it.pinned,
    est_minutes: p.est_minutes !== undefined ? Math.min(600, Math.max(0, Math.round(Number(p.est_minutes) || 0))) : it.est_minutes,
    remind: p.remind ?? it.remind ?? '',
    child_id: it.child_id,
  };
  if (p.child_id !== undefined && p.child_id !== it.child_id) {
    if (s.role !== 'parent') return '不能把作业移到别的本子。';
    if (!getChildren(db).some((c) => c.id === p.child_id)) return '归属孩子不存在，未保存。';
    next.child_id = Number(p.child_id);
  }
  if (!next.title) return '标题不能为空，未保存。';
  if (!getSubjects(db).includes(next.subject)) return '学科不存在，未保存。';
  if (!KINDS[next.kind]) return '类型不存在，未保存。';
  if (!validDate(next.due)) return '截止日期格式不对，未保存。';
  if (next.due_time && !validTime(next.due_time)) return '截止时间格式不对，未保存。';
  if (next.visible_at && !validDateTime(next.visible_at)) return '显示时间格式不对，未保存。';
  if (next.remind && !['off', '60', '120', '180', 'eve'].includes(next.remind)) return '提醒设置不对，未保存。';
  tx(db, () => {
    run(db, `UPDATE items SET title=?, subject=?, kind=?, body=?, link_url=?, due=?, due_time=?, visible_at=?, pinned=?,
             est_minutes=?, remind=?, child_id=? WHERE id=?`,
      next.title, next.subject, next.kind, next.body, next.link_url, next.due, next.due_time, next.visible_at,
      next.pinned, next.est_minutes, next.remind, next.child_id, it.id);
    if (p.steps !== undefined) replaceSteps(db, it.id, p.steps);
  });
  return '';
}

/** 用新的步骤列表替换旧的；文字相同的步骤保留原来的完成状态。 */
export function replaceSteps(db: DB, itemId: number, raw: unknown) {
  const old = all(db, 'SELECT text, done FROM steps WHERE item_id=?', itemId);
  const doneByText = new Map<string, number>(old.map((s) => [s.text, s.done]));
  run(db, 'DELETE FROM steps WHERE item_id=?', itemId);
  parseSteps(raw).forEach((text, i) => run(db, 'INSERT INTO steps (item_id, ord, text, done) VALUES (?,?,?,?)', itemId, i, text, doneByText.get(text) || 0));
}

export function setDone(db: DB, id: number, done: boolean) {
  run(db, 'UPDATE items SET done=?, done_at=? WHERE id=?', done ? 1 : 0, done ? nowDT() : '', id);
}

export const fileUrl = (it: ItemRow) => (it.stored ? '/uploads/' + encodeURIComponent(it.stored) : '');

/** 旧版 GET /api/items 的返回格式，字段一个不多、一个不少。 */
export function legacyItemJson(i: ItemRow) {
  return {
    id: i.id, title: i.title, subject: i.subject, kind: i.kind, body: i.body, link_url: i.link_url,
    filename: i.filename, file_url: fileUrl(i), due: i.due, done: !!i.done, child_id: i.child_id ?? 0, url: `/item?id=${i.id}`,
  };
}

type Extra = { steps: Map<number, { id: number; text: string; done: boolean }[]>; focus: Map<number, number> };

/** 一次查出一批条目的步骤和专注时长，避免每条各查两次。 */
function extrasFor(db: DB, ids: number[]): Extra {
  const steps = new Map<number, { id: number; text: string; done: boolean }[]>();
  const focus = new Map<number, number>();
  for (let k = 0; k < ids.length; k += 500) {
    const chunk = ids.slice(k, k + 500), q = chunk.map(() => '?').join(',');
    if (!chunk.length) continue;
    for (const s of all(db, `SELECT id, item_id, text, done FROM steps WHERE item_id IN (${q}) ORDER BY ord, id`, ...chunk)) {
      if (!steps.has(s.item_id)) steps.set(s.item_id, []);
      steps.get(s.item_id)!.push({ id: s.id, text: s.text, done: !!s.done });
    }
    for (const f of all(db, `SELECT item_id, SUM(minutes) AS m FROM focus_sessions WHERE item_id IN (${q}) GROUP BY item_id`, ...chunk)) focus.set(f.item_id, Number(f.m));
  }
  return { steps, focus };
}

export const appItemsJson = (db: DB, items: ItemRow[]) => {
  const ex = extrasFor(db, items.map((i) => i.id));
  return items.map((i) => appItemJson(db, i, ex));
};

/** 新界面用的完整格式：带步骤、专注时长和是否尚未公开。 */
export function appItemJson(db: DB, i: ItemRow, ex: Extra = extrasFor(db, [i.id])) {
  const steps = ex.steps.get(i.id) || [];
  const focus = ex.focus.get(i.id) || 0;
  return {
    id: i.id, title: i.title, subject: i.subject, kind: i.kind, body: i.body || '', link_url: i.link_url || '',
    filename: i.filename || '', file_url: fileUrl(i), mime: i.mime || guessMime(i.stored || ''), created: i.created,
    due: validDate(i.due || '') ? i.due || '' : '', due_raw: i.due || '', due_time: i.due_time || '', visible_at: i.visible_at || '',
    hidden: isHidden(i), pinned: !!i.pinned, done: !!i.done, done_at: i.done_at || '', child_id: i.child_id ?? 0,
    shared: (i.child_id ?? 0) === 0, est_minutes: i.est_minutes || 0, remind: i.remind || '', focus_minutes: focus, steps,
  };
}
export type AppItem = ReturnType<typeof appItemJson>;
