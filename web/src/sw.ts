/// <reference lib="webworker" />
// 离线：界面文件预缓存；作业数据“先联网、断网用上次的”，并标记成缓存数据。附件不缓存。
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (string | { url: string; revision: string | null })[] };

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
// 页面路由都用缓存的 index.html（离线也能打开）；附件和接口不走这条。
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/uploads\//, /^\/api(\/|$)/, /^\/app-api\//, /^\/health$/] }));
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const DATA_CACHE = 'sb-data-v1';
const isData = (u: URL) => u.pathname === '/app-api/me' || u.pathname === '/app-api/items' || u.pathname === '/app-api/notebooks';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (isData(url)) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-store' });
        if (res.ok) {
          const copy = new Response(await res.clone().blob(), { headers: { 'Content-Type': 'application/json', 'X-SB-Saved': new Date().toISOString() } });
          (await caches.open(DATA_CACHE)).put(url.pathname + url.search, copy);
        } else if (res.status === 401) {
          await caches.delete(DATA_CACHE);
        }
        return res;
      } catch {
        const hit = await (await caches.open(DATA_CACHE)).match(url.pathname + url.search);
        if (!hit) return offline();
        const saved = hit.headers.get('X-SB-Saved') || '';
        const local = saved ? new Date(saved) : null;
        const stamp = local ? `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}T${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}` : '1';
        return new Response(await hit.blob(), { headers: { 'Content-Type': 'application/json', 'X-SB-Cache': stamp } });
      }
    })());
  }
});

function offline() {
  return new Response(JSON.stringify({ ok: false, error: 'offline', message: '没有网络' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-SB-Offline': '1' } });
}

interface Payload { title: string; body: string; url: string; tag: string; actions?: { action: string; title: string; url: string }[] }

self.addEventListener('push', (event) => {
  let p: Payload;
  try { p = event.data!.json(); } catch { p = { title: '作业簿', body: event.data?.text() || '', url: '/', tag: 'sb' }; }
  const opts: NotificationOptions & { actions?: unknown; renotify?: boolean } = {
    body: p.body, tag: p.tag, icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: p.url, actions: Object.fromEntries((p.actions || []).map((a) => [a.action, a.url])) },
    renotify: true,
  };
  // iOS 不支持通知按钮，点通知本身会打开作业；安卓 / 桌面会多出“开始专注”按钮。
  if (p.actions?.length) opts.actions = p.actions.map((a) => ({ action: a.action, title: a.title }));
  event.waitUntil(self.registration.showNotification(p.title, opts));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = (event.action && data.actions?.[event.action]) || data.url || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if ('focus' in w) {
        await (w as WindowClient).navigate(url).catch(() => null);
        return (w as WindowClient).focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
