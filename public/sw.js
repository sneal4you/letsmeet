// sw.js - caché versionada del shell. Nunca toca WebSockets (no pasan por fetch) ni otros orígenes.
const VERSION = 'quedamos-93e0054751e6';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'core.js', 'crypto.js', 'sync.js', 'store.js',
  'vendor/noble-secp256k1.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  // Primera instalación: activar ya. Actualizaciones: esperan a que la app pida SKIP_WAITING.
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('quedamos-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      const fallback = req.mode === 'navigate' ? await cache.match('index.html') : null;
      if (fallback) return fallback;
      throw err;
    }
  })());
});
