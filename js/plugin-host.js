// Loads browser-native plugins straight from archives: our web-plugin contract or Web Audio Modules 2.0.
// Archives are unpacked in memory and served by plugin-sw.js so relative imports keep working.
// Native plugins (VST3, AU, ...) cannot run in a browser; they are identified and matched to a built-in effect.
import { readArchive } from './archive.js';
import { identifyNative, standInFor } from './native-id.js';
import { fxSlot } from './fx-chain.js';
import { read, save } from './storage.js';
import { el, renderParams, card } from './plugin-ui.js';
import { initializeWamHost } from './vendor/webaudiomodules-sdk.js';

const CACHE = 'zip-plugins-v1';
const BUILT_INS = { air: 'Air', reverb: 'Reverb', delay: 'Delay', compressor: 'Compressor', saturator: 'Saturator', chorus: 'Chorus' };
const ADVICE = [
 [/^iPlug2/, 'Built with iPlug2, which can export Web Audio Modules directly. A WAM build from the developer would load in this widget.'],
 [/^JUCE/, 'Built with JUCE. The developer could compile it to WebAssembly for the browser; JUCE support for that is experimental.'],
 [/^DPF/, 'Built with DPF, which has experimental WebAssembly support, so a browser build is possible from the source code.'],
 [/^HISE/, 'Built with HISE. A browser build would have to come from the developer.']
];
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

// A dropped folder keeps its own name as the first path segment; web plugins expect their files at the root.
function stripRoot(files) {
 const roots = new Set([...files.keys()].map(p => p.split('/')[0]));
 return roots.size === 1 && [...files.keys()].every(p => p.includes('/')) ? new Map([...files].map(([p, d]) => [p.slice(p.indexOf('/') + 1), d])) : files;
}

async function toFiles(blob, name) {
 try { return await readArchive(blob, name); } catch (e) {
  if (!/Unsupported archive/.test(e.message)) throw e;
  return new Map([[name, new Uint8Array(await blob.arrayBuffer())]]);
 }
}

async function readEntry(entry, prefix, files) {
 if (entry.isFile) { const file = await new Promise((resolve, reject) => entry.file(resolve, reject)); files.set(prefix + entry.name, new Uint8Array(await file.arrayBuffer())); return; }
 const reader = entry.createReader();
 for (let batch; (batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))).length;) for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, files);
}

async function install(files, entry, fileName) {
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
 const { section, content } = card('plugin-host-module', 'Plugins');
 const records = read('synth-web-plugins-v1', []).filter(r => r?.id && r.main);
 const persist = () => save('synth-web-plugins-v1', records);
 const picker = el('input', { type: 'file', multiple: true, hidden: true });
 const status = el('span', { role: 'status', textContent: 'Drop a plugin, folder, or archive here.' });
 const builtIn = el('select'); builtIn.setAttribute('aria-label', 'Built-in effect');
 Object.entries(BUILT_INS).forEach(([value, textContent]) => builtIn.append(el('option', { value, textContent })));
 const found = el('div', { className: 'plugin-list' }), list = el('div', { className: 'plugin-list' });
 content.append(
  el('div', { className: 'sequence-toolbar' }, el('button', { textContent: '+ Load file…', onclick: () => picker.click() }), builtIn,
   el('button', { textContent: 'Add built-in', onclick: () => addBuiltIn(builtIn.value) }), status, picker),
  el('p', { className: 'module-hint' }, 'Loads Web Audio Modules 2.0 and web-plugin archives (.zip, .tar, .tar.gz). Native plugins (.vst3, .component, .dll, .pkg installers, or archives of them) are identified instead: browsers cannot run compiled code, so the closest built-in effect is offered.'),
  found, list);
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

 const showNative = (items, source) => {
  items.forEach(item => {
   const stand = standInFor(item);
   const type = [item.kind !== 'Unknown' && item.kind, item.categories.filter(c => c !== 'Fx' && c !== 'Instrument').join(', ')].filter(Boolean).join(' · ');
   const rows = [['Format', item.format], ['Type', type || (item.installer ? '' : 'Not declared')], ['Vendor', item.vendor], ['Version', item.version], ['Bundle ID', item.bundleId],
    ['Platforms', item.platforms.join(', ')], ['Built with', [...item.frameworks, item.sdk && `VST SDK ${item.sdk.replace(/^VST /, '')}`].filter(Boolean).join(', ')],
    ['Minimum macOS', item.minOS], ['Installs to', item.installLocation && item.installLocation !== '/' ? item.installLocation : null], ['Found at', item.path]].filter(([, v]) => v);
   const notes = [...(item.notes || []), item.note,
    !item.installer && 'This is compiled machine code for the platforms above. Browsers only run JavaScript and WebAssembly, so it cannot run here.',
    ...item.frameworks.map(f => ADVICE.find(([re]) => re.test(f))?.[1]),
    item.complete === false && 'Only the installer\'s manifest could be read, so the type and platforms are unknown.',
    item.kind === 'Instrument' && 'Instruments cannot be replaced by an effect. Play it with the built-in synth.'].filter(Boolean);
   const box = el('div', { className: 'plugin-card native-card' },
    el('div', { className: 'sequence-toolbar' }, el('strong', { textContent: item.name }), el('span', { className: 'badge', textContent: item.format }),
     ...(stand ? [el('button', { textContent: `Use ${BUILT_INS[stand]} instead`, onclick: () => addBuiltIn(stand) })] : []),
     el('a', { href: 'https://www.webaudiomodules.com/community/', target: '_blank', rel: 'noopener', textContent: 'Find web plugins ↗' }),
     el('button', { textContent: 'Dismiss', onclick: () => box.remove() })),
    el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })])),
    ...notes.map(n => el('p', { className: 'module-hint', textContent: n })));
   found.append(box);
  });
  say(`Identified ${items.length} native item${items.length === 1 ? '' : 's'} in ${source}.`);
 };

 const loadFiles = async (files, name) => {
  const entry = findEntry(files) || findEntry(stripRoot(files));
  if (entry) {
   await serviceWorker();
   const rec = await install(findEntry(files) ? files : stripRoot(files), entry, name);
   const old = records.findIndex(r => r.id === rec.id);
   if (old >= 0) { teardown(rec.id); records.splice(old, 1); }
   records.push(rec); persist(); await mount(rec); say(`Loaded ${rec.name}.`);
   return;
  }
  const native = await identifyNative(files);
  if (native.length) return showNative(native, name);
  throw new Error(`No plugin found in ${name}. Expected a Web Audio Module, a web plugin (plugin.json), or a native plugin to identify. Found: ${[...files.keys()].slice(0, 5).join(', ')}`);
 };
 const load = async (source, name) => {
  try { say(`Reading ${name}…`); await loadFiles(source instanceof Map ? source : await toFiles(source, name), name); } catch (e) { say(e.message, true); }
 };
 const addBuiltIn = async id => load(await (await fetch(`plugins/${id}.zip`)).blob(), `${id}.zip`);
 picker.onchange = () => { [...picker.files].forEach(f => load(f, f.name)); picker.value = ''; };
 section.addEventListener('dragover', e => { e.preventDefault(); section.classList.add('drop-target'); });
 section.addEventListener('dragleave', () => section.classList.remove('drop-target'));
 section.addEventListener('drop', e => {
  e.preventDefault(); section.classList.remove('drop-target');
  const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...e.dataTransfer.files].forEach(f => load(f, f.name));
  entries.forEach(entry => entry.isDirectory
   ? (async () => { say(`Reading ${entry.name}…`); const files = new Map(); try { await readEntry(entry, '', files); } catch (err) { return say(err.message, true); } load(files, entry.name); })()
   : entry.file(f => load(f, f.name), err => say(err.message, true)));
 });
 if (records.length) serviceWorker().then(() => records.forEach(mount)).catch(e => say(e.message, true));
 return section;
}
