// Loads browser-native plugins straight from archives: our web-plugin contract, Web Audio Modules 2.0, and VST3
// bundles built for WebAssembly (with their own editors where they have one: js/plugin-editor.js).
// Archives are unpacked in memory (a file of hundreds of MB is left unread until needed: js/archive.js) and
// served by plugin-sw.js so relative imports keep working.
// Native machine-code plugins (VST3, AU, ...) can't run in a browser; they are identified and offered a rebuild,
// a capture or a built-in stand-in.
import { readArchive, writeZip, LargeEntry, LARGE } from './archive.js';
import { testSignal, encodeWav, analyze, verdict, layout } from './capture.js';
import { createCapturedPlugin } from './capture-engine.js';
import { Vst3Module } from './vst3-runtime.js';
import { identifyNative, standInFor, editorFrameworkOf } from './native-id.js';
import { fxSlot, instrumentSlot, updateVoices } from './fx-chain.js';
import { read, save } from './storage.js';
import { el, renderParams, card } from './plugin-ui.js';
import { pluginWindow } from './plugin-window.js';
import { mountView } from './plugin-editor.js';
import './vstgui-web.js'; // the adapter for VSTGUI editors
import { initializeWamHost } from './vendor/webaudiomodules-sdk.js';

const CACHE = 'zip-plugins-v1';
const BUILT_INS = { air: 'Air', reverb: 'Reverb', delay: 'Delay', compressor: 'Compressor', saturator: 'Saturator', chorus: 'Chorus',
 'vst3/mda-vst3': 'VST3: MDA collection (34 plug-ins)', 'vst3/AGain': 'VST3: Steinberg AGain (with its own editor)', 'vst3/ADelay': 'VST3: Steinberg ADelay',
 'vst3/AGainSampleAccurate': 'VST3: Steinberg AGain Sample Accurate', 'vst3/SyncDelay': 'VST3: Steinberg SyncDelay',
 // One class of a module, loaded as its own plug-in: the MDA instruments play from the keyboard, sequencer and looper.
 'vst3/mda-vst3#mda JX10': 'VST3 instrument: MDA JX10 synth', 'vst3/mda-vst3#mda DX10': 'VST3 instrument: MDA DX10 FM synth',
 'vst3/mda-vst3#mda Piano': 'VST3 instrument: MDA Piano', 'vst3/mda-vst3#mda EPiano': 'VST3 instrument: MDA ePiano' };
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
 if (files.has('plugin.json')) { const m = json('plugin.json'); if (m?.main && files.has(m.main)) return { name: m.name, main: m.main, format: m.format }; }
 if (files.has('descriptor.json') && files.has('index.js')) return { name: json('descriptor.json')?.name, main: 'index.js' };
 for (const main of ['index.js', 'index.mjs']) if (files.has(main)) return { main };
 return null;
}

// A dropped folder keeps its own name as the first path segment; web plugins expect their files at the root.
function stripRoot(files) {
 const roots = new Set([...files.keys()].map(p => p.split('/')[0]));
 return roots.size === 1 && [...files.keys()].every(p => p.includes('/')) ? new Map([...files].map(([p, d]) => [p.slice(p.indexOf('/') + 1), d])) : files;
}

// A dropped file of LARGE bytes or more (an installer, a disk image) is read only as far as it is needed.
const fileData = async file => file.size >= LARGE ? new LargeEntry(file, file.size) : new Uint8Array(await file.arrayBuffer());

async function toFiles(blob, name) {
 try { return await readArchive(blob, name); } catch (e) {
  if (!/Unsupported archive/.test(e.message)) throw e;
  return new Map([[name, await fileData(blob)]]);
 }
}

async function readEntry(entry, prefix, files) {
 if (entry.isFile) { const file = await new Promise((resolve, reject) => entry.file(resolve, reject)); files.set(prefix + entry.name, await fileData(file)); return; }
 const reader = entry.createReader();
 for (let batch; (batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))).length;) for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, files);
}

async function install(files, entry, fileName) {
 const name = entry.name || fileName.replace(/\.(zip|tgz|tar(\.gz)?|gz)$/i, '');
 const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plugin';
 await removeFiles(id);
 const cache = await caches.open(CACHE);
 await Promise.all([...files].map(([path, data]) => cache.put(new URL(`${id}/${path}`, root).href,
  new Response(data instanceof LargeEntry ? data.stream() : data, { headers: { 'Content-Type': TYPES[path.split('.').pop().toLowerCase()] || 'application/octet-stream' } }))));
 return { id, name, main: entry.main, format: entry.format, version: Date.now(), bypass: false, values: {} };
}

async function removeFiles(id) {
 const cache = await caches.open(CACHE), prefix = new URL(`${id}/`, root).href;
 await Promise.all((await cache.keys()).filter(r => r.url.startsWith(prefix)).map(r => cache.delete(r)));
}

// VST3 bundles that carry a WebAssembly build (Contents/wasm32-web/*.wasm) run directly.
const WASM_BUNDLE = /^(?:.*\/)?[^/]+\.vst3\/Contents\/wasm32-web\/[^/]+\.wasm$/i;
const wasmBinary = files => [...files.keys()].find(p => WASM_BUNDLE.test(p));
const worklets = new WeakSet();

// The files in a VST3 bundle's Contents/Resources, by name (an editor's .uidesc and bitmaps), and which editor
// it says it has (editor.json: {"framework": "vstgui" | "none" | ...}).
const resourcesDir = rec => rec.main.replace(/wasm32-web\/[^/]+$/, 'Resources/');
async function readResources(rec) {
 const cache = await caches.open(CACHE), prefix = new URL(`${rec.id}/${resourcesDir(rec)}`, root).href, out = new Map();
 for (const req of await cache.keys()) if (req.url.startsWith(prefix)) out.set(decodeURIComponent(req.url.slice(prefix.length)), new Uint8Array(await (await cache.match(req)).arrayBuffer()));
 return out;
}
// Undeclared, it is read from the binary: our VSTGUI build exports the view functions; any other framework's
// strings name it (js/native-id.js), so the window can say which one it can't show yet.
async function editorFramework(rec, module) {
 try { const r = await fetch(new URL(`${rec.id}/${resourcesDir(rec)}editor.json`, root)); if (r.ok) return (await r.json()).framework || 'none'; } catch { /* none declared */ }
 if (WebAssembly.Module.exports(module).some(e => e.name === 'vst3web_view_open')) return 'vstgui';
 const found = editorFrameworkOf(new Uint8Array(await (await fetch(new URL(`${rec.id}/${rec.main}`, root))).arrayBuffer()));
 return found && found !== 'vstgui' ? found : found === 'vstgui' ? 'vstgui-native' : 'none';
}

async function instantiateVst3(ctx, rec) {
 const module = await WebAssembly.compileStreaming(fetch(new URL(`${rec.id}/${rec.main}`, root)));
 // This instance is the controller half (role 2): parameters and their text here, the processor in the worklet,
 // their messages crossing through its port. An open editor runs in an instance of its own (js/vstgui-web.js).
 let node = null, plugin = null;
 const editors = new Set();
 const control = new Vst3Module(module, m => ({ vst3web: { message: (ptr, length) => node?.port.postMessage({ message: m.bytes(ptr, length) }) } }));
 const classes = control.classes();
 const info = (rec.className && classes.find(c => c.name === rec.className)) || classes[rec.classIndex] || classes[0];
 if (!info) throw new Error('This VST3 module contains no audio plug-in classes.');
 const io = control.open(info.index, ctx.sampleRate, 128, 2);
 if (!worklets.has(ctx)) { await ctx.audioWorklet.addModule(new URL('./vst3-worklet.js', import.meta.url)); worklets.add(ctx); }
 node = new AudioWorkletNode(ctx, 'vst3-wasm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
  processorOptions: { module, classIndex: info.index, values: rec.values, tempo: window.synth.tempo } });
 await new Promise((resolve, reject) => { node.port.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve()); });
 // What the processor sends back: its output parameters (meters) and messages for the controller.
 node.port.onmessage = ({ data }) => {
  if (data.out) for (const [id, v] of data.out) { control.controllerSet(id, v); editors.forEach(e => e.output(id, v)); plugin?.onOutput?.(id, v); }
  if (data.message) { control.deliver(data.message); editors.forEach(e => e.message(data.message)); }
 };
 const input = ctx.createGain(), output = ctx.createGain();
 if (io.inputs && !info.instrument) input.connect(node);
 node.connect(output);
 const onNote = ({ detail }) => node.port.postMessage({ note: detail.midi, on: detail.on, velocity: detail.velocity });
 const onPanic = () => node.port.postMessage({ panic: true });
 // Tempo-synced plug-ins (SyncDelay, mda DubDelay, ...) follow the session tempo through the VST3 ProcessContext.
 const onTempo = ({ detail }) => node.port.postMessage({ tempo: detail });
 window.addEventListener('synth:tempo', onTempo);
 if (io.events) { window.addEventListener('synth:note', onNote); window.addEventListener('synth:panic', onPanic); }
 const params = control.params().map(p => ({ id: p.id, label: p.title, min: 0, max: 1, step: p.steps > 0 ? 1 / p.steps : 0.001, value: p.value,
  format: v => `${control.text(p.id, v)}${p.units ? ' ' + p.units : ''}`.trim() }));
 const framework = await editorFramework(rec, module);
 plugin = {
  name: info.name, input, output, params, classes, classIndex: info.index, instrument: info.instrument, events: io.events, layer: !!rec.layer,
  editor: { framework }, module,
  values: () => control.values(), resources: () => readResources(rec),
  send: bytes => node.port.postMessage({ message: bytes }),
  connect: hooks => { editors.add(hooks); return () => editors.delete(hooks); },
  setLayer: on => { plugin.layer = on; updateVoices(); },
  setParam: (id, value) => { control.set(Number(id), value); node.port.postMessage({ param: Number(id), value }); },
  destroy: () => { window.removeEventListener('synth:tempo', onTempo); window.removeEventListener('synth:note', onNote); window.removeEventListener('synth:panic', onPanic); node.disconnect(); input.disconnect(); control.close(); }
 };
 return plugin;
}

async function instantiate(rec) {
 const ctx = window.synth.ensureAudio();
 if (rec.format === 'vst3-wasm') return instantiateVst3(ctx, rec);
 if (rec.format === 'capture') {
  const model = await (await fetch(new URL(`${rec.id}/model.json`, root))).json();
  const raw = new Float32Array(await (await fetch(new URL(`${rec.id}/ir.f32`, root))).arrayBuffer());
  const ir = Array.from({ length: model.channels }, (_, c) => raw.subarray(c * model.length, (c + 1) * model.length));
  return createCapturedPlugin(ctx, model, ir);
 }
 const mod = await import(new URL(`${rec.id}/${rec.main}?v=${rec.version}`, root).href);
 const Wam = mod.default;
 if (typeof Wam?.createInstance === 'function') {
  hostGroup ||= await initializeWamHost(ctx);
  const wam = await Wam.createInstance(hostGroup[0], ctx), node = wam.audioNode;
  const info = await node.getParameterInfo();
  const params = Object.values(info).map(p => ({ id: p.id, label: p.label || p.id, min: p.minValue, max: p.maxValue, step: p.discreteStep || (p.maxValue - p.minValue) / 100, value: p.defaultValue, unit: p.units }));
  const gui = await wam.createGui().catch(() => null);
  return { name: rec.name, input: node, output: node, params, gui, editor: gui ? { framework: 'html' } : undefined,
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
 const capName = el('input', { type: 'text', placeholder: 'Name for the capture', className: 'capture-name' });
 capName.setAttribute('aria-label', 'Capture name');
 const capFile = el('input', { type: 'file', accept: 'audio/*,.wav,.aif,.aiff,.flac', hidden: true });
 const capResult = el('div');
 const capturePanel = el('div', { className: 'plugin-card capture-panel', hidden: true },
  el('div', { className: 'sequence-toolbar' }, el('strong', { textContent: 'Capture a plugin' }), capName, el('button', { textContent: 'Close', onclick: () => { capturePanel.hidden = true; } })),
  el('p', { className: 'module-hint' }, 'Measures any effect plugin from its sound and rebuilds it with one general model: a level-dependent curve followed by the measured impulse response. Tone, EQ, filtering, reverb, delay, saturation and steady-state level behaviour carry over; modulation and compressor timing are approximated. The original plugin is not needed again afterwards.'),
  el('ol', { className: 'module-hint capture-steps' },
   el('li', {}, el('button', { textContent: 'Download test signal', onclick: () => downloadSignal() }), ' (a stereo WAV).'),
   el('li', {}, 'In any DAW, put it on a track with the plugin inserted and set the way you want it. Export the full length at the same sample rate, with no normalizing or dithering.'),
   el('li', {}, el('button', { textContent: 'Load processed file…', onclick: () => capFile.click() }), ' or drop it on this widget.')),
  capResult, capFile);
 content.append(
  el('div', { className: 'sequence-toolbar' }, el('button', { textContent: '+ Load file…', onclick: () => picker.click() }), builtIn,
   el('button', { textContent: 'Add built-in', onclick: () => addBuiltIn(builtIn.value) }),
   el('button', { textContent: 'Capture a plugin…', onclick: () => openCapture('') }), status, picker),
  el('p', { className: 'module-hint' }, 'Loads Web Audio Modules 2.0 and web-plugin archives (.zip, .tar, .tar.gz). VST3 plug-ins built for WebAssembly run here, with their own editors. Plug-ins that only contain macOS, Windows or Linux machine code are identified and offered a rebuild from source, a sound capture, or a built-in stand-in.'),
  capturePanel, found, list);
 const live = new Map();
 const teardown = id => { const item = live.get(id); if (!item) return; item.view?.close(); item.slot.clear(); item.plugin?.destroy?.(); item.box.remove(); item.win.remove(); live.delete(id); };
 const say = (text, error) => { status.textContent = text; status.classList.toggle('error', !!error); };

 // Each plug-in gets a row in this widget and its own window with its controls; closing the window keeps it running.
 const mount = async rec => {
  rec.window ||= { open: false };
  const kind = { 'vst3-wasm': 'VST3', capture: 'Capture' }[rec.format] || 'Web plugin';
  const rowName = el('strong', { textContent: rec.name }), rowBadge = el('span', { className: 'badge', textContent: kind });
  const rowBypass = el('input', { type: 'checkbox', checked: rec.bypass }), bypass = el('input', { type: 'checkbox', checked: rec.bypass });
  const openButton = el('button', { textContent: 'Open' }), problem = el('span', { className: 'module-hint error' });
  const remove = async () => {
   teardown(rec.id);
   records.splice(records.indexOf(rec), 1); persist(); await removeFiles(rec.id); say(`Removed ${rec.name}.`);
  };
  const box = el('div', { className: 'plugin-card plugin-row' },
   el('div', { className: 'sequence-toolbar' }, rowName, rowBadge, el('label', {}, rowBypass, 'Bypass'), openButton,
    el('button', { textContent: 'Remove', onclick: remove }), problem));
  list.append(box);
  const win = pluginWindow({ title: rec.name, state: rec.window, opener: openButton,
   onChange: open => { openButton.textContent = open ? 'Close' : 'Open'; openButton.setAttribute('aria-expanded', open); persist(); } });
  openButton.textContent = win.open ? 'Close' : 'Open'; openButton.setAttribute('aria-expanded', win.open);
  openButton.onclick = () => win.toggle();
  // The generic controls are made first, so they are there whatever happens to the plug-in's own editor.
  const generic = el('div', { className: 'plugin-params' }), viewBox = el('div', { className: 'plugin-view' }), extra = el('span', { className: 'sequence-toolbar' });
  win.content.append(
   el('div', { className: 'sequence-toolbar' }, extra, el('label', {}, bypass, 'Bypass'),
    ...(rec.format === 'capture' ? [el('button', { textContent: 'Export .zip', onclick: () => exportCapture(rec) })] : []),
    el('button', { textContent: 'Remove', onclick: remove })),
   viewBox);
  const item = { slot: { clear() {} }, box, win, plugin: null };
  live.set(rec.id, item);
  try {
   const plugin = item.plugin = await instantiate(rec);
   // Instruments replace the built-in synth's voices; effects join the chain in load order.
   const slot = item.slot = plugin.instrument ? instrumentSlot() : fxSlot(20 + records.indexOf(rec) / 100);
   if (plugin.name) { rowName.textContent = plugin.name; win.setTitle(plugin.name); }
   if (plugin.classes) { vst3Controls(rec, plugin, extra); rowBadge.textContent = `VST3 · ${plugin.instrument ? 'Instrument' : 'Effect'}`; }
   Object.entries(rec.values).forEach(([id, v]) => plugin.setParam?.(id, v));
   const shown = plugin.params?.length ? renderParams(generic, plugin.params.map(p => ({ ...p, value: rec.values[p.id] ?? p.value })), (id, v) => { rec.values[id] = v; plugin.setParam(id, v); item.view?.editor?.param?.(id, v); persist(); })
    : (generic.append(el('p', { className: 'module-hint', textContent: 'This plug-in has no controls to show.' })), null);
   // Then its own editor, where it has one; an edit there reaches the processor and moves the generic control.
   const toggle = el('span'); win.addToHeader(toggle);
   item.view = mountView({ box: viewBox, header: toggle, generic, plugin, choice: rec.view || 'editor',
    onChoice: mode => { rec.view = mode; persist(); }, onSize: w => win.fitContent(w),
    bridge: { edit: (id, v) => { rec.values[id] = v; plugin.setParam(id, v, 'editor'); shown?.set(id, v); persist(); } } });
   plugin.onOutput = (id, v) => shown?.set(id, v); // meters and other values the processor reports
   win.place();
   const setBypass = on => { rec.bypass = bypass.checked = rowBypass.checked = on; on ? slot.clear() : slot.set(plugin); };
   bypass.onchange = () => { setBypass(bypass.checked); persist(); };
   rowBypass.onchange = () => { setBypass(rowBypass.checked); persist(); };
   setBypass(rec.bypass);
  } catch (e) {
   problem.textContent = 'Failed to start';
   viewBox.append(el('p', { className: 'module-hint error', textContent: 'Failed to start: ' + e.message }));
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
    !item.installer && 'This is compiled machine code for the platforms above. Browsers only run JavaScript and WebAssembly, so this binary cannot run here.',
    item.format === 'VST3' && 'With the plug-in\'s source code, native/build.sh compiles it against the VST3 SDK into a wasm32-web bundle that loads here like any VST3. Without source, capture its sound instead.',
    ...item.frameworks.map(f => ADVICE.find(([re]) => re.test(f))?.[1]),
    item.complete === false && 'Only the installer\'s manifest could be read, so the type and platforms are unknown.',
    item.kind === 'Instrument' && 'Instruments cannot be replaced by an effect. Play it with the built-in synth.'].filter(Boolean);
   const box = el('div', { className: 'plugin-card native-card' },
    el('div', { className: 'sequence-toolbar' }, el('strong', { textContent: item.name }), el('span', { className: 'badge', textContent: item.format }),
     ...(!item.installer && item.kind !== 'Instrument' ? [el('button', { textContent: 'Capture its sound', onclick: () => openCapture(item.name) })] : []),
     ...(stand ? [el('button', { textContent: `Quick stand-in: ${BUILT_INS[stand]}`, onclick: () => addBuiltIn(stand) })] : []),
     el('a', { href: 'https://www.webaudiomodules.com/community/', target: '_blank', rel: 'noopener', textContent: 'Find web plugins ↗' }),
     el('button', { textContent: 'Dismiss', onclick: () => box.remove() })),
    el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })])),
    ...notes.map(n => el('p', { className: 'module-hint', textContent: n })));
   found.append(box);
  });
  say(`Identified ${items.length} native item${items.length === 1 ? '' : 's'} in ${source}.`);
 };

 const openCapture = name => { capturePanel.hidden = false; if (name) capName.value = name; capturePanel.scrollIntoView({ block: 'nearest' }); };
 const downloadSignal = () => {
  const ctx = window.synth.ensureAudio(), rate = ctx.sampleRate, signal = testSignal(rate);
  const a = el('a', { href: URL.createObjectURL(encodeWav([signal, signal], rate)), download: `plugin-capture-test-${rate}hz.wav` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  say(`Test signal: ${(layout(rate).length / rate).toFixed(1)} s at ${rate} Hz.`);
 };
 const analyzeFile = async (blob, fileName) => {
  openCapture(capName.value || fileName.replace(/\.[^.]+$/, ''));
  say(`Analyzing ${fileName}…`); capResult.replaceChildren();
  const ctx = window.synth.ensureAudio();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const result = await analyze(Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)), ctx.sampleRate);
  const [grade, explain] = verdict(result.esr), r = result.report;
  const name = capName.value.trim() || 'Captured plugin';
  const rows = [['Match', `${grade} · ${(r.accuracy * 100).toFixed(1)}%`], ['Impulse response', `${r.irSeconds.toFixed(2)} s, ${r.stereo ? 'stereo' : 'mono'}`],
   ['Latency', `${r.latencyMs.toFixed(1)} ms`], ['Level dependence', r.levelSpreadDb < 0.5 ? 'linear' : `up to ${r.levelSpreadDb.toFixed(1)} dB across levels`]];
  capResult.replaceChildren(
   el('dl', {}, ...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v })])),
   el('p', { className: 'module-hint', textContent: explain }),
   el('button', { textContent: `Add “${name}” to the chain`, onclick: () => {
    const length = result.ir[0].length, raw = new Float32Array(length * result.ir.length);
    result.ir.forEach((c, i) => raw.set(c, i * length));
    const model = { name, sampleRate: result.sampleRate, latency: result.latency, points: result.points, channels: result.ir.length, length, esr: result.esr, capturedAt: new Date().toISOString() };
    const enc = new TextEncoder();
    load(new Map([['plugin.json', enc.encode(JSON.stringify({ name, main: 'model.json', format: 'capture' }))], ['model.json', enc.encode(JSON.stringify(model))], ['ir.f32', new Uint8Array(raw.buffer)]]), name);
   } }));
  say(`Captured ${name}: ${grade.toLowerCase()} match.`);
 };
 const exportCapture = async rec => {
  const files = new Map();
  for (const path of ['plugin.json', 'model.json', 'ir.f32']) files.set(path, new Uint8Array(await (await fetch(new URL(`${rec.id}/${path}`, root))).arrayBuffer()));
  const a = el('a', { href: URL.createObjectURL(writeZip(files)), download: `${rec.id}.zip` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
 };
 const vst3Controls = (rec, plugin, extra) => {
  extra.append(el('span', { className: 'badge', textContent: `VST3 · ${plugin.instrument ? 'Instrument' : 'Effect'}` }));
  if (plugin.classes.length > 1) {
   const pick = el('select'); pick.setAttribute('aria-label', 'Plug-in in this module');
   plugin.classes.forEach(c => pick.append(el('option', { value: c.index, textContent: `${c.name} (${c.instrument ? 'instrument' : 'effect'})` })));
   pick.value = plugin.classIndex;
   pick.onchange = () => { rec.classIndex = Number(pick.value); delete rec.className; rec.values = {}; persist(); teardown(rec.id); mount(rec); };
   extra.append(pick);
  }
  if (plugin.instrument) {
   const layer = el('input', { type: 'checkbox', checked: !!rec.layer });
   layer.onchange = () => { rec.layer = layer.checked; plugin.setLayer(layer.checked); persist(); };
   extra.append(el('label', {}, layer, 'Layer built-in synth'));
  }
 };

 // className picks one class of a multi-plug-in VST3 module and names the plug-in after it.
 const loadFiles = async (files, name, className) => {
  const wasm = wasmBinary(files);
  const entry = wasm ? { name: className || wasm.match(/([^/]+)\.vst3\//i)[1], main: wasm, format: 'vst3-wasm' } : findEntry(files) || findEntry(stripRoot(files));
  if (entry) {
   await serviceWorker();
   const rec = await install(wasm || findEntry(files) ? files : stripRoot(files), entry, name);
   if (wasm) { rec.classIndex = 0; if (className) rec.className = className; }
   const old = records.findIndex(r => r.id === rec.id);
   rec.window = { ...records[old]?.window, open: true }; // a plug-in opens its own window when added, where it was before
   if (old >= 0) { teardown(rec.id); records.splice(old, 1); }
   records.push(rec); persist(); await mount(rec); say(`Loaded ${rec.name}.`);
   return;
  }
  const native = await identifyNative(files);
  if (native.length) return showNative(native, name);
  throw new Error(`No plugin found in ${name}. Expected a Web Audio Module, a web plugin (plugin.json), or a native plugin to identify. Found: ${[...files.keys()].slice(0, 5).join(', ')}`);
 };
 const load = async (source, name, className) => {
  try {
   if (!(source instanceof Map) && /\.(wav|aiff?|flac|mp3|m4a|ogg)$/i.test(name)) return await analyzeFile(source, name);
   say(`Reading ${name}…`); await loadFiles(source instanceof Map ? source : await toFiles(source, name), name, className);
  } catch (e) { say(e.message, true); }
 };
 const addBuiltIn = async id => {
  const [path, className] = id.split('#');
  return load(await (await fetch(`plugins/${path}.zip`)).blob(), `${path.split('/').pop()}.zip`, className);
 };
 capFile.onchange = () => { const f = capFile.files[0]; capFile.value = ''; if (f) load(f, f.name); };
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
