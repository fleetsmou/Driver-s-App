/* SMOU Driver — service worker. Only shows push notifications (GPS lost alerts).
   No offline caching: the app always loads fresh from the server. */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: "SMOU Driver", body: e.data ? e.data.text() : "" }; }
  var lost = d.tag === "gps-lost";
  e.waitUntil(self.registration.showNotification(d.title || "SMOU Driver", {
    body: d.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: d.tag || "smou",
    renotify: true,
    requireInteraction: lost,
    vibrate: lost ? [400, 150, 400, 150, 400] : [200],
    data: { url: d.url || "./" }
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (ws) {
    for (var i = 0; i < ws.length; i++) { if (ws[i].url.indexOf(self.registration.scope) === 0 && "focus" in ws[i]) return ws[i].focus(); }
    return self.clients.openWindow(url);
  }));
});
