// The preview gateway: each open project's canvas, reachable from any browser that can reach the editor.
// Desktop loads the canvas straight from the project's Astro dev server on 127.0.0.1:<port>. Here each project gets a
// public port of its own on the server's host, proxied to that dev server (pages, modules and Vite's HMR socket).
//
// Why a port per project and not a path on the editor's origin: Astro pages use root-absolute URLs (/_astro/…,
// /@vite/client, links to /about), and the canvas must stay a DIFFERENT origin from the editor, as on desktop, so a
// site's own scripts never reach window.sqDesktop. Ports are different origins but the same site, so the editor's
// SameSite=Strict session cookie still reaches them.
//
// Every request needs that cookie. Astro's private routes (/__sq/local/*, the health probe) are never forwarded: the
// server reaches those itself with the per-instance secret, which no browser ever holds.
import http from 'node:http';
import https from 'node:https';
import { withoutSession } from './auth.mjs';
import { refuse, tunnel } from './tunnel.mjs';

const PRIVATE = /^\/__sq\/(local\/|local$|desktop-health(?:$|[/?]))/;
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 }); // a canvas loads hundreds of modules

/** Ports every browser refuses to load (the Fetch standard's "bad ports"): a canvas there would never appear. */
export const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103,
  104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

export function parsePorts(spec) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(spec).trim());
  if (!m) throw new Error(`Bad preview port range: ${spec}`);
  const from = Number(m[1]); const to = Number(m[2] ?? m[1]);
  if (from < 1 || to > 65535 || from > to || to - from > 1000) throw new Error(`Bad preview port range: ${spec}`);
  return { from, to };
}

/**
 * `publicOrigin(port)` → the origin a browser uses for that preview port (e.g. https://host:3100).
 * `listen(server, port)` binds a listener (tests inject it); `tls` = { cert, key } serves HTTPS.
 */
export function createPreviews({ auth, editorOrigin, publicOrigin, ports, bindHost = '127.0.0.1', tls = null }) {
  const entries = new Map(); // project id → { port, server, publicOrigin, publicHost, target: 'http://127.0.0.1:N' | null, ready }
  const preferred = new Map(); // project id → the port it had last (its canvas keeps one origin across reopens)
  const chains = new Map(); // project id → promise: state events stay in order across the async open

  const busy = port => [...entries.values()].some(e => e.port === port);
  /** The project's last port when free (its canvas keeps one origin across reopens), else the first free one. */
  function pickPort(id, tried) {
    const free = p => !busy(p) && !tried.has(p) && !BAD_PORTS.has(p);
    const last = preferred.get(id);
    if (last !== undefined && free(last)) return last;
    for (let p = ports.from; p <= ports.to; p++) if (free(p)) return p;
    return null;
  }

  function open(id) {
    const existing = entries.get(id); if (existing) return existing.ready;
    const tried = new Set();
    const attempt = () => {
      const port = pickPort(id, tried); // `tried`: ports something else on this machine already holds
      if (port === null) return Promise.reject(new Error(`No free preview port in ${ports.from}-${ports.to} (SQ_WEB_PREVIEW_PORTS)`));
      tried.add(port);
      const origin = publicOrigin(port);
      const entry = { id, port, publicOrigin: origin, publicHost: new URL(origin).host, target: null, server: null };
      const handler = (req, res) => handle(entry, req, res);
      entry.server = tls ? https.createServer({ ...tls }, handler) : http.createServer(handler);
      entry.server.on('upgrade', (req, socket, head) => upgrade(entry, req, socket, head));
      entry.server.on('clientError', (_error, socket) => socket.destroy());
      entries.set(id, entry);
      entry.ready = new Promise((resolve, reject) => {
        entry.server.once('error', error => {
          entries.delete(id);
          if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(attempt()); else reject(error);
        });
        entry.server.listen(port, bindHost, () => { preferred.set(id, port); resolve(entry); });
      });
      return entry.ready;
    };
    const ready = attempt();
    void ready.catch(() => {});
    return ready;
  }

  /** The URL the browser uses for an instance URL the supervisor published (http://127.0.0.1:N/…). */
  async function publicUrl(id, internalUrl) {
    if (typeof internalUrl !== 'string' || !internalUrl) return internalUrl;
    const entry = await open(id);
    const inner = new URL(internalUrl).origin;
    entry.target = inner;
    return entry.publicOrigin + (internalUrl.startsWith(inner) ? internalUrl.slice(inner.length) : '');
  }

  /** A state/status object with its url made public; order-preserving per project. */
  function publicState(id, state, deliver) {
    const prev = chains.get(id) ?? Promise.resolve();
    const next = prev.then(async () => {
      if (state && typeof state.url === 'string' && state.url) deliver({ ...state, url: await publicUrl(id, state.url) });
      else deliver(state);
    }).catch(error => { console.error('[sq-web preview]', error); deliver({ ...state, url: null }); });
    chains.set(id, next);
    return next;
  }

  function handle(entry, req, res) {
    // DNS rebinding: only the host this preview was announced on.
    if (req.headers.host !== entry.publicHost) { res.writeHead(421, { 'content-type': 'text/plain' }).end('Misdirected request'); return; }
    if (!auth.signedIn(req)) { res.writeHead(401, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end('Sign in to Starquix first'); return; }
    let pathname; try { pathname = new URL(req.url, entry.publicOrigin).pathname; } catch { res.writeHead(400).end(); return; }
    if (PRIVATE.test(pathname)) { res.writeHead(404).end(); return; }
    if (!entry.target) { res.writeHead(503, { 'retry-after': '1' }).end('Preview starting'); return; }
    const target = new URL(entry.target);
    const headers = { ...req.headers, host: target.host };
    delete headers['x-sq-desktop-token'];
    const cookie = withoutSession(req.headers.cookie); if (cookie) headers.cookie = cookie; else delete headers.cookie;
    // The page's own requests look same-origin to Vite (as on desktop); the editor's keep their origin (Astro's CORS allows it).
    if (headers.origin === entry.publicOrigin) headers.origin = target.origin;
    if (typeof headers.referer === 'string' && headers.referer.startsWith(entry.publicOrigin)) headers.referer = target.origin + headers.referer.slice(entry.publicOrigin.length);
    const upstream = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers, agent }, up => {
      const out = { ...up.headers };
      if (typeof out.location === 'string' && out.location.startsWith(target.origin)) out.location = entry.publicOrigin + out.location.slice(target.origin.length);
      // Only the editor (and the preview itself) may frame the canvas.
      const ancestors = `frame-ancestors 'self' ${editorOrigin}`;
      out['content-security-policy'] = out['content-security-policy'] ? [].concat(out['content-security-policy'], ancestors) : ancestors;
      res.writeHead(up.statusCode ?? 502, up.statusMessage, out);
      up.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Preview unavailable'); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  }

  function upgrade(entry, req, socket, head) {
    // Vite's HMR socket, opened by the canvas page itself: its own origin, signed in, the announced host.
    if (req.headers.host !== entry.publicHost || req.headers.origin !== entry.publicOrigin || !auth.signedIn(req)) { refuse(socket, 403, 'Forbidden'); return; }
    if (!entry.target) { refuse(socket, 503, 'Service Unavailable'); return; }
    const target = new URL(entry.target);
    tunnel(req, socket, head, { port: Number(target.port), host: target.hostname, rewrite: (name, value) => {
      if (name === 'host') return target.host;
      if (name === 'origin') return target.origin; // desktop-guard.mjs accepts only the instance's own origin
      if (name === 'cookie') return withoutSession(value);
      if (name === 'x-sq-desktop-token') return undefined;
      return value;
    } });
  }

  async function close(id) {
    const entry = entries.get(id); if (!entry) return;
    entries.delete(id); chains.delete(id);
    await new Promise(resolve => { entry.server.close(() => resolve()); entry.server.closeAllConnections?.(); });
  }

  return {
    open, publicUrl, publicState, close,
    async closeAll() { await Promise.all([...entries.keys()].map(close)); agent.destroy(); },
    /** Test/diagnostics: the public origin a project's canvas is on. */
    originOf: id => entries.get(id)?.publicOrigin ?? null,
  };
}
