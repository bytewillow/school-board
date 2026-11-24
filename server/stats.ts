import { addDays, dueAt, isoDate, parseDateTime, startOfDay, weekStart } from '../shared/dates.js';
import { all, type DB } from './db.js';
import type { ItemRow } from './items.js';

export type DayStatus = 'ok' | 'late' | 'none' | 'today' | 'future';

/** 某一天要交的作业是否都按时交了。旧数据没有完成时间，已完成就算按时。 */
function dayStatus(items: ItemRow[], day: Date, now: Date): DayStatus {
  const key = isoDate(day);
  const due = items.filter((i) => i.kind === 'homework' && i.due === key);
  const isToday = key === isoDate(now);
  if (day > now && !isToday) return 'future';
  if (!due.length) return 'none';
  const onTime = due.every((i) => {
    if (!i.done) return false;
    const at = parseDateTime(i.done_at);
    const deadline = dueAt(i.due || '', i.due_time);
    return !at || !deadline || at <= deadline;
  });
  if (isToday) return onTime ? 'ok' : 'today';
  return onTime ? 'ok' : 'late';
}

export function computeStats(db: DB, items: ItemRow[], childId: number, now = new Date()) {
  const today = startOfDay(now);
  const ws = weekStart(now);
  const grid = Array.from({ length: 28 }, (_, i) => addDays(ws, i - 21));
  const days = grid.map((d) => ({ date: isoDate(d), status: dayStatus(items, d, now) }));

  const earliest = items.filter((i) => i.kind === 'homework' && /^\d{4}-\d{2}-\d{2}$/.test(i.due || '')).map((i) => i.due!).sort()[0];
  let streak = dayStatus(items, today, now) === 'ok' ? 1 : 0;
  let lastLate = '';
  if (earliest) {
    for (let d = addDays(today, -1); isoDate(d) >= earliest; d = addDays(d, -1)) {
      const st = dayStatus(items, d, now);
      if (st === 'late') { lastLate = isoDate(d); break; }
      if (st === 'ok') streak++;
    }
  }
  const counted = days.filter((d) => d.status === 'ok' || d.status === 'late');
  const onTimeRate = counted.length ? Math.round((counted.filter((d) => d.status === 'ok').length / counted.length) * 100) : null;

  const from = isoDate(addDays(ws, -7)) + 'T00:00';
  const sessions = all(db, 'SELECT started, minutes FROM focus_sessions WHERE child_id=? AND started>=?', childId, from);
  const minutesOn = (d: Date) => sessions.filter((s) => s.started.slice(0, 10) === isoDate(d)).reduce((a, s) => a + Number(s.minutes), 0);
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i);
    return { date: isoDate(d), minutes: d > now ? null : minutesOn(d) };
  });
  const elapsed = Math.min(7, Math.round((today.getTime() - ws.getTime()) / 86400000) + 1);
  const prevSameSpan = Array.from({ length: elapsed }, (_, i) => minutesOn(addDays(ws, i - 7))).reduce((a, b) => a + b, 0);
  const weekKeys = new Set(week.map((w) => w.date));
  const weekHw = items.filter((i) => i.kind === 'homework' && weekKeys.has(i.due || ''));
  return {
    streak, lastLate, onTimeRate, days, week, prevSameSpan,
    weekDone: weekHw.filter((i) => i.done).length, weekTotal: weekHw.length,
  };
}
