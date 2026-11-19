// The browser ↔ server wire format (shared verbatim: server.mjs imports it, client.js is served with it inlined).
// One WebSocket binary frame = u32 JSON length | JSON | (u32 length | bytes)*. Every Uint8Array (Node Buffers too) and
// ArrayBuffer inside the value travels as raw bytes and comes back as the same kind — Electron IPC's structured clone,
// which the editor and main.mjs were written against (snapshot/seed/disk-change maps, fetch bodies).
const BLOB = '\u0000sq-blob';

export function encodeFrame(value) {
  const blobs = [];
  const json = JSON.stringify(value, function (key, v) {
    const raw = this[key]; // before toJSON: a Buffer's toJSON would hide its bytes
    if (raw instanceof ArrayBuffer) { blobs.push(new Uint8Array(raw)); return { [BLOB]: blobs.length - 1, ab: 1 }; }
    if (ArrayBuffer.isView(raw)) { blobs.push(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)); return { [BLOB]: blobs.length - 1 }; }
    return v;
  }) ?? 'null';
  const head = new TextEncoder().encode(json);
  let size = 4 + head.length; for (const b of blobs) size += 4 + b.length;
  const out = new Uint8Array(size); const view = new DataView(out.buffer);
  view.setUint32(0, head.length); out.set(head, 4); let at = 4 + head.length;
  for (const b of blobs) { view.setUint32(at, b.length); out.set(b, at + 4); at += 4 + b.length; }
  return out;
}

export function decodeFrame(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4) throw new Error('Bad frame');
  const headLength = view.getUint32(0);
  if (4 + headLength > bytes.length) throw new Error('Bad frame');
  const json = new TextDecoder().decode(bytes.subarray(4, 4 + headLength));
  const blobs = []; let at = 4 + headLength;
  while (at < bytes.length) {
    if (at + 4 > bytes.length) throw new Error('Bad frame');
    const length = view.getUint32(at); if (at + 4 + length > bytes.length) throw new Error('Bad frame');
    blobs.push(bytes.slice(at + 4, at + 4 + length)); at += 4 + length; // a copy: owns its buffer exactly
  }
  return JSON.parse(json, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v[BLOB] === 'number') {
      const blob = blobs[v[BLOB]]; if (!blob) throw new Error('Bad frame');
      return v.ab ? blob.buffer : blob;
    }
    return v;
  });
}
