// 前后端共用的日期规则：截止时间、提醒时间、日期文字。全部按服务器 / 设备的本地时区计算。
export const DEFAULT_DUE_TIME = '21:00';
export const WEEKDAYS = '日一二三四五六';

export const pad = (n: number) => String(n).padStart(2, '0');

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 旧版用的 YYYY-MM-DDTHH:MM 本地时间字符串，可直接按字符串比较大小。 */
export function isoDateTime(d: Date): string {
  return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function parseDate(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isoDate(d) === s ? d : null;
}

export function parseDateTime(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

export const validDate = (s: string) => s === '' || parseDate(s) !== null;
export const validTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const validDateTime = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s) && parseDateTime(s) !== null;

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function diffDays(a: Date, b: Date): number {
  return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000);
}

/** 本周一。 */
export function weekStart(d: Date): Date {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() + 6) % 7));
}

/** AI 解析出的作业没写日期时的默认截止日：当天；周五登记则周日（与旧版一致）。 */
export function aiDefaultDue(day: Date): string {
  return isoDate(day.getDay() === 5 ? addDays(day, 2) : day);
}

/** 截止时刻。旧数据只有日期，按当天 21:00 计。 */
export function dueAt(due: string, dueTime = ''): Date | null {
  const d = parseDate(due);
  if (!d) return null;
  const [h, m] = (validTime(dueTime) ? dueTime : DEFAULT_DUE_TIME).split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

export type RemindChoice = 'off' | '60' | '120' | '180' | 'eve';
export const REMIND_CHOICES: RemindChoice[] = ['off', '60', '120', '180', 'eve'];
export interface RemindPrefs { remind: boolean; before: number }

/** 每项作业自己的提醒设置优先；没设置时按偏好：早上 9 点前交的作业前一晚 21:00 提醒，其余截止前 N 分钟。 */
export function effectiveRemind(itemRemind: string, dueTime: string, prefs: RemindPrefs): RemindChoice {
  if ((REMIND_CHOICES as string[]).includes(itemRemind)) return itemRemind as RemindChoice;
  if (!prefs.remind) return 'off';
  const hour = validTime(dueTime) ? Number(dueTime.slice(0, 2)) : Number(DEFAULT_DUE_TIME.slice(0, 2));
  if (hour <= 9) return 'eve';
  return (['60', '120', '180'].includes(String(prefs.before)) ? String(prefs.before) : '120') as RemindChoice;
}

export function remindAt(due: string, dueTime: string, itemRemind: string, prefs: RemindPrefs): Date | null {
  const choice = effectiveRemind(itemRemind, dueTime, prefs);
  const at = dueAt(due, dueTime);
  if (choice === 'off' || !at) return null;
  if (choice === 'eve') {
    const x = addDays(at, -1);
    x.setHours(21, 0, 0, 0);
    return x;
  }
  return new Date(at.getTime() - Number(choice) * 60000);
}

export const REMIND_LABELS: Record<RemindChoice, string> = {
  off: '不提醒', '60': '截止前 1 小时', '120': '截止前 2 小时', '180': '截止前 3 小时', eve: '前一晚 21:00',
};

/** 今天 / 明天 / 昨天 / 本周的周几 / M月D日 */
export function dayLabel(d: Date, now: Date): string {
  const df = diffDays(d, now);
  if (df === 0) return '今天';
  if (df === 1) return '明天';
  if (df === -1) return '昨天';
  const ws = weekStart(now);
  if (d >= ws && d < addDays(ws, 7)) return '周' + WEEKDAYS[d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function dueLabel(due: string, dueTime: string, now: Date): string {
  const d = parseDate(due);
  if (!d) return '没有截止日期';
  return validTime(dueTime) ? `${dayLabel(d, now)} ${dueTime}` : dayLabel(d, now);
}

export function fmtMinutes(m: number): string {
  m = Math.max(0, Math.round(m));
  const h = Math.floor(m / 60), r = m % 60;
  if (!h) return `${r} 分钟`;
  return r ? `${h} 小时 ${r} 分` : `${h} 小时`;
}
