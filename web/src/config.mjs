// Where the web server listens and the address browsers use, from flags and environment variables, checked before
// anything starts. The rule that matters: the server never listens beyond this machine over plain HTTP unless told to
// (--allow-insecure-http). The token and the session cookie would otherwise cross the network readable by anyone on it.
import fs from 'node:fs';
import { BAD_PORTS, parsePorts } from './preview.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const WILDCARD = new Set(['0.0.0.0', '::', '[::]']);
export const isLoopback = host => LOOPBACK.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);

const fail = message => Object.assign(new Error(message), { code: 'config' });

/** The checked settings. A flag (`--name value`) wins over its environment variable. Throws `code: 'config'` with the fix. */
export function resolveConfig({ argv = [], env = {}, readFile = fs.readFileSync } = {}) {
  const flag = name => argv.includes(`--${name}`);
  const option = name => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const get = (name, key) => option(name) ?? env[key];

  const port = Number(get('port', 'SQ_WEB_PORT') ?? 3060);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail(`Bad port: ${get('port', 'SQ_WEB_PORT')}`);
  if (BAD_PORTS.has(port)) throw fail(`Browsers refuse to load port ${port}; pick another --port.`);
  const host = get('host', 'SQ_WEB_HOST') ?? '127.0.0.1';
  const allowInsecure = flag('allow-insecure-http') || env.SQ_WEB_ALLOW_INSECURE_HTTP === '1';

  const certFile = get('tls-cert', 'SQ_WEB_TLS_CERT'); const keyFile = get('tls-key', 'SQ_WEB_TLS_KEY');
  if (!!certFile !== !!keyFile) throw fail('HTTPS needs both --tls-cert and --tls-key.');
  const tls = certFile ? { cert: readFile(certFile), key: readFile(keyFile) } : null;

  let origin = get('origin', 'SQ_WEB_ORIGIN');
  if (!origin) {
    if (WILDCARD.has(host)) throw fail(`Listening on ${host} reaches every network this machine is on: say which address browsers use, e.g. --origin https://starquix.example.com:${port}`);
    origin = `${tls ? 'https' : 'http'}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;
  }
  let parsed; try { parsed = new URL(origin); } catch { throw fail(`Bad --origin: ${origin}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username) {
    throw fail(`--origin must be a bare origin like https://host:${port} (got ${origin})`);
  }
  origin = parsed.origin;
  if (tls && parsed.protocol !== 'https:') throw fail(`--origin must be https:// when the server serves HTTPS (got ${origin})`);

  // Beyond loopback, the bytes on the wire must be encrypted by THIS server (a TLS proxy elsewhere on the network still
  // leaves the hop to us in the clear), unless the user says the network is trusted.
  const remote = !isLoopback(host);
  if (remote && !tls && !allowInsecure) {
    throw fail(`Refusing to listen on ${host} over plain HTTP: your access token and session would cross the network unencrypted.\n`
      + '  Serve HTTPS: --tls-cert <cert.pem> --tls-key <key.pem>\n'
      + '  Or keep --host 127.0.0.1 behind a TLS reverse proxy on this machine (with --origin https://…)\n'
      + '  Or, on a network you trust completely: --allow-insecure-http');
  }

  const previewPorts = parsePorts(get('preview-ports', 'SQ_WEB_PREVIEW_PORTS') ?? `${port + 40}-${port + 59}`);
  const usable = []; for (let p = previewPorts.from; p <= previewPorts.to; p++) if (!BAD_PORTS.has(p)) usable.push(p);
  if (!usable.length) throw fail(`Browsers refuse every port in ${previewPorts.from}-${previewPorts.to}; pick another --preview-ports.`);
  if (port >= previewPorts.from && port <= previewPorts.to) throw fail(`The preview ports ${previewPorts.from}-${previewPorts.to} include the editor's port ${port}.`);
  const template = get('preview-origin', 'SQ_WEB_PREVIEW_ORIGIN') ?? `${parsed.protocol}//${parsed.hostname}:{port}`;
  if (!template.includes('{port}')) throw fail('--preview-origin must contain {port}, e.g. https://starquix.example.com:{port}');
  const previewOrigin = p => new URL(template.replace('{port}', String(p))).origin;
  const sample = new URL(previewOrigin(previewPorts.from));
  // A canvas on http:// inside an https:// editor is mixed content: the browser blocks it.
  if (sample.protocol !== parsed.protocol) throw fail(`The preview origin (${sample.origin}) must use ${parsed.protocol} like the editor.`);
  if (sample.origin === origin) throw fail('The preview origin must differ from the editor origin: the canvas runs the site\'s own scripts.');

  return { port, host, origin, tls, secure: parsed.protocol === 'https:', remote, allowInsecure, previewPorts, previewOrigin };
}
