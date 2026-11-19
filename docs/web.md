# Starquix in the browser (`web/`)

`web/` runs Starquix as a local web app. A Node server takes the place of the Electron main process, and the editor runs in any browser tab.

```
┌──────────────────────────────┐ WebSocket ┌──────────────────────────────┐  spawns  ┌──────────────────────────┐
│ Editor (React, app/)         │◄─────────►│ web/src/server.mjs (Node)    │─────────►│ Project's `astro dev`    │
│ any browser tab              │ /__sq-web │ desktop/src/* modules:       │          │ 127.0.0.1:<random port>  │
│ http://127.0.0.1:3060        │  /socket  │ files, git, publish, MCP,    │          └──────────────────────────┘
└──────────────────────────────┘           │ terminal, outside-edit watch │                       ▲
               │  postMessage (bridge.js inside the canvas iframes)       └──────────────────────────────┘
               └──────────────────────────────────────────────────────────────────────────────────┘
```

## What changed and what did not

The editor talks to its host only through `window.sqDesktop` (`app/src/services/desktopDriver.ts`). On desktop, `desktop/src/preload.cjs` provides that API over Electron IPC. In the browser, `web/client/client.js` provides the same API over one WebSocket, so the editor code is unchanged.

The server reuses `desktop/src/` as-is: projects, the Astro supervisor, sessions and leases, git and publishing, Cloudflare, the terminal, the watchers and the MCP relay host. Only the Electron parts were replaced:

| Electron (desktop/src/main.mjs) | Browser (web/) |
|---|---|
| `ipcMain.handle` + `validateSender` | `web/src/rpc.mjs`: a WebSocket that needs the access cookie and the editor's own `Origin` |
| `webContents.send` | broadcast to every open tab |
| `starquix://app` protocol | `web/src/http.mjs`: serves `app/dist` with the same CSP, and injects the shim into `index.html` |
| `safeStorage` (OS keychain) | `web/src/secrets.mjs`: AES-256-GCM under `<data>/secret.key` (0600) |
| Navigation calls `sessions.releaseAll()` | When a tab's socket closes, `sessions.release(id, lease)` runs for that tab's leases. The reloaded page adopts the instance within 30 s |
| Quit handshake (`quit-flush.mjs`) | Ctrl-C sends `flush-for-quit` to the tabs and waits ≤ 2 s, then stops children, shells and watchers |
| Cloudflare sign-in window | `web/src/signin.mjs` + a panel in the shim: the user opens the sign-in in a new tab and pastes back the redirect address. `cloudflare.mjs`'s `onNavigate` checks it as before (path + state) |
| Update notifier, Dock, downloads | Dropped. The browser handles downloads |

## Running it

```bash
npm ci
npm ci --prefix preview-template
npm run web:build     # editor build (app/dist), shared Astro runtime (desktop/runtime-deps), MCP relay (desktop/mcp)
npm run web           # prints the link to open, with ?token=…
```

Options (flag / environment variable):

| | Default | |
|---|---|---|
| `--port` / `SQ_WEB_PORT` | `3060` | |
| `--host` / `SQ_WEB_HOST` | `127.0.0.1` | See the note on remote use below |
| `--open` | off | Opens the link in the default browser |
| `--new-token` | off | Replaces the saved access token |
| `SQ_WEB_TOKEN` | saved in `<data>/access-token` | A fixed token |
| `SQ_USER_DATA` | `~/.starquix-web` | Sign-ins, key, token, logs, compile cache |
| `SQ_PROJECTS_ROOT` | `~/Starquix` | The same folder the desktop app uses |
| `SQ_WEB_DEV_EDITOR` | unset | Proxy a running `vite` (HMR included) instead of serving `app/dist` |

Editor development: `npm --prefix app run dev -- --host 127.0.0.1 --port 3061 --strictPort`, then `npm run web:dev`.

Tests: `cd web && npm test` (unit). `npm run test:e2e` runs real Chromium, server and Astro children; build first. Set `SQ_E2E_CHROMIUM=<path>` to use a preinstalled Chromium.

## Security

Whoever can use the editor can run anything on the server machine: projects run their own Astro config, and the built-in terminal is a real shell. So the server:

- listens on loopback by default;
- requires the access token once per browser. `/?token=…` sets an `HttpOnly; SameSite=Strict` cookie, and every page, asset and the socket need that cookie;
- accepts the socket only from its own origin, and redirects any other `Host` to that origin (DNS rebinding);
- keeps the per-instance Astro secret on the server, as before. The tab never gets it.

## Limits

- **Same machine only, for now.** The canvas iframes load each project's Astro dev server directly at `http://127.0.0.1:<port>`, and the coding-agent relay listens on `127.0.0.1:47821`. A browser on another machine cannot reach either. Remote use needs those proxied through the server (for example one public port per running instance, or host-based routing). `--host 0.0.0.0` only makes the editor itself reachable.
- **Project list per browser.** As on desktop, the project list lives in the editor's IndexedDB. A different browser or profile starts with an empty list, while the folders stay in `~/Starquix`.
- **One tab per project.** A second tab that opens the same project gets "Project still owned", as a second desktop window would.
