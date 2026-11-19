// Cloudflare's sign-in "window" (cloudflare.mjs `windows`) for a browser editor. Desktop opened its own Electron window and
// stopped it at the OAuth redirect (http://127.0.0.1/oauth/cloudflare). A web page cannot watch another tab's navigation, so
// the tab shows the sign-in link and the user pastes back the redirect address; `onNavigate` decides, exactly as on desktop
// (codeFromRedirect: our path, our state — anything else is refused and the panel stays open).
import { randomUUID } from 'node:crypto';

const SIGN_IN_MS = 15 * 60_000; // an abandoned sign-in never holds the account lane forever

export function createSignIn({ emit, timeoutMs = SIGN_IN_MS }) {
  let current = null; // { id, onNavigate, done, timer }

  function finish(entry) {
    if (current !== entry) return;
    current = null; clearTimeout(entry.timer);
    emit('cloudflare-signin-closed', entry.id);
    entry.done();
  }

  const windows = {
    /** Resolves when the sign-in ends (accepted redirect, cancel, timeout or every tab gone). One at a time. */
    open(url, { onNavigate } = {}) {
      if (current) { emit('cloudflare-signin', { id: current.id, url: current.url }); return current.closed; }
      const entry = { id: randomUUID(), url, onNavigate };
      entry.closed = new Promise(resolve => { entry.done = resolve; });
      entry.timer = setTimeout(() => finish(entry), timeoutMs);
      current = entry;
      emit('cloudflare-signin', { id: entry.id, url });
      return entry.closed;
    },
    /** Desktop cleared the sign-in window's cookies; the user's own browser keeps its Cloudflare session. */
    clear: async () => {},
  };

  return {
    windows,
    /** The tab's answer: a pasted address (true = it was our redirect, the sign-in ends) or null (cancelled). */
    answer(id, url) {
      const entry = current;
      if (!entry || entry.id !== id) return false;
      if (url === null || url === undefined) { finish(entry); return true; }
      if (typeof url !== 'string' || url.length > 8192) return false;
      if (!entry.onNavigate?.(url)) return false;
      finish(entry); return true;
    },
    cancelAll() { if (current) finish(current); },
  };
}
