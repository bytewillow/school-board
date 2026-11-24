import { useEffect, useReducer } from 'preact/hooks';
import { api } from './api';
import { cancelPush, schedulePush } from './push';
import { getState, replaceItem, showError } from './store';
import type { Item } from './types';

/**
 * 专注计时。以“结束时刻”为准而不是每秒减一：页面切到后台、锁屏、刷新后回来，时间都还是对的。
 * 状态存在 localStorage，重新打开 App 会接着计时。
 */
export interface Focus {
  itemId: number; phase: 'focus' | 'break' | 'done' | 'breakdone';
  total: number; endsAt: number; left: number; running: boolean;
  spent: number; runFrom: number; startedAt: number; min: boolean; result?: number; early?: boolean; count: number;
}
const KEY = 'sb-focus';
let focus: Focus | null = load();
const subs = new Set<() => void>();
function load(): Focus | null { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
function save(f: Focus | null) {
  focus = f;
  if (f) localStorage.setItem(KEY, JSON.stringify(f)); else localStorage.removeItem(KEY);
  subs.forEach((s) => s());
}
export const getFocus = () => focus;
/** tick=true 时每 250ms 刷新一次（只给正在显示倒计时的组件用），并顺便检查是否到点。 */
export function useFocus(tick = false): Focus | null {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    // Preact 的 dispatch 要一个参数，包成无参回调；同一个引用才能在卸载时删掉。
    const rerender = () => force(0);
    subs.add(rerender);
    const t = tick ? setInterval(() => { checkFocus(); rerender(); }, 250) : 0;
    return () => { subs.delete(rerender); if (t) clearInterval(t); };
  }, [tick]);
  return focus;
}

export const leftSec = (f: Focus) => Math.max(0, f.running ? (f.endsAt - Date.now()) / 1000 : f.left);
export const spentSec = (f: Focus) => f.spent + (f.running && f.phase === 'focus' ? Math.min(f.total, (Date.now() - f.runFrom) / 1000) : 0);
const todayCount = () => {
  const d = new Date().toDateString();
  const v = JSON.parse(localStorage.getItem('sb-focus-count') || '{}');
  return v.d === d ? v.n : 0;
};

function itemOf(id: number): Item | undefined { return getState().items.find((i) => i.id === id); }

function schedule(f: Focus) {
  const it = itemOf(f.itemId);
  const detail = getState().prefs.lockDetail;
  const title = f.phase === 'break' ? '休息结束了' : '专注时间到';
  const body = f.phase === 'break' ? '回来接着写吧。' : detail && it ? `${it.subject}：${it.title}。可以休息一下或接着写。` : '可以休息一下或接着写。';
  schedulePush('focus', f.endsAt, title, body, `/item/${f.itemId}?focus=1`);
}

export function startFocus(itemId: number, kind: 'focus' | 'break' = 'focus') {
  const p = getState().prefs;
  const sec = (kind === 'focus' ? p.focus : p.rest) * 60;
  const now = Date.now();
  const f: Focus = { itemId, phase: kind, total: sec, endsAt: now + sec * 1000, left: sec, running: true, spent: 0, runFrom: now, startedAt: now, min: false, count: todayCount() };
  save(f);
  schedule(f);
  wake(true);
}

export function pauseResume() {
  if (!focus || !['focus', 'break'].includes(focus.phase)) return;
  const now = Date.now();
  if (focus.running) {
    save({ ...focus, running: false, left: leftSec(focus), spent: spentSec(focus) });
    cancelPush('focus');
    wake(false);
  } else {
    const f = { ...focus, running: true, endsAt: now + focus.left * 1000, runFrom: now };
    save(f);
    schedule(f);
    wake(true);
  }
}

export function addFive() {
  if (!focus) return;
  const f = focus.running ? { ...focus, endsAt: focus.endsAt + 300000, total: focus.total + 300 } : { ...focus, left: focus.left + 300, total: focus.total + 300 };
  save(f);
  if (f.running) schedule(f);
}

export const minimize = (min: boolean) => focus && save({ ...focus, min });

/** 结束一段。专注满 1 分钟才记录，记录失败也不丢计时结果。 */
export async function finish(early = false) {
  if (!focus) return;
  const f = focus;
  cancelPush('focus');
  wake(false);
  if (f.phase === 'break') return save({ ...f, phase: 'breakdone', running: false, left: 0, min: false });
  const minutes = Math.round(spentSec(f) / 60);
  if (minutes < 1) { save(null); return 'short'; }
  const d = new Date().toDateString();
  localStorage.setItem('sb-focus-count', JSON.stringify({ d, n: todayCount() + 1 }));
  save({ ...f, phase: 'done', running: false, left: 0, spent: spentSec(f), result: minutes, early, min: false, count: todayCount() });
  try {
    const r = await api<{ item: Item }>(`/app-api/items/${f.itemId}/focus`, { json: { minutes, started: f.startedAt } });
    replaceItem(r.item);
  } catch (e) {
    showError(e);
  }
}

export function closeFocus() { cancelPush('focus'); wake(false); save(null); }

/** 到点检查：前台时由界面每 250ms 调用。 */
export function checkFocus() {
  if (focus && focus.running && leftSec(focus) <= 0) finish();
}

// 专注时保持屏幕常亮（iOS 16.4+ 支持），屏幕一直显示倒计时。
let lock: any = null;
async function wake(on: boolean) {
  try {
    if (on && !lock && 'wakeLock' in navigator) {
      lock = await (navigator as any).wakeLock.request('screen');
      lock.addEventListener?.('release', () => { lock = null; });
    } else if (!on && lock) { await lock.release(); lock = null; }
  } catch { lock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    checkFocus();
    if (focus?.running) wake(true);
  }
});
