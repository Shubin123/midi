// Cookie helpers for the teacher, plus OpenRouter's key-free sign-in. The provider keys and settings live in
// cookies (scoped to this app's path), which is what "keep it in cookies" means here: a page can only read
// cookies its own domain set, so this never touches a claude.ai or chatgpt.com login. OpenRouter adds an
// OAuth 2.0 PKCE flow so that provider needs no key pasted at all: the user approves on openrouter.ai and
// comes back with a short code we trade for a key, which we then store like any other.

const cookiePath = () => location.pathname.replace(/[^/]*$/, '') || '/';
export function getCookie(name) {
 const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
 return m ? decodeURIComponent(m[1]) : null;
}
export function setCookie(name, val, days = 400) {
 const secure = location.protocol === 'https:' ? ';Secure' : ''; // http://localhost drops a Secure cookie in Safari
 document.cookie = `${name}=${encodeURIComponent(val)};max-age=${days * 86400};path=${cookiePath()};SameSite=Lax${secure}`;
}
export function deleteCookie(name) { document.cookie = `${name}=;max-age=0;path=${cookiePath()};SameSite=Lax`; }

/* ---- OpenRouter OAuth (PKCE) ---- */
const AUTH_URL = 'https://openrouter.ai/auth';
const KEY_EXCHANGE = 'https://openrouter.ai/api/v1/auth/keys';
const VERIFIER_STORE = 'openrouter_pkce_verifier';

const base64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A PKCE verifier (random) and its S256 challenge (base64url of its SHA-256). The challenge goes to the auth
// page; the verifier is kept locally and proves, at exchange time, that this is the same browser that started.
export async function createPkcePair() {
 const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
 const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
 return { verifier, challenge: base64url(digest) };
}

const callbackUrl = () => location.origin + location.pathname; // OpenRouter returns the user here with ?code=

export async function signIn() {
 const { verifier, challenge } = await createPkcePair();
 try { localStorage.setItem(VERIFIER_STORE, verifier); } catch { /* private mode: the exchange will just fail and ask to retry */ }
 location.assign(`${AUTH_URL}?callback_url=${encodeURIComponent(callbackUrl())}&code_challenge=${challenge}&code_challenge_method=S256`);
}

// Call once on load. If the page opened with ?code= (back from OpenRouter), trade it for a key and return it,
// stripping the code from the URL. Returns null when there is no code; throws when the exchange fails.
export async function completeSignIn() {
 const code = new URLSearchParams(location.search).get('code');
 if (!code) return null;
 let verifier = null;
 try { verifier = localStorage.getItem(VERIFIER_STORE); localStorage.removeItem(VERIFIER_STORE); } catch { /* storage blocked */ }
 const clean = () => { try { history.replaceState(null, '', callbackUrl()); } catch { /* ignore */ } };
 try {
  const body = { code };
  if (verifier) { body.code_verifier = verifier; body.code_challenge_method = 'S256'; }
  const res = await fetch(KEY_EXCHANGE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.key) throw new Error(data?.error?.message || data?.message || `Sign-in failed (${res.status}). Please try again.`);
  clean();
  return data.key;
 } catch (err) {
  clean();
  throw err;
 }
}
