// Remote access: the startup rules (config.mjs), the preview gateway (preview.mjs) against a stand-in Astro dev server,
// and the relay proxy (relay.mjs) against a stand-in relay. Real sockets on loopback throughout.
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { COOKIE, createAuth } from '../src/auth.mjs';
import { resolveConfig } from '../src/config.mjs';
import { createPreviews } from '../src/preview.mjs';
import { createRelayProxy, relayPortFrom } from '../src/relay.mjs';

const TOKEN = 'remote-token-0123456789abcdefghijklmnopqrstuv';
const auth = createAuth({ token: TOKEN });
const session = auth.signInCookie.split(';')[0];
const cleanup = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

const config = (argv, env = {}) => resolveConfig({ argv, env, readFile: f => Buffer.from(`pem:${f}`) });

it('config: loopback over HTTP by default; previews on their own ports of the same host', () => {
  const c = config([]);
  expect(c).toMatchObject({ host: '127.0.0.1', port: 3060, origin: 'http://127.0.0.1:3060', secure: false, remote: false, tls: null });
  expect(c.previewPorts).toEqual({ from: 3100, to: 3119 });
  expect(c.previewOrigin(3100)).toBe('http://127.0.0.1:3100');
});

it('config: beyond loopback only over HTTPS, unless the user says the network is trusted', () => {
  expect(() => config(['--host', '192.168.1.5'])).toThrow(/Refusing to listen on 192.168.1.5 over plain HTTP/);
  expect(() => config(['--host', '0.0.0.0', '--origin', 'https://sq.example.com:3060'])).toThrow(/plain HTTP/); // a TLS proxy elsewhere does not count
  const lan = config(['--host', '192.168.1.5', '--allow-insecure-http']);
  expect(lan).toMatchObject({ origin: 'http://192.168.1.5:3060', remote: true, allowInsecure: true });
  const tls = config(['--host', '0.0.0.0', '--origin', 'https://sq.example.com:3060', '--tls-cert', 'c.pem', '--tls-key', 'k.pem']);
  expect(tls).toMatchObject({ origin: 'https://sq.example.com:3060', secure: true, remote: true });
  expect(String(tls.tls.cert)).toBe('pem:c.pem');
  expect(tls.previewOrigin(3101)).toBe('https://sq.example.com:3101');
  // A TLS reverse proxy on THIS machine: loopback bind, https origin.
  expect(config(['--origin', 'https://sq.example.com'])).toMatchObject({ origin: 'https://sq.example.com', secure: true, remote: false });
});

it('config: the mistakes that would break or weaken it are refused with the fix', () => {
  expect(() => config(['--host', '0.0.0.0', '--allow-insecure-http'])).toThrow(/--origin/); // which address do browsers use?
  expect(() => config(['--tls-cert', 'c.pem'])).toThrow(/both --tls-cert and --tls-key/);
  expect(() => config(['--tls-cert', 'c', '--tls-key', 'k', '--origin', 'http://h:3060'])).toThrow(/must be https/);
  expect(() => config(['--origin', 'https://h/path'])).toThrow(/bare origin/);
  expect(() => config(['--preview-ports', '3050-3070'])).toThrow(/include the editor's port/);
  expect(() => config(['--preview-ports', 'lots'])).toThrow(/Bad preview port range/);
  expect(() => config(['--origin', 'https://h', '--preview-origin', 'https://h'])).toThrow(/\{port\}/);
  expect(() => config(['--origin', 'https://h', '--preview-origin', 'http://h:{port}'])).toThrow(/must use https/); // mixed content
  expect(() => config(['--origin', 'https://h:3100', '--preview-origin', 'https://h:{port}', '--preview-ports', '3100-3101', '--port', '3060'])).toThrow(/differ from the editor/);
  expect(config([], { SQ_WEB_PORT: '4000', SQ_WEB_PREVIEW_PORTS: '5000-5001' })).toMatchObject({ port: 4000, previewPorts: { from: 5000, to: 5001 } });
  expect(() => config(['--port', '6000'])).toThrow(/Browsers refuse to load port 6000/);
  expect(() => config(['--preview-ports', '6665-6669'])).toThrow(/Browsers refuse every port/);
});

async function listenOn(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  cleanup.push(() => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }));
  return server.address().port;
}
async function freeRange(size) {
  // A random high range; the gateway itself skips a port something else holds.
  const from = 40_000 + Math.floor(Math.random() * 20_000);
  return { from, to: from + size - 1 };
}

/** A stand-in for a project's Astro dev server: echoes what it was sent, plus a redirect and a WebSocket. */
async function fakeAstro() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/moved') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/new` }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': "img-src 'self'", 'set-cookie': 'site=1' }).end(`page ${req.url}`);
  });
  const wss = new WebSocketServer({ server });
  const upgrades = [];
  wss.on('connection', (ws, req) => { upgrades.push(req.headers); ws.on('message', m => ws.send(`echo:${m}`)); });
  const port = await listenOn(server);
  cleanup.push(() => wss.close());
  return { port, url: `http://127.0.0.1:${port}`, seen, upgrades };
}

async function gateway() {
  const ports = await freeRange(4);
  const editorOrigin = 'https://editor.example';
  const previews = createPreviews({ auth, editorOrigin, ports, publicOrigin: p => `http://127.0.0.1:${p}` });
  cleanup.push(() => previews.closeAll());
  return { previews, ports, editorOrigin };
}
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers }, res => {
    let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on('error', reject);
});
const wsOpen = (url, headers) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url, { headers });
  ws.once('open', () => resolve(ws)); ws.once('error', reject);
  ws.once('unexpected-response', (_q, r) => reject(new Error(String(r.statusCode))));
});

it('preview gateway: a signed-in browser gets the page; nothing private, nothing of ours reaches the dev server', async () => {
  const astro = await fakeAstro(); const { previews, ports, editorOrigin } = await gateway();
  const url = await previews.publicUrl('p', astro.url);
  expect(url).toBe(`http://127.0.0.1:${ports.from}`); // what the editor's canvas loads
  expect(await previews.publicUrl('p', `${astro.url}/about?x=1`)).toBe(`http://127.0.0.1:${ports.from}/about?x=1`);

  expect((await get(`${url}/`)).status).toBe(401); // signed out
  expect((await get(`${url}/`, { cookie: `${COOKIE}=${TOKEN}` })).status).toBe(401); // the raw token is not a session
  expect((await get(`${url}/`, { cookie: session, host: `evil.test:${ports.from}` })).status).toBe(421); // DNS rebinding
  for (const route of ['/__sq/local/pages', '/__sq/local', '/__sq/desktop-health', '/__sq/desktop-health?x']) {
    expect((await get(`${url}${route}`, { cookie: session, 'x-sq-desktop-token': 'guess' })).status).toBe(404);
  }
  expect(astro.seen).toEqual([]); // none of those reached the dev server

  const page = await get(`${url}/blog?x=1`, { cookie: `theme=dark; ${session}`, 'x-sq-desktop-token': 'guess', origin: url, referer: `${url}/` });
  expect(page.status).toBe(200); expect(page.body).toBe('page /blog?x=1');
  const sent = astro.seen.at(-1).headers;
  expect(sent.host).toBe(`127.0.0.1:${astro.port}`);
  expect(sent.cookie).toBe('theme=dark'); // the site's own cookie, never our session
  expect(sent['x-sq-desktop-token']).toBeUndefined();
  expect(sent.origin).toBe(astro.url); expect(sent.referer).toBe(`${astro.url}/`); // same-origin to Vite, as on desktop
  expect(page.headers['set-cookie']).toEqual(['site=1']);
  expect([].concat(page.headers['content-security-policy']).join(', ')).toContain(`frame-ancestors 'self' ${editorOrigin}`);
  expect([].concat(page.headers['content-security-policy']).join(', ')).toContain("img-src 'self'"); // the site's own CSP stays
  // The editor's own requests keep their origin (Astro's CORS allows exactly it).
  await get(`${url}/x`, { cookie: session, origin: editorOrigin }); expect(astro.seen.at(-1).headers.origin).toBe(editorOrigin);
  // A redirect to the dev server's own address comes back as the public one.
  expect((await get(`${url}/moved`, { cookie: session })).headers.location).toBe(`${url}/new`);
});

it('preview gateway: the canvas page\'s own HMR socket goes through; anyone else\'s does not', async () => {
  const astro = await fakeAstro(); const { previews, editorOrigin } = await gateway();
  const url = await previews.publicUrl('p', astro.url); const wsUrl = url.replace('http:', 'ws:') + '/?token=vite';
  await expect(wsOpen(wsUrl, { origin: url })).rejects.toThrow('403'); // signed out
  await expect(wsOpen(wsUrl, { origin: editorOrigin, cookie: session })).rejects.toThrow('403'); // not the canvas page
  await expect(wsOpen(wsUrl, { origin: 'https://evil.test', cookie: session })).rejects.toThrow('403');
  const ws = await wsOpen(wsUrl, { origin: url, cookie: `a=b; ${session}` });
  cleanup.push(() => ws.close());
  const reply = new Promise(r => ws.once('message', m => r(String(m))));
  ws.send('hi'); expect(await reply).toBe('echo:hi');
  expect(astro.upgrades.at(-1)).toMatchObject({ host: `127.0.0.1:${astro.port}`, origin: astro.url, cookie: 'a=b' });
});

it('preview gateway: one port per open project, kept across reopen; a port something else holds is skipped', async () => {
  const astro = await fakeAstro(); const { previews, ports } = await gateway();
  const squatter = net.createServer(); await listenOn(squatter, ports.from); // something else on this machine
  const a = await previews.publicUrl('a', astro.url); const b = await previews.publicUrl('b', astro.url);
  expect(a).toBe(`http://127.0.0.1:${ports.from + 1}`); expect(b).toBe(`http://127.0.0.1:${ports.from + 2}`);
  await previews.close('a');
  expect((await get(`${a}/`, { cookie: session }).catch(e => ({ error: e.code }))).error).toBe('ECONNREFUSED'); // closed with its project
  expect(await previews.publicUrl('a', astro.url)).toBe(a); // same origin again: the canvas keeps its paint-held swap
  expect(previews.originOf('b')).toBe(b);
});

it('preview gateway: never hands out a port browsers refuse to load', async () => {
  const astro = await fakeAstro();
  const previews = createPreviews({ auth, editorOrigin: 'https://e.example', ports: { from: 3659, to: 3660 }, publicOrigin: p => `http://127.0.0.1:${p}` });
  cleanup.push(() => previews.closeAll());
  expect(await previews.publicUrl('p', astro.url)).toBe('http://127.0.0.1:3660'); // 3659 is a "bad port"
});

it('preview gateway: state events keep their order while the preview port opens', async () => {
  const astro = await fakeAstro(); const { previews, ports } = await gateway();
  const seen = [];
  void previews.publicState('p', { id: 'p', phase: 'starting', url: null }, s => seen.push(s));
  void previews.publicState('p', { id: 'p', phase: 'running', url: astro.url }, s => seen.push(s));
  await previews.publicState('p', { id: 'p', phase: 'stopped' }, s => seen.push(s));
  expect(seen).toEqual([{ id: 'p', phase: 'starting', url: null }, { id: 'p', phase: 'running', url: `http://127.0.0.1:${ports.from}` }, { id: 'p', phase: 'stopped' }]);
});

it('relay proxy: only the relay\'s own port, only the signed-in editor', async () => {
  const relayHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-relay-')); cleanup.push(() => fs.rmSync(relayHome, { recursive: true, force: true }));
  expect(relayPortFrom(relayHome)).toBeNull();
  const relayServer = http.createServer(); const wss = new WebSocketServer({ server: relayServer });
  const seen = []; wss.on('connection', (ws, req) => { seen.push({ url: req.url, headers: req.headers }); ws.on('message', m => ws.send(`relay:${m}`)); });
  const relayPort = await listenOn(relayServer); cleanup.push(() => wss.close());
  fs.writeFileSync(path.join(relayHome, 'daemon.json'), JSON.stringify({ token: 'a'.repeat(24), wsPort: relayPort }));
  expect(relayPortFrom(relayHome)).toBe(relayPort);

  let origin; const front = http.createServer((_q, s) => s.end());
  front.on('upgrade', (req, socket, head) => { if (!proxy.upgrade(req, socket, head)) socket.destroy(); });
  origin = `http://127.0.0.1:${await listenOn(front)}`;
  const proxy = createRelayProxy({ auth, origin, relayPort: () => relayPortFrom(relayHome) });
  const at = port => `${origin.replace('http:', 'ws:')}/__sq-web/relay/${port}`;

  await expect(wsOpen(at(relayPort), { origin })).rejects.toThrow('403'); // signed out
  await expect(wsOpen(at(relayPort), { origin: 'https://evil.test', cookie: session })).rejects.toThrow('403');
  await expect(wsOpen(at(22), { origin, cookie: session })).rejects.toThrow('404'); // never another local port
  const ws = await wsOpen(at(relayPort), { origin, cookie: `x=1; ${session}` }); cleanup.push(() => ws.close());
  const reply = new Promise(r => ws.once('message', m => r(String(m))));
  ws.send('hello'); expect(await reply).toBe('relay:hello');
  expect(seen.at(-1).url).toBe('/'); // the path the relay always saw
  expect(seen.at(-1).headers.origin).toBeUndefined(); expect(seen.at(-1).headers.cookie).toBe('x=1');
});
