import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { passwordHash } from '../server/auth.js';
import { loadConfig } from '../server/config.js';
import { openDb, run } from '../server/db.js';

export const ORIGIN = 'http://board.test';

/** 每个测试一份隔离的临时数据目录。名字、密码都是虚构的。 */
export function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sb-test-'));
  const cfg = loadConfig({ DATA_DIR: dir, ADMIN_PASSWORD: 'parent-pass', SCHEDULER: '0', WEB_DIR: join(dir, 'web'), ...env } as NodeJS.ProcessEnv);
  mkdirSync(cfg.uploadDir, { recursive: true });
  const db = openDb(cfg.dbPath);
  const app = createApp(db, cfg);
  const req = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Host', 'board.test');
    if (init.cookie) headers.set('Cookie', init.cookie);
    return app.request(ORIGIN + path, { ...init, headers });
  };
  const json = (path: string, body: unknown, init: RequestInit & { cookie?: string } = {}) =>
    req(path, { method: 'POST', ...init, headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) }, body: JSON.stringify(body) });
  const addChild = (name: string, password = '') => run(db, 'INSERT INTO children (name, password_hash) VALUES (?,?)', name, password ? passwordHash(password) : '').id;
  const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
  const loginParent = async () => cookieOf(await json('/app-api/admin-login', { password: 'parent-pass' }));
  const loginStudent = async (name: string, password: string) => cookieOf(await json('/app-api/login', { name, password }));
  return { dir, cfg, db, app, req, json, addChild, cookieOf, loginParent, loginStudent };
}

export function form(fields: Record<string, string>, file?: { name: string; type: string; bytes: Uint8Array }) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append('file', new Blob([file.bytes], { type: file.type }), file.name);
  return fd;
}

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
