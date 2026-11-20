// The coding-agent relay, reached through the web server. Agents run on the server (its terminal), so their relay
// listens on the server's loopback (mcp/src/tabBridge.ts, ws://127.0.0.1:<wsPort>). Desktop's editor dialed that
// directly; a browser on another machine cannot, so the editor dials /__sq-web/relay/<port> on its own origin instead.
// Only the relay's own port (~/.starquix-mcp/daemon.json wsPort) is ever forwarded: never an open door to other local
// ports. The relay still checks its pairing token in the first message, as before.
import fs from 'node:fs';
import path from 'node:path';
import { withoutSession } from './auth.mjs';
import { RELAY_PREFIX } from './http.mjs';
import { refuse, tunnel } from './tunnel.mjs';

/** The relay's WebSocket port from its identity file, or null (no relay set up yet). */
export function relayPortFrom(relayHome) {
  try {
    const port = JSON.parse(fs.readFileSync(path.join(relayHome, 'daemon.json'), 'utf8')).wsPort;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch { return null; }
}

export function createRelayProxy({ auth, origin, relayPort }) {
  return {
    /** The upgrade for RELAY_PREFIX<port>; false = not ours. */
    upgrade(req, socket, head) {
      let url; try { url = new URL(req.url, origin); } catch { return false; }
      if (!url.pathname.startsWith(RELAY_PREFIX)) return false;
      if (req.headers.origin !== origin || !auth.signedIn(req)) { refuse(socket, 403, 'Forbidden'); return true; }
      const asked = Number(url.pathname.slice(RELAY_PREFIX.length));
      const port = relayPort();
      if (!port || asked !== port) { refuse(socket, 404, 'Not Found'); return true; }
      // The relay sees its root path, as when the editor dialed it directly.
      tunnel(req, socket, head, { port, path: '/', rewrite: (name, value) => {
        if (name === 'host') return `127.0.0.1:${port}`;
        if (name === 'origin') return undefined; // the relay is reached by its pairing token, not by a browser origin
        if (name === 'cookie') return withoutSession(value);
        return value;
      } });
      return true;
    },
  };
}
