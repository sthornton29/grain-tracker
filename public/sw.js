// Minimal service worker so the app is installable as a PWA.
// We don't aggressively cache — auth and data need to stay fresh — but the
// presence of a SW + manifest is what lets iPad's "Add to Home Screen" install
// it in standalone mode.

const CACHE = 'grain-tracker-v1'
const PRECACHE = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Only cache same-origin static icons/manifest; everything else goes to network.
  if (url.origin === self.location.origin && PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((c) => c || fetch(req)))
  }
})
