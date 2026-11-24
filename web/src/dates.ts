import { addDays, diffDays, dueAt, dueLabel, isoDate, parseDate, startOfDay, weekStart, WEEKDAYS } from '../../shared/dates';
import type { Item } from './types';

export * from '../../shared/dates';

export const itemDueAt = (it: Item) => dueAt(it.due, it.due_time);
export const itemDueLabel = (it: Item, now: Date) => dueLabel(it.due, it.due_time, now);
export const isHomework = (it: Item) => it.kind === 'homework';

export type Group = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'nodate' | 'past';
export function groupOf(it: Item, now: Date): Group {
  const d = parseDate(it.due);
  if (!d) return 'nodate';
  const at = itemDueAt(it)!;
  const df = diffDays(d, now);
  if (!it.done && at < now) return 'overdue';
  if (df < 0) return 'past';
  if (df === 0) return 'today';
  if (df === 1) return 'tomorrow';
  if (d < addDays(weekStart(now), 7)) return 'week';
  return 'later';
}

/** 最急：还没过截止时间、截止最早的那一项未完成作业。 */
export function urgentId(items: Item[], now: Date): number | null {
  const next = items.filter((i) => isHomework(i) && !i.done && itemDueAt(i) && itemDueAt(i)! > now)
    .sort((a, b) => itemDueAt(a)!.getTime() - itemDueAt(b)!.getTime())[0];
  return next ? next.id : null;
}

export function countdown(it: Item, now: Date): { big: string; unit: string; small?: string; unit2?: string; past: boolean } | null {
  const at = itemDueAt(it);
  if (!at) return null;
  const mins = Math.round((at.getTime() - now.getTime()) / 60000);
  if (mins < 0) {
    const ago = -mins;
    return ago < 1440 ? { big: String(Math.floor(ago / 60)), unit: '小时', small: String(ago % 60).padStart(2, '0'), unit2: '分前已截止', past: true }
      : { big: String(Math.floor(ago / 1440)), unit: '天前已截止', past: true };
  }
  if (mins >= 1440) return { big: String(Math.floor(mins / 1440)), unit: '天', small: String(Math.floor((mins % 1440) / 60)), unit2: '小时', past: false };
  return { big: String(Math.floor(mins / 60)), unit: '小时', small: String(mins % 60).padStart(2, '0'), unit2: '分', past: false };
}

export const md = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
export const weekdayName = (d: Date) => '周' + WEEKDAYS[d.getDay()];

/** 剩下没做的步骤按比例估算还要多久；没拆步骤就用整项预计时长。 */
export function remainingMinutes(it: Item): number {
  if (it.done) return 0;
  if (!it.steps.length) return it.est_minutes;
  const left = it.steps.filter((s) => !s.done).length;
  return Math.round((it.est_minutes * left) / it.steps.length);
}
