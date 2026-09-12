/* A shell cache only. API responses, identities, and attachments belong in authenticated IndexedDB namespaces. */
const BASE = new URL('./', self.location.href);
const PREFIX = 'avenor-shell-' + encodeURIComponent(BASE.pathname) + '-';
const VERSION = PREFIX + 'v4';
const REQUIRED = ['index.html', 'app.js', 'core.js', 'calendar-recurrence.js', 'windows-timezones.js', 'provider-ui.js', 'compliance-ui.js', 'inbound-ui.js', 'runtime.js', 'collab.js', 'collab-store.js', 'renderer.js', 'offline.js', 'gpu-workspace.js', 'gpu-mode.js', 'scene-text.js', 'scene-layout.js', 'search-worker.js', 'seed.js', 'style.css'];
const OPTIONAL = ['favicon.svg', 'manifest.webmanifest'];
const shellURLs = new Set([...REQUIRED, ...OPTIONAL].map(path => new URL(path, BASE).href));
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // An incomplete new shell must not replace the previous functioning worker.
    for (const path of REQUIRED) {
      const url = new URL(path, BASE), response = await fetch(url, {cache: 'reload', credentials: 'omit'});
      if (!response.ok || response.redirected) throw new Error('Incomplete offline shell: ' + path);
      await cache.put(url, response);
    }
    await Promise.all(OPTIONAL.map(async path => {
      try { const response = await fetch(new URL(path, BASE), {cache: 'reload', credentials: 'omit'}); if (response.ok && !response.redirected) await cache.put(new URL(path, BASE), response); } catch { /* Icons and install metadata may be optional. */ }
    }));
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', event => { if (event.data?.type === 'SKIP_WAITING') self.skipWaiting(); });
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname) || /\/(?:api|auth|oauth|signin|signout|login|logout|callback)(?:\/|$|-)/i.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.open(VERSION)).match(new URL('index.html', BASE)) || Response.error()));
  } else if (shellURLs.has(url.href)) {
    event.respondWith(caches.open(VERSION).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && !response.redirected) await cache.put(request, response.clone());
      return response;
    }));
  }
});
