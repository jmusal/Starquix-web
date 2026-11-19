// At-rest encryption for the GitHub / Cloudflare sign-ins (desktop: Electron safeStorage, the OS keychain). Here: AES-256-GCM
// under a random key in <data>/secret.key (0600, created once). The same `{ encrypt, decrypt }` shape git/auth.mjs and
// cloudflare.mjs take. It keeps tokens out of plain text files and backups; it is no stronger than the key file's permissions.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

export function loadKey(file) {
  try {
    const key = fs.readFileSync(file);
    if (key.length === 32) return key;
    throw new Error(`${file} is not a 32-byte key`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' }); // wx: a concurrent first start never overwrites the other's key
  return fs.readFileSync(file);
}

export function createKeychain(key) {
  return {
    encrypt(text) {
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
    },
    decrypt(blob) {
      const bytes = Buffer.from(blob);
      if (bytes[0] !== VERSION || bytes.length < 29) throw new Error('Unreadable sign-in');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
      decipher.setAuthTag(bytes.subarray(13, 29));
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8');
    },
  };
}

/** A sign-in file under the data folder (main.mjs fileStore): read → bytes | null. */
export function fileStore(dir, name) {
  const file = path.join(dir, name);
  return {
    read: () => fs.promises.readFile(file).catch(() => null),
    write: bytes => fs.promises.writeFile(file, bytes, { mode: 0o600 }),
    clear: () => fs.promises.rm(file, { force: true }),
  };
}
