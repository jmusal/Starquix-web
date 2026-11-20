// Editor-side MCP session (no React). Dials the starquix-mcp relay from the
// pairing code, says hello, then serves tools/list + tools/call. Every call:
// serialized → readiness gate → fresh catalogue (fresh ctx + batch guard =
// ONE undo step per call) → validate → execute → flush() after a mutating
// call so files are true before the result returns. Errors are typed
// (protocol.McpErrorCode); never a hang.
import { CLOSE_REPLACED, decodePairingCode, PROTOCOL_VERSION, type McpErrorCode, type RelayRequest, type TabResponse } from './protocol';
import type { Catalogue } from './catalogue';
import { relaySocketUrl } from './clientSetup';

/** waiting = nothing listens on the code's port yet (a tab-issued code before the
 *  agent runs `pair --code`): the normal idle state, not an error. */
export type McpSessionState = 'off' | 'connecting' | 'waiting' | 'connected' | 'disconnected' | 'replaced';
export interface McpStatus { state: McpSessionState; error?: string }
export interface McpCallReport { id: string; name: string; args: Record<string, unknown>; ok: boolean; error?: string; result?: unknown; at: number;
  /** A successful call that changed the project (agent canvas flash: docs/plans/2026-11-10-agent-canvas-flash-design.md). */
  mutating?: boolean }

/** Minimal WebSocket surface the session drives (browser WebSocket or a test fake). */
export type SocketLike = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export interface McpSessionOptions {
  code: string;
  projectId: string;
  projectName: string;
  makeSocket: (url: string) => SocketLike;
  /** The relay's socket URL for a port. Default: the host's (web/client/client.js relays through the Starquix server,
   *  so a browser on another machine reaches it), else the relay on this machine's loopback (desktop). */
  relayUrl?: (port: number) => string;
  /** Built per request so selection/breakpoint are fresh and each call gets its own batch guard. */
  getCatalogue: () => Catalogue;
  /** Persist files after a mutating call. */
  flush: () => Promise<void>;
  /** Readiness probe (project instance running). Absent = always ready. A call made
   *  while not ready waits for it (polled) — never refused — up to readyWaitMs from its arrival. */
  isReady?: () => Promise<{ ready: boolean; reason?: string }>;
  onStatus?: (s: McpStatus) => void;
  onCall?: (r: McpCallReport) => void;
  reconnectDelayMs?: number;
  readyWaitMs?: number;
}

// Low cap: a waiting tab should turn green within seconds of `pair --code`.
const MAX_BACKOFF_MS = 5_000;
// Under the relay's 60 s per-call timeout (mcp/src/server.ts callTimeoutFor): the agent
// always gets THIS answer, and a call the relay already gave up on never runs late.
const READY_WAIT_MS = 55_000;
const READY_POLL_MS = 250;

class SessionError extends Error {
  constructor(public code: McpErrorCode, message: string) { super(message); this.name = 'SessionError'; }
}

export class McpSession {
  private socket: SocketLike | null = null;
  private helloOk = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;
  private queue: Promise<void> = Promise.resolve();
  private state: McpSessionState = 'off';
  private target: { port: number; token: string } | null;

  constructor(private opts: McpSessionOptions) {
    this.backoff = opts.reconnectDelayMs ?? 1500;
    this.target = decodePairingCode(opts.code);
  }

  connect(): void {
    if (!this.target) { this.setStatus('off', 'Invalid connect code.'); return; }
    this.closed = false;
    this.dial();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const s = this.socket;
    this.socket = null;
    this.helloOk = false;
    if (s) { s.onclose = null; s.onerror = null; s.onmessage = null; s.onopen = null; try { s.close(); } catch { /* already closed */ } }
    this.setStatus('off');
  }

  private setStatus(state: McpSessionState, error?: string) {
    this.state = state;
    this.opts.onStatus?.(error ? { state, error } : { state });
  }

  private dial() {
    if (this.closed || !this.target) return;
    this.helloOk = false;
    // A waiting tab redials every few seconds: stay 'waiting' (no amber flicker).
    if (this.state !== 'waiting') this.setStatus('connecting');
    const ws = this.opts.makeSocket((this.opts.relayUrl ?? relaySocketUrl)(this.target.port));
    this.socket = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ type: 'hello', v: PROTOCOL_VERSION, token: this.target!.token, projectId: this.opts.projectId, projectName: this.opts.projectName }));
    };
    ws.onmessage = (ev) => this.onMessage(ws, String(ev.data));
    ws.onerror = () => { /* onclose follows; nothing to do here */ };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      this.socket = null;
      const rejected = !this.helloOk;
      this.helloOk = false;
      if (this.closed) return;
      // Replaced by another tab: stay down. Redialing would take the pairing
      // back and the two tabs would swap forever (see protocol.CLOSE_REPLACED).
      if ((ev as { code?: number } | undefined)?.code === CLOSE_REPLACED) {
        this.setStatus('replaced', 'Another tab took over this pairing. Reload this tab to take it back.');
        return;
      }
      // Never opened = no relay on the port yet: wait for the agent, quietly.
      if (!opened) { this.setStatus('waiting'); this.scheduleReconnect(); return; }
      this.setStatus('disconnected', rejected ? 'Your agent is connected with a different code. Paste this prompt into your agent again.' : undefined);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.dial(); }, delay);
  }

  private onMessage(ws: SocketLike, raw: string) {
    let msg: { type?: string; id?: string };
    try { msg = JSON.parse(raw); } catch { return; }
    if (!this.helloOk) {
      if (msg.type === 'hello-ok') {
        this.helloOk = true;
        this.backoff = this.opts.reconnectDelayMs ?? 1500;
        this.setStatus('connected');
      }
      return; // nothing else is valid before hello-ok
    }
    if (typeof msg.id !== 'string') return;
    const req = msg as RelayRequest;
    const deadline = Date.now() + (this.opts.readyWaitMs ?? READY_WAIT_MS); // from arrival: the relay's clock
    // Serialize: one call at a time, in arrival order.
    this.queue = this.queue.then(() => this.handle(ws, req, deadline)).catch(() => {});
  }

  private reply(ws: SocketLike, res: TabResponse) {
    if (this.socket !== ws || ws.readyState !== 1) return; // tab reconnected mid-call: the relay already failed this id
    ws.send(JSON.stringify(res));
  }

  private async handle(ws: SocketLike, req: RelayRequest, deadline: number) {
    if (req.type === 'tools/list') {
      try {
        this.reply(ws, { id: req.id, tools: this.opts.getCatalogue().descriptors() });
      } catch (e) {
        this.reply(ws, { id: req.id, error: { code: 'TOOL_FAILED', message: errMessage(e) } });
      }
      return;
    }
    if (req.type !== 'tools/call') return;
    const at = Date.now();
    try {
      if (!(await this.waitReady(ws, deadline))) return;
      const { result, mutating } = await this.call(req.name, req.args ?? {});
      this.opts.onCall?.({ id: req.id, name: req.name, args: req.args ?? {}, ok: true, result, at, mutating });
      this.reply(ws, { id: req.id, result });
    } catch (e) {
      const code: McpErrorCode = e instanceof SessionError ? e.code : 'TOOL_FAILED';
      const message = errMessage(e);
      this.opts.onCall?.({ id: req.id, name: req.name, args: req.args ?? {}, ok: false, error: `${code}: ${message}`, at });
      this.reply(ws, { id: req.id, error: { code, message } });
    }
  }

  /** Waits while the project boots. False = the link this call came on closed meanwhile
   *  (the relay already failed it): drop it unrun. */
  private async waitReady(ws: SocketLike, deadline: number): Promise<boolean> {
    if (!this.opts.isReady) return true;
    for (;;) {
      const r = await this.opts.isReady();
      if (r.ready) return true;
      if (Date.now() >= deadline) throw new SessionError('NOT_CONNECTED', `The project did not start in time${r.reason ? ` (last state: ${r.reason})` : ''}.`);
      await new Promise(res => setTimeout(res, READY_POLL_MS));
      if (this.socket !== ws) return false;
    }
  }

  private async call(name: string, args: Record<string, unknown>): Promise<{ result: unknown; mutating: boolean }> {
    // A fresh catalogue per call = a fresh batch guard = one undo step per
    // MCP call (the chat batches a whole run; MCP has no run boundary).
    const callable = this.opts.getCatalogue().callables.get(name);
    if (!callable) throw new SessionError('TOOL_FAILED', `Unknown tool: ${name}`);
    const v = await callable.validate(args);
    if (!v.ok) throw new SessionError('INVALID_ARGS', v.message);
    let result: unknown;
    try { result = await callable.execute(v.value); }
    catch (e) { throw new SessionError('TOOL_FAILED', errMessage(e)); }
    if (isRecord(result) && result.success === false) {
      const message = typeof result.message === 'string' ? result.message : 'Tool failed';
      throw new SessionError(result.needsConfirmation === true ? 'NEEDS_CONFIRMATION' : 'TOOL_FAILED', message);
    }
    // Files are truth: persist before the result returns so a read after a write sees it.
    if (callable.mutating) await this.opts.flush();
    return { result, mutating: callable.mutating };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null; }
function errMessage(e: unknown): string { return e instanceof Error ? e.message : String(e); }
