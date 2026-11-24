import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { Hono } from 'hono';
import { appApi } from './app-api.js';
import { getSession } from './auth.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import type { Env } from './http.js';
import { legacyApi } from './legacy-api.js';

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/** 前端页面路由：都返回同一个 index.html，由前端自己渲染。旧版的 /item?id=、/register、/admin 链接继续能打开。 */
const SPA_ROUTES = /^\/(|login|admin|register|calendar|subjects(\/.*)?|me|item(\/\d+)?|notebooks|manage(\/.*)?)$/;

export function createApp(db: DB, cfg: Config) {
  const app = new Hono<Env>();

  app.use('*', async (c, next) => {
    c.set('session', getSession(c, db, cfg));
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
  });

  // 显式跨站的写请求一律拒绝（SameSite=Lax 之外再加一道）。令牌接口 /api/items 保留命令行用法。
  app.use('*', async (c, next) => {
    const origin = c.req.header('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && origin && new URL(c.req.url).pathname !== '/api/items') {
      let host = '';
      try { host = new URL(origin).host; } catch { host = ''; }
      if (host !== (c.req.header('host') || new URL(c.req.url).host)) return c.json({ ok: false, error: 'forbidden_origin', message: '请从本站页面重新操作。' }, 403);
    }
    await next();
  });

  app.route('/', legacyApi(db, cfg));
  app.route('/app-api', appApi(db, cfg));
  app.all('/app-api/*', (c) => c.json({ ok: false, error: 'not_found' }, 404));
  app.all('/api/*', (c) => c.json({ ok: false, error: 'not_found' }, 404));

  const indexHtml = () => {
    const p = join(cfg.webDir, 'index.html');
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : '<!doctype html><meta charset="utf-8"><p>前端还没构建：先运行 npm run build。</p>';
  };

  app.get('*', (c) => {
    let path = '/';
    try { path = decodeURIComponent(new URL(c.req.url).pathname); } catch { return c.json({ ok: false, error: 'not_found' }, 404); }
    if (SPA_ROUTES.test(path)) {
      return c.body(indexHtml(), 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    }
    const file = normalize(join(cfg.webDir, path));
    if (!file.startsWith(cfg.webDir) || !existsSync(file) || !statSync(file).isFile()) {
      return c.json({ ok: false, error: 'not_found', message: '这个页面不存在' }, 404);
    }
    const headers: Record<string, string> = { 'Content-Type': STATIC_TYPES[extname(file)] || 'application/octet-stream' };
    // 带哈希的构建产物可以长期缓存；sw.js、manifest、图标每次都要重新确认。
    headers['Cache-Control'] = path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    if (path === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    return c.body(new Uint8Array(readFileSync(file)), 200, headers);
  });

  return app;
}
