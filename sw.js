// 作业登记簿 Service Worker：只为满足 PWA 安装条件，不缓存动态内容，
// 作业数据永远走网络，避免离线旧数据误导；断网时只提示一句话。
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).catch(
      () =>
        new Response("离线了，联网后再打开作业登记簿", {
          headers: {"Content-Type": "text/plain;charset=utf-8"},
        })
    )
  );
});
