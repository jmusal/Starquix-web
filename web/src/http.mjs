// The web server's HTTP side: sign-in, the editor (a production build from disk, or a proxied Vite dev server), and the
// /__sq-web/client.js shim. Every editor page gets the shim injected before its own scripts.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EDITOR_CSP, editorFile } from '../../desktop/src/editor.mjs';
import { tunnel } from './tunnel.mjs';

export const CLIENT_PATH = '/__sq-web/client.js';
export const SOCKET_PATH = '/__sq-web/socket';
export const LOGIN_PATH = '/__sq-web/login';
export const LOGOUT_PATH = '/__sq-web/logout';
export const RELAY_PREFIX = '/__sq-web/relay/';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
export const contentType = file => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/** The editor's own pages: only its build's scripts (desktop's CSP), and never framed by another site. */
export const PAGE_CSP = `${EDITOR_CSP}; frame-ancestors 'self'`;

/** The editor's index.html with the shim first in <head>: window.sqDesktop exists before the editor's module runs. */
export function injectClient(html) {
  const tag = `<script src="${CLIENT_PATH}"></script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => `${m}\n    ${tag}`) : tag + html;
}

/** The shim: wire.js + client.js in one classic-script closure, with the values preload.cjs read synchronously. */
export function clientScript(boot) {
  const dir = new URL('../client/', import.meta.url);
  const strip = file => fs.readFileSync(new URL(file, dir), 'utf8').replace(/^export /gm, '');
  return `(function (BOOT) {\n'use strict';\n${strip('wire.js')}\n${strip('client.js')}\n})(${JSON.stringify(boot).replace(/</g, '\\u003c')});\n`;
}

/** A same-origin path to return to after sign-in; anything else (another site, a protocol-relative URL) is "/". */
export function safeNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.length > 2048) return '/';
  if (value.startsWith('/__sq-web/')) return '/';
  return value;
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const SIGN_IN_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The sign-in page: paste the access token (it never has to appear in a URL), or open the printed link. */
export function signInPage({ next = '/', error = '' } = {}) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Starquix</title>
<style>
:root{color-scheme:light dark;--bg:#f7f7f7;--card:#fff;--fg:#111;--muted:#666;--line:#d4d4d4;--accent:#111;--accent-fg:#fff;--err:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#151515;--card:#1e1e1e;--fg:#eee;--muted:#a3a3a3;--line:#3a3a3a;--accent:#eee;--accent-fg:#111;--err:#f87171}}
*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);padding:16px}
form{width:min(380px,100%);background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;display:grid;gap:12px}
h1{font-size:18px;margin:0}p{margin:0;color:var(--muted);font-size:14px}label{font-size:13px;font-weight:500}
input{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font:inherit;background:transparent;color:inherit}
button{padding:9px 12px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:500;cursor:pointer}
.err{color:var(--err);font-size:14px}code{font-size:13px}
</style>
<form method="post" action="${LOGIN_PATH}">
<h1>Sign in to Starquix</h1>
<p>Paste the access token the Starquix server printed when it started (also in <code>~/.starquix-web/access-token</code> on that machine).</p>
<label for="token">Access token</label>
<input id="token" name="token" type="password" autocomplete="current-password" autofocus required>
<input type="hidden" name="next" value="${escapeHtml(next)}">
${error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ''}
<button type="submit">Sign in</button>
</form></html>`;
}

/** A form post from this origin's own pages (login CSRF, sign-out). Browsers send Origin on a same-origin POST, but
 *  `null` under some referrer policies; their Sec-Fetch-Site says the same thing and no page can forge it. */
export function sameOriginPost(req, origin) {
  if (req.headers.origin === origin) return true;
  const unusable = req.headers.origin === undefined || req.headers.origin === 'null';
  return unusable && req.headers['sec-fetch-site'] === 'same-origin';
}

async function readForm(req, limit = 4096) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(chunk); }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The request handler for everything but the WebSockets.
 * `editor`: { dir } (a production build) or { devUrl } (a Vite dev server to proxy; its HMR is `proxyDevUpgrade`).
 */
export function createHttpHandler({ auth, origin, editor, boot }) {
  const canonical = new URL(origin);
  const base = auth.secure ? { 'strict-transport-security': 'max-age=31536000' } : {};
  let shim = null; // built once per process (dev: rebuilt each time, the shim's files may be edited)

  function page(res, status, html, extra = {}) {
    res.writeHead(status, { ...base, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': SIGN_IN_CSP, 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff', ...extra }).end(html);
  }
  const signedInRedirect = (res, next) => res.writeHead(303, { ...base, 'set-cookie': auth.signInCookie, location: safeNext(next),
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();

  async function signIn(req, res, url) {
    if (req.method === 'GET') { page(res, 200, signInPage({ next: safeNext(url.searchParams.get('next')) })); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'GET, POST' }).end(); return; }
    // A form on another site cannot sign this browser in (login CSRF): the form must come from this origin.
    if (!sameOriginPost(req, origin)) { page(res, 403, signInPage({ error: 'Sign in from this page.' })); return; }
    if (auth.limiter.blocked()) { page(res, 429, signInPage({ error: 'Too many failed attempts. Wait a minute and try again.' }), { 'retry-after': String(auth.limiter.retryAfter()) }); return; }
    const form = await readForm(req);
    const next = safeNext(form.get('next'));
    if (!auth.isToken(form.get('token') ?? '')) { auth.limiter.fail(); page(res, 401, signInPage({ next, error: 'That token is not right.' })); return; }
    signedInRedirect(res, next);
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, origin);
      // One origin only: the Astro children allow exactly it (CORS), and a foreign Host (DNS rebinding) never gets a page.
      if (req.headers.host !== canonical.host) {
        res.writeHead(307, { location: new URL(url.pathname + url.search, origin).href }).end(); return;
      }
      // The printed link (`?token=<ours>`) signs this browser in, then the address bar drops it. Any other `token`
      // query (Vite's own) is just a query.
      const given = url.searchParams.get('token');
      if (given !== null && req.method === 'GET') {
        if (auth.isToken(given) && !auth.limiter.blocked()) {
          url.searchParams.delete('token');
          signedInRedirect(res, url.pathname === LOGIN_PATH ? '/' : url.pathname + url.search); return;
        }
        if (!auth.signedIn(req)) auth.limiter.fail();
      }
      if (url.pathname === LOGIN_PATH) { await signIn(req, res, url); return; }
      if (url.pathname === LOGOUT_PATH) {
        if (req.method !== 'POST' || !sameOriginPost(req, origin)) { res.writeHead(405, { allow: 'POST' }).end(); return; }
        res.writeHead(303, { ...base, 'set-cookie': auth.signOutCookie, location: LOGIN_PATH, 'cache-control': 'no-store' }).end(); return;
      }
      if (!auth.signedIn(req)) {
        // Pages go to the sign-in form; anything else (a script, an asset) is a plain refusal.
        if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
          res.writeHead(303, { location: `${LOGIN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}`, 'cache-control': 'no-store' }).end();
        } else res.writeHead(401, { 'cache-control': 'no-store' }).end();
        return;
      }
      if (url.pathname === CLIENT_PATH) {
        if (!shim || editor.devUrl) shim = clientScript(boot());
        res.writeHead(200, { ...base, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(shim); return;
      }
      if (url.pathname.startsWith('/__sq-web/')) { res.writeHead(404).end(); return; }
      if (editor.devUrl) return proxyEditor(req, res, editor.devUrl);
      return serveEditor(req, res, editor.dir, url.pathname, base);
    } catch (error) {
      if (error.status) { if (!res.headersSent) res.writeHead(error.status); res.end(); return; }
      console.error('[sq-web http]', error);
      if (!res.headersSent) res.writeHead(500); res.end();
    }
  };
}

async function serveEditor(req, res, dir, pathname, base) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; } // as the packaged editor answers it
  const file = await editorFile(dir, pathname);
  if (!file) { res.writeHead(404).end('Not found'); return; }
  const headers = { ...base, 'content-type': contentType(file), 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff' };
  if (file.endsWith('.html')) {
    const html = injectClient(await fs.promises.readFile(file, 'utf8'));
    res.writeHead(200, { ...headers, 'cache-control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : html); return;
  }
  // Vite's hashed build output never changes under its name.
  headers['cache-control'] = /\/assets\//.test(file.split(path.sep).join('/')) ? 'public, max-age=31536000, immutable' : 'no-cache';
  const stat = await fs.promises.stat(file); headers['content-length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

/** Development: the editor from `vite` (npm run dev in app/), through this origin so the shim and the socket share it. */
function proxyEditor(req, res, devUrl) {
  const target = new URL(devUrl);
  const headers = { ...req.headers, host: target.host };
  delete headers.cookie; // our session cookie is ours, never the dev server's
  delete headers['accept-encoding']; // HTML gets rewritten: plain bytes
  const upstream = http.request({ hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers }, up => {
    const type = up.headers['content-type'] ?? '';
    if (type.includes('text/html')) {
      const chunks = []; up.on('data', c => chunks.push(c));
      up.on('end', () => {
        const body = injectClient(Buffer.concat(chunks).toString('utf8'));
        const out = { ...up.headers }; delete out['content-length'];
        res.writeHead(up.statusCode ?? 502, out).end(body);
      });
      return;
    }
    res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res);
  });
  upstream.on('error', error => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end(`Editor dev server unreachable: ${error.message}`); });
  req.pipe(upstream);
}

/** Development: Vite's HMR socket for the editor itself. */
export function proxyDevUpgrade(req, socket, head, devUrl) {
  const target = new URL(devUrl);
  tunnel(req, socket, head, { port: Number(target.port), host: target.hostname,
    rewrite: (name, value) => (name === 'cookie' ? undefined : name === 'host' ? target.host : value) });
}
