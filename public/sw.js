/**
 * VaultExpiry service worker.
 * - App shell: precached, served cache-first, refreshed on each new version.
 * - Personal data (GET /api/auth/me, /api/items, /api/account): network-first, with
 *   the last good response kept for offline read-only use. Cleared on sign-in/out.
 * - Everything else under /api, and all non-GET requests: network only.
 * Bump VERSION whenever any shell file changes.
 */
const VERSION = 'v1.4.0';
const SHELL_CACHE = `vx-shell-${VERSION}`;
const DATA_CACHE = 'vx-data';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/icons.svg',
  '/js/theme-boot.js',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/dashboard.js',
  '/js/settings.js',
  '/js/admin.js',
  '/js/photos.js',
  '/js/shared/expiry.js',
  '/manifest.webmanifest',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];
const DATA_PATHS = [/^\/api\/auth\/me$/, /^\/api\/items$/, /^\/api\/account$/, /^\/api\/auth\/config$/];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith('vx-shell-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'skip-waiting') self.skipWaiting();
  if (event.data?.type === 'clear-user-data') event.waitUntil(caches.delete(DATA_CACHE));
});

async function networkFirstData(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(DATA_CACHE);
      await cache.put(request, response.clone());
    } else if (response.status === 401) {
      await caches.delete(DATA_CACHE);
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request, { cacheName: DATA_CACHE });
    if (!cached) throw err;
    const headers = new Headers(cached.headers);
    headers.set('X-From-Cache', '1');
    return new Response(await cached.blob(), { status: cached.status, headers });
  }
}

async function cacheFirstShell(request) {
  const cached = await caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    if (DATA_PATHS.some((re) => re.test(url.pathname))) event.respondWith(networkFirstData(request));
    return; // other API calls: browser default (network)
  }
  if (url.pathname.startsWith('/cal/') || url.pathname === '/healthz') return;

  if (request.mode === 'navigate') {
    // Always try the network for HTML so deploys show up; fall back to the cached shell offline.
    event.respondWith(fetch(request).catch(() => caches.match('/index.html', { cacheName: SHELL_CACHE })));
    return;
  }
  event.respondWith(cacheFirstShell(request));
});
