import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { decodeFrame, encodeFrame } from '../client/wire.js';
import { createKeychain, loadKey } from '../src/secrets.mjs';
import { clientScript, createHttpHandler, injectClient, safeNext, signInPage } from '../src/http.mjs';
import { COOKIE, createAuth, createLimiter, parseCookies, sameSecret, withoutSession } from '../src/auth.mjs';
import { createRpc } from '../src/rpc.mjs';
import { createSignIn } from '../src/signin.mjs';
import { codeFromRedirect } from '../../desktop/src/cloudflare.mjs';

const TOKEN = 'unit-token-0123456789abcdefghijklmnopqrstuv';
const cleanup = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-web-unit-')); cleanup.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

it('the wire keeps bytes as bytes, ArrayBuffers as ArrayBuffers, Buffers as Uint8Arrays', () => {
  const ab = new Uint8Array([9, 8, 7]).buffer;
  const value = { files: { 'a.txt': new TextEncoder().encode('héllo'), 'b.bin': Buffer.from([0, 255]) }, body: ab,
    view: new Uint8Array([1, 2, 3, 4]).subarray(1, 3), list: [1, 'x', null, { nested: new Uint8Array(0) }], s: '\u0000sq' };
  const back = decodeFrame(encodeFrame(value));
  expect(back.files['a.txt']).toBeInstanceOf(Uint8Array); expect(new TextDecoder().decode(back.files['a.txt'])).toBe('héllo');
  expect([...back.files['b.bin']]).toEqual([0, 255]); expect(Buffer.isBuffer(back.files['b.bin'])).toBe(false);
  expect(back.body).toBeInstanceOf(ArrayBuffer); expect([...new Uint8Array(back.body)]).toEqual([9, 8, 7]);
  expect([...back.view]).toEqual([2, 3]); // a view sends only its own window of the buffer
  expect(back.list).toEqual([1, 'x', null, { nested: new Uint8Array(0) }]); expect(back.s).toBe('\u0000sq');
  expect(decodeFrame(encodeFrame(undefined))).toBe(null);
  expect(() => decodeFrame(new Uint8Array([0, 0, 0, 9, 1]))).toThrow('Bad frame');
});

it('sign-ins are encrypted at rest under a key created once', () => {
  const dir = tempDir(); const file = path.join(dir, 'secret.key');
  const key = loadKey(file); expect(key).toHaveLength(32); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(loadKey(file).equals(key)).toBe(true);
  const chain = createKeychain(key); const blob = chain.encrypt('gho_secret');
  expect(blob.includes(Buffer.from('gho_secret'))).toBe(false);
  expect(chain.decrypt(blob)).toBe('gho_secret');
  blob[blob.length - 1] ^= 1; expect(() => chain.decrypt(blob)).toThrow(); // tampered
  expect(() => createKeychain(loadKey(path.join(dir, 'other.key'))).decrypt(chain.encrypt('x'))).toThrow(); // another key
});

it('cookies, secret comparison and the shim tag', () => {
  expect(parseCookies('a=1; sq_web_session=x%20y; bad; =z')).toEqual({ a: '1', sq_web_session: 'x y' });
  expect(sameSecret(TOKEN, TOKEN)).toBe(true); expect(sameSecret(TOKEN, TOKEN.slice(1))).toBe(false); expect(sameSecret(TOKEN, undefined)).toBe(false);
  expect(withoutSession(`a=1; ${COOKIE}=s; b=2`)).toBe('a=1; b=2'); expect(withoutSession(`${COOKIE}=s`)).toBeUndefined();
  expect(injectClient('<html><head lang="x"><title>t</title></head>')).toBe('<html><head lang="x">\n    <script src="/__sq-web/client.js"></script><title>t</title></head>');
  const script = clientScript({ mcpCommand: '</script><script>alert(1)</script>', mcpServer: null });
  expect(script).not.toContain('</script>'); expect(script).not.toMatch(/^export /m);
});

it('the shim gives the editor the preload API before any script runs', () => {
  const sent = []; const window = {};
  class FakeSocket { constructor() { this.readyState = 0; } send(f) { sent.push(decodeFrame(f)); } }
  const run = new Function('window', 'location', 'WebSocket', 'addEventListener', 'document', clientScript({ mcpCommand: '"/x/starquix-mcp"', mcpServer: null }));
  run(window, new URL('http://127.0.0.1:3060/editor/p'), FakeSocket, () => {}, {});
  const api = window.sqDesktop;
  for (const key of ['exists', 'start', 'stop', 'snapshot', 'status', 'fetch', 'abort', 'git', 'onState', 'onDiskChanged', 'onFlushForQuit', 'quitFlushed'])
    expect(typeof api[key]).toBe('function');
  expect(api.mcpCommand).toBe('"/x/starquix-mcp"');
  expect(Object.keys(api.terminal)).toEqual(['attach', 'input', 'resize', 'onOutput']);
  expect(Object.keys(api.mcp)).toEqual(['code', 'rotate', 'onCode']);
  void api.exists('p'); expect(sent).toEqual([]); // queued until the socket opens
});

async function listen(handler, upgrade) {
  const server = http.createServer(handler); if (upgrade) server.on('upgrade', upgrade);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return server.address().port;
}

it('the session cookie is derived from the token, never the token itself; a new token signs every browser out', () => {
  const auth = createAuth({ token: TOKEN, secure: true });
  expect(auth.signInCookie).not.toContain(TOKEN);
  expect(auth.signInCookie).toMatch(/HttpOnly/); expect(auth.signInCookie).toMatch(/SameSite=Strict/); expect(auth.signInCookie).toMatch(/Secure/);
  const cookie = auth.signInCookie.split(';')[0];
  expect(auth.signedIn({ headers: { cookie } })).toBe(true);
  expect(auth.signedIn({ headers: { cookie: `${COOKIE}=${TOKEN}` } })).toBe(false); // the raw token is not a session
  expect(createAuth({ token: TOKEN.replace('u', 'v') }).signedIn({ headers: { cookie } })).toBe(false);
  expect(() => createAuth({ token: 'short' })).toThrow('at least 32');
});

it('failed sign-ins are limited for the whole server, and the limit lifts after its window', () => {
  let t = 0; const limiter = createLimiter({ max: 3, windowMs: 1000, now: () => t });
  for (let i = 0; i < 3; i++) { expect(limiter.blocked()).toBe(false); limiter.fail(); }
  expect(limiter.blocked()).toBe(true); expect(limiter.retryAfter()).toBe(1);
  t = 1000; expect(limiter.blocked()).toBe(false);
});

it('a sign-in only ever returns to a path on this origin', () => {
  expect(safeNext('/editor/p?x=1')).toBe('/editor/p?x=1');
  for (const evil of ['//evil.test/x', '/\\evil.test', 'https://evil.test', 'javascript:alert(1)', '/__sq-web/logout', undefined]) expect(safeNext(evil)).toBe('/');
  expect(signInPage({ next: '"><script>alert(1)</script>' })).not.toContain('<script>alert');
});

async function editorServer({ secure = false } = {}) {
  const dir = tempDir(); fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>editor</body></html>');
  fs.mkdirSync(path.join(dir, 'assets')); fs.writeFileSync(path.join(dir, 'assets/a.js'), 'x');
  let handle; const port = await listen((req, res) => handle(req, res));
  const origin = `http://127.0.0.1:${port}`;
  const auth = createAuth({ token: TOKEN, secure, limiter: createLimiter({ max: 3 }) });
  handle = createHttpHandler({ auth, origin, editor: { dir }, boot: () => ({ mcpCommand: null, mcpServer: null }) });
  return { origin, auth };
}
const post = (url, form, headers = {}) => fetch(url, { method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form).toString() });

it('the HTTP gate: the token link or the sign-in form signs in once; nothing else is served signed out', async () => {
  const { origin } = await editorServer();
  expect((await fetch(`${origin}/assets/a.js`)).status).toBe(401);
  const page = await fetch(`${origin}/editor/p`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  expect(page.status).toBe(303); expect(page.headers.get('location')).toBe('/__sq-web/login?next=%2Feditor%2Fp');
  const form = await fetch(`${origin}/__sq-web/login?next=%2Feditor%2Fp`);
  expect(await form.text()).toContain('name="token"'); expect(form.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");

  const login = await fetch(`${origin}/editor/p?token=${TOKEN}&x=1`, { redirect: 'manual' });
  expect(login.status).toBe(303); expect(login.headers.get('location')).toBe('/editor/p?x=1');
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0] };
  const editor = await fetch(`${origin}/editor/p`, { headers }); // a SPA route: index.html, with the shim and the CSP
  expect(await editor.text()).toContain('<script src="/__sq-web/client.js"></script>');
  expect(editor.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(editor.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  const asset = await fetch(`${origin}/assets/a.js`, { headers });
  expect(asset.headers.get('content-type')).toMatch(/javascript/); expect(asset.headers.get('cache-control')).toMatch(/immutable/);
  expect((await fetch(`${origin}/__sq-web/client.js`, { headers })).status).toBe(200);
  // An encoded escape stays inside the build folder (an extensionless miss is the SPA's index.html, never the file).
  for (const evil of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/assets/..%2f..%2f..%2fetc%2fhosts.txt']) {
    expect(await (await fetch(`${origin}${evil}`, { headers })).text()).not.toMatch(/root:|localhost/);
  }
  // Sign out: the cookie is cleared, only from this origin.
  expect((await post(`${origin}/__sq-web/logout`, {}, { ...headers, origin: 'https://evil.test' })).status).toBe(405);
  const out = await post(`${origin}/__sq-web/logout`, {}, { ...headers, origin });
  expect(out.status).toBe(303); expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
});

it('the sign-in form: right token signs in, wrong ones are counted, another site cannot post it', async () => {
  const { origin } = await editorServer();
  expect((await post(`${origin}/__sq-web/login`, { token: TOKEN }, { origin: 'https://evil.test' })).status).toBe(403); // login CSRF
  expect((await post(`${origin}/__sq-web/login`, { token: TOKEN }, { origin: 'null', 'sec-fetch-site': 'cross-site' })).status).toBe(403);
  expect((await post(`${origin}/__sq-web/login`, { token: TOKEN })).status).toBe(403); // no origin at all, nothing to vouch for it
  // A real browser's own form: Origin can be "null" (referrer policy); Sec-Fetch-Site still says same-origin.
  expect((await post(`${origin}/__sq-web/login`, { token: TOKEN }, { origin: 'null', 'sec-fetch-site': 'same-origin' })).status).toBe(303);
  const good = await post(`${origin}/__sq-web/login`, { token: TOKEN, next: '/editor/p' }, { origin });
  expect(good.status).toBe(303); expect(good.headers.get('location')).toBe('/editor/p'); expect(good.headers.get('set-cookie')).toMatch(/sq_web_session=/);
  expect((await post(`${origin}/__sq-web/login`, { token: TOKEN, next: '//evil.test' }, { origin })).headers.get('location')).toBe('/');
  for (let i = 0; i < 3; i++) expect((await post(`${origin}/__sq-web/login`, { token: 'wrong' }, { origin })).status).toBe(401);
  const limited = await post(`${origin}/__sq-web/login`, { token: TOKEN }, { origin }); // even the right token waits now
  expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBeTruthy();
  expect((await fetch(`${origin}/?token=${TOKEN}`, { redirect: 'manual' })).status).not.toBe(303); // the link waits too
});

it('HTTPS deployments get HSTS', async () => {
  const { origin } = await editorServer({ secure: true });
  expect((await fetch(`${origin}/__sq-web/login`)).headers.get('strict-transport-security')).toMatch(/max-age=/);
});

it('the socket: calls answer with bytes and encoded errors, events reach every tab, a foreign origin is refused', async () => {
  let rpc; const closed = vi.fn();
  const port = await listen((_q, s) => s.end(), (req, socket, head) => { if (!rpc.upgrade(req, socket, head)) socket.destroy(); });
  const origin = `http://127.0.0.1:${port}`;
  const auth = createAuth({ token: TOKEN });
  const session = auth.signInCookie.split(';')[0];
  rpc = createRpc({ auth, origin, onClose: closed, handlers: {
    echo: ([bytes]) => ({ got: bytes, size: bytes.byteLength }),
    fail: () => { throw Object.assign(new Error('sq-git:{"code":"nothing"}'), { code: 'nothing' }); },
  } });
  cleanup.push(() => rpc.close());
  const open = headers => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__sq-web/socket`, { headers });
    ws.binaryType = 'arraybuffer'; ws.once('open', () => resolve(ws)); ws.once('error', reject); ws.once('unexpected-response', (_q, r) => reject(new Error(String(r.statusCode))));
  });
  await expect(open({ origin, cookie: `${COOKIE}=wrong` })).rejects.toThrow('403');
  await expect(open({ origin, cookie: `${COOKIE}=${TOKEN}` })).rejects.toThrow('403'); // the token is not a session
  await expect(open({ origin: 'http://evil.test', cookie: session })).rejects.toThrow('403');
  const ws = await open({ origin, cookie: session });
  const replies = [];
  ws.on('message', data => replies.push(decodeFrame(data)));
  ws.send(encodeFrame({ t: 'call', id: 1, name: 'echo', args: [new Uint8Array([5, 6]).buffer] }));
  ws.send(encodeFrame({ t: 'call', id: 2, name: 'fail', args: [] }));
  ws.send(encodeFrame({ t: 'call', id: 3, name: 'toString', args: [] })); // never a prototype method
  await vi.waitFor(() => expect(replies).toHaveLength(3));
  expect(replies.find(r => r.id === 1).value.size).toBe(2);
  expect(replies.find(r => r.id === 2)).toEqual({ t: 'ret', id: 2, ok: false, error: { message: 'sq-git:{"code":"nothing"}', code: 'nothing' } });
  expect(replies.find(r => r.id === 3).error.message).toContain('Unknown call');
  rpc.emit('state', { id: 'p', phase: 'running' });
  await vi.waitFor(() => expect(replies.at(-1)).toEqual({ t: 'event', channel: 'state', args: [{ id: 'p', phase: 'running' }] }));
  ws.close(); await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
});

it('Cloudflare sign-in: only our redirect with our state ends it; cancel and a lost tab end it too', async () => {
  const events = []; const signIn = createSignIn({ emit: (...e) => events.push(e) });
  const state = 'state-1';
  const onNavigate = vi.fn(url => codeFromRedirect(url, state) !== undefined);
  let ended = false; const closed = signIn.windows.open('https://dash.cloudflare.com/oauth2/auth?x', { onNavigate }).then(() => { ended = true; });
  const { id } = events[0][1];
  expect(signIn.answer('other-id', 'http://127.0.0.1/oauth/cloudflare?code=c&state=state-1')).toBe(false);
  expect(signIn.answer(id, 'https://example.com/')).toBe(false);
  expect(signIn.answer(id, 'javascript:alert(1)')).toBe(false);
  await Promise.resolve(); expect(ended).toBe(false);
  expect(signIn.answer(id, 'http://127.0.0.1/oauth/cloudflare?code=c&state=state-1')).toBe(true);
  await closed; expect(events.at(-1)).toEqual(['cloudflare-signin-closed', id]);
  const second = signIn.windows.open('https://dash.cloudflare.com/oauth2/auth?y', { onNavigate });
  expect(signIn.answer(events.at(-1)[1].id, null)).toBe(true); await second; // cancelled
  const third = signIn.windows.open('https://dash.cloudflare.com/oauth2/auth?z', { onNavigate });
  signIn.cancelAll(); await third; // every tab closed
});
