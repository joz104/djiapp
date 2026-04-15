const CACHE = 'field-cam-v25';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './dji-control.js',
  './ble-transport.js',
  './video-pane.js',
  './manifest.json',
  './vendor/hls.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isSegment = /\.(m3u8|ts|mp4|m4s)(\?|$)/i.test(url.pathname);
  if (isSegment || url.protocol === 'rtmp:') {
    event.respondWith(fetch(req).catch(() => new Response('', { status: 504 })));
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
