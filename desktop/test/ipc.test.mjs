import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import { validateSender, requestPath, createSessions } from '../src/ipc.mjs';
import { privateFetch } from '../src/supervisor.mjs';
import { uncaughtDuring } from './helpers/uncaught.mjs';

const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections(); s.close(r); }))); });
async function serve(handler) {
  const server = http.createServer(handler); servers.push(server);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

it('requires the exact editor top frame and exact origin', () => {
  const frame = { url: 'http://127.0.0.1:3061/editor/p' };
  const sender = { mainFrame: frame };
  expect(() => validateSender({ sender, senderFrame: frame }, sender, 'http://127.0.0.1:3061')).not.toThrow();
  expect(() => validateSender({ sender, senderFrame: { ...frame } }, sender, 'http://127.0.0.1:3061')).toThrow();
  expect(() => validateSender({ sender: {}, senderFrame: frame }, sender, 'http://127.0.0.1:3061')).toThrow();
  frame.url = 'https://foreign.test';
  expect(() => validateSender({ sender, senderFrame: frame }, sender, 'http://127.0.0.1:3061')).toThrow();
});
it('authorizes the packaged starquix://app editor and nothing else on a custom scheme', () => {
  const frame = { url: 'starquix://app/editor/browser_1' }; const sender = { mainFrame: frame };
  expect(() => validateSender({ sender, senderFrame: frame }, sender, 'starquix://app')).not.toThrow();
  for (const url of ['starquix://evil/', 'data:text/html,x', 'about:blank', 'file:///x']) {
    frame.url = url; expect(() => validateSender({ sender, senderFrame: frame }, sender, 'starquix://app')).toThrow();
  }
});
it('does not turn the fetch capability into arbitrary localhost access', () => {
  expect(requestPath('local', '/__sq/local/pages?path=wc%3A%2F%2Fp', 'GET')).toContain('/__sq/local/pages');
  for (const route of ['http://127.0.0.1:9999/', '//127.0.0.1:9999/', '/__sq/local/../../etc']) {
    expect(() => requestPath('local', route, 'GET')).toThrow();
  }
  expect(() => requestPath('document', '/', 'POST')).toThrow();
  expect(() => requestPath('document', '/__sq/desktop-health', 'GET')).toThrow();
  expect(() => requestPath('bridge', '/__sq/local/pages', 'GET')).toThrow();
  expect(() => requestPath('nope', '/', 'GET')).toThrow();
});
it('stop during seed prevents spawn; stale lease cannot stop its replacement', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const projects = { seed: vi.fn(async () => { await gate; return '/owned/p'; }) };
  const spawn = vi.fn();
  const sessions = createSessions({ projects, spawn, emit() {} });
  const starting = sessions.start('p', 'first', { a: 'x' });
  const failed = expect(starting).rejects.toThrow();
  const stopping = sessions.stop('p', 'first'); release();
  await stopping; await failed; expect(spawn).not.toHaveBeenCalled();
  spawn.mockReturnValue({ ready: Promise.resolve({ url: 'http://127.0.0.1:4567', generation: 1 }), stop: vi.fn(async () => {}) });
  await sessions.start('p', 'second', { a: 'x' });
  await sessions.stop('p', 'first');
  expect(sessions.get('p', 'second')).toBeDefined();
  expect(() => sessions.get('p', 'first')).toThrow('Stale');
  await sessions.closeAll();
  expect(() => sessions.start('p', 'third')).toThrow();
});
it('never follows a redirect to another loopback server', async () => {
  let reached = 0;
  const second = await serve((_req, res) => { reached++; res.end('second'); });
  const first = await serve((_req, res) => { res.statusCode = 302; res.setHeader('Location', second + '/'); res.end(); });
  await expect(privateFetch('t', new AbortController().signal)(first + '/')).rejects.toThrow();
  expect(reached).toBe(0);
});
// 2026-11-10: on a loaded machine a live instance's first render took past the old 10 s deadline
// (5 desktop tests timed out at load ~40, and every editor request shares this deadline): a busy
// instance is waited for; only one that never answers is cut off.
it('waits for a busy instance: an answer after 12 s is not cut off', async () => {
  const url = await serve((_req, res) => { setTimeout(() => res.end('late but here'), 12_000); });
  const response = await privateFetch('t', new AbortController().signal)(url + '/');
  expect(await response.text()).toBe('late but here');
}, 30_000);
it('still cuts off an instance that never answers, at its deadline', async () => {
  const url = await serve(() => { /* never answer */ });
  const started = Date.now();
  await expect(privateFetch('t', new AbortController().signal, 300)(url + '/')).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(Date.now() - started).toBeLessThan(5_000);
});
it('forwards abort while the instance holds the headers', async () => {
  let seen;
  const url = await serve(req => { seen = req.headers['x-sq-desktop-token']; /* never answer */ });
  const c = new AbortController();
  const pending = privateFetch('secret', new AbortController().signal)(url + '/', { signal: c.signal });
  await vi.waitFor(() => expect(seen).toBe('secret'));
  c.abort();
  await expect(pending).rejects.toThrow();
});
it('forwards abort while the instance streams the body', async () => {
  const url = await serve((_req, res) => { res.writeHead(200); res.write('partial'); /* never end */ });
  const c = new AbortController();
  const response = await privateFetch('t', new AbortController().signal)(url + '/', { signal: c.signal });
  const body = response.text(); c.abort();
  await expect(body).rejects.toThrow();
});
// 2026-11-09 main-process dialog `assert(controller != null)`: undici's fetch arms its abort listener before
// its own controller exists, so an abort reaching it while fetch() is still inside its synchronous setup
// (dispatch included), or after that setup threw, is an uncaught AssertionError. A test dispatcher puts the
// abort in that window on purpose; the stack is the owner's, frame for frame.
it('an abort landing inside fetch()\'s own setup reaches undici only once fetch() has returned', async () => {
  const lifetime = new AbortController(); let outcome;
  const dispatcher = { dispatch: () => { lifetime.abort(new Error('project closed')); return true; } };
  const uncaught = await uncaughtDuring(async () => {
    outcome = await Promise.race([privateFetch('t', lifetime.signal)('http://127.0.0.1:65000/', { dispatcher }).catch(e => e.message),
      new Promise(r => setTimeout(r, 1000, 'never settled'))]);
  });
  expect(uncaught).toEqual([]);
  expect(outcome).toBe('project closed');
});
it('a fetch() whose setup threw is never aborted afterwards', async () => {
  const lifetime = new AbortController();
  expect(await uncaughtDuring(() => {
    // undici asserts the dispatcher after arming its abort listener: the setup throws synchronously
    expect(() => privateFetch('t', lifetime.signal)('http://127.0.0.1:65000/', { dispatcher: 0 })).toThrow();
    lifetime.abort();
  })).toEqual([]);
});
it('a reloaded editor adopts the running instance: no respawn, the old lease is stale', async () => {
  const instance = { ready: Promise.resolve({ url: 'http://127.0.0.1:4567', generation: 1 }), stop: vi.fn(async () => {}),
    state: () => ({ phase: 'running', pid: 42 }) };
  const spawn = vi.fn().mockReturnValue(instance); const emitted = [];
  let onState;
  spawn.mockImplementation(o => { onState = o.onState; return instance; });
  const sessions = createSessions({ projects: { seed: async () => '/owned/p' }, spawn, emit: s => emitted.push(s), graceMs: 60_000 });
  await sessions.start('p', 'old-document');
  expect(() => sessions.start('p', 'new-document')).toThrow('still owned');
  await sessions.releaseAll();
  await expect(sessions.start('p', 'new-document')).resolves.toEqual({ url: 'http://127.0.0.1:4567', generation: 1 });
  expect(spawn).toHaveBeenCalledTimes(1); expect(instance.stop).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(emitted.at(-1)).toEqual({ id: 'p', lease: 'new-document', phase: 'running', pid: 42 }));
  expect(() => sessions.get('p', 'old-document')).toThrow('Stale');
  await sessions.stop('p', 'old-document'); expect(instance.stop).not.toHaveBeenCalled(); // the departed document cannot stop it
  onState({ phase: 'running' }); expect(emitted.at(-1)).toMatchObject({ id: 'p', lease: 'new-document' });
  await sessions.closeAll(); expect(instance.stop).toHaveBeenCalled();
});
it('a released instance nobody adopts stops after the grace period', async () => {
  vi.useFakeTimers();
  try {
    const instance = { ready: Promise.resolve({ url: 'http://127.0.0.1:4567', generation: 1 }), stop: vi.fn(async () => {}) };
    const sessions = createSessions({ projects: { seed: async () => '/owned/p' }, spawn: () => instance, emit() {}, graceMs: 1000 });
    await sessions.start('p', 'old-document');
    await sessions.releaseAll();
    await vi.advanceTimersByTimeAsync(999); expect(instance.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(instance.stop).toHaveBeenCalled();
    await expect(sessions.start('p', 'late')).resolves.toBeDefined(); // a fresh boot, not the stopped one
  } finally { vi.useRealTimers(); }
});
it('releasing aborts the departed document\'s in-flight requests', async () => {
  const instance = { ready: Promise.resolve({ url: 'http://127.0.0.1:4567', generation: 1 }), stop: vi.fn(async () => {}) };
  const sessions = createSessions({ projects: { seed: async () => '/owned/p' }, spawn: () => instance, emit() {}, graceMs: 60_000 });
  await sessions.start('p', 'old-document');
  const inFlight = new AbortController(); sessions.get('p', 'old-document').requests.set('r1', inFlight);
  await sessions.releaseAll();
  expect(inFlight.signal.aborted).toBe(true);
  await sessions.closeAll();
});
it('release(id, lease) frees one document\'s project only, and only for its own lease', async () => {
  const instance = () => ({ ready: Promise.resolve({ url: 'http://127.0.0.1:4567', generation: 1 }), stop: vi.fn(async () => {}), state: () => ({ phase: 'running' }) });
  const sessions = createSessions({ projects: { seed: async () => '/owned/p' }, spawn: instance, emit() {}, graceMs: 60_000 });
  await sessions.start('a', 'tab-1'); await sessions.start('b', 'tab-2');
  await sessions.release('a', 'not-tab-1'); expect(() => sessions.get('a', 'tab-1')).not.toThrow(); // a foreign lease frees nothing
  const inFlight = new AbortController(); sessions.get('a', 'tab-1').requests.set('r1', inFlight);
  await sessions.release('a', 'tab-1');
  expect(inFlight.signal.aborted).toBe(true);
  expect(() => sessions.get('a', 'tab-1')).toThrow('Stale');
  expect(() => sessions.get('b', 'tab-2')).not.toThrow(); // the other tab keeps its project
  await expect(sessions.start('a', 'tab-3')).resolves.toBeDefined(); // adopted by the reloaded page
  await sessions.closeAll();
});

function hooked(over = {}) {
  const calls = [];
  const sessions = createSessions({ projects: { seed: async () => '/S/p' },
    spawn: () => ({ ready: Promise.resolve({ url: 'http://x', generation: 1 }), stop: async () => {}, state: () => ({ phase: 'running' }) }),
    emit: () => {}, onOpen: id => calls.push(['open', id]), onClose: id => calls.push(['close', id]), ...over });
  return { sessions, calls };
}
it('terminal lifetime hooks: onOpen on every start (a reload adoption too), onClose once a stop finishes', async () => {
  const { sessions, calls } = hooked();
  await sessions.start('p', 'lease-1');
  await sessions.stop('p', 'stale'); // a stale lease stops nothing
  await sessions.releaseAll(); await sessions.start('p', 'lease-2');
  expect(calls).toEqual([['open', 'p'], ['open', 'p']]);
  await sessions.stop('p', 'lease-2');
  expect(calls).toEqual([['open', 'p'], ['open', 'p'], ['close', 'p']]);
});
it('a session exposes its seeded folder before the instance is ready', async () => {
  let ready; const { sessions } = hooked({ spawn: () => ({ ready: new Promise(r => { ready = r; }), stop: async () => {}, state: () => ({}) }) });
  void sessions.start('p', 'lease-1');
  await expect(sessions.get('p', 'lease-1').seeded).resolves.toBe('/S/p');
  ready({ url: 'x', generation: 1 });
});
