// `window.sqDesktop` for the browser: the same API desktop/src/preload.cjs gives the Electron renderer, carried over one
// WebSocket to web/src/server.mjs. Served as a classic script before the editor's module (so the API exists when the
// editor boots), wrapped by the server with wire.js inlined and BOOT = the values preload read synchronously.
/* global BOOT, encodeFrame, decodeFrame */
const listeners = new Map(); // channel → Set<callback>
const pending = new Map(); // call id → { resolve, reject }
let socket = null; let open = false; let queue = []; let nextId = 1; let retry = 250;

function on(channel, callback) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(callback);
  return () => listeners.get(channel)?.delete(callback);
}
function emit(channel, args) { for (const callback of listeners.get(channel) ?? []) { try { callback(...args); } catch (error) { console.error(error); } } }

function connect() {
  const url = new URL('/__sq-web/socket', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
  socket.onopen = () => { open = true; retry = 250; const q = queue; queue = []; for (const frame of q) socket.send(frame); };
  socket.onmessage = event => {
    let message; try { message = decodeFrame(event.data); } catch (error) { console.error('[sq-web] bad frame', error); return; }
    if (message.t === 'ret') {
      const call = pending.get(message.id); if (!call) return; pending.delete(message.id);
      if (message.ok) call.resolve(message.value);
      else call.reject(Object.assign(new Error(message.error?.message ?? 'Server error'), message.error?.code ? { code: message.error.code } : {}));
    } else if (message.t === 'event') emit(message.channel, message.args ?? []);
  };
  socket.onclose = () => {
    open = false;
    // In-flight calls died with the connection (the server released this page's leases): fail them, as a dead main would.
    for (const call of pending.values()) call.reject(new Error('Starquix server connection lost'));
    pending.clear();
    if (socket?.sqUnloading) return;
    setTimeout(connect, retry); retry = Math.min(retry * 2, 5000);
  };
}
function send(frame) { if (open) socket.send(frame); else queue.push(frame); }
function call(name, ...args) {
  const id = nextId++;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send(encodeFrame({ t: 'call', id, name, args })); });
}
function notify(name, ...args) { send(encodeFrame({ t: 'send', name, args })); }

// Cloudflare sign-in (desktop: a separate Electron window that main stops at the OAuth redirect). A browser tab cannot be
// watched across origins, so the user opens the sign-in in a new tab and pastes back the address Cloudflare sends them
// to (http://127.0.0.1/oauth/cloudflare?code=… — a page that does not load; the address bar holds what we need).
function signInPanel({ id, url }) {
  document.getElementById('sq-web-signin')?.remove();
  const box = document.createElement('div'); box.id = 'sq-web-signin';
  box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Connect Cloudflare');
  box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4);font:13px/1.45 system-ui,sans-serif';
  const card = document.createElement('div');
  card.style.cssText = 'width:min(440px,calc(100vw - 32px));padding:20px;border-radius:10px;background:#fff;color:#111;box-shadow:0 10px 40px rgba(0,0,0,.25);display:grid;gap:12px';
  const title = document.createElement('div'); title.textContent = 'Connect Cloudflare'; title.style.cssText = 'font-weight:600;font-size:15px';
  const step1 = document.createElement('div'); step1.textContent = '1. Sign in to Cloudflare in a new tab and allow access.';
  const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
  link.textContent = 'Open Cloudflare sign-in'; link.style.cssText = 'color:#2563eb;font-weight:500';
  const step2 = document.createElement('div');
  step2.textContent = '2. Cloudflare then sends that tab to a page that does not load. Copy its full address and paste it here.';
  const input = document.createElement('input'); input.type = 'url'; input.placeholder = 'http://127.0.0.1/oauth/cloudflare?code=…';
  input.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font:inherit';
  const error = document.createElement('div'); error.style.cssText = 'color:#b91c1c;min-height:1em';
  const row = document.createElement('div'); row.style.cssText = 'display:flex;justify-content:flex-end;gap:8px';
  const button = (text, primary) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.style.cssText = `padding:6px 12px;border-radius:6px;font:inherit;cursor:pointer;border:1px solid ${primary ? '#111' : '#ccc'};background:${primary ? '#111' : '#fff'};color:${primary ? '#fff' : '#111'}`; return b; };
  const cancel = button('Cancel'); const done = button('Connect', true);
  const close = () => { box.remove(); };
  cancel.onclick = () => { notify('cloudflare-signin', id, null); close(); };
  done.onclick = async () => {
    error.textContent = '';
    const accepted = await call('cloudflare-signin', id, input.value.trim()).catch(() => false);
    if (accepted) close(); else error.textContent = 'That is not the address Cloudflare sent you to. Copy it again from the address bar.';
  };
  row.append(cancel, done); card.append(title, step1, link, step2, input, error, row); box.append(card);
  document.body.append(box); input.focus();
}
on('cloudflare-signin', signInPanel);
on('cloudflare-signin-closed', id => { const box = document.getElementById('sq-web-signin'); if (box) box.remove(); void id; });

const stream = channel => callback => on(channel, callback);
window.sqDesktop = {
  web: true,
  mcpCommand: BOOT.mcpCommand ?? null,
  mcpServer: BOOT.mcpServer ?? null,
  mcp: { code: () => call('mcp-code'), rotate: () => call('mcp-rotate'), onCode: stream('mcp-code') },
  exists: id => call('exists', id),
  start: (id, lease, seed) => call('start', id, lease, seed),
  stop: (id, lease) => call('stop', id, lease),
  snapshot: (id, lease) => call('snapshot', id, lease),
  status: (id, lease) => call('status', id, lease),
  fetch: (...args) => call('fetch', ...args),
  abort: (...args) => call('abort', ...args),
  git: (id, lease, op, args) => call('git', id, lease, op, args),
  terminal: {
    attach: (id, lease) => call('terminal-attach', id, lease),
    input: (id, lease, data) => call('terminal-input', id, lease, data),
    resize: (id, lease, cols, rows) => call('terminal-resize', id, lease, cols, rows),
    onOutput: stream('terminal-output'),
  },
  onDiskChanged: stream('disk-changed'),
  onState: stream('state'),
  onFlushForQuit: stream('flush-for-quit'),
  quitFlushed: () => notify('quit-flushed'),
};
// A closing tab: no reconnect loop while the page unloads (the server releases its leases for the next page to adopt).
addEventListener('pagehide', () => { if (socket) socket.sqUnloading = true; });
connect();
addEventListener('pageshow', event => { if (event.persisted && !open) { if (socket) socket.sqUnloading = false; connect(); } });
