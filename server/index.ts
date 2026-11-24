import { mkdirSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { startScheduler } from './push.js';

const cfg = loadConfig();
mkdirSync(cfg.uploadDir, { recursive: true });
const db = openDb(cfg.dbPath);
const app = createApp(db, cfg);

if (cfg.adminPassword === 'admin123') console.warn('⚠ 仍在使用默认管理密码 admin123，部署前请设置 ADMIN_PASSWORD。');
if (cfg.scheduler) startScheduler(db, cfg);

serve({ fetch: app.fetch, port: cfg.port, hostname: '0.0.0.0' }, (info) => {
  console.log(`作业簿 http://127.0.0.1:${info.port}/  数据目录 ${cfg.dataDir}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { db.close(); process.exit(0); });
