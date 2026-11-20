// The browser build end to end: a real web/src/server.mjs, a real Chromium tab, real Astro children and real disk.
// Mirrors desktop/e2e/runtime.spec.mjs's first journey (edit → disk → reload → child crash → server restart) plus the parts
// that changed transport: the shell, versions (git), the access-token gate and the socket's origin check.
import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BAD_PORTS } from '../src/preview.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const fixture = path.join(root, 'app/e2e/fixtures/release-project');
const BOOT = 120_000;
const TOKEN = 'e2e-token-0123456789abcdefghijklmnopqrstuv';
const preview = page => page.locator('iframe[title$=" preview"]:visible').first().contentFrame();
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };

let nextPort = 3160 + Math.floor(Math.random() * 500);
/** `args`: extra server flags; `origin`: the address browsers use (default http://127.0.0.1:<port>). */
const takePort = () => { while (BAD_PORTS.has(nextPort)) nextPort++; const port = nextPort; nextPort += 60; return port; }; // +60: preview ports never overlap
async function startServer(temp, port = takePort(), { args = [], origin = `http://127.0.0.1:${port}` } = {}) {
  const env = { ...process.env, SQ_USER_DATA: path.join(temp, 'data'), SQ_PROJECTS_ROOT: path.join(temp, 'projects'),
    STARQUIX_MCP_HOME: path.join(temp, 'mcp-home'), SQ_WEB_TOKEN: TOKEN, SQ_WEB_PORT: String(port) };
  const child = spawn(process.execPath, [path.join(root, 'web/src/server.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', d => out.push(String(d))); child.stderr.on('data', d => out.push(String(d)));
  const exited = new Promise(r => child.once('exit', r));
  for (let i = 0; i < 200 && !out.join('').includes('Starquix is running'); i++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${out.join('')}`);
    await delay(100);
  }
  return { origin, port, out, child,
    async stop() { if (child.exitCode === null) { child.kill('SIGINT'); await Promise.race([exited, delay(20_000)]); } } };
}

async function signIn(page, origin) {
  await page.addInitScript(() => {
    window.__states = [];
    addEventListener('DOMContentLoaded', () => window.sqDesktop?.onState(s => window.__states.push(s)), { once: true });
  });
  await page.goto(`${origin}/?token=${TOKEN}`);
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 60_000 });
}
const running = page => page.evaluate(() => window.__states?.findLast(s => s.phase === 'running') ?? null);

async function importFixture(page, name) {
  await page.getByRole('button', { name: 'Import project', exact: true }).click();
  await page.getByTestId('import-folder-input').setInputFiles(fixture);
  await page.getByLabel('Project name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page).toHaveURL(/\/editor\/browser_/, { timeout: 30_000 });
  return new URL(page.url()).pathname.split('/').pop();
}
async function select(page, element) {
  await expect(page.locator('iframe[data-viewport]').first()).toHaveCSS('opacity', '1', { timeout: BOOT });
  const box = await element.boundingBox(); expect(box).not.toBeNull();
  await page.keyboard.down('ControlOrMeta');
  try { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); } finally { await page.keyboard.up('ControlOrMeta'); }
}

test('the access token gates the editor and its socket', async ({ page }) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-web-'));
  const server = await startServer(temp);
  try {
    expect((await fetch(`${server.origin}/`)).status).toBe(401);
    expect((await fetch(`${server.origin}/__sq-web/client.js`)).status).toBe(401);
    expect((await fetch(`${server.origin}/?token=wrong`, { redirect: 'manual' })).status).toBe(401);
    // A foreign Host (DNS rebinding) is sent to the one origin the Astro children allow.
    const foreign = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.port, path: '/x',
      headers: { host: `localhost:${server.port}` } }, res => { res.resume(); resolve(res); }).on('error', reject));
    expect(foreign.statusCode).toBe(307); expect(foreign.headers.location).toBe(`${server.origin}/x`);
    await signIn(page, server.origin);
    // Signed in, but from another site: the socket refuses it.
    const refused = await page.evaluate(port => new Promise(resolve => {
      const ws = new WebSocket(`ws://localhost:${port}/__sq-web/socket`);
      ws.onopen = () => resolve('open'); ws.onerror = () => resolve('refused');
    }), server.port);
    expect(refused).toBe('refused');
    expect(await page.evaluate(() => window.sqDesktop.exists('browser_missing'))).toBe(false);
  } finally { await server.stop(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10 }); }
});

test('the browser edits real source, survives a child crash, a reload and a server restart', async ({ page }, info) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-web-'));
  let server = await startServer(temp);
  try {
    await signIn(page, server.origin);
    const id = await importFixture(page, 'Web edit fixture'); const editorPath = new URL(page.url()).pathname;
    const heading = preview(page).getByRole('heading', { name: 'Release fixture', exact: true });
    await expect(heading).toBeVisible({ timeout: BOOT }); await select(page, heading);
    await expect(page.getByTestId('design-bar').getByText('H1', { exact: true })).toBeVisible();
    await page.keyboard.press('Enter');
    await preview(page).locator('[contenteditable="true"]').fill('Web durable source');
    await page.keyboard.press('Escape');
    await page.getByTitle('Align center', { exact: true }).click();
    const edited = preview(page).getByRole('heading', { name: 'Web durable source' });
    await expect(edited).toHaveCSS('text-align', 'center');
    const file = path.join(temp, 'projects', id, 'src/pages/index.astro');
    await expect.poll(() => fs.readFile(file, 'utf8'), { timeout: 15_000 }).toMatch(/<h1[^>]*class="[^"]*text-center[^"]*"[^>]*>Web durable source<\/h1>/);

    // Reload: the closed socket released the lease; the new page adopts the same Astro child.
    await page.reload();
    await expect(edited).toBeVisible({ timeout: BOOT });
    await expect.poll(() => running(page).then(s => s?.pid), { timeout: BOOT }).toBeTruthy();
    const pid = (await running(page)).pid;
    process.kill(pid, 'SIGKILL');
    await expect.poll(() => running(page).then(s => !!s?.pid && s.pid !== pid), { timeout: BOOT }).toBe(true);
    await expect(edited).toBeVisible({ timeout: BOOT });
    const finalPid = (await running(page)).pid;

    // Ctrl-C: every child goes with the server; a new server reopens the project from disk.
    await server.stop();
    await expect.poll(() => alive(finalPid), { timeout: 10_000 }).toBe(false);
    server = await startServer(temp, server.port);
    await page.goto(`${server.origin}${editorPath}`);
    const reopened = preview(page).getByRole('heading', { name: 'Web durable source' });
    await expect(reopened).toBeVisible({ timeout: BOOT });
    await expect(reopened).toHaveCSS('text-align', 'center');
  } catch (error) {
    await info.attach('server.log', { body: server.out.join(''), contentType: 'text/plain' });
    throw error;
  } finally { await server.stop(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10 }); }
});

test('the shell and versions work through the socket', async ({ page }, info) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-web-'));
  const server = await startServer(temp);
  try {
    await signIn(page, server.origin);
    const id = await importFixture(page, 'Web shell fixture');
    await expect(preview(page).getByRole('heading', { name: 'Release fixture', exact: true })).toBeVisible({ timeout: BOOT });
    const dir = path.join(temp, 'projects', id);
    // The project's shell (node-pty in the server), reached the way the Terminal view does.
    const lease = await page.evaluate(() => new Promise(resolve => {
      // The current owner's lease is private to the driver: read it from the next state event of a running instance.
      const off = window.sqDesktop.onState(s => { if (s.phase === 'running') { off(); resolve(s.lease); } });
      setTimeout(() => resolve(window.__states.findLast(s => s.phase === 'running')?.lease ?? null), 2000);
    }));
    expect(lease).toBeTruthy();
    await page.evaluate(async ([pid, l]) => {
      await window.sqDesktop.terminal.attach(pid, l);
      await window.sqDesktop.terminal.input(pid, l, 'echo shell-ok > from-shell.txt\r');
    }, [id, lease]);
    await expect.poll(() => fs.readFile(path.join(dir, 'from-shell.txt'), 'utf8').catch(() => ''), { timeout: 20_000 }).toContain('shell-ok');
    // The outside edit comes back to the tab as a disk change (watch.mjs → socket event).
    const seen = page.evaluate(() => new Promise(resolve => window.sqDesktop.onDiskChanged((_id, change) => {
      if (Object.keys(change.files).includes('from-shell-2.txt')) resolve(new TextDecoder().decode(change.files['from-shell-2.txt']));
    })));
    await fs.writeFile(path.join(dir, 'from-shell-2.txt'), 'bytes-ok');
    expect(await seen).toBe('bytes-ok');
    // Versions: a save is a real commit in the project folder.
    await page.evaluate(([pid, l]) => window.sqDesktop.git(pid, l, 'save', { message: 'From the browser' }), [id, lease]);
    const history = await page.evaluate(([pid, l]) => window.sqDesktop.git(pid, l, 'history', {}), [id, lease]);
    expect(JSON.stringify(history)).toContain('From the browser');
    // A refused op keeps its encoded error (the editor parses `sq-git:<json>` out of the message, as over Electron IPC).
    const refused = await page.evaluate(([pid, l]) => window.sqDesktop.git(pid, l, 'restore', { oid: 'nope' }).then(() => null, e => e.message), [id, lease]);
    expect(refused).toContain('sq-git:');
  } catch (error) {
    await info.attach('server.log', { body: server.out.join(''), contentType: 'text/plain' });
    throw error;
  } finally { await server.stop(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10 }); }
});

/** This machine's first non-loopback IPv4 address: a browser on another machine would use one like it. */
const lanAddress = () => Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address ?? null;
const loopback = url => { try { return /^(127\.|localhost$|\[::1\]$)/.test(new URL(url).hostname); } catch { return false; } };

test('from another machine: HTTPS on a network address, sign-in form, canvas and edits — never a loopback URL', async ({ browser }, info) => {
  const address = lanAddress();
  test.skip(!address, 'no non-loopback network address on this machine');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sq-web-'));
  // A self-signed certificate for that address, as a user might make one (or use a real one from their CA).
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${address}`,
    '-addext', `subjectAltName=IP:${address}`, '-keyout', path.join(temp, 'key.pem'), '-out', path.join(temp, 'cert.pem')], { stdio: 'ignore' });
  const port = takePort();
  const origin = `https://${address}:${port}`;
  const server = await startServer(temp, port, { origin,
    args: ['--host', address, '--tls-cert', path.join(temp, 'cert.pem'), '--tls-key', path.join(temp, 'key.pem')] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const loopbackHits = []; const consoleLines = [];
  page.on('console', m => consoleLines.push(`[${m.type()}] ${m.text()}`)); page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.stack}`));
  context.on('request', r => { if (loopback(r.url())) loopbackHits.push(r.url()); });
  page.on('websocket', ws => { if (loopback(ws.url())) loopbackHits.push(ws.url()); });
  try {
    // Plain HTTP on that address is not served at all.
    expect(await fetch(`http://${address}:${port}/`).then(() => 'answered', () => 'refused')).toBe('refused');
    await test.step('sign in with the form', async () => {
    // The sign-in form: the token is pasted, never put in a URL.
    await page.goto(`${origin}/`);
    await expect(page).toHaveURL(`${origin}/__sq-web/login?next=%2F`);
    await page.getByLabel('Access token').fill('not-the-token');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('That token is not right.');
    await page.getByLabel('Access token').fill(TOKEN);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible({ timeout: 60_000 });
    const cookies = await context.cookies(origin);
    expect(cookies.find(c => c.name === 'sq_web_session')).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict' });
    expect(cookies.some(c => c.value.includes(TOKEN))).toBe(false);
    });

    const id = await test.step('import a project', () => importFixture(page, 'Remote fixture'));
    const heading = preview(page).getByRole('heading', { name: 'Release fixture', exact: true });
    let canvas;
    await test.step('the canvas loads from the preview port', async () => {
    await expect(heading).toBeVisible({ timeout: BOOT });
    // The canvas comes from this server's preview port on the same address, over HTTPS.
    canvas = await page.locator('iframe[title$=" preview"]:visible').first().getAttribute('src');
    expect(new URL(canvas).origin).toBe(`https://${address}:${port + 40}`);
    // The relay is dialed through this server too (web/src/relay.mjs).
    expect(await page.evaluate(() => window.sqDesktop.relayUrl(47821))).toBe(`wss://${address}:${port}/__sq-web/relay/47821`);
    });

    const file = path.join(temp, 'projects', id, 'src/pages/index.astro');
    await test.step('edit the heading on the canvas', async () => {
    await select(page, heading);
    await expect(page.getByTestId('design-bar').getByText('H1', { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await preview(page).locator('[contenteditable="true"]').fill('Edited from afar');
    await page.keyboard.press('Escape');
    await expect.poll(() => fs.readFile(file, 'utf8'), { timeout: 15_000 }).toContain('Edited from afar');
    });
    await test.step('live reload through the gateway', async () => {
    // Live reload over the gateway: a change on disk (an agent in the terminal) reaches the canvas.
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Edited from afar', 'Changed on the server'));
    await expect(preview(page).getByRole('heading', { name: 'Changed on the server' })).toBeVisible({ timeout: 30_000 });
    });

    // A signed-out browser gets nothing from the canvas port either.
    const outsider = await browser.newContext({ ignoreHTTPSErrors: true });
    const res = await outsider.request.get(canvas);
    expect(res.status()).toBe(401);
    await outsider.close();
    expect(loopbackHits).toEqual([]);
  } catch (error) {
    await info.attach('server.log', { body: server.out.join(''), contentType: 'text/plain' });
    await info.attach('console.log', { body: consoleLines.join('\n'), contentType: 'text/plain' });
    await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {});
    throw error;
  } finally { await context.close(); await server.stop(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10 }); }
});
