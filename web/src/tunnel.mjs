// A WebSocket upgrade forwarded to a loopback port, byte for byte after the handshake. Used for the preview's Vite HMR
// socket, the coding-agent relay and the dev editor's HMR. The caller has already checked who may open it.
import net from 'node:net';

/**
 * `path`: the request path upstream (default: the browser's). `rewrite(name, value)` → the header value to send upstream; `undefined` drops the header. Names are lower-case.
 * Hop-by-hop headers pass through unchanged: the upstream server answers the handshake itself.
 */
export function tunnel(req, socket, head, { port, host = '127.0.0.1', path = req.url, rewrite = (_name, value) => value }) {
  const upstream = net.connect(port, host, () => {
    const lines = [`${req.method} ${path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const value = rewrite(req.rawHeaders[i].toLowerCase(), req.rawHeaders[i + 1]);
      if (value !== undefined) lines.push(`${req.rawHeaders[i]}: ${value}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n'); if (head?.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  const end = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', end); socket.on('error', end);
  upstream.on('close', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  return upstream;
}

export const refuse = (socket, status, reason) => {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};
