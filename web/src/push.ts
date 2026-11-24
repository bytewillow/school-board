import { api } from './api';
import { getState } from './store';

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on';

export async function pushState(): Promise<PushState> {
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && localStorage.getItem('sb-push-child') === String(getState().child) ? 'on' : 'off';
}

function keyBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** 必须在用户点击里调用：iOS 只允许由点击触发的权限请求。 */
export async function enablePush(): Promise<PushState> {
  const s = getState();
  if (!s.me || s.child === null) return 'off';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(s.me.push.publicKey) as BufferSource });
  await api('/app-api/push/subscribe', { json: { subscription: sub.toJSON(), child_id: s.child } });
  localStorage.setItem('sb-push-child', String(s.child));
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api('/app-api/push/unsubscribe', { json: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  localStorage.removeItem('sb-push-child');
  return 'off';
}

async function endpoint(): Promise<string | null> {
  if (!pushSupported() || localStorage.getItem('sb-push-child') === null) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription())?.endpoint || null;
}

/** 让服务器在某个时刻推一条（专注结束）。没开提醒就什么都不做。 */
export async function schedulePush(tag: string, atMs: number, title: string, body: string, url: string) {
  const ep = await endpoint();
  if (ep) await api('/app-api/push/schedule', { json: { endpoint: ep, tag, at_ms: atMs, title, body, url } }).catch(() => {});
}
export async function cancelPush(tag: string) {
  const ep = await endpoint();
  if (ep) await api('/app-api/push/cancel', { json: { endpoint: ep, tag } }).catch(() => {});
}
