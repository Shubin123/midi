// Serves files unpacked from plugin archives under ./plugin-fs/<id>/ so their relative imports,
// worklet modules, and fetches resolve like a normal hosted plugin.
const CACHE = 'zip-plugins-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
 const url = new URL(event.request.url);
 if (!url.pathname.startsWith(new URL('plugin-fs/', self.registration.scope).pathname)) return;
 url.search = ''; url.hash = '';
 event.respondWith(caches.open(CACHE)
  .then(cache => cache.match(url.href))
  .then(hit => hit || new Response('Not found in any loaded plugin archive.', { status: 404 })));
});
