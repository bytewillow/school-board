import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;
export const SCHEMA_VERSION = '2';
export const DEFAULT_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '道法', '历史', '地理'];

// node:sqlite 的结果是宽松对象，这里统一成 any，具体字段由调用方约定。
export const one = (db: DB, sql: string, ...args: unknown[]): any => db.prepare(sql).get(...(args as never[]));
export const all = (db: DB, sql: string, ...args: unknown[]): any[] => db.prepare(sql).all(...(args as never[])) as any[];
export function run(db: DB, sql: string, ...args: unknown[]): { changes: number; id: number } {
  const r = db.prepare(sql).run(...(args as never[]));
  return { changes: Number(r.changes), id: Number(r.lastInsertRowid) };
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const columns = (db: DB, table: string): string[] => all(db, `PRAGMA table_info(${table})`).map((r) => r.name);
function addColumn(db: DB, table: string, col: string, def: string) {
  if (!columns(db, table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}

/**
 * 只做加法：旧表、旧列一个不删不改，旧版 app.py 仍能直接读这个库（回滚安全）。
 * v2 新增：items.due_time / est_minutes / remind / done_at，以及步骤、专注、偏好、推送相关的新表。
 */
export function migrate(db: DB) {
  db.exec(`CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '其他', kind TEXT NOT NULL DEFAULT 'notice',
    body TEXT DEFAULT '', link_url TEXT DEFAULT '',
    filename TEXT DEFAULT '', stored TEXT DEFAULT '', mime TEXT DEFAULT '',
    created TEXT NOT NULL, due TEXT DEFAULT '', visible_at TEXT DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0,
    child_id INTEGER NOT NULL DEFAULT 0)`);
  addColumn(db, 'items', 'child_id', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE TABLE IF NOT EXISTS subjects (name TEXT PRIMARY KEY, ord INTEGER)');
  db.exec('CREATE TABLE IF NOT EXISTS children (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL)');
  addColumn(db, 'children', 'password_hash', "TEXT DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, role TEXT NOT NULL,
    child_id INTEGER NOT NULL DEFAULT 0, created TEXT NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS api_tokens (token_hash TEXT PRIMARY KEY, created TEXT NOT NULL)');

  // ---- v2 ----
  addColumn(db, 'items', 'due_time', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'items', 'est_minutes', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'items', 'remind', "TEXT NOT NULL DEFAULT ''");
  addColumn(db, 'items', 'done_at', "TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    ord INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE INDEX IF NOT EXISTS steps_item ON steps(item_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS focus_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL,
    child_id INTEGER NOT NULL DEFAULT 0, started TEXT NOT NULL, minutes INTEGER NOT NULL)`);
  db.exec('CREATE INDEX IF NOT EXISTS focus_child ON focus_sessions(child_id, started)');
  db.exec('CREATE TABLE IF NOT EXISTS prefs (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key))');
  db.exec(`CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
    child_id INTEGER NOT NULL, role TEXT NOT NULL, created TEXT NOT NULL)`);
  db.exec('CREATE TABLE IF NOT EXISTS push_log (key TEXT PRIMARY KEY, sent TEXT NOT NULL)');
  db.exec(`CREATE TABLE IF NOT EXISTS push_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint TEXT NOT NULL, tag TEXT NOT NULL,
    at TEXT NOT NULL, payload TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0)`);
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  run(db, "INSERT OR REPLACE INTO meta VALUES ('schema_version', ?)", SCHEMA_VERSION);
}

/** 与旧版 init_db 一致：默认学科总在、排在前面，其余学科排后面。 */
export function seedSubjects(db: DB) {
  DEFAULT_SUBJECTS.forEach((s, i) => {
    run(db, 'INSERT OR IGNORE INTO subjects VALUES (?,?)', s, i);
    run(db, 'UPDATE subjects SET ord=? WHERE name=?', i, s);
  });
  run(db, `UPDATE subjects SET ord=99 WHERE name NOT IN (${DEFAULT_SUBJECTS.map(() => '?').join(',')})`, ...DEFAULT_SUBJECTS);
  for (const r of all(db, 'SELECT DISTINCT subject FROM items')) run(db, 'INSERT OR IGNORE INTO subjects VALUES (?,99)', r.subject);
}

/** 打开数据库。第一次在旧库上运行时，先在同目录留一份 board.db.v1-backup。 */
export function openDb(path: string): DB {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const probe = new DatabaseSync(path);
    let version = '';
    try {
      version = (probe.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as any)?.value || '';
    } catch {
      version = '';
    }
    const hasItems = !!probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='items'").get();
    probe.close();
    const backup = path + '.v1-backup';
    if (hasItems && !version && !existsSync(backup)) copyFileSync(path, backup);
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec('PRAGMA journal_mode=WAL');
  migrate(db);
  seedSubjects(db);
  return db;
}
