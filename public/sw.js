// Minimal service worker so the app is installable as a PWA.
// We don't aggressively cache — auth and data need to stay fresh — but the
// presence of a SW + manifest is what lets iPad's "Add to Home Screen" install
// it in standalone mode. The one offline behavior: when a page navigation
// fails with no connection, serve the offline page instead of the browser's
// blank error screen.

const CACHE = 'turnrow-v2'
const PRECACHE = ['/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png']
const OFFLINE_URL = '/offline'

// Inline fallback in case /offline could not be cached (e.g. the install ran
// while signed out and the page redirected to sign-in).
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline — Turnrow</title>
<style>body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#f8fafc;color:#1e293b;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.1);padding:24px;max-width:360px;text-align:center}
h1{font-size:20px;margin:8px 0}p{font-size:14px;color:#475569;line-height:1.5}
a{display:inline-block;margin-top:12px;background:#36B449;color:#fff;text-decoration:none;font-weight:600;border-radius:10px;padding:12px 18px;font-size:14px}</style></head>
<body><div class="card"><div style="font-size:36px">📡</div><h1>You’re offline</h1>
<p>Turnrow needs a connection to load pages. Check your signal, then reconnect and try again.</p>
<a href="/">Try again</a></div></body></html>`

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const c = await caches.open(CACHE)
      await c.addAll(PRECACHE).catch(() => {})
      // Only keep /offline if it really came back as the offline page (not a
      // redirect to sign-in).
      try {
        const res = await fetch(OFFLINE_URL, { redirect: 'follow' })
        if (res.ok && !res.redirected && new URL(res.url).pathname === OFFLINE_URL) await c.put(OFFLINE_URL, res)
      } catch { /* cached later, or the inline fallback serves */ }
    } catch { /* never block install */ }
  })())
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
  if (url.origin !== self.location.origin) return

  // Page navigations: network first; on failure, the offline page.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match(OFFLINE_URL)
        return cached ?? new Response(OFFLINE_HTML, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
      })
    )
    return
  }

  // Only cache same-origin static icons/manifest; everything else goes to network.
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((c) => c || fetch(req)))
  }
})
