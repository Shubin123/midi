// Loads browser-native plugins straight from archives: our web-plugin contract or Web Audio Modules 2.0.
// Archives are unpacked in memory and served by plugin-sw.js so relative imports keep working.
import { readArchive, nativeFormats } from './archive.js';
import { fxSlot } from './fx-chain.js';
import { read, save } from './storage.js';
import { el, renderParams, card } from './plugin-ui.js';
import { initializeWamHost } from './vendor/webaudiomodules-sdk.js';

const CACHE = 'zip-plugins-v1';
const TYPES = { js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', wasm: 'application/wasm', html: 'text/html', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', txt: 'text/plain' };
let root, hostGroup;

async function serviceWorker() {
 if (root) return;
 if (!('serviceWorker' in navigator)) throw new Error('Archive plugins need a service worker: open the site over https:// or http://localhost.');
 const reg = await navigator.serviceWorker.register('plugin-sw.js');
 await navigator.serviceWorker.ready;
 if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
  navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true });
  setTimeout(() => reject(new Error('The plugin service worker is not active on this page. Reload normally (not a hard reload) and try again.')), 4000);
 });
 root = new URL('plugin-fs/', reg.scope);
}

function findEntry(files) {
 const json = path => { try { return JSON.parse(new TextDecoder().decode(files.get(path))); } catch { return null; } };
 if (files.has('plugin.json')) { const m = json('plugin.json'); if (m?.main && files.has(m.main)) return { name: m.name, main: m.main }; }
 if (files.has('descriptor.json') && files.has('index.js')) return { name: json('descriptor.json')?.name, main: 'index.js' };
 for (const main of ['index.js', 'index.mjs']) if (files.has(main)) return { main };
 return null;
}

async function install(blob, fileName) {
 const files = await readArchive(blob, fileName);
 const entry = findEntry(files);
 if (!entry) {
  const native = [...files.keys()].map(p => p.match(nativeFormats)?.[1]).find(Boolean);
  throw new Error(native
   ? `${native} is a native plugin or installer (compiled machine code). Browsers can only run JavaScript and WebAssembly, so it cannot load here. Look for a Web Audio Modules version of the plugin.`
   : `No plugin entry found. Expected plugin.json, a WAM descriptor.json with index.js, or index.js. Found: ${[...files.keys()].slice(0, 6).join(', ')}`);
 }
 const name = entry.name || fileName.replace(/\.(zip|tgz|tar(\.gz)?|gz)$/i, '');
 const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plugin';
 await removeFiles(id);
 const cache = await caches.open(CACHE);
 await Promise.all([...files].map(([path, data]) => cache.put(new URL(`${id}/${path}`, root).href,
  new Response(data, { headers: { 'Content-Type': TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream' } }))));
 return { id, name, main: entry.main, version: Date.now(), bypass: false, values: {} };
}

async function removeFiles(id) {
 const cache = await caches.open(CACHE), prefix = new URL(`${id}/`, root).href;
 await Promise.all((await cache.keys()).filter(r => r.url.startsWith(prefix)).map(r => cache.delete(r)));
}

async function instantiate(rec) {
 const ctx = window.synth.ensureAudio();
 const mod = await import(new URL(`${rec.id}/${rec.main}?v=${rec.version}`, root).href);
 const Wam = mod.default;
 if (typeof Wam?.createInstance === 'function') {
  hostGroup ||= await initializeWamHost(ctx);
  const wam = await Wam.createInstance(hostGroup[0], ctx), node = wam.audioNode;
  const info = await node.getParameterInfo();
  const params = Object.values(info).map(p => ({ id: p.id, label: p.label || p.id, min: p.minValue, max: p.maxValue, step: p.discreteStep || (p.maxValue - p.minValue) / 100, value: p.defaultValue, unit: p.units }));
  const gui = await wam.createGui().catch(() => null);
  return { name: rec.name, input: node, output: node, params, gui,
   setParam: (id, value) => node.setParameterValues({ [id]: { id, value, normalized: false } }),
   destroy: () => { if (gui) wam.destroyGui?.(gui); node.disconnect(); node.destroy?.(); } };
 }
 const create = typeof mod.createPlugin === 'function' ? mod.createPlugin : Wam;
 if (typeof create !== 'function') throw new Error(`${rec.main} must export a WAM class or a createPlugin(audioContext) function.`);
 return create(ctx, { baseUrl: new URL(`${rec.id}/`, root).href });
}

export function createPluginHost() {
 const { section, content } = card('plugin-host-module', 'Web plugins (ZIP)');
 const records = read('synth-web-plugins-v1', []).filter(r => r?.id && r.main);
 const persist = () => save('synth-web-plugins-v1', records);
 const picker = el('input', { type: 'file', accept: '.zip,.tar,.tgz,.gz', multiple: true, hidden: true });
 const status = el('span', { role: 'status', textContent: 'Drop a plugin archive here.' });
 const example = el('button', { textContent: 'Load bundled Air.zip' });
 const list = el('div', { className: 'plugin-list' });
 content.append(
  el('div', { className: 'sequence-toolbar' }, el('button', { textContent: '+ Load archive…', onclick: () => picker.click() }), example, status, picker),
  el('p', { className: 'module-hint' }, 'Loads Web Audio Modules 2.0 or web-plugin archives (.zip, .tar, .tar.gz) without unpacking them on disk. Native .vst3/.component binaries cannot run in a browser.'),
  list);
 const live = new Map();
 const teardown = id => { const item = live.get(id); if (!item) return; item.slot.clear(); item.plugin?.destroy?.(); item.box.remove(); live.delete(id); };
 const say = (text, error) => { status.textContent = text; status.classList.toggle('error', !!error); };

 const mount = async rec => {
  const slot = fxSlot(20 + records.indexOf(rec) / 100);
  const bypass = el('input', { type: 'checkbox', checked: rec.bypass });
  const params = el('div', { className: 'plugin-params' }), gui = el('div', { className: 'plugin-gui' });
  const box = el('div', { className: 'plugin-card' },
   el('div', { className: 'sequence-toolbar' }, el('strong', { textContent: rec.name }), el('label', {}, bypass, 'Bypass'),
    el('button', { textContent: 'Remove', onclick: async () => {
     teardown(rec.id);
     records.splice(records.indexOf(rec), 1); persist(); await removeFiles(rec.id); say(`Removed ${rec.name}.`);
    } })),
   params, gui);
  list.append(box);
  const item = { slot, box, plugin: null };
  live.set(rec.id, item);
  try {
   const plugin = item.plugin = await instantiate(rec);
   Object.entries(rec.values).forEach(([id, v]) => plugin.setParam?.(id, v));
   if (plugin.gui) gui.append(plugin.gui);
   else if (plugin.params?.length) renderParams(params, plugin.params.map(p => ({ ...p, value: rec.values[p.id] ?? p.value })), (id, v) => { rec.values[id] = v; plugin.setParam(id, v); persist(); });
   const apply = () => (bypass.checked ? slot.clear() : slot.set(plugin));
   bypass.onchange = () => { rec.bypass = bypass.checked; apply(); persist(); };
   apply();
  } catch (e) {
   params.append(el('p', { className: 'module-hint error', textContent: 'Failed to start: ' + e.message }));
  }
 };

 const load = async (blob, name) => {
  try {
   say(`Reading ${name}…`); await serviceWorker();
   const rec = await install(blob, name);
   const old = records.findIndex(r => r.id === rec.id);
   if (old >= 0) { teardown(rec.id); records.splice(old, 1); }
   records.push(rec); persist(); await mount(rec); say(`Loaded ${rec.name}.`);
  } catch (e) { say(e.message, true); }
 };
 picker.onchange = () => { [...picker.files].forEach(f => load(f, f.name)); picker.value = ''; };
 example.onclick = async () => load(await (await fetch('plugins/air.zip')).blob(), 'air.zip');
 section.addEventListener('dragover', e => { e.preventDefault(); section.classList.add('drop-target'); });
 section.addEventListener('dragleave', () => section.classList.remove('drop-target'));
 section.addEventListener('drop', e => { e.preventDefault(); section.classList.remove('drop-target'); [...e.dataTransfer.files].forEach(f => load(f, f.name)); });
 if (records.length) serviceWorker().then(() => records.forEach(mount)).catch(e => say(e.message, true));
 return section;
}
