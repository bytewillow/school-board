import { useEffect, useReducer } from 'preact/hooks';
import { api, ApiError, enqueue, flushOutbox, OfflineError } from './api';
import type { Item, Me, Prefs, Stats } from './types';

export type View = 'today' | 'cal' | 'subj' | 'me' | 'login' | 'manage' | 'notebooks';
export interface Route { view: View; itemId: number | null; subject: string | null; params: URLSearchParams }
export interface Toast { text: string; action?: { label: string; run: () => void }; id: number }
export type Sheet = null | { mode: 'add'; day?: string; subject?: string } | { mode: 'edit'; id: number };

export interface State {
  boot: 'loading' | 'ready' | 'error';
  bootError: string;
  me: Me | null;
  child: number | null;
  items: Item[];
  prefs: Prefs;
  stats: Stats | null;
  cachedAt: string;
  offline: boolean;
  route: Route;
  sheet: Sheet;
  toast: Toast | null;
  calSel: string;
}

export const DEFAULT_PREFS: Prefs = { remind: true, before: 120, daily: true, dailyAt: '17:30', focus: 25, rest: 5, lockDetail: true };

let state: State = {
  boot: 'loading', bootError: '', me: null, child: null, items: [], prefs: DEFAULT_PREFS, stats: null,
  cachedAt: '', offline: !navigator.onLine, route: parseRoute(), sheet: null, toast: null, calSel: '',
};
const subs = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  subs.forEach((f) => f());
}
export function useApp(): State {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    // Preact 的 dispatch 要一个参数，包成无参回调；同一个引用才能在卸载时删掉。
    const rerender = () => force(0);
    subs.add(rerender);
    return () => { subs.delete(rerender); };
  }, []);
  return state;
}

// ---------- 路由 ----------
export function parseRoute(loc: Location = location): Route {
  const params = new URLSearchParams(loc.search);
  const path = loc.pathname.replace(/\/+$/, '') || '/';
  let m: RegExpExecArray | null;
  if (path === '/item') return { view: 'today', itemId: Number(params.get('id')) || null, subject: null, params };
  if ((m = /^\/item\/(\d+)$/.exec(path))) return { view: 'today', itemId: Number(m[1]), subject: null, params };
  if (path === '/calendar') return { view: 'cal', itemId: null, subject: null, params };
  if (path === '/subjects') return { view: 'subj', itemId: null, subject: null, params };
  if ((m = /^\/subjects\/(.+)$/.exec(path))) return { view: 'subj', itemId: null, subject: decodeURIComponent(m[1]), params };
  if (path === '/me') return { view: 'me', itemId: null, subject: null, params };
  if (path === '/login') return { view: 'login', itemId: null, subject: null, params };
  if (path === '/admin' || path === '/manage') return { view: 'manage', itemId: null, subject: null, params };
  if (path === '/notebooks') return { view: 'notebooks', itemId: null, subject: null, params };
  return { view: 'today', itemId: null, subject: null, params };
}

/** 打开作业详情时保留当前页面在底下（手机上详情盖在上面，平板上并排）。 */
let underlying: View = 'today';
export function navigate(path: string, opts: { replace?: boolean; keepView?: boolean } = {}) {
  const url = new URL(path, location.origin);
  const s = getState();
  if (s.me?.role === 'parent' && s.child && !url.searchParams.has('child') && !['/login', '/notebooks', '/manage', '/admin'].includes(url.pathname)) url.searchParams.set('child', String(s.child));
  const target = url.pathname + url.search;
  if (target !== location.pathname + location.search) history[opts.replace ? 'replaceState' : 'pushState']({ inApp: true }, '', target);
  applyRoute();
}
export function applyRoute() {
  const r = parseRoute();
  const isItem = /^\/item/.test(location.pathname);
  if (isItem) r.view = underlying;
  else underlying = r.view === 'login' ? 'today' : r.view;
  const s = getState();
  if (s.me?.role === 'parent') {
    const c = Number(r.params.get('child'));
    if (c && c !== s.child && s.me.children.some((x) => x.id === c)) { selectChild(c); }
  }
  setState({ route: r });
}
window.addEventListener('popstate', applyRoute);

export function openItem(id: number) {
  navigate(`/item/${id}`);
}
export function closeItem() {
  if (history.state?.inApp && /^\/item/.test(location.pathname)) history.back();
  else navigate(underlyingPath(), { replace: true });
}
function underlyingPath() {
  const s = getState();
  return { today: '/', cal: '/calendar', subj: s.route.subject ? `/subjects/${encodeURIComponent(s.route.subject)}` : '/subjects', me: '/me', login: '/login', manage: '/manage', notebooks: '/notebooks' }[underlying];
}

// ---------- 提示 ----------
let toastTimer = 0;
export function toast(text: string, action?: Toast['action']) {
  clearTimeout(toastTimer);
  setState({ toast: { text, action, id: Date.now() } });
  toastTimer = window.setTimeout(() => setState({ toast: null }), action ? 5000 : 3200);
}
export function showError(e: unknown) {
  if (e instanceof OfflineError) toast('现在没有网络，联网后再试');
  else if (e instanceof ApiError) toast(e.message);
  else toast('出错了，请再试一次');
}

// ---------- 数据 ----------
export async function boot() {
  try {
    const me = await api<Me & { ok: boolean }>('/app-api/me');
    setState({ me });
    if (parseRoute().view === 'login') { history.replaceState({}, '', '/'); applyRoute(); }
    if (me.role === 'student') return selectChild(me.child_id, true);
    const fromUrl = Number(new URLSearchParams(location.search).get('child'));
    const saved = Number(localStorage.getItem('sb-child'));
    const pick = [fromUrl, saved].find((c) => c && me.children.some((x) => x.id === c)) || (me.children.length === 1 ? me.children[0].id : 0);
    if (pick) return selectChild(pick, true);
    setState({ boot: 'ready' });
    const r = parseRoute();
    if (!['manage', 'notebooks'].includes(r.view)) navigate(me.children.length ? '/notebooks' : '/manage', { replace: true });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setState({ boot: 'ready', me: null });
      if (parseRoute().view !== 'login') navigate(location.pathname === '/admin' ? '/login?as=parent' : '/login', { replace: true });
    } else {
      setState({ boot: 'error', bootError: e instanceof OfflineError ? '现在没有网络，也没有保存过的数据。联网后再打开。' : '连不上服务器，请稍后再试。' });
    }
  }
}

export async function selectChild(child: number, first = false) {
  if (getState().me?.role === 'parent') localStorage.setItem('sb-child', String(child));
  // 换本子时先清空，免得短暂显示上一个孩子的作业
  setState({ child, items: child === getState().child && !first ? getState().items : [], stats: child === getState().child ? getState().stats : null });
  await refresh();
  if (first) setState({ boot: 'ready' });
}

let refreshing: Promise<void> | null = null;
export function refresh(): Promise<void> {
  const child = getState().child;
  if (child === null) return Promise.resolve();
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      await flushOutbox();
      const r = await api<any>(`/app-api/items?child=${child}`);
      if (getState().child !== child) return;
      setState({ items: r.items, prefs: r.prefs, stats: r.stats, cachedAt: r.__cached || '', offline: !!r.__cached });
      updateBadge();
    } catch (e) {
      if (e instanceof OfflineError) setState({ offline: true });
      else if (e instanceof ApiError && e.status === 401) { setState({ me: null }); navigate('/login', { replace: true }); }
      else throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export function replaceItem(item: Item) {
  setState((s) => ({ items: s.items.some((i) => i.id === item.id) ? s.items.map((i) => (i.id === item.id ? item : i)) : [item, ...s.items] }));
  updateBadge();
}

/** 完成 / 取消完成。断网时先在本机改好，联网后补发。统计数字要等服务器确认后再刷新。 */
export async function setDone(item: Item, done: boolean): Promise<boolean> {
  const path = `/app-api/items/${item.id}/done`;
  try {
    const r = await api<{ item: Item }>(path, { json: { done } });
    replaceItem(r.item);
    refresh();
    return true;
  } catch (e) {
    if (e instanceof OfflineError) {
      enqueue({ path, json: { done } });
      replaceItem({ ...item, done, steps: done ? item.steps.map((s) => ({ ...s, done: true })) : item.steps });
      toast('已记在本机，联网后自动同步');
      return true;
    }
    showError(e);
    return false;
  }
}

export async function setStep(item: Item, stepId: number, done: boolean) {
  const path = `/app-api/items/${item.id}/steps/${stepId}`;
  const steps = item.steps.map((s) => (s.id === stepId ? { ...s, done } : s));
  replaceItem({ ...item, steps, done: steps.length > 0 && steps.every((s) => s.done) });
  try {
    const r = await api<{ item: Item }>(path, { json: { done } });
    replaceItem(r.item);
  } catch (e) {
    if (e instanceof OfflineError) enqueue({ path, json: { done } });
    else { replaceItem(item); showError(e); }
  }
}

export async function savePrefs(patch: Partial<State['prefs']>) {
  const before = getState().prefs;
  setState({ prefs: { ...before, ...patch } });
  try {
    const r = await api<{ prefs: State['prefs'] }>(`/app-api/prefs?child=${getState().child}`, { method: 'PUT', json: patch });
    setState({ prefs: r.prefs });
  } catch (e) {
    setState({ prefs: before });
    showError(e);
  }
}

export async function logout() {
  try { await api('/app-api/logout', { json: {} }); } catch { /* 断网也要清掉本机数据 */ }
  localStorage.removeItem('sb-child');
  localStorage.removeItem('sb-outbox');
  localStorage.removeItem('sb-focus');
  if ('caches' in window) for (const k of await caches.keys()) if (k.startsWith('sb-data')) await caches.delete(k);
  location.href = '/login';
}

function updateBadge() {
  const nav = navigator as any;
  if (!nav.setAppBadge) return;
  const today = new Date();
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const n = getState().items.filter((i) => i.kind === 'homework' && !i.done && i.due && i.due <= key).length;
  (n ? nav.setAppBadge(n) : nav.clearAppBadge?.())?.catch?.(() => {});
}

// 回到前台、重新联网时刷新；在前台时每分钟刷新一次（倒计时和“最急”会跟着变）。
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
window.addEventListener('online', () => { setState({ offline: false }); refresh(); });
window.addEventListener('offline', () => setState({ offline: true }));
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
