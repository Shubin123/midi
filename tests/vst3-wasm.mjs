// Loads every VST3 plug-in class in plugins/vst3/*.zip through the same runtime the browser uses,
// and checks each one opens, reports parameters, and processes audio (effects) or plays a note (instruments).
// Every bundle says which editor it has (Contents/Resources/editor.json); for every class with a VSTGUI editor,
// the editor is opened on a recording stand-in for the page's canvas (js/vstgui-web.js does the real drawing,
// tests/plugin-editor.mjs checks it in Chrome), a frame is drawn and must not be blank, a drag across it must
// find a control and edit it, and the processor must hear the edit. Build the zips first with native/build.sh.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readArchive } from '../js/archive.js';
import { Vst3Module } from '../js/vst3-runtime.js';

const RATE = 48000, BLOCK = 128, BLOCKS = 500; // 1.3 s: longer than ADelay's default 1 s delay
const dir = new URL('../plugins/vst3/', import.meta.url);
const zips = readdirSync(dir).filter(f => f.endsWith('.zip'));
assert.ok(zips.length, 'No plugins/vst3/*.zip found; run native/build.sh');
let total = 0, editors = 0;
const silent = [];
// The "vstgui" imports, recording what is drawn: enough of the page for an editor to open and draw.
function recorder(files, root) {
 const drawn = [], res = name => files.get(`${root}Resources/${name}`);
 return {
  drawn,
  hooks: m => ({
   vstgui: new Proxy({}, { get: (_, name) => {
    if (name === 'resource_size') return p => res(m.string(p))?.length ?? -1;
    if (name === 'resource_read') return (p, to) => { const r = res(m.string(p)); new Uint8Array(m.x.memory.buffer, to, r.length).set(r); };
    if (name === 'bitmap_load') return (p, size) => { const png = res(m.string(p)); if (!png) return 0; new Int32Array(m.x.memory.buffer, size, 2).set([png[19] | png[18] << 8, png[23] | png[22] << 8]); return drawn.push('load') ; };
    if (name === 'text_width') return p => m.string(p).length * 7;
    if (['fill', 'stroke', 'image', 'text', 'clear'].includes(name)) return () => { drawn.push(name); };
    return () => 0;
   } }),
   vst3web: { edit: (kind, id, value) => { if (kind === 1) { drawn.edits ||= []; drawn.edits.push([id, value]); m.set(id, value); } } },
  }),
 };
}
const level = (plugin, io, blocks = 40) => {
 let e = 0;
 for (let b = 0; b < blocks; b++) {
  for (let c = 0; c < io.inputs; c++) { const buf = plugin.buffer(0, c, BLOCK); for (let i = 0; i < BLOCK; i++) buf[i] = 0.3 * Math.sin(2 * Math.PI * 220 * (b * BLOCK + i) / RATE); }
  plugin.process(BLOCK);
  for (let c = 0; c < io.outputs; c++) for (const v of plugin.buffer(1, c, BLOCK)) e += v * v;
 }
 return Math.sqrt(e / (blocks * BLOCK * Math.max(1, io.outputs)));
};
for (const zip of zips) {
 const files = await readArchive(new Blob([readFileSync(new URL(zip, dir))]), zip);
 const wasmPath = [...files.keys()].find(p => /\.vst3\/Contents\/wasm32-web\/[^/]+\.wasm$/.test(p));
 assert.ok(wasmPath, `${zip} has no wasm32-web binary`);
 assert.ok([...files.keys()].some(p => p.endsWith('Resources/VST3-SDK-LICENSE.txt')), `${zip} is missing the SDK license`);
 const root = wasmPath.replace(/wasm32-web\/[^/]+$/, '');
 const declared = files.get(`${root}Resources/editor.json`);
 assert.ok(declared, `${zip} doesn't say which editor it has (Contents/Resources/editor.json)`);
 const { framework } = JSON.parse(new TextDecoder().decode(declared));
 if (framework === 'vstgui') assert.ok(files.has(`${root}Resources/VSTGUI-LICENSE.txt`), `${zip} has a VSTGUI editor but not VSTGUI's license`);
 const module = await WebAssembly.compile(files.get(wasmPath));
 const classes = new Vst3Module(module).classes();
 assert.ok(classes.length > 0, `${zip} exposes no audio classes`);
 for (const info of classes) {
  const plugin = new Vst3Module(module); // a fresh instance per class, as each worklet gets
  const io = plugin.open(info.index, RATE, BLOCK);
  const params = plugin.params();
  for (const p of params.slice(0, 3)) assert.equal(typeof plugin.text(p.id, p.value), 'string');
  if (params[0]) plugin.set(params[0].id, params[0].value);
  if (info.instrument || (io.events && !io.inputs)) plugin.note(true, 60, 0.8);
  let energy = 0;
  for (let b = 0; b < BLOCKS; b++) {
   for (let c = 0; c < io.inputs; c++) {
    const buf = plugin.buffer(0, c, BLOCK);
    for (let i = 0; i < BLOCK; i++) buf[i] = 0.3 * Math.sin(2 * Math.PI * 220 * (b * BLOCK + i) / RATE);
   }
   assert.equal(plugin.process(BLOCK), 0, `${info.name} process failed`);
   for (let c = 0; c < io.outputs; c++) for (const v of plugin.buffer(1, c, BLOCK)) { assert.ok(Number.isFinite(v), `${info.name} produced NaN`); energy += v * v; }
  }
  const rms = Math.sqrt(energy / (BLOCKS * BLOCK * Math.max(1, io.outputs)));
  if (rms < 1e-5) silent.push(info.name);
  console.log(`${zip.padEnd(14)} ${info.name.padEnd(22)} ${(info.instrument ? 'instrument' : 'effect').padEnd(10)} in ${io.inputs} out ${io.outputs} params ${String(params.length).padStart(2)} rms ${rms.toFixed(4)}  ${info.subCategories}`);
  plugin.close();
  total++;

  // Its editor: opened, drawn, and dragged until a control moves, which the processor must hear.
  if (framework !== 'vstgui') continue;
  const rec = recorder(files, root), ed = new Vst3Module(module, rec.hooks);
  const eio = ed.open(info.index, RATE, BLOCK);
  const size = ed.x.malloc(12);
  assert.equal(ed.x.vst3web_view_open(size), 0, `${info.name}: its editor didn't open`);
  const [w, h] = new Int32Array(ed.x.memory.buffer, size, 2);
  assert.ok(w > 0 && h > 0, `${info.name}: its editor is ${w} × ${h}`);
  ed.x.vst3web_view_focus(1);
  assert.equal(ed.x.vst3web_view_draw(1), 1, `${info.name}: its editor drew nothing`);
  const kinds = new Set(rec.drawn);
  assert.ok(rec.drawn.length > 10 && kinds.has('fill') && kinds.has('text'), `${info.name}: its first frame is blank (${rec.drawn.length} calls: ${[...kinds]})`);
  const before = level(ed, eio);
  for (let y = 4; y < h && !rec.drawn.edits; y += 6) for (let x = 4; x < w && !rec.drawn.edits; x += 12) {
   ed.x.vst3web_view_mouse(0, x, y, 1, 0, 1); ed.x.vst3web_view_mouse(1, x - 60, y, 1, 0, 1); ed.x.vst3web_view_mouse(2, x - 60, y, 1, 0, 1);
  }
  assert.ok(rec.drawn.edits?.length, `${info.name}: no control in its editor answered a drag`);
  const after = level(ed, eio);
  assert.ok(Math.abs(after - before) > 1e-4, `${info.name}: the processor didn't hear the editor's edit (rms ${before.toFixed(4)} then ${after.toFixed(4)})`);
  console.log(`${''.padEnd(14)} ${'  its editor'.padEnd(22)} ${w} × ${h}, ${rec.drawn.length} draw calls; a drag set parameter ${rec.drawn.edits[0][0]} and the output went from ${before.toFixed(4)} to ${after.toFixed(4)}`);
  ed.x.vst3web_view_close(); ed.close();
  editors++;
 }
}
console.log(`${total} VST3 plug-in classes loaded and processed audio, ${editors} opened their own editors${silent.length ? `; silent with default settings: ${silent.join(', ')}` : ''}.`);
