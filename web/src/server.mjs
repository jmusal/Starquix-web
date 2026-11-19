#!/usr/bin/env node
// Starquix in the browser. The Electron main process (desktop/src/main.mjs) without Electron: the same project folders,
// Astro children, versions/publishing, terminal, outside-edit watch and coding-agent relay — reused from desktop/src —
// behind a local HTTP server. The editor (app/) runs in any browser tab and reaches them through window.sqDesktop, which
// web/client/client.js provides over one WebSocket instead of Electron IPC.
//
// Trust model (desktop: one window, a sandboxed preload): the server listens on loopback by default; a browser needs the
// access token (printed at start, kept in <data>/access-token) once, which becomes an HttpOnly SameSite=Strict cookie. The
// socket also requires the editor's own Origin. Anyone holding the token controls this machine's projects and its shell.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import gitHttp from 'isomorphic-git/http/node';
import { createProjects, projectDirFor } from '../../desktop/src/projects.mjs';
import { createAuth } from '../../desktop/src/git/auth.mjs';
import { createGithub } from '../../desktop/src/git/github.mjs';
import { createPages } from '../../desktop/src/git/pages.mjs';
import { createCloudflare } from '../../desktop/src/cloudflare.mjs';
import { buildSite, checkSite } from '../../desktop/src/site-build.mjs';
import { ACCOUNT_OPS, createGitContext, runGitOp } from '../../desktop/src/git/ops.mjs';
import { createInstance, prepareSpare, closeSpare } from '../../desktop/src/supervisor.mjs';
import { createSessions, requestPath, responseBytes } from '../../desktop/src/ipc.mjs';
import { QUIT_FLUSH_MS } from '../../desktop/src/quit-flush.mjs';
import { createMcpHost } from '../../desktop/src/agents.mjs';
import { createTerminals, shellSpec } from '../../desktop/src/terminal.mjs';
import { createWatchers } from '../../desktop/src/watch.mjs';
import { installCrashLog } from '../../desktop/src/crash-log.mjs';
import { createKeychain, fileStore, loadKey } from './secrets.mjs';
import { createHttpHandler, proxyUpgrade } from './http.mjs';
import { createRpc } from './rpc.mjs';
import { createSignIn } from './signin.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const env = process.env;
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

const port = Number(option('port') ?? env.SQ_WEB_PORT ?? 3060);
const host = option('host') ?? env.SQ_WEB_HOST ?? '127.0.0.1';
const origin = (env.SQ_WEB_ORIGIN ?? `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}`).replace(/\/$/, '');
const dataDir = path.resolve(env.SQ_USER_DATA ?? path.join(os.homedir(), '.starquix-web'));
const projectsRoot = path.resolve(env.SQ_PROJECTS_ROOT ?? path.join(os.homedir(), 'Starquix'));
const templateDir = path.resolve(env.SQ_TEMPLATE_DIR ?? path.join(repo, 'preview-template'));
const depsDir = path.resolve(env.SQ_RUNTIME_DEPS ?? path.join(repo, 'desktop/runtime-deps/node_modules'));
const mcpScript = path.resolve(env.SQ_MCP_SCRIPT ?? path.join(repo, 'desktop/mcp/starquix-mcp.mjs'));
const devEditor = env.SQ_WEB_DEV_EDITOR || null;
const editorDir = path.resolve(env.SQ_WEB_EDITOR_DIR ?? path.join(repo, 'app/dist'));

fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
Error.stackTraceLimit = 50;
installCrashLog(path.join(dataDir, 'logs', 'main.log'));
env.SQ_COMPILE_CACHE ??= path.join(dataDir, 'compile-cache'); // inherited by every Astro child
env.SQ_EDITOR_ORIGIN = origin; // inherited by every Astro child: its only CORS origin (desktop/src/wrapper.mjs)

// Preflight: what `npm run web:build` makes. Missing pieces are named, not discovered as a broken canvas later.
if (!devEditor && !fs.existsSync(path.join(editorDir, 'index.html'))) {
  console.error(`No editor build at ${editorDir}. Run: npm run web:build (or set SQ_WEB_DEV_EDITOR to a running \`vite\`).`);
  process.exit(1);
}
if (!fs.existsSync(depsDir)) console.warn(`[sq-web] No Astro runtime at ${depsDir}: projects cannot open. Run: npm --prefix desktop run deps`);
const hasMcp = fs.existsSync(mcpScript);
if (!hasMcp) console.warn(`[sq-web] No coding-agent relay at ${mcpScript}: agents cannot connect. Run: npm --prefix desktop run mcp`);

/** The access token: SQ_WEB_TOKEN, else one kept in the data folder so a bookmarked link keeps working. */
function accessToken() {
  if (env.SQ_WEB_TOKEN) return env.SQ_WEB_TOKEN;
  const file = path.join(dataDir, 'access-token');
  if (flag('new-token')) fs.rmSync(file, { force: true });
  try { const saved = fs.readFileSync(file, 'utf8').trim(); if (/^[\w-]{32,}$/.test(saved)) return saved; } catch { /* first start */ }
  const fresh = randomBytes(24).toString('base64url');
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}
const token = accessToken();

const projects = createProjects(projectsRoot);
let rpc = null; // set below; the factories only emit after start
const emit = (channel, ...args) => rpc?.emit(channel, ...args);

// Coding-agent relay (desktop/src/agents.mjs): the launcher runs THIS Node on the bundled relay script.
const mcpHost = createMcpHost({ relayHome: env.STARQUIX_MCP_HOME || path.join(os.homedir(), '.starquix-mcp'),
  execPath: process.execPath, script: mcpScript });
let mcpCommand = null; let shellHook = null;
if (hasMcp) {
  mcpCommand = `"${mcpHost.launcher}"`;
  try { mcpHost.refreshLauncher(); } catch (error) { console.error('[mcp launcher]', error); mcpCommand = `"${process.execPath}" "${mcpScript}"`; }
  try { shellHook = mcpHost.writeShellHook(); } catch (error) { console.error('[terminal hook]', error); }
  mcpHost.watch(code => emit('mcp-code', code));
}

// The open project's shell. node-pty loads on first use: without it only the terminal is missing.
const require = createRequire(import.meta.url);
const terminals = createTerminals({
  spawnPty: (cwd, cols, rows) => {
    const s = shellSpec(env, shellHook);
    if (hasMcp) {
      if (mcpHost.server) execFile(mcpHost.server.command, [...mcpHost.server.args, 'tools'], { env: { ...env, ...mcpHost.server.env }, windowsHide: true }, () => {});
      else execFile(mcpHost.launcher, ['tools'], () => {});
    }
    return require('node-pty').spawn(s.file, s.args, { name: 'xterm-256color', cols, rows, cwd, env: s.env });
  },
  emit,
});
const watchers = createWatchers({ read: (id, rels) => projects.read(id, rels), emit });
const sessions = createSessions({ projects,
  spawn: options => createInstance({ ...options, templateDir, depsDir, spares: true }),
  emit: state => emit('state', state),
  onOpen: id => { terminals.keepOnly(id); watchers.keepOnly(id, projectDirFor(projectsRoot, id)); },
  onClose: id => { terminals.release(id); watchers.release(id); },
});

// Versions, GitHub and Cloudflare (main.mjs): the sign-ins live in the data folder, encrypted (secrets.mjs).
const keychain = createKeychain(loadKey(path.join(dataDir, 'secret.key')));
const gitAuth = createAuth({ store: fileStore(dataDir, 'github-token.bin'), crypto: keychain });
const github = createGithub({ token: () => gitAuth.token() });
const signIn = createSignIn({ emit });
const cloudflare = createCloudflare({ store: fileStore(dataDir, 'cloudflare-token.bin'), crypto: keychain, windows: signIn.windows,
  sandbox: env.SQ_CLOUDFLARE_SANDBOX === '1' });
const git = createGitContext({ auth: gitAuth, github, http: gitHttp, pages: createPages({ github }), cloudflare, build: buildSite, typeCheck: checkSite });

const HEADERS = ['accept', 'content-type', 'cache-control', 'x-sq-mutation-session', 'x-sq-mutation-id'];
/** The calls preload.cjs exposes, as main.mjs answers them. `client` is the tab: its leases are released when it goes. */
const handlers = {
  'mcp-code': () => (hasMcp ? mcpHost.code() : null),
  'mcp-rotate': () => (hasMcp ? mcpHost.rotate() : null),
  exists: ([id]) => projects.exists(id),
  start: async ([id, lease, seed], client) => {
    const result = sessions.start(id, lease, seed);
    client.leases.set(id, lease); // after start validated the lease
    return result;
  },
  stop: async ([id, lease], client) => { if (client.leases.get(id) === lease) client.leases.delete(id); return sessions.stop(id, lease); },
  snapshot: async ([id, lease]) => { const owner = sessions.get(id, lease); await owner.ready; return projects.snapshot(id); },
  status: ([id, lease]) => sessions.get(id, lease).instance?.state() ?? { phase: 'starting' },
  git: ([id, lease, op, args]) => {
    sessions.get(id, lease);
    const run = () => runGitOp(git, projectDirFor(projectsRoot, id), op, args);
    return ACCOUNT_OPS.has(op) ? run() : projects.serial(id, run);
  },
  'terminal-attach': async ([id, lease]) => { const owner = sessions.get(id, lease); await owner.seeded; return terminals.attach(id, projectDirFor(projectsRoot, id)); },
  'terminal-input': ([id, lease, data]) => { sessions.get(id, lease); terminals.input(id, data); },
  'terminal-resize': ([id, lease, cols, rows]) => { sessions.get(id, lease); terminals.resize(id, cols, rows); },
  abort: ([id, lease, requestId]) => { sessions.get(id, lease).requests.get(requestId)?.abort(); },
  fetch: async ([id, lease, requestId, kind, route, init]) => {
    const owner = sessions.get(id, lease);
    if (typeof requestId !== 'string' || owner.requests.has(requestId)) throw new Error('Invalid request id');
    const method = init?.method ?? 'GET'; const safeRoute = requestPath(kind, route, method);
    if (init?.body && (!(init.body instanceof ArrayBuffer) || init.body.byteLength > 25 * 1024 * 1024)) throw new Error('Request too large');
    const headers = new Headers(init?.headers);
    for (const key of headers.keys()) if (!HEADERS.includes(key)) throw new Error(`Unapproved header: ${key}`);
    const cancel = new AbortController(); owner.requests.set(requestId, cancel);
    try {
      await owner.ready;
      sessions.get(id, lease);
      const response = await owner.instance.request(safeRoute, { method, headers, body: init?.body,
        signal: AbortSignal.any([cancel.signal, owner.controller.signal]) });
      return { status: response.status, statusText: response.statusText, headers: [...response.headers], body: await responseBytes(response) };
    } finally {
      owner.requests.delete(requestId);
      cancel.abort();
    }
  },
  'cloudflare-signin': ([id, url]) => signIn.answer(id, url),
};

let flushAck = null;
const notices = {
  'quit-flushed': () => flushAck?.(),
  'cloudflare-signin': ([id]) => { signIn.answer(id, null); },
};

const ipcLog = env.SQ_IPC_LOG ? (name, args, ms) => console.log('[sq-ipc]', JSON.stringify({ at: Date.now(), name,
  route: name === 'fetch' ? `${args[3]} ${String(args[4]).replace(/path=[^&]*&?/, '').replace(/[?&]$/, '')}` : '', ms })) : undefined;

rpc = createRpc({ token, origin, handlers, notices, log: ipcLog,
  onClose: client => {
    // The tab is gone (closed or reloading): its leases die, the instances wait for the next page to adopt them.
    for (const [id, lease] of client.leases) void sessions.release(id, lease);
    if (!rpc.clients.size) signIn.cancelAll();
  } });

const handle = createHttpHandler({ token, origin, secure: origin.startsWith('https:'),
  editor: devEditor ? { devUrl: devEditor } : { dir: editorDir },
  boot: () => ({ mcpCommand, mcpServer: hasMcp ? mcpHost.server : null }) });
const server = http.createServer(handle);
server.on('upgrade', (req, socket, head) => {
  if (rpc.upgrade(req, socket, head)) return;
  if (devEditor && req.headers.host === new URL(origin).host) return proxyUpgrade(req, socket, head, devEditor); // Vite HMR
  socket.destroy();
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${port} is in use. Pick another: --port <n> (or SQ_WEB_PORT).`);
  else console.error(error);
  process.exit(1);
});
server.listen(port, host, () => {
  const link = `${origin}/?token=${token}`;
  console.log(`\n  Starquix is running.\n\n  Open: ${link}\n\n  Projects: ${projectsRoot}\n  Press Ctrl-C to stop.\n`);
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    console.warn('  Warning: listening beyond this computer. The canvas still loads from this machine\'s loopback ports, and anyone with the link controls your projects and shell.\n');
  }
  if (flag('open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [link], () => {});
  }
  setTimeout(() => { if (!stopping) prepareSpare({ depsDir }); }, 1000); // a warm Astro runner for the first open
});

// Ctrl-C: the tabs push what they still hold (main.mjs's quit handshake), then every Astro child, shell and watcher stops.
let stopping = null;
function shutdown() {
  if (stopping) { console.log('Forcing exit.'); process.exit(1); }
  console.log('\nStopping Starquix…');
  stopping = (async () => {
    if (rpc.clients.size) {
      await new Promise(resolve => {
        let left = rpc.clients.size; const timer = setTimeout(resolve, QUIT_FLUSH_MS);
        flushAck = () => { if (--left <= 0) { clearTimeout(timer); resolve(); } };
        rpc.emit('flush-for-quit');
      });
    }
    signIn.cancelAll(); terminals.closeAll(); watchers.closeAll();
    await sessions.closeAll();
    await closeSpare();
    rpc.close(); server.close();
  })().catch(error => console.error('[sq-web shutdown]', error)).finally(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
