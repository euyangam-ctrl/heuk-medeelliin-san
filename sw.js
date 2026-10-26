/* ХЭҮК мэдээллийн сан: offline support for the installed web app.
   The page, data.json and every PDF a reader has opened are kept so the app opens without a connection.
   Online, the network always wins, so admins' changes show up as soon as GitHub Pages publishes them. */
const SHELL_CACHE = 'heuk-shell-v1';
const DATA_CACHE = 'heuk-data';
const SHELL = ['./', 'manifest.webmanifest', 'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/qrcode.js', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const WAIT_MS = 6000;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== DATA_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const base = new URL(self.registration.scope);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return;
  const rel = url.pathname.slice(base.pathname.length);
  if (req.mode === 'navigate') e.respondWith(networkFirst(req, SHELL_CACHE, './'));
  else if (rel === 'data.json') e.respondWith(networkFirst(req, DATA_CACHE, 'data.json'));
  else if (/^pdf\/[^/]+\.pdf$/i.test(rel)) e.respondWith(pdf(req, url));
  else if (/^(lib|icons)\//.test(rel) || rel === 'manifest.webmanifest') e.respondWith(cacheThenUpdate(req));
  /* everything else (admins.json, data.js, sw.js) always comes from the network */
});

/* the network answer, kept for later; the kept copy when offline or when the network is very slow */
async function networkFirst(req, name, key) {
  const cache = await caches.open(name);
  const net = fetch(req).then(r => { if (r.ok) cache.put(key, r.clone()); return r; });
  const kept = await cache.match(key);
  if (!kept) return net;
  return Promise.race([net.catch(() => kept), new Promise(res => setTimeout(() => res(kept), WAIT_MS))]);
}

async function cacheThenUpdate(req) {
  const cache = await caches.open(SHELL_CACHE);
  const kept = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(r => { if (r.ok) cache.put(req, r.clone()); return r; });
  if (kept) { net.catch(() => {}); return kept; }
  return net;
}

/* PDFs: whole files are kept under their versioned address; byte ranges are cut from the kept copy offline */
async function pdf(req, url) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const r = await fetch(req);
    if (r.status === 200) {
      const old = (await cache.keys()).filter(k => { const u = new URL(k.url); return u.pathname === url.pathname && u.href !== url.href; });
      await Promise.all(old.map(k => cache.delete(k)));
      cache.put(url.href, r.clone());
    }
    return r;
  } catch (err) {
    const kept = (await cache.match(url.href)) || (await cache.match(url.href, { ignoreSearch: true }));
    if (!kept) throw err;
    const range = req.headers.get('range');
    return range ? slice(kept, range) : kept;
  }
}

async function slice(res, range) {
  const buf = await res.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
  let start = m[1] === '' ? Math.max(0, buf.byteLength - +m[2]) : +m[1];
  let end = m[1] !== '' && m[2] !== '' ? Math.min(+m[2], buf.byteLength - 1) : buf.byteLength - 1;
  if (start > end) { start = 0; end = buf.byteLength - 1; }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: { 'Content-Type': 'application/pdf', 'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes' }
  });
}
