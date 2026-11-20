import { describe, it, expect, vi } from 'vitest';
import { McpSession } from '../session';
import type { Callable, Catalogue } from '../catalogue';
import { FakeWS } from './fakeSocket';

const ok = (a: unknown) => ({ ok: true as const, value: a as Record<string, unknown> });
const catalogue = (entries: [string, Callable][], descriptors: Catalogue['descriptors'] = () => []): Catalogue => ({ callables: new Map(entries), descriptors });

function harness(over: Partial<ConstructorParameters<typeof McpSession>[0]> = {}) {
  let ws!: FakeWS;
  const flush = vi.fn(async () => {});
  const execute = vi.fn(async (_n: string, a: unknown) => ({ success: true, a }));
  const addPage: Callable = { mutating: true, validate: async (a) => ('name' in (a as object) ? ok(a) : { ok: false, message: 'name required' }), execute: (a) => execute('add_page', a) };
  const getCatalogue = vi.fn(() => catalogue([['add_page', addPage]], () => [{ name: 'add_page', description: 'd', inputSchema: { type: 'object' } }]));
  const s = new McpSession({
    code: 'XXX.' + 'a'.repeat(24), projectId: 'p', projectName: 'P',
    makeSocket: url => (ws = new FakeWS(url)),
    getCatalogue, flush, onStatus: vi.fn(), ...over,
  });
  return { s, get ws() { return ws; }, flush, execute, getCatalogue };
}
const tick = () => new Promise(r => setTimeout(r, 0));
const cat = (name: string, c: Callable) => () => catalogue([[name, c]]);

describe('McpSession', () => {
  it('dials 127.0.0.1:<port from code> and sends hello with the token', async () => {
    const h = harness(); h.s.connect(); await tick();
    expect(h.ws.url).toBe('ws://127.0.0.1:43989'); // parseInt('xxx', 36)
    expect(h.ws.sent[0]).toMatchObject({ type: 'hello', v: 1, token: 'a'.repeat(24), projectId: 'p', projectName: 'P' });
  });
  it('dials the relay through the host when the host offers it (web build: the relay is on the server)', async () => {
    const g = globalThis as { sqDesktop?: unknown };
    const before = g.sqDesktop;
    g.sqDesktop = { relayUrl: (port: number) => `wss://starquix.example/__sq-web/relay/${port}` };
    try {
      const h = harness(); h.s.connect(); await tick();
      expect(h.ws.url).toBe('wss://starquix.example/__sq-web/relay/43989');
      expect(h.ws.sent[0]).toMatchObject({ type: 'hello', token: 'a'.repeat(24) }); // the pairing token still authenticates
    } finally { g.sqDesktop = before; }
  });
  it('an explicit relayUrl option wins', async () => {
    const h = harness({ relayUrl: port => `ws://relay.test:${port}/x` }); h.s.connect(); await tick();
    expect(h.ws.url).toBe('ws://relay.test:43989/x');
  });
  it('rejects a malformed code up front', () => {
    const onStatus = vi.fn();
    const h = harness({ code: 'garbage', onStatus });
    h.s.connect();
    expect(onStatus).toHaveBeenLastCalledWith({ state: 'off', error: expect.stringMatching(/code/i) });
  });
  it('answers tools/list after hello-ok', async () => {
    const h = harness(); h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: '1', type: 'tools/list' }); await tick();
    expect(h.ws.sent.at(-1)).toMatchObject({ id: '1', tools: [{ name: 'add_page' }] });
  });
  it('validates args → INVALID_ARGS, never executes', async () => {
    const h = harness(); h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: '2', type: 'tools/call', name: 'add_page', args: {} }); await tick(); await tick();
    expect(h.ws.sent.at(-1)).toMatchObject({ id: '2', error: { code: 'INVALID_ARGS', message: 'name required' } });
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('builds a fresh catalogue per call (one batch guard = one undo step) and flushes after a mutating call', async () => {
    const h = harness(); h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: '3', type: 'tools/call', name: 'add_page', args: { name: 'A' } }); await tick(); await tick(); await tick();
    h.ws.receive({ id: '3b', type: 'tools/call', name: 'add_page', args: { name: 'B' } }); await tick(); await tick(); await tick();
    expect(h.getCatalogue).toHaveBeenCalledTimes(2);
    expect(h.flush).toHaveBeenCalledTimes(2);
    expect(h.ws.sent.at(-1)).toMatchObject({ id: '3b', result: { success: true, a: { name: 'B' } } });
  });
  it('does not flush after a read-only call', async () => {
    const h = harness({ getCatalogue: cat('r', { mutating: false, validate: async a => ok(a), execute: async () => ({ x: 1 }) }) });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: 'r1', type: 'tools/call', name: 'r', args: {} }); await tick(); await tick();
    expect(h.flush).not.toHaveBeenCalled();
    expect(h.ws.sent.at(-1)).toMatchObject({ id: 'r1', result: { x: 1 } });
  });
  it('unknown tool → TOOL_FAILED; executor throw → TOOL_FAILED with the message', async () => {
    const h = harness({ getCatalogue: cat('boom', { mutating: false, validate: async a => ok(a), execute: async () => { throw new Error('kaboom'); } }) });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: '4', type: 'tools/call', name: 'nope', args: {} }); await tick(); await tick();
    expect(h.ws.sent.at(-1)).toMatchObject({ id: '4', error: { code: 'TOOL_FAILED' } });
    h.ws.receive({ id: '5', type: 'tools/call', name: 'boom', args: {} }); await tick(); await tick();
    expect(h.ws.sent.at(-1)).toMatchObject({ id: '5', error: { code: 'TOOL_FAILED', message: expect.stringContaining('kaboom') } });
  });
  it('maps needsConfirmation → NEEDS_CONFIRMATION and success:false → TOOL_FAILED, no flush either way', async () => {
    const h = harness({ getCatalogue: () => catalogue([
      ['gated', { mutating: true, validate: async a => ok(a), execute: async () => ({ success: false, cancelled: true, needsConfirmation: true, message: 'Push? Re-run with confirm:true' }) }],
      ['fails', { mutating: true, validate: async a => ok(a), execute: async () => ({ success: false, message: 'no such page' }) }],
    ]) });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: 'g', type: 'tools/call', name: 'gated', args: {} }); await tick(); await tick();
    expect(h.ws.sent.at(-1)).toMatchObject({ id: 'g', error: { code: 'NEEDS_CONFIRMATION', message: expect.stringContaining('confirm:true') } });
    h.ws.receive({ id: 'f', type: 'tools/call', name: 'fails', args: {} }); await tick(); await tick();
    expect(h.ws.sent.at(-1)).toMatchObject({ id: 'f', error: { code: 'TOOL_FAILED', message: 'no such page' } });
    expect(h.flush).not.toHaveBeenCalled();
  });
  it('regression: a call made while the project boots waits for it, then runs — never refused', async () => {
    let ready = false;
    const h = harness({ isReady: async () => (ready ? { ready: true } : { ready: false, reason: 'starting' }) });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: 'n', type: 'tools/call', name: 'add_page', args: { name: 'A' } });
    await new Promise(r => setTimeout(r, 300));
    expect(h.ws.sent.some(m => (m as { id?: string }).id === 'n')).toBe(false); // waiting, not refused
    ready = true;
    await vi.waitFor(() => expect(h.ws.sent.at(-1)).toMatchObject({ id: 'n', result: { success: true } }), { timeout: 2000 });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
  it('still not running after the bound → NOT_CONNECTED with an honest message that never says retry', async () => {
    const h = harness({ isReady: async () => ({ ready: false, reason: 'starting' }), readyWaitMs: 30 });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: 'b', type: 'tools/call', name: 'add_page', args: { name: 'A' } });
    await vi.waitFor(() => expect(h.ws.sent.at(-1)).toMatchObject({ id: 'b', error: { code: 'NOT_CONNECTED', message: expect.stringMatching(/did not start.*starting/) } }), { timeout: 2000 });
    expect((h.ws.sent.at(-1) as { error: { message: string } }).error.message).not.toMatch(/retry/i);
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('a call still waiting when the session closes never runs late (the relay already failed it)', async () => {
    let ready = false;
    const h = harness({ isReady: async () => ({ ready }) });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: 'z', type: 'tools/call', name: 'add_page', args: { name: 'A' } }); await tick();
    h.s.close(); ready = true;
    await new Promise(r => setTimeout(r, 400));
    expect(h.execute).not.toHaveBeenCalled();
  });
  it('serializes concurrent calls', async () => {
    const order: string[] = [];
    const slow: Callable = { mutating: false, validate: async a => ok(a), execute: async (a) => { order.push('start' + a.i); await tick(); order.push('end' + a.i); return {}; } };
    const h = harness({ getCatalogue: cat('slow', slow) });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: 'a', type: 'tools/call', name: 'slow', args: { i: 1 } });
    h.ws.receive({ id: 'b', type: 'tools/call', name: 'slow', args: { i: 2 } });
    for (let i = 0; i < 8; i++) await tick();
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });
  it('reports each finished call through onCall', async () => {
    const onCall = vi.fn();
    const h = harness({ onCall }); h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    h.ws.receive({ id: 'c', type: 'tools/call', name: 'add_page', args: { name: 'A' } }); await tick(); await tick(); await tick();
    expect(onCall).toHaveBeenCalledWith(expect.objectContaining({ name: 'add_page', ok: true, args: { name: 'A' } }));
    h.ws.receive({ id: 'd', type: 'tools/call', name: 'add_page', args: {} }); await tick(); await tick();
    expect(onCall).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'add_page', ok: false, error: expect.stringContaining('name required') }));
  });
  it('reports status transitions and reconnects after close with backoff', async () => {
    const onStatus = vi.fn(); const h = harness({ onStatus, reconnectDelayMs: 1 });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    expect(onStatus).toHaveBeenLastCalledWith({ state: 'connected' });
    const first = h.ws; first.close(); await new Promise(r => setTimeout(r, 5));
    expect(onStatus).toHaveBeenCalledWith({ state: 'disconnected' });
    expect(h.ws).not.toBe(first); // a new socket was made
    h.s.close(); await new Promise(r => setTimeout(r, 5));
    expect(onStatus).toHaveBeenLastCalledWith({ state: 'off' });
  });
  it('a close with CLOSE_REPLACED (another tab took over) stops reconnecting', async () => {
    const onStatus = vi.fn(); const h = harness({ onStatus, reconnectDelayMs: 1 });
    h.s.connect(); await tick(); h.ws.receive({ type: 'hello-ok', v: 1 });
    const first = h.ws; first.close(4001); await new Promise(r => setTimeout(r, 10));
    expect(onStatus).toHaveBeenLastCalledWith({ state: 'replaced', error: expect.stringMatching(/another tab/i) });
    expect(h.ws).toBe(first); // no redial
    h.s.close();
  });
  it('no relay listening yet (tab-issued code) is WAITING — no refusal error, no connecting flicker, keeps dialing', async () => {
    FakeWS.refuse = true;
    try {
      const onStatus = vi.fn(); const h = harness({ onStatus, reconnectDelayMs: 1 });
      h.s.connect(); await new Promise(r => setTimeout(r, 20));
      expect(onStatus).toHaveBeenLastCalledWith({ state: 'waiting' });
      const states = onStatus.mock.calls.map(c => c[0].state);
      expect(states.filter(s => s === 'connecting')).toHaveLength(1); // only the very first dial
      expect(states.some(s => s === 'disconnected')).toBe(false);
      expect(FakeWS.instances.length).toBeGreaterThan(2); // still redialing
      FakeWS.refuse = false;
      await new Promise(r => setTimeout(r, 40)); h.ws.receive({ type: 'hello-ok', v: 1 });
      expect(onStatus).toHaveBeenLastCalledWith({ state: 'connected' });
      h.s.close();
    } finally { FakeWS.refuse = false; }
  });
  it('a socket closed before hello-ok (wrong token) reports the pairing rejection', async () => {
    const onStatus = vi.fn(); const h = harness({ onStatus, reconnectDelayMs: 1 });
    h.s.connect(); await tick(); h.ws.close(); await tick();
    expect(onStatus).toHaveBeenCalledWith({ state: 'disconnected', error: expect.stringMatching(/different code.*prompt/i) });
    h.s.close();
  });
});

describe('mintPairingCode (tab-issued code)', () => {
  it('decodes to DEFAULT_RELAY_PORT + a fresh 24-hex token', async () => {
    const { mintPairingCode, decodePairingCode, DEFAULT_RELAY_PORT } = await import('../protocol');
    const a = decodePairingCode(mintPairingCode());
    const b = decodePairingCode(mintPairingCode());
    expect(a?.port).toBe(DEFAULT_RELAY_PORT);
    expect(a?.token).toMatch(/^[0-9a-f]{24}$/);
    expect(a?.token).not.toBe(b?.token);
  });
});
