// Supertonic, Supertone's on-device text-to-speech, as one of talk mode's neural voices (see js/voice.js).
// Supertonic 3 (99M parameters, 44.1 kHz) runs in the browser through ONNX Runtime Web: on the GPU (WebGPU) when
// there is one, else on the CPU (single-threaded WASM, so the page needn't be cross-origin isolated). Text goes in
// as characters (unicode_indexer.json); a duration predictor sets how long it takes to say, a text encoder reads
// it in the chosen voice's style, a flow-matching estimator turns noise into speech latents over several passes,
// and a vocoder makes the waveform. Ported from the official web example (github.com/supertone-inc/supertonic,
// web/helper.js; sample code under the MIT License, Copyright (c) 2025 Supertone Inc.). The model weights are
// under the BigScience OpenRAIL-M licence, which forbids some uses (huggingface.co/supertone-oss-archive/
// supertonic-3/blob/aafc6e32416a594460b32413efc49d7fe4ce6d46/LICENSE). Supertone has archived the project, so the
// weights come from its archive namespace at a pinned revision. ONNX Runtime loads from jsDelivr on demand and
// the weights are kept in Cache Storage, so only the first use downloads them.

// The same build as js/laya.js, so a page using both loads one runtime.
const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const REVISION = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
const MODEL_BASE = `https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/${REVISION}/`;
const CACHE = `tts-supertonic-3-${REVISION.slice(0, 8)}`; // "Clear downloaded models" removes caches named tts-…
// The four graphs with their sizes, so one progress bar covers the whole 398 MB.
const GRAPHS = [
 ['dp', 'onnx/duration_predictor.onnx', 3700147],
 ['enc', 'onnx/text_encoder.onnx', 36416150],
 ['est', 'onnx/vector_estimator.onnx', 256534781],
 ['voc', 'onnx/vocoder.onnx', 101424195],
];
const LANG = 'en';
// Denoising passes. On the GPU, 8, the project's own default: a sentence takes about 0.6 s on an M4 Mac, 12
// took half as long again, and 5 left Whisper misreading more words (16 in 1,270 against 10).
// On the CPU 8 passes run at 0.8x real time on that Mac, too close to keep up with playback on a slower machine,
// so it takes 5 (0.5x real time), which still reads back at about 99% word accuracy.
const STEPS_GPU = 8, STEPS_CPU = 5;
const SPEED = 1.05; // the project's default pace (its demo calls this "1.0x")
const MAX_CHUNK = 300; // characters per pass, as in the example; longer text is split at sentences
const GAP = 0.3; // seconds of silence between those parts

export const ENGINE = {
 id: 'supertonic', name: 'Supertonic',
 about: 'Supertone\'s Supertonic 3: clear, natural speech made on this device, fast on a GPU; a one-time 400 MB download.',
 license: 'Code MIT (Supertone sample code); model OpenRAIL-M (use restrictions apply).',
 // The preset styles, with the names Supertone's own demo gives them.
 voices: [
  { id: 'F1', label: 'Sarah, calm and steady (female)', female: true },
  { id: 'F2', label: 'Lily, bright and cheerful (female)', female: true },
  { id: 'F3', label: 'Jessica, clear announcer (female)', female: true },
  { id: 'F4', label: 'Olivia, crisp and confident (female)', female: true },
  { id: 'F5', label: 'Emily, kind and gentle (female)', female: true },
  { id: 'M1', label: 'Alex, lively and upbeat (male)', female: false },
  { id: 'M2', label: 'James, deep and calm (male)', female: false },
  { id: 'M3', label: 'Robert, polished and assured (male)', female: false },
  { id: 'M4', label: 'Sam, soft and friendly (male)', female: false },
  { id: 'M5', label: 'Daniel, warm storyteller (male)', female: false },
 ],
 // F1. No community ranking of the voices turned up, and Supertone's demo starts on a male one (M3). All five
 // female styles read our teacher sentences back almost word-perfectly (Whisper, 0.4–1.2% of words wrong), so
 // F1 was picked on character: Supertone describes it as calm and steady, for guided instructions, the nearest
 // to a teacher (F2 is playful, F4 brisk), at an unhurried pace, and it lost nothing at the CPU's 5 passes.
 defaultVoice: 'F1',
};

let ort = null, sessions = null, steps = STEPS_CPU, cfg = null, indexer = null, ready = null, warm = null, queue = Promise.resolve();
const styles = new Map(), listeners = new Set();
const report = p => listeners.forEach(f => { try { f(p); } catch { /* a listener's problem, not ours */ } });

// One file from the pinned revision, from Cache Storage when it's there. Only complete files are cached.
async function fetchFile(file, size, onBytes) {
 const url = MODEL_BASE + file;
 let cache = null;
 try { cache = await caches.open(CACHE); } catch { /* no Cache Storage: just download */ }
 try {
  const hit = await cache?.match(url);
  if (hit) { const bytes = new Uint8Array(await hit.arrayBuffer()); if (!size || bytes.length === size) { onBytes?.(bytes.length); return bytes; } }
 } catch { /* treat as a miss */ }
 const res = await fetch(url);
 if (!res.ok) throw new Error(`Supertonic download failed (${file}: ${res.status}).`);
 const reader = res.body.getReader(), chunks = [];
 let got = 0;
 for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value); got += value.length; onBytes?.(got);
 }
 if (size && got !== size) throw new Error(`Supertonic download was incomplete (${file}).`);
 const bytes = new Uint8Array(got);
 let at = 0;
 for (const c of chunks) { bytes.set(c, at); at += c.length; }
 try { await cache?.put(url, new Response(bytes)); } catch { /* over quota: fine, it just won't be cached */ }
 return bytes;
}
const fetchJson = async file => JSON.parse(new TextDecoder().decode(await fetchFile(file)));

async function init() {
 report({ text: 'Supertonic: loading the runtime…' });
 ort = await import(ORT_URL);
 ort.env.wasm.wasmPaths = ORT_DIST;
 ort.env.logLevel = 'error'; // its node-placement notes are expected, not problems
 ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
 // An older revision's cache would otherwise keep its 400 MB for good.
 globalThis.caches?.keys().then(names => names.filter(n => n.startsWith('tts-supertonic') && n !== CACHE).forEach(n => caches.delete(n))).catch(() => {});
 const gpu = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
 const total = GRAPHS.reduce((sum, g) => sum + g[2], 0), got = {};
 const progress = () => {
  const sum = Object.values(got).reduce((a, b) => a + b, 0);
  report(sum < total ? { text: `Supertonic: ${Math.round(sum / 1e6)} of ${Math.round(total / 1e6)} MB`, progress: sum / total } : { text: `Supertonic: starting on ${gpu ? 'the GPU' : 'the CPU'}…`, progress: 1 });
 };
 // All four download at once; each graph starts as soon as its own file is in.
 const files = GRAPHS.map(([key, file, size]) => fetchFile(file, size, n => { got[key] = n; progress(); }));
 files.forEach(f => f.catch(() => {})); // a failure is reported once, below, not again as unhandled
 [cfg, indexer] = await Promise.all([fetchJson('onnx/tts.json'), fetchJson('onnx/unicode_indexer.json')]);
 const out = {};
 for (let i = 0; i < GRAPHS.length; i++) {
  const [key] = GRAPHS[i], bytes = await files[i];
  // logSeverityLevel 3: only errors; its node-placement warnings would otherwise land in the console.
  const create = providers => ort.InferenceSession.create(bytes, { executionProviders: providers, graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  // A GPU that can't take a graph (too little memory, a driver quirk) shouldn't stop the voice: use the CPU.
  const onGpu = gpu && await create(['webgpu', 'wasm']).catch(() => null);
  out[key] = onGpu || await create(['wasm']);
  if (key === 'est') steps = onGpu ? STEPS_GPU : STEPS_CPU; // the estimator is where the time goes
 }
 sessions = out;
}

async function loadStyle(id) {
 const json = await fetchJson(`voice_styles/${id}.json`);
 const tensor = s => new ort.Tensor('float32', Float32Array.from(s.data.flat(Infinity)), s.dims);
 return { ttl: tensor(json.style_ttl), dp: tensor(json.style_dp) };
}

// Downloads and starts Supertonic once, and the given voice style. Safe to call again (it returns at once) or
// while a load is under way; onProgress({ text, progress }) hears about the download either way.
export async function load(voiceId = ENGINE.defaultVoice, onProgress) {
 if (!ENGINE.voices.some(v => v.id === voiceId)) throw new Error(`Supertonic has no voice "${voiceId}".`);
 if (onProgress) listeners.add(onProgress);
 try {
  await (ready ||= init().catch(err => { ready = null; throw err; }));
  if (!styles.has(voiceId)) styles.set(voiceId, loadStyle(voiceId).catch(err => { styles.delete(voiceId); throw err; }));
  const style = await styles.get(voiceId);
  // The first pass on the GPU compiles its shaders; do that now rather than in the first reply.
  await (warm ||= infer(ids('Hello.'), style, 1).catch(() => {}));
 } finally {
  if (onProgress) listeners.delete(onProgress);
 }
}

// The example's text clean-up: plain punctuation, no emoji, a full stop at the end, the language tags around it.
const EMOJI = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu;
function preprocess(text) {
 text = text.normalize('NFKD').replace(EMOJI, '')
  .replace(/[\u2013\u2011\u2014]/g, '-').replace(/_/g, ' ').replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019\u00B4`]/g, '\'')
  .replace(/[[\]|/#→←]/g, ' ').replace(/[♥☆♡©\\]/g, '')
  .replaceAll('@', ' at ').replaceAll('e.g.,', 'for example,').replaceAll('i.e.,', 'that is,')
  .replace(/ ([,.!?;:'])/g, '$1').replace(/"{2,}/g, '"').replace(/'{2,}/g, '\'')
  .replace(/\s+/g, ' ').trim();
 if (!/[.!?;:,'"')\]}…。」』】〉》›»]$/.test(text)) text += '.';
 return `<${LANG}>${text}</${LANG}>`;
}

// Character ids. Characters the model has no id for are left out rather than read as something else.
function ids(text) {
 const out = [];
 for (const ch of preprocess(text)) { const id = indexer[ch.codePointAt(0)]; if (id >= 0) out.push(id); }
 return out;
}

// Splits text into parts of at most MAX_CHUNK characters at paragraph and sentence ends, as the example does.
const SENTENCE_END = /(?<!Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Sr\.|Jr\.|Ph\.D\.|etc\.|e\.g\.|i\.e\.|vs\.|Inc\.|Ltd\.|Co\.|Corp\.|St\.|Ave\.|Blvd\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/;
function chunks(text) {
 const out = [];
 for (const paragraph of text.trim().split(/\n\s*\n+/)) {
  let part = '';
  for (const sentence of paragraph.trim().split(SENTENCE_END)) {
   if (!sentence) continue;
   if (part && part.length + sentence.length + 1 > MAX_CHUNK) { out.push(part); part = sentence; }
   else part = part ? `${part} ${sentence}` : sentence;
  }
  if (part) out.push(part);
 }
 return out;
}

// One part through the four graphs: samples at cfg.ae.sample_rate.
async function infer(textIds, style, passes) {
 const n = textIds.length, { dp, enc, est, voc } = sessions;
 const text_ids = new ort.Tensor('int64', BigInt64Array.from(textIds, BigInt), [1, n]);
 const text_mask = new ort.Tensor('float32', new Float32Array(n).fill(1), [1, 1, n]);
 const { duration } = await dp.run({ text_ids, style_dp: style.dp, text_mask });
 const { text_emb } = await enc.run({ text_ids, style_ttl: style.ttl, text_mask });
 const rate = cfg.ae.sample_rate, length = Math.floor(duration.data[0] / SPEED * rate);
 const frame = cfg.ae.base_chunk_size * cfg.ttl.chunk_compress_factor, frames = Math.max(1, Math.ceil(length / frame));
 const dims = [1, cfg.ttl.latent_dim * cfg.ttl.chunk_compress_factor, frames];
 // Start from Gaussian noise (Box-Muller); with one part per pass every frame is real, so the mask is all ones.
 let x = new Float32Array(dims[1] * frames);
 for (let i = 0; i < x.length; i++) x[i] = Math.sqrt(-2 * Math.log(Math.max(1e-4, Math.random()))) * Math.cos(2 * Math.PI * Math.random());
 const latent_mask = new ort.Tensor('float32', new Float32Array(frames).fill(1), [1, 1, frames]);
 const total_step = new ort.Tensor('float32', new Float32Array([passes]), [1]);
 for (let step = 0; step < passes; step++) {
  const res = await est.run({ noisy_latent: new ort.Tensor('float32', x, dims), text_emb, style_ttl: style.ttl, latent_mask, text_mask, current_step: new ort.Tensor('float32', new Float32Array([step]), [1]), total_step });
  x = res.denoised_latent.data;
 }
 const { wav_tts } = await voc.run({ latent: new ort.Tensor('float32', x, dims) });
 return wav_tts.data.slice(0, length);
}

// Speaks text in the given voice: { samples (mono Float32Array, -1..1), sampleRate }. Loads the engine first if
// needed. Calls run one at a time, in order, since a session can't run two passes at once.
export function synthesize(text, voiceId = ENGINE.defaultVoice) {
 const job = queue.then(async () => {
  await load(voiceId);
  const style = await styles.get(voiceId), rate = cfg.ae.sample_rate;
  const words = String(text ?? ''), parts = /[\p{L}\p{N}]/u.test(words) ? chunks(words) : [];
  const waves = [];
  for (const part of parts) waves.push(await infer(ids(part), style, steps));
  const gap = Math.floor(GAP * rate), samples = new Float32Array(waves.reduce((sum, w) => sum + w.length, 0) + gap * Math.max(0, waves.length - 1));
  let at = 0;
  for (const w of waves) { samples.set(w, at); at += w.length + gap; }
  for (let i = 0; i < samples.length; i++) samples[i] = Math.max(-1, Math.min(1, samples[i]));
  return { samples, sampleRate: rate };
 });
 queue = job.catch(() => {});
 return job;
}
