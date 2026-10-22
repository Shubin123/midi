// Loads every VST3 plug-in class in plugins/vst3/*.zip through the same runtime the browser uses,
// and checks each one opens, reports parameters, and processes audio (effects) or plays a note (instruments).
// Build the zips first with native/build.sh.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readArchive } from '../js/archive.js';
import { Vst3Module } from '../js/vst3-runtime.js';

const RATE = 48000, BLOCK = 128, BLOCKS = 500; // 1.3 s: longer than ADelay's default 1 s delay
const dir = new URL('../plugins/vst3/', import.meta.url);
const zips = readdirSync(dir).filter(f => f.endsWith('.zip'));
assert.ok(zips.length, 'No plugins/vst3/*.zip found; run native/build.sh');
let total = 0;
const silent = [];
for (const zip of zips) {
 const files = await readArchive(new Blob([readFileSync(new URL(zip, dir))]), zip);
 const wasmPath = [...files.keys()].find(p => /\.vst3\/Contents\/wasm32-web\/[^/]+\.wasm$/.test(p));
 assert.ok(wasmPath, `${zip} has no wasm32-web binary`);
 assert.ok([...files.keys()].some(p => p.endsWith('Resources/VST3-SDK-LICENSE.txt')), `${zip} is missing the SDK license`);
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
 }
}
console.log(`${total} VST3 plug-in classes loaded and processed audio${silent.length ? `; silent with default settings: ${silent.join(', ')}` : ''}.`);
