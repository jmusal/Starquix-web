// The web server's HTTP side: access-token login, the editor (a production build from disk, or a proxied Vite dev
// server), and the /__sq-web/client.js shim. Every editor page gets the shim injected before its own scripts.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { EDITOR_CSP, editorFile } from '../../desktop/src/editor.mjs';

export const COOKIE = 'sq_web_auth';
export const CLIENT_PATH = '/__sq-web/client.js';
export const SOCKET_PATH = '/__sq-web/socket';
export const LOGIN_PATH = '/__sq-web/login';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
export const contentType = file => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const key = part.slice(0, i).trim(); if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed: ignored */ }
  }
  return out;
}

export function tokenMatches(token, value) {
  if (typeof value !== 'string' || value.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(token));
}

export const authorized = (req, token) => tokenMatches(token, parseCookies(req.headers.cookie)[COOKIE]);

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

const SIGNED_OUT = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Starquix</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f7f7;color:#111}
main{max-width:420px;padding:24px}code{background:#e9e9e9;padding:1px 5px;border-radius:4px}
@media (prefers-color-scheme:dark){body{background:#151515;color:#eee}code{background:#2a2a2a}}</style>
<main><h1 style="font-size:18px">Starquix</h1><p>Open the link the Starquix server printed in its terminal (it ends with <code>?token=…</code>).</p></main>`;

/**
 * The request handler for everything but the WebSocket.
 * `editor`: { dir } (a production build) or { devUrl } (a Vite dev server to proxy, HMR included — see `upgrade`).
 */
export function createHttpHandler({ token, origin, editor, boot, secure = false }) {
  const canonical = new URL(origin);
  const cookie = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}; Max-Age=31536000`;
  let shim = null; // built once per process (dev: rebuilt each time, the shim's files may be edited)

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, origin);
      // One origin only: the Astro children allow exactly it (CORS), and a foreign Host (DNS rebinding) never gets a page.
      if (req.headers.host !== canonical.host) {
        res.writeHead(307, { location: new URL(url.pathname + url.search, origin).href }).end(); return;
      }
      // The printed link (`?token=<ours>`) signs this browser in. Any other `token` query (Vite's own) is just a query.
      const given = url.searchParams.get('token');
      if (given !== null && tokenMatches(token, given)) {
        url.searchParams.delete('token');
        const next = url.pathname === LOGIN_PATH ? '/' : url.pathname + (url.search || '');
        res.writeHead(303, { 'set-cookie': cookie, location: next, 'cache-control': 'no-store' }).end(); return;
      }
      if (url.pathname === LOGIN_PATH || !authorized(req, token)) { res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(SIGNED_OUT); return; }
      if (url.pathname === CLIENT_PATH) {
        if (!shim || editor.devUrl) shim = clientScript(boot());
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }).end(shim); return;
      }
      if (url.pathname.startsWith('/__sq-web/')) { res.writeHead(404).end(); return; }
      if (editor.devUrl) return proxyEditor(req, res, editor.devUrl);
      return serveEditor(req, res, editor.dir, url.pathname);
    } catch (error) {
      console.error('[sq-web http]', error);
      if (!res.headersSent) res.writeHead(500); res.end();
    }
  };
}

async function serveEditor(req, res, dir, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; } // as the packaged editor answers it
  const file = await editorFile(dir, pathname);
  if (!file) { res.writeHead(404).end('Not found'); return; }
  const headers = { 'content-type': contentType(file), 'content-security-policy': EDITOR_CSP, 'x-content-type-options': 'nosniff' };
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
  delete headers.cookie; // our auth cookie is ours, never the dev server's
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

/** Development: Vite's HMR socket, piped through unchanged. */
export function proxyUpgrade(req, socket, head, devUrl) {
  const target = new URL(devUrl);
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const [key, value] = [req.rawHeaders[i], req.rawHeaders[i + 1]];
      if (/^cookie$/i.test(key)) continue;
      lines.push(`${key}: ${/^host$/i.test(key) ? target.host : value}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n'); if (head?.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  const end = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', end); socket.on('error', end);
}
