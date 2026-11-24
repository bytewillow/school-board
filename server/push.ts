import webpush from 'web-push';
import { addDays, dueAt, dueLabel, fmtMinutes, isoDate, isoDateTime, pad, remindAt, validTime } from '../shared/dates.js';
import type { Config } from './config.js';
import { all, one, run, type DB } from './db.js';
import { allItems, filterChild, getChildren, visibleItems, type ItemRow } from './items.js';
import { getPrefs } from './prefs.js';

export interface PushPayload { title: string; body: string; url: string; tag: string; actions?: { action: string; title: string; url: string }[] }

/** VAPID 密钥：优先用环境变量；没有就生成一对存进数据库，之后一直用这一对（换了钥匙，已订阅的设备要重新订阅）。 */
export function vapidKeys(db: DB, cfg: Config) {
  if (cfg.vapid.publicKey && cfg.vapid.privateKey) return { publicKey: cfg.vapid.publicKey, privateKey: cfg.vapid.privateKey };
  const row = one(db, "SELECT value FROM meta WHERE key='vapid'");
  if (row) return JSON.parse(row.value) as { publicKey: string; privateKey: string };
  const keys = webpush.generateVAPIDKeys();
  run(db, "INSERT OR REPLACE INTO meta VALUES ('vapid', ?)", JSON.stringify(keys));
  return keys;
}

type Sender = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<unknown>;

export function makeSender(db: DB, cfg: Config): Sender {
  const keys = vapidKeys(db, cfg);
  return (sub, payload) => webpush.sendNotification(sub, payload, {
    TTL: 3600, urgency: 'high',
    vapidDetails: { subject: cfg.vapid.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
  });
}

/** 发给一个孩子名下的所有已订阅设备；推送服务说订阅已失效（404/410）就删掉。 */
export async function sendToChild(db: DB, send: Sender, childId: number, payload: PushPayload) {
  const subs = all(db, 'SELECT * FROM push_subs WHERE child_id=?', childId);
  await Promise.all(subs.map((s) => sendTo(db, send, s, payload)));
  return subs.length;
}

async function sendTo(db: DB, send: Sender, s: any, payload: PushPayload) {
  try {
    await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) run(db, 'DELETE FROM push_subs WHERE endpoint=?', s.endpoint);
    else console.warn('push failed', e?.statusCode || e?.message || e);
  }
}

const sentOnce = (db: DB, key: string) => {
  const r = run(db, 'INSERT OR IGNORE INTO push_log VALUES (?,?)', key, isoDateTime(new Date()));
  return r.changes === 1;
};

const undoneHomework = (items: ItemRow[]) => items.filter((i) => i.kind === 'homework' && !i.done && /^\d{4}-\d{2}-\d{2}$/.test(i.due || ''));

export function dueReminder(it: ItemRow, steps: { done: number }[], detail: boolean, now: Date): PushPayload {
  const at = dueAt(it.due || '', it.due_time)!;
  const left = steps.filter((s) => !s.done).length;
  const est = it.est_minutes && steps.length ? Math.max(5, Math.round((it.est_minutes * left) / steps.length / 5) * 5) : it.est_minutes;
  const hours = Math.max(1, Math.round((at.getTime() - now.getTime()) / 3600000));
  const when = isoDate(at) === isoDate(now) ? `还有 ${hours} 小时截止` : `${dueLabel(it.due || '', validTime(it.due_time) ? it.due_time : '', now)}要交`;
  if (!detail) return { title: '有 1 项作业快到截止时间', body: '解锁后查看是哪一项', url: `/item/${it.id}`, tag: `due-${it.id}` };
  const extra = [left ? `还剩 ${left} 步` : '', est ? `约 ${fmtMinutes(est)}` : ''].filter(Boolean).join('，');
  return {
    title: `${it.subject}作业${when}`,
    body: `${it.title}${extra ? '，' + extra : ''}。现在开始正好来得及。`,
    url: `/item/${it.id}`, tag: `due-${it.id}`,
    actions: [{ action: 'focus', title: '开始专注', url: `/item/${it.id}?focus=1` }],
  };
}

export function dailyReminder(items: ItemRow[], now: Date, detail: boolean): PushPayload | null {
  const today = isoDate(now), tomorrow = isoDate(addDays(now, 1));
  const tonight = undoneHomework(items).filter((i) => i.due === today && dueAt(i.due, i.due_time)! > now)
    .sort((a, b) => dueAt(a.due!, a.due_time)!.getTime() - dueAt(b.due!, b.due_time)!.getTime());
  const morning = undoneHomework(items).filter((i) => i.due === tomorrow && validTime(i.due_time) && Number(i.due_time.slice(0, 2)) <= 9);
  const list = [...tonight, ...morning];
  if (!list.length) return null;
  const mins = list.reduce((a, i) => a + (i.est_minutes || 0), 0);
  const title = `今晚有 ${list.length} 项作业${mins ? '，约 ' + fmtMinutes(mins) : ''}`;
  if (!detail) return { title, body: '打开作业簿看看先写哪项', url: '/', tag: 'daily' };
  const subjects = [...new Set(list.map((i) => i.subject))];
  const first = list[0];
  const firstWhen = first.due === today ? (validTime(first.due_time) ? `${first.due_time} 截止` : '今天交') : '明早交';
  return { title, body: `先写${first.subject}（${firstWhen}）${subjects.length > 1 ? '，再写' + subjects.slice(1).join('、') : ''}。`, url: '/', tag: 'daily' };
}

/** 每 30 秒跑一次：截止提醒、每日提醒、专注结束提醒。漏掉 15 分钟以上的就不补发，免得半夜一次弹一串。 */
export async function tick(db: DB, send: Sender, now = new Date()) {
  const windowMs = 15 * 60000;
  const childIds = all(db, 'SELECT DISTINCT child_id FROM push_subs').map((r) => r.child_id as number);
  const children = new Set(getChildren(db).map((c) => c.id));
  for (const childId of childIds) {
    if (!children.has(childId)) continue;
    const prefs = getPrefs(db, childId);
    const items = filterChild(visibleItems(allItems(db)), childId);
    for (const it of undoneHomework(items)) {
      const at = remindAt(it.due || '', it.due_time, it.remind, { remind: prefs.remind, before: prefs.before });
      if (!at || at > now || now.getTime() - at.getTime() > windowMs) continue;
      if (!sentOnce(db, `due:${childId}:${it.id}:${isoDateTime(at)}`)) continue;
      const steps = all(db, 'SELECT done FROM steps WHERE item_id=?', it.id);
      await sendToChild(db, send, childId, dueReminder(it, steps, prefs.lockDetail, now));
    }
    if (prefs.daily && validTime(prefs.dailyAt)) {
      const [h, m] = prefs.dailyAt.split(':').map(Number);
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
      if (at <= now && now.getTime() - at.getTime() <= windowMs) {
        const payload = dailyReminder(items, now, prefs.lockDetail);
        if (payload && sentOnce(db, `daily:${childId}:${isoDate(now)}`)) await sendToChild(db, send, childId, payload);
      }
    }
  }
  const nowKey = isoDateTime(now) + ':' + pad(now.getSeconds()); // 与 /push/schedule 存的格式一致，精确到秒
  for (const q of all(db, 'SELECT * FROM push_queue WHERE sent=0 AND at<=?', nowKey)) {
    run(db, 'UPDATE push_queue SET sent=1 WHERE id=?', q.id);
    const sub = one(db, 'SELECT * FROM push_subs WHERE endpoint=?', q.endpoint);
    if (sub) await sendTo(db, send, sub, JSON.parse(q.payload));
  }
  run(db, 'DELETE FROM push_queue WHERE at<?', isoDateTime(addDays(now, -1)));
  run(db, 'DELETE FROM push_log WHERE sent<?', isoDateTime(addDays(now, -30)));
}

export function startScheduler(db: DB, cfg: Config) {
  const send = makeSender(db, cfg);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await tick(db, send); } catch (e) { console.error('scheduler', e); } finally { busy = false; }
  }, 30000);
  timer.unref();
  return () => clearInterval(timer);
}
