# Starquix in the browser (`web/`)

`web/` runs Starquix as a web app. A Node server takes the place of the Electron main process, and the editor runs in any browser tab: on the same computer, or on another one over HTTPS.

```
                     ┌───────────────────────────────────────────────────────────┐
 Browser             │ web/src/server.mjs (Node)                                 │
┌────────────────┐   │                                                           │   ┌──────────────────────┐
│ Editor tab     │──────► :3060  editor, sign-in, /__sq-web/socket (the API)     │   │ Project's astro dev  │
│                │   │           /__sq-web/relay/<port> ─► coding-agent relay    │   │ 127.0.0.1:<random>   │
│  ┌──────────┐  │   │                                                           │   └──────────────────────┘
│  │ Canvas   │──────► :3100…3119  preview gateway, one port per open project ─────────────────▲
│  │ iframe   │  │   │           (pages, modules, Vite HMR)                      │
│  └──────────┘  │   │  desktop/src/*: projects, Astro supervisor, git, publish, │
└────────────────┘   │  terminal, watchers, MCP relay host                       │
                     └───────────────────────────────────────────────────────────┘
```

## What changed and what did not

The editor talks to its host only through `window.sqDesktop` (`app/src/services/desktopDriver.ts`). On desktop, `desktop/src/preload.cjs` provides that API over Electron IPC. In the browser, `web/client/client.js` provides the same API over one WebSocket.

The server reuses `desktop/src/` as-is: projects, the Astro supervisor, sessions and leases, git and publishing, Cloudflare, the terminal, the watchers and the MCP relay host. Only the Electron parts were replaced:

| Electron (desktop/src/main.mjs) | Browser (web/) |
|---|---|
| `ipcMain.handle` + `validateSender` | `rpc.mjs`: a WebSocket that needs the session cookie and the editor's own `Origin` |
| `webContents.send` | broadcast to every open tab |
| `starquix://app` protocol | `http.mjs`: serves `app/dist` with the same CSP and injects the shim into `index.html` |
| Canvas at `http://127.0.0.1:<port>` | `preview.mjs`: each open project's canvas on a public port of the server's host, proxied to its dev server |
| Relay at `ws://127.0.0.1:47821` | `relay.mjs`: `/__sq-web/relay/<port>` on the editor's origin, forwarded only to the relay's own port |
| `safeStorage` (OS keychain) | `secrets.mjs`: AES-256-GCM under `<data>/secret.key` (0600) |
| Navigation calls `sessions.releaseAll()` | When a tab's socket closes, `sessions.release(id, lease)` runs for that tab's leases. The reloaded page adopts the instance within 30 s |
| Quit handshake (`quit-flush.mjs`) | Ctrl-C sends `flush-for-quit` to the tabs and waits ≤ 2 s, then stops children, shells, watchers and preview ports |
| Cloudflare sign-in window | `signin.mjs` + a panel in the shim: the user opens the sign-in in a new tab and pastes back the redirect address. `cloudflare.mjs`'s `onNavigate` checks it as before (path + state) |
| Update notifier, Dock, downloads | Dropped. The browser handles downloads |

Two editor changes made the canvas and the relay work from another host: `mcp/session.ts` dials the relay URL the host offers (`sqDesktop.relayUrl`), and `SelectionContext` trusts canvas messages by their frame instead of by a `localhost` host name.

## Running it on this computer

```bash
npm ci
npm ci --prefix preview-template
npm run web:build     # editor build (app/dist), shared Astro runtime (desktop/runtime-deps), MCP relay (desktop/mcp)
npm run web           # prints the link to open, with ?token=…
```

## Using it from another computer

The server then holds your projects and a shell, reachable over the network, so it only listens beyond loopback over HTTPS that it serves itself.

1. **Get a certificate for the server's name** that the browser already trusts:
   - On a Tailscale network: `tailscale cert <machine>.<tailnet>.ts.net` (a real certificate, nothing to install on the other computers).
   - On a public domain: any Let's Encrypt client, e.g. `certbot certonly --standalone -d starquix.example.com`.
   - On a home network: `mkcert starquix.lan` on the server, then install mkcert's root certificate on each computer that opens the editor.

   A certificate the browser does not trust does not work, even if you click through the warning: the canvas is an iframe on another port, and browsers never show a certificate warning inside an iframe.

2. **Start the server** on the network, with that name:

   ```bash
   npm run web -- --host 0.0.0.0 --origin https://starquix.example.com:3060 \
     --tls-cert /path/to/fullchain.pem --tls-key /path/to/privkey.pem
   ```

3. **Open ports 3060 and 3100–3119** (TCP) to the computers that should reach it. The editor uses 3060, and each open project's canvas uses one port from 3100–3119.

4. **Open `https://starquix.example.com:3060`** on the other computer and paste the access token. It is printed at start and kept in `~/.starquix-web/access-token` on the server.

The browser signs in once. `--new-token` replaces the token and signs every browser out.

### Options

| Flag / environment variable | Default | |
|---|---|---|
| `--port` / `SQ_WEB_PORT` | `3060` | The editor's port |
| `--host` / `SQ_WEB_HOST` | `127.0.0.1` | Where to listen. Beyond loopback needs HTTPS |
| `--origin` / `SQ_WEB_ORIGIN` | `http(s)://<host>:<port>` | The address browsers use. Required with `--host 0.0.0.0` |
| `--tls-cert`, `--tls-key` / `SQ_WEB_TLS_CERT`, `SQ_WEB_TLS_KEY` | none | Serve HTTPS (PEM files) on the editor and preview ports |
| `--preview-ports` / `SQ_WEB_PREVIEW_PORTS` | `<port+40>-<port+59>` | One per open project. Ports browsers refuse to load (e.g. 3659, 6000) are skipped |
| `--preview-origin` / `SQ_WEB_PREVIEW_ORIGIN` | `<editor scheme>://<editor host>:{port}` | The address of a preview port, `{port}` filled in |
| `--allow-insecure-http` / `SQ_WEB_ALLOW_INSECURE_HTTP=1` | off | Listen beyond loopback over plain HTTP. Only on a network you trust completely |
| `--new-token` | off | Replaces the saved access token |
| `--open` | off | Opens the link in the default browser |
| `SQ_WEB_TOKEN` | saved in `<data>/access-token` | A fixed token (at least 32 characters) |
| `SQ_USER_DATA` | `~/.starquix-web` | Sign-ins, key, token, logs, compile cache |
| `SQ_PROJECTS_ROOT` | `~/Starquix` | The same folder the desktop app uses |
| `SQ_WEB_DEV_EDITOR` | unset | Proxy a running `vite` (HMR included) instead of serving `app/dist` |

The server refuses to start, and says how to fix it, when a setting would break or weaken this: plain HTTP beyond loopback, `--host 0.0.0.0` without `--origin`, half a certificate, an `http://` origin with a certificate, previews on a different scheme from the editor (mixed content), or preview ports that overlap the editor's or that browsers refuse.

A TLS reverse proxy on the same machine also works: keep `--host 127.0.0.1`, pass `--origin https://…`, and forward the editor port and every preview port to the same ports here.

Editor development: `npm --prefix app run dev -- --host 127.0.0.1 --port 3061 --strictPort`, then `npm run web:dev`.

Tests: `cd web && npm test` (unit). `npm run test:e2e` runs real Chromium, server and Astro children (build first). It includes a run over HTTPS on this machine's network address that fails if the browser ever requests a loopback URL. Set `SQ_E2E_CHROMIUM=<path>` to use a preinstalled Chromium.

## Security

Whoever can use the editor can run anything on the server machine: projects run their own Astro config, and the built-in terminal is a real shell. So:

- **Network:** loopback by default. Beyond it, only over HTTPS the server terminates itself (or with `--allow-insecure-http`). HTTPS responses send HSTS.
- **Sign-in:** the access token (192 random bits) is the only credential. Paste it into the sign-in form, or open the printed `?token=` link once; the address bar drops the token. Failed sign-ins are limited to 20 a minute for the whole server. The sign-in form only accepts posts from its own page (login CSRF).
- **Session:** an `HttpOnly; SameSite=Strict` cookie (`Secure` over HTTPS), derived from the token by HMAC, so the cookie never reveals the token. Every editor page and asset, the socket, the relay and every preview port require it. A preview port strips it before forwarding, and never forwards it to a project's dev server.
- **Origins:** the socket and the relay accept only the editor's own `Origin`. A canvas socket (Vite HMR) accepts only its preview's `Origin`. Any other `Host` is redirected (editor) or refused (previews), which blocks DNS rebinding.
- **Isolation:** the canvas is on a different origin from the editor, as on desktop, so a site's own scripts never reach `window.sqDesktop`. Editor pages may only be framed by themselves, and previews only by the editor (`frame-ancestors`).
- **Private routes:** Astro's `/__sq/local/*` and its health check are never forwarded from a browser. The server reaches them with the per-instance secret, which no browser holds.
- **Relay:** the proxy forwards only to the relay's port from `daemon.json`, never to another local port. The relay still checks its pairing token.

## Limits

- **Project list per browser.** As on desktop, the project list lives in the editor's IndexedDB. A different browser or profile starts with an empty list, while the folders stay in `~/Starquix` on the server.
- **One tab per project.** A second tab that opens the same project gets "Project still owned", as a second desktop window would.
- **The post editor's first try is refused.** Its fast path fetches the post preview without the session cookie, gets a 401 and falls back to its hidden-iframe path, which works. That costs one quick round trip.
- **One user.** Everyone with the token shares the projects and the shell. There are no accounts.
