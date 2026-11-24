// 用法：
//   npm run import -- --from /旧的/data              合并另一份数据目录（含 board.db 和 uploads/）
//   npm run import -- --url http://旧服务器:8765 --token sb_xxx [--cookie "sb_session=..."]
// 导入到 DATA_DIR（默认 ./data）。导入前会自动备份当前库为 board.db.before-import-时间。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { importDataDir, importFromServer } from '../server/import.js';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] || '' : ''; };
const cfg = loadConfig();
mkdirSync(cfg.uploadDir, { recursive: true });
if (existsSync(cfg.dbPath)) copyFileSync(cfg.dbPath, `${cfg.dbPath}.before-import-${Date.now()}`);
const db = openDb(cfg.dbPath);

const from = opt('from'), url = opt('url');
if (!from && !url) {
  console.error('需要 --from <数据目录> 或 --url <旧服务器地址>');
  process.exit(2);
}
const report = from ? importDataDir(db, cfg.uploadDir, from) : await importFromServer(db, cfg.uploadDir, url, opt('token'), opt('cookie'));
db.close();
console.log(`导入完成：新孩子 ${report.children}，新学科 ${report.subjects}，条目 ${report.items}，附件 ${report.files}，重复跳过 ${report.skipped}`);
for (const n of report.notes) console.log('· ' + n);
