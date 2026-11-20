// The WebSocket side: one connection per editor tab, the calls preload.cjs made with ipcRenderer.invoke, and main's
// webContents.send events broadcast to every tab. A tab's leases are released when its socket closes — the counterpart
// of main.mjs's did-start-navigation → sessions.releaseAll(): the instance waits for the reloaded page to adopt it.
import { WebSocketServer } from 'ws';
import { decodeFrame, encodeFrame } from '../client/wire.js';
import { SOCKET_PATH } from './http.mjs';
import { refuse } from './tunnel.mjs';

const MAX_FRAME = 64 * 1024 * 1024; // a 25 MB fetch body / project seed, with room

/** Errors as ipcMain.handle forwards them: the message (git ops encode theirs as `sq-git:<json>`), and the code. */
export function encodeError(error) {
  return { message: String(error?.message ?? error), ...(typeof error?.code === 'string' ? { code: error.code } : {}) };
}

/**
 * `handlers`: name → (args, client) => value; `notices`: name → (args, client) => void (fire-and-forget sends).
 * `onClose(client)` runs when a tab's socket closes.
 */
export function createRpc({ auth, origin, handlers, notices = {}, onClose = () => {}, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  const clients = new Set();

  function accepts(req) {
    // The editor page only: same origin (a cross-site page cannot open it with our cookie) and signed in.
    return req.headers.origin === origin && auth.signedIn(req);
  }

  wss.on('connection', socket => {
    const client = { socket, leases: new Map() }; // project id → lease this tab started
    clients.add(client);
    socket.on('message', async (data, isBinary) => {
      if (!isBinary) return;
      let message; try { message = decodeFrame(data); } catch { socket.close(1003, 'Bad frame'); return; }
      if (message?.t === 'send') {
        try { notices[message.name]?.(message.args ?? [], client); } catch (error) { console.error('[sq-web notice]', message.name, error); }
        return;
      }
      if (message?.t !== 'call' || typeof message.id !== 'number') return;
      const handler = Object.hasOwn(handlers, message.name) ? handlers[message.name] : null;
      const t0 = performance.now();
      let reply;
      try {
        if (!handler) throw new Error(`Unknown call: ${message.name}`);
        reply = { t: 'ret', id: message.id, ok: true, value: await handler(Array.isArray(message.args) ? message.args : [], client) };
      } catch (error) {
        reply = { t: 'ret', id: message.id, ok: false, error: encodeError(error) };
      }
      log(message.name, message.args, Math.round(performance.now() - t0));
      if (socket.readyState === socket.OPEN) socket.send(encodeFrame(reply));
    });
    socket.on('close', () => {
      clients.delete(client);
      try { onClose(client); } catch (error) { console.error('[sq-web close]', error); }
    });
    socket.on('error', () => {});
  });

  return {
    clients,
    /** The upgrade request for SOCKET_PATH; false = not ours (the caller may proxy it). */
    upgrade(req, socket, head) {
      if (new URL(req.url, origin).pathname !== SOCKET_PATH) return false;
      if (!accepts(req)) { refuse(socket, 403, 'Forbidden'); return true; }
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
      return true;
    },
    /** main.mjs's win.webContents.send(`sq:${channel}`, ...args), to every open tab. */
    emit(channel, ...args) {
      if (!clients.size) return;
      const frame = encodeFrame({ t: 'event', channel, args });
      for (const c of clients) if (c.socket.readyState === c.socket.OPEN) c.socket.send(frame);
    },
    /** One tab only (a reply-style event). */
    emitTo(client, channel, ...args) {
      if (client.socket.readyState === client.socket.OPEN) client.socket.send(encodeFrame({ t: 'event', channel, args }));
    },
    close() { for (const c of clients) c.socket.terminate(); wss.close(); },
  };
}
