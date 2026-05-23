const CACHE_NAME = "wellness-os-shell-v19";
const SHELL_ASSETS = [
  "./",
  "index.html",
  "share.html",
  "daily-planner.html",
  "space.css",
  "app-auth.js",
  "manifest.webmanifest",
  "assets/favicons/audio-pilot-180.png",
  "assets/favicons/audio-pilot-32.png",
  "assets/favicons/audio-pilot.svg",
  "assets/favicons/beauty-180.png",
  "assets/favicons/beauty-32.png",
  "assets/favicons/beauty.svg",
  "assets/favicons/body-comp-180.png",
  "assets/favicons/body-comp-32.png",
  "assets/favicons/body-comp.svg",
  "assets/favicons/dashboard-180.png",
  "assets/favicons/dashboard-32.png",
  "assets/favicons/dashboard.svg",
  "assets/favicons/events-180.png",
  "assets/favicons/events-32.png",
  "assets/favicons/events.svg",
  "assets/favicons/finances-180.png",
  "assets/favicons/finances-32.png",
  "assets/favicons/finances.svg",
  "assets/favicons/fitness-180.png",
  "assets/favicons/fitness-32.png",
  "assets/favicons/fitness.svg",
  "assets/favicons/goals-180.png",
  "assets/favicons/goals-32.png",
  "assets/favicons/goals.svg",
  "assets/favicons/learning-180.png",
  "assets/favicons/learning-32.png",
  "assets/favicons/learning.svg",
  "assets/favicons/meals-180.png",
  "assets/favicons/meals-32.png",
  "assets/favicons/meals.svg",
  "assets/favicons/products-180.png",
  "assets/favicons/products-32.png",
  "assets/favicons/products-library-180.png",
  "assets/favicons/products-library-32.png",
  "assets/favicons/products-library.svg",
  "assets/favicons/products.svg",
  "assets/favicons/progress-180.png",
  "assets/favicons/progress-32.png",
  "assets/favicons/progress.svg",
  "assets/favicons/reading-180.png",
  "assets/favicons/reading-32.png",
  "assets/favicons/reading.svg",
  "assets/favicons/skincare-180.png",
  "assets/favicons/skincare-32.png",
  "assets/favicons/skincare-routine-180.png",
  "assets/favicons/skincare-routine-32.png",
  "assets/favicons/skincare-routine.svg",
  "assets/favicons/skincare.svg",
  "assets/favicons/treatments-180.png",
  "assets/favicons/treatments-32.png",
  "assets/favicons/treatments.svg",
  "assets/favicons/vlog-180.png",
  "assets/favicons/vlog-32.png",
  "assets/favicons/vlog.svg",
  "assets/favicons/wellness-180.png",
  "assets/favicons/wellness-192.png",
  "assets/favicons/wellness-32.png",
  "assets/favicons/wellness-512.png",
  "assets/favicons/wellness.svg",
  "assets/header-logo.png",
  "assets/1.png",
  "assets/2.png",
  "assets/3.png",
  "assets/4.png",
  "assets/5.png",
  "assets/6.png",
  "assets/7.png",
  "assets/8.png",
  "assets/9.png",
  "assets/10.png",
  "assets/11.png",
  "assets/vlog.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "WELLNESS_REFRESH") {
    self.skipWaiting();
  }
});

self.addEventListener("push", (event) => {
  const fallback = {
    title: "Wellness OS",
    body: "You have a Wellness OS update.",
    url: "/"
  };
  let payload = fallback;

  try {
    payload = event.data ? { ...fallback, ...event.data.json() } : fallback;
  } catch {
    payload = event.data ? { ...fallback, body: event.data.text() } : fallback;
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || fallback.title, {
      body: payload.body || fallback.body,
      icon: "assets/favicons/wellness-192.png",
      badge: "assets/favicons/wellness-192.png",
      tag: payload.tag || "wellness-os",
      data: {
        url: payload.url || "/"
      }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === targetUrl && "focus" in client) {
          return client.focus();
        }
      }

      return self.clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.pathname.includes("/api/")) {
    return;
  }

  if (url.pathname.endsWith("/share")) {
    event.respondWith(fetch(request).catch(() => caches.match("share.html")));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
          return response;
        })
        .catch(() => caches.match(request).then((cached) => cached || caches.match("index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)));
        }
        return response;
      });
    })
  );
});
