import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { isoDateTime, pad, parseDateTime } from '../shared/dates.js';
import type { Config } from './config.js';
import { all, one, run, type DB } from './db.js';

export interface Session { role: 'parent' | 'student'; child_id: number }
export const SESSION_DAYS = 30;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** 与旧版相同的格式：16 字节随机 salt + PBKDF2-HMAC-SHA256 20 万次，存 salt_hex:hash_hex。 */
export function passwordHash(password: string): string {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + pbkdf2Sync(password, salt, 200000, 32, 'sha256').toString('hex');
}

export function passwordMatches(password: string, stored: string): boolean {
  const [salt, expected] = (stored || '').split(':');
  if (!salt || !expected || !/^[0-9a-f]+$/i.test(salt) || !/^[0-9a-f]+$/i.test(expected)) return false;
  const got = pbkdf2Sync(password, Buffer.from(salt, 'hex'), 200000, 32, 'sha256');
  const want = Buffer.from(expected, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** 找不到名字时也走一次同样耗时的计算，不让人从响应时间猜出孩子名单。 */
export const DUMMY_HASH = '00'.repeat(16) + ':' + '00'.repeat(32);

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 沿用旧版的 sb_session cookie 和 sessions 表：升级后已登录的设备不用重新登录。 */
export function getSession(c: Context, db: DB, cfg: Config): Session | null {
  const legacy = getCookie(c, 'admin');
  if (legacy && safeEqual(legacy, sha256(cfg.adminPassword))) return { role: 'parent', child_id: 0 };
  const token = getCookie(c, 'sb_session');
  if (!token) return null;
  const hashed = sha256(token);
  const row = one(db, 'SELECT * FROM sessions WHERE token_hash=?', hashed);
  if (!row) return null;
  // 旧版存的是本地时间 isoformat（可能带微秒），按本地时间解析。
  const created = parseDateTime(row.created);
  let valid = !!created && created.getTime() > Date.now() - SESSION_DAYS * 86400000;
  if (row.role === 'parent') valid = valid && row.child_id === 0;
  else if (row.role === 'student') valid = valid && !!one(db, "SELECT 1 FROM children WHERE id=? AND password_hash != ''", row.child_id);
  else valid = false;
  if (!valid) {
    run(db, 'DELETE FROM sessions WHERE token_hash=?', hashed);
    return null;
  }
  return { role: row.role, child_id: row.child_id };
}

function secureFlag(c: Context) {
  // 只在可信反向代理后面使用这个头；不要把后端直接暴露给能伪造转发头的客户端。
  return (c.req.header('x-forwarded-proto') || '').toLowerCase() === 'https' ? '; Secure' : '';
}

export function sessionCookie(c: Context, token: string, clear = false): string {
  return `sb_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_DAYS * 86400}` + secureFlag(c);
}

export function revokeSession(c: Context, db: DB) {
  const token = getCookie(c, 'sb_session');
  if (token) run(db, 'DELETE FROM sessions WHERE token_hash=?', sha256(token));
}

export function startSession(c: Context, db: DB, role: Session['role'], childId = 0): string {
  revokeSession(c, db);
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  run(db, 'INSERT INTO sessions VALUES (?,?,?,?)', sha256(token), role, childId, isoDateTime(now) + ':' + pad(now.getSeconds()));
  return sessionCookie(c, token);
}

// ---- 外部 API 令牌（环境变量 API_TOKEN，或管理页生成、库里只存哈希） ----
export function hasAnyApiToken(db: DB, cfg: Config): boolean {
  return !!cfg.apiToken || Number(one(db, 'SELECT COUNT(*) AS n FROM api_tokens').n) > 0;
}

export function apiTokenOk(db: DB, cfg: Config, token: string): boolean {
  if (!token) return false;
  if (cfg.apiToken && safeEqual(token, cfg.apiToken)) return true;
  return !!one(db, 'SELECT 1 FROM api_tokens WHERE token_hash=?', sha256(token));
}

export function generateApiToken(db: DB): string {
  const token = 'sb_' + randomBytes(24).toString('base64url');
  run(db, 'DELETE FROM api_tokens');
  run(db, 'INSERT INTO api_tokens VALUES (?,?)', sha256(token), isoDateTime(new Date()));
  return token;
}

export function apiTokenStatus(db: DB, cfg: Config) {
  const row = one(db, 'SELECT created FROM api_tokens ORDER BY created DESC LIMIT 1');
  return { env: !!cfg.apiToken, created: row?.created || '' };
}

export function revokeChildSessions(db: DB, childId: number) {
  run(db, 'DELETE FROM sessions WHERE child_id=? AND role=?', childId, 'student');
}

export const childrenWithPasswordState = (db: DB) =>
  all(db, 'SELECT id, name, password_hash FROM children ORDER BY id').map((c) => ({ id: c.id, name: c.name, has_password: !!c.password_hash }));
