// No offline homework cache: never show stale private data or an old UI as current.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const local = new URL(event.request.url).origin === self.location.origin;
  event.respondWith(fetch(event.request, local ? {cache: 'no-store'} : {}).catch(() =>
    new Response('离线了，联网后再打开作业登记簿', {
      status: 503, headers: {'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store'}
    })
  ));
});
