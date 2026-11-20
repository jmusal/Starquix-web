// Main-side IPC boundary: exact editor frame, route allowlist per request kind,
// and project sessions owned by (id, lease) — never by a renderer-supplied URL.
import { originOf } from './editor.mjs';
export function validateSender(event, contents, editorOrigin) {
  if (event.sender !== contents || event.senderFrame !== contents.mainFrame
      || originOf(event.senderFrame.url) !== editorOrigin) throw new Error('Unauthorized editor frame');
}
export function requestPath(kind, route, method) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || /[\\\0]/.test(route)) throw new Error('Invalid route');
  const url = new URL(route, 'http://owned.invalid');
  if (url.origin !== 'http://owned.invalid' || url.hash) throw new Error('Invalid route');
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Invalid method');
  if (kind === 'local') { if (!url.pathname.startsWith('/__sq/local/')) throw new Error('Invalid local route'); }
  else if (kind === 'bridge') { if (url.pathname !== '/scripts/bridge.js' || method !== 'GET') throw new Error('Invalid bridge read'); }
  else if (kind === 'document') { if (!['GET', 'HEAD'].includes(method) || url.pathname.startsWith('/__sq/local') || url.pathname === '/__sq/desktop-health') throw new Error('Invalid document read'); }
  else throw new Error('Invalid request kind');
  return url.pathname + url.search;
}
export function createSessions({ projects, spawn, emit, graceMs = 30_000, onOpen = () => {}, onClose = () => {} }) {
  const entries = new Map(); let closing = false;
  function get(id, lease) {
    const entry = entries.get(id);
    if (!entry || entry.lease !== lease || entry.controller.signal.aborted) throw new Error('Stale instance lease');
    return entry;
  }
  function start(id, lease, seed) {
    if (closing || typeof lease !== 'string' || !/^[\w-]{1,100}$/.test(lease)) throw new Error('Invalid lease');
    onOpen(id); // the terminal: cancel its pending kill, other projects' shells go
    const old = entries.get(id);
    if (old?.lease === lease) return old.ready;
    // A reloaded editor adopts the instance its departed document released (no reboot).
    if (old?.released && !old.stopping) {
      clearTimeout(old.released); old.released = null; old.lease = lease;
      // The new document never saw this instance's states: announce the current one.
      void old.ready.then(() => { if (entries.get(id) === old && old.lease === lease) emit({ id, lease, ...old.instance.state() }); }, () => {});
      return old.ready;
    }
    // A released owner (its document navigated away) is still stopping: queue behind it.
    if (old?.stopping) return old.stopping.then(() => start(id, lease, seed));
    if (old) throw new Error('Project still owned');
    const entry = { id, lease, controller: new AbortController(), instance: null, requests: new Map(), ready: null, seeded: null };
    entries.set(id, entry);
    entry.seeded = projects.seed(id, seed, entry.controller.signal); // the terminal starts in it, Astro or not
    void entry.seeded.catch(() => {});
    entry.ready = (async () => {
      const projectDir = await entry.seeded;
      entry.controller.signal.throwIfAborted();
      entry.instance = spawn({ projectId: id, lease, projectDir,
        onState: state => { if (entries.get(id) === entry && !entry.controller.signal.aborted) emit({ id, lease: entry.lease, ...state }); } });
      const result = await entry.instance.ready;
      entry.controller.signal.throwIfAborted(); return result;
    })();
    void entry.ready.catch(() => {}); return entry.ready;
  }
  function stop(id, lease) {
    const entry = entries.get(id); if (!entry || entry.lease !== lease) return Promise.resolve();
    clearTimeout(entry.released);
    entry.stopping ??= (async () => {
      entry.controller.abort();
      for (const c of entry.requests.values()) c.abort();
      await entry.instance?.stop();
      await entry.ready.catch(() => {});
      await entry.instance?.stop();
      if (entries.get(id) === entry) { entries.delete(id); onClose(id); }
    })();
    return entry.stopping;
  }
  function release(e) {
    if (e.stopping || e.released) return;
    for (const c of e.requests.values()) c.abort();
    e.requests.clear(); e.lease = `released-${e.lease}`; // the departed document's lease is now stale
    e.released = setTimeout(() => void stop(e.id, e.lease), graceMs);
  }
  const stopAll = () => Promise.all([...entries.values()].map(e => stop(e.id, e.lease)));
  return { start, stop, get,
    /** The editor document went away (reload/navigation): its leases die with it
     *  (in-flight requests aborted, a fresh unguessable lease is required), but the
     *  instance waits graceMs for the next document to adopt it — a reload does not
     *  reboot Astro. Accepted-but-unmaterialized edits stay in the renderer's durable journal. */
    async releaseAll() { for (const e of entries.values()) release(e); },
    /** One document's lease only (web/src/server.mjs: a browser tab that went away while other tabs stay). */
    async release(id, lease) { const e = entries.get(id); if (e && e.lease === lease) release(e); },
    async closeAll() { closing = true; await stopAll(); },
  };
}
export async function responseBytes(response, limit = 50 * 1024 * 1024) {
  const reader = response.body?.getReader(); const chunks = []; let length = 0;
  if (reader) try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > limit) { await reader.cancel(); throw new Error('Instance response too large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes.buffer;
}
