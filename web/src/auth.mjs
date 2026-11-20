// Sign-in for the web server, shared by the editor, the preview gateway and the relay proxy.
// The access token is the only credential. Signing in once sets a session cookie that is DERIVED from the token (an
// HMAC), so a leaked cookie does not reveal the token, and replacing the token (--new-token) signs every browser out.
// The cookie is host-only, HttpOnly and SameSite=Strict: it reaches the editor and every preview port of the same host
// (cookies ignore ports), never another site's requests.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'sq_web_session';
const YEAR = 31_536_000;

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    const key = part.slice(0, i).trim(); if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed: ignored */ }
  }
  return out;
}

/** The Cookie header without our session cookie: a project's own cookies still reach its dev server, ours never do. */
export function withoutSession(header) {
  if (!header) return header;
  const kept = header.split(';').map(p => p.trim()).filter(p => p && !p.startsWith(`${COOKIE}=`));
  return kept.length ? kept.join('; ') : undefined;
}

export function sameSecret(expected, given) {
  if (typeof given !== 'string' || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Failed sign-ins, counted for the whole server (behind a reverse proxy every client has the proxy's address).
 * Past `max` failures in a window, every sign-in is refused until the window ends. Signed-in browsers are unaffected.
 */
export function createLimiter({ max = 20, windowMs = 60_000, now = Date.now } = {}) {
  let start = now(); let failures = 0;
  const roll = () => { if (now() - start >= windowMs) { start = now(); failures = 0; } };
  return {
    blocked() { roll(); return failures >= max; },
    fail() { roll(); failures++; },
    retryAfter() { return Math.max(1, Math.ceil((start + windowMs - now()) / 1000)); },
  };
}

export function createAuth({ token, secure = false, limiter = createLimiter() }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('The access token must be at least 32 characters');
  const session = createHmac('sha256', token).update('starquix-web-session-v1').digest('base64url');
  const attrs = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return {
    limiter,
    secure,
    /** Set-Cookie for a browser that just proved it holds the token. */
    signInCookie: `${COOKIE}=${session}; ${attrs}; Max-Age=${YEAR}`,
    signOutCookie: `${COOKIE}=; ${attrs}; Max-Age=0`,
    /** The token itself, as typed or linked (constant-time). */
    isToken: given => sameSecret(token, given),
    /** A request from a signed-in browser. */
    signedIn: req => sameSecret(session, parseCookies(req.headers.cookie)[COOKIE]),
  };
}
