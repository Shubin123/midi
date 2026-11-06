// Basic Pitch (Spotify, Apache-2.0; github.com/spotify/basic-pitch), a small neural network that hears several
// notes at once, run in the page with TensorFlow.js: an optional second way to transcribe chords from a clip,
// beside the built-in one (PolyPitch, js/listen-dsp.js). Nothing is downloaded until it is first asked for
// (about 2.6 MB from jsdelivr: TensorFlow.js, its WebGPU or WebAssembly backend, and the model's 0.7 MB of
// weights); the browser keeps them. It runs on the GPU through WebGPU where the browser has it, else in
// WebAssembly, else WebGL or plain JavaScript. Like the built-in one, it is approximate.
const CDN = 'https://cdn.jsdelivr.net/npm/';
const urls = base => ({ tfjs: `${base}@tensorflow/tfjs@4.22.0/dist/tf.min.js`, webgpu: `${base}@tensorflow/tfjs-backend-webgpu@4.22.0/dist/tf-backend-webgpu.min.js`, wasm: `${base}@tensorflow/tfjs-backend-wasm@4.22.0/dist/`, model: `${base}@spotify/basic-pitch@1.0.1/model/model.json` });
export const MODEL_MB = 2.6;

// The model's framing (basic_pitch/constants.py): 2 s windows at 22.05 kHz, a frame every 256 samples, 30
// frames of overlap between windows, 88 piano keys from A0.
const RATE = 22050, HOP = 256, FPS = Math.floor(RATE / HOP), WINDOW = RATE * 2 - HOP, FRAMES = FPS * 2, OVERLAP = 30;
const STEP = WINDOW - OVERLAP * HOP, LOWEST = 21;
// Each window's frames run a little long: this much is taken off every window's worth (from Basic Pitch).
const WINDOW_OFFSET = (HOP / RATE) * (FRAMES - WINDOW / HOP) + 0.0018;
const frameTime = k => (k * HOP) / RATE - WINDOW_OFFSET * Math.floor(k / FRAMES);

const script = src => new Promise((resolve, reject) => {
 if (document.querySelector(`script[src="${src}"]`)) return resolve();
 const s = Object.assign(document.createElement('script'), { src, crossOrigin: 'anonymous', onload: resolve, onerror: () => { s.remove(); reject(new Error(`couldn't download ${src.split('/npm/').pop()}`)); } });
 document.head.append(s);
});

let loading = null;
// Loads TensorFlow.js, the best backend this browser has, and the model, once. Resolves to { tf, model,
// backend }; on failure it can be asked again. `base` is where the files come from (a test points it nowhere).
export function loadBasicPitch(onProgress = () => {}, { base = CDN } = {}) {
 if (base !== CDN) loading = null;
 const at = urls(base);
 loading ||= (async () => {
  onProgress('Downloading TensorFlow.js…');
  await script(at.tfjs);
  const tf = globalThis.tf;
  const tryBackend = async (name, prepare) => { try { await prepare?.(); return (await tf.setBackend(name)) && (await tf.ready(), tf.getBackend() === name); } catch { return false; } };
  let backend = null;
  if (navigator.gpu && (await tryBackend('webgpu', () => script(at.webgpu)))) backend = 'webgpu';
  else if (await tryBackend('wasm', async () => { await script(`${at.wasm}tf-backend-wasm.min.js`); tf.wasm.setWasmPaths(at.wasm); })) backend = 'wasm';
  else if (await tryBackend('webgl')) backend = 'webgl';
  else { await tf.setBackend('cpu'); backend = 'cpu'; }
  onProgress(`Downloading the Basic Pitch model (on ${backend})…`);
  const model = await tf.loadGraphModel(at.model);
  return { tf, model, backend };
 })().catch(err => { loading = null; throw err; });
 const mine = loading;
 if (base !== CDN) loading = null; // a test's source is never kept
 return mine;
}

// Mono samples at any rate, to 22.05 kHz, through the browser's own resampler.
async function resample(samples, sampleRate) {
 if (sampleRate === RATE) return samples;
 const ctx = new OfflineAudioContext(1, Math.ceil((samples.length * RATE) / sampleRate), RATE);
 const b = ctx.createBuffer(1, samples.length, sampleRate); b.copyToChannel(samples, 0);
 const src = new AudioBufferSourceNode(ctx, { buffer: b }); src.connect(ctx.destination); src.start();
 return (await ctx.startRendering()).getChannelData(0);
}

// The model's note and onset activations for a clip: { notes, onsets }, each [frame][key] in 0-1.
export async function activations(samples, sampleRate, onProgress = () => {}) {
 const { tf, model } = await loadBasicPitch(onProgress);
 const audio = await resample(samples, sampleRate);
 const padded = new Float32Array(audio.length + (OVERLAP * HOP) / 2 + WINDOW);
 padded.set(audio, (OVERLAP * HOP) / 2);
 const total = Math.floor((audio.length * FPS) / RATE), notes = [], onsets = [];
 for (let start = 0, k = 0; notes.length < total; start += STEP, k++) {
  onProgress(`Listening with Basic Pitch… ${Math.min(99, Math.round((start / audio.length) * 100))}%`);
  const input = tf.tensor3d(padded.subarray(start, start + WINDOW), [1, WINDOW, 1]);
  const [frames, hits] = model.execute(input, ['Identity_1', 'Identity_2']);
  const keep = async t => (await t.array())[0].slice(OVERLAP / 2, FRAMES - OVERLAP / 2);
  const [f, o] = [await keep(frames), await keep(hits)];
  tf.dispose([input, frames, hits]);
  for (let i = 0; i < f.length && notes.length < total; i++) { notes.push(f[i]); onsets.push(o[i]); }
  if (start > padded.length) break;
 }
 return { notes, onsets };
}

// Notes from the activations, as Basic Pitch decodes them (outputToNotesPoly): onsets are the peaks in time of
// the onset activation (or of a sudden rise in a note's own activation) above `onsetThresh`; each note holds
// while its activation stays above `frameThresh`, allowing 11 frames below, and is kept if longer than
// `minFrames` (about 128 ms). Returns [{ midi, velocity, start, end }] in ms.
export function decode({ notes: frames, onsets }, { onsetThresh = 0.5, frameThresh = 0.3, minFrames = 11, tolerance = 11 } = {}) {
 const n = frames.length, keys = frames[0]?.length || 88;
 if (!n) return [];
 // A note's own activation rising sharply counts as an onset too, scaled to the onsets' peak.
 const rise = frames.map((row, t) => row.map((v, f) => (t < 2 ? 0 : Math.max(0, Math.min(v - frames[t - 1][f], v - frames[t - 2][f])))));
 const peakOn = Math.max(...onsets.flat()), peakRise = Math.max(...rise.flat()) || 1;
 const hit = onsets.map((row, t) => row.map((v, f) => Math.max(v, (rise[t][f] * peakOn) / peakRise)));
 const starts = [];
 for (let t = 1; t < n - 1; t++) for (let f = 0; f < keys; f++) if (hit[t][f] > onsetThresh && hit[t][f] > hit[t - 1][f] && hit[t][f] > hit[t + 1][f]) starts.push([t, f]);
 const left = frames.map(r => r.slice()), out = [];
 for (const [t0, f] of starts.reverse()) {
  let t = t0 + 1, below = 0;
  while (t < n - 1 && below < tolerance) { below = left[t][f] < frameThresh ? below + 1 : 0; t++; }
  t -= below;
  if (t - t0 <= minFrames) continue;
  for (let j = t0; j < t; j++) for (const g of [f - 1, f, f + 1]) if (g >= 0 && g < keys) left[j][g] = 0;
  const amp = frames.slice(t0, t).reduce((a, r) => a + r[f], 0) / (t - t0);
  out.push({ midi: f + LOWEST, velocity: Math.max(0.1, Math.min(1, amp)), start: frameTime(t0) * 1000, end: frameTime(t) * 1000 });
 }
 return out.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

// Several notes at once from a clip, with Basic Pitch.
export async function transcribeWithModel(samples, sampleRate, onProgress) { return decode(await activations(samples, sampleRate, onProgress)); }
