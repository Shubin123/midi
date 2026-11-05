// Sign-in portal for the AI teacher: OpenRouter OAuth 2.0 with PKCE, straight from the browser. No server
// and no API key to paste. The user clicks Sign in, approves on openrouter.ai, and comes back with a short
// code that we trade for a key; the key lives in a cookie in this browser only. A free OpenRouter account
// can use the free models; adding credit there unlocks GPT, Claude, Gemini and the rest behind the same
// sign-in. (A page cannot read a cookie set by another site such as claude.ai, so this is the cookie-based,
// key-free sign-in that a static site can actually do.)
const AUTH_URL = 'https://openrouter.ai/auth';
const KEY_EXCHANGE = 'https://openrouter.ai/api/v1/auth/keys';
const TOKEN_COOKIE = 'openrouter_key';
const MODEL_COOKIE = 'openrouter_model';
const VERIFIER_STORE = 'openrouter_pkce_verifier';

const cookiePath = () => location.pathname.replace(/[^/]*$/, '') || '/';
function readCookie(name) {
 const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
 return m ? decodeURIComponent(m[1]) : null;
}
function writeCookie(name, val, days) {
 const secure = location.protocol === 'https:' ? ';Secure' : ''; // http://localhost drops a Secure cookie in Safari
 document.cookie = `${name}=${encodeURIComponent(val)};max-age=${days * 86400};path=${cookiePath()};SameSite=Lax${secure}`;
}
function dropCookie(name) { document.cookie = `${name}=;max-age=0;path=${cookiePath()};SameSite=Lax`; }

export const getToken = () => readCookie(TOKEN_COOKIE);
export const setToken = v => writeCookie(TOKEN_COOKIE, v, 400);
export const clearToken = () => dropCookie(TOKEN_COOKIE);
export const getModel = () => readCookie(MODEL_COOKIE);
export const setModel = v => writeCookie(MODEL_COOKIE, v, 400);

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

// Call once on load. If the page opened with ?code= (back from OpenRouter), trade it for a key, store the
// key in a cookie, and strip the code from the URL. Returns true when a sign-in just completed, false when
// there was no code; throws with a readable message when the exchange fails.
export async function completeSignIn() {
 const code = new URLSearchParams(location.search).get('code');
 if (!code) return false;
 let verifier = null;
 try { verifier = localStorage.getItem(VERIFIER_STORE); localStorage.removeItem(VERIFIER_STORE); } catch { /* storage blocked */ }
 const clean = () => { try { history.replaceState(null, '', callbackUrl()); } catch { /* ignore */ } };
 try {
  const body = { code };
  if (verifier) { body.code_verifier = verifier; body.code_challenge_method = 'S256'; }
  const res = await fetch(KEY_EXCHANGE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.key) throw new Error(data?.error?.message || data?.message || `Sign-in failed (${res.status}). Please try again.`);
  setToken(data.key); clean();
  return true;
 } catch (err) {
  clean();
  throw err;
 }
}
