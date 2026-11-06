// A backup of the workspace: everything the app keeps in this browser's localStorage (the layout, the patch,
// the sequence and lanes, the teacher's conversations and course, settings, controller presets and what each
// controller learned) as one JSON file, and putting such a file back. Only the app's own keys go in and come
// back, so another page on the same site keeps its own, and nothing secret is there (provider keys live in
// cookies, a sign-in's one-time verifier is left out). Plug-in files the app keeps in IndexedDB aren't in it.
const PREFIXES = /^(synth|teacher-|teach-|timing-|listen|looper-|midi-|controller-|panic-button-|speech-local-|audio-to-provider-)/;
export const FORMAT = 'midi-workspace-backup';
export const isAppKey = key => PREFIXES.test(key) && key !== 'openrouter_pkce_verifier';

// The backup's text; `storage` is localStorage unless a test gives another.
export function makeBackup(storage = localStorage, now = new Date()) {
 const keys = {};
 for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (isAppKey(k)) keys[k] = storage.getItem(k); }
 return JSON.stringify({ format: FORMAT, version: 1, saved: now.toISOString(), keys }, null, 1);
}
export const isBackup = text => { try { return JSON.parse(text)?.format === FORMAT; } catch { return false; } };
// Puts a backup's keys back (the app's keys it doesn't have are removed, so the workspace is as it was).
// Returns how many keys it wrote. Reload the page afterwards for everything to read them.
export function restoreBackup(text, storage = localStorage) {
 let b;
 try { b = JSON.parse(text); } catch (err) { throw new Error(`that isn't a backup (${err.message})`); }
 if (b?.format !== FORMAT || !b.keys || typeof b.keys !== 'object') throw new Error('that isn\'t a workspace backup from this app');
 const entries = Object.entries(b.keys).filter(([k, v]) => isAppKey(k) && typeof v === 'string');
 const stale = []; for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (isAppKey(k) && !(k in b.keys)) stale.push(k); }
 stale.forEach(k => storage.removeItem(k));
 entries.forEach(([k, v]) => storage.setItem(k, v));
 return entries.length;
}
