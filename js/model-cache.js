// The on-device models' downloads, kept in the browser so a second visit loads quickly: WebLLM stores Qwen in
// Cache Storage under "webllm/…" (or in IndexedDB databases of the same prefix), and Laya stores its weights
// under "laya-…", and the neural voices (js/tts-*.js) under "tts-<engine>…". This lists them and deletes them.
// Plug-in archives live in their own cache and are not touched. A model that is already loaded keeps running
// until the page is reloaded.
import { MODELS as QWEN } from './local-model.js';

const OURS = /^(webllm|laya-|tts-)/;
const VOICE_NAMES = { supertonic: 'Supertonic voice', pocket: 'Pocket TTS voice', piper: 'Piper voice' };

// { laya, qwen: [model labels], voices: [names], caches: [names], bytes } — bytes is the whole site's storage use, when the
// browser reports it (models are nearly all of it).
export async function modelCacheInfo() {
 if (typeof caches === 'undefined') return { laya: false, qwen: [], voices: [], caches: [], bytes: null };
 const names = (await caches.keys()).filter(n => OURS.test(n));
 const qwen = new Set();
 for (const name of names.filter(n => n.startsWith('webllm'))) {
  for (const req of await (await caches.open(name)).keys()) {
   const hit = QWEN.find(m => req.url.includes(m.id));
   if (hit) qwen.add(hit.label.split(' —')[0]);
  }
 }
 let bytes = null;
 try { bytes = (await navigator.storage?.estimate?.())?.usage ?? null; } catch { /* not reported */ }
 const voices = [...new Set(names.filter(n => n.startsWith('tts-')).map(n => VOICE_NAMES[n.slice(4).split(/[-_]/)[0]] || 'a voice'))];
 return { laya: names.some(n => n.startsWith('laya-')), qwen: [...qwen], voices, caches: names, bytes };
}

// Deletes every downloaded model. Returns how many caches and databases were removed.
export async function clearModelCache() {
 let removed = 0;
 if (typeof caches !== 'undefined') for (const name of (await caches.keys()).filter(n => OURS.test(n))) if (await caches.delete(name)) removed++;
 if (typeof indexedDB !== 'undefined' && indexedDB.databases) {
  for (const { name } of await indexedDB.databases()) {
   if (!name || !/^webllm/.test(name)) continue;
   await new Promise(resolve => { const req = indexedDB.deleteDatabase(name); req.onsuccess = req.onerror = req.onblocked = resolve; });
   removed++;
  }
 }
 return removed;
}

export const formatBytes = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round((n || 0) / 1e3)} kB`);
