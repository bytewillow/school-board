import { validTime } from '../shared/dates.js';
import { all, run, type DB } from './db.js';

export interface Prefs {
  remind: boolean; before: number; daily: boolean; dailyAt: string;
  focus: number; rest: number; lockDetail: boolean;
}
export const DEFAULT_PREFS: Prefs = { remind: true, before: 120, daily: true, dailyAt: '17:30', focus: 25, rest: 5, lockDetail: true };

export function getPrefs(db: DB, childId: number): Prefs {
  const p: any = { ...DEFAULT_PREFS };
  for (const r of all(db, 'SELECT key, value FROM prefs WHERE scope=?', `child:${childId}`)) {
    if (!(r.key in p)) continue;
    const d = (DEFAULT_PREFS as any)[r.key];
    p[r.key] = typeof d === 'boolean' ? r.value === '1' : typeof d === 'number' ? Number(r.value) : r.value;
  }
  return p;
}

/** 只接受已知的键和合法的值，其余忽略。 */
export function setPrefs(db: DB, childId: number, patch: Record<string, unknown>): Prefs {
  const ok: Record<string, (v: unknown) => string | null> = {
    remind: (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : null),
    daily: (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : null),
    lockDetail: (v) => (typeof v === 'boolean' ? (v ? '1' : '0') : null),
    before: (v) => ([60, 120, 180].includes(Number(v)) ? String(Number(v)) : null),
    dailyAt: (v) => (typeof v === 'string' && validTime(v) ? v : null),
    focus: (v) => (Number.isInteger(Number(v)) && Number(v) >= 5 && Number(v) <= 90 ? String(Number(v)) : null),
    rest: (v) => (Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 30 ? String(Number(v)) : null),
  };
  for (const [k, v] of Object.entries(patch || {})) {
    const val = ok[k]?.(v);
    if (val !== null && val !== undefined) run(db, 'INSERT OR REPLACE INTO prefs VALUES (?,?,?)', `child:${childId}`, k, val);
  }
  return getPrefs(db, childId);
}
