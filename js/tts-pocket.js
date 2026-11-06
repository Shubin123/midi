// Pocket TTS voices for the teacher's talk mode: Kyutai's small (100M-parameter) English speech model, run on
// the viewer's own CPU. pocket-tts-js drives an ONNX export of the model with ONNX Runtime Web inside a worker,
// so speaking doesn't freeze the page. Its worker is a blob: URL importing the library from jsDelivr (a worker
// can't be started from another origin's URL), and without cross-origin isolation ONNX Runtime runs on one
// thread. The code comes from jsDelivr; the int8 graphs (vlapky's copy of KevinAHM's export) and Kyutai's own
// precomputed voices from Hugging Face, all pinned; downloads are kept in Cache Storage under "tts-pocket".
// Licences: pocket-tts-js and ONNX Runtime MIT; the weights © Kyutai, CC-BY-4.0, which requires crediting
// Kyutai where the voice is offered. Each voice carries its recording's licence, listed below.

const LIB_URL = 'https://cdn.jsdelivr.net/npm/pocket-tts-js@0.1.0/src/index.js';
const WORKER_URL = 'https://cdn.jsdelivr.net/npm/pocket-tts-js@0.1.0/src/worker.js';
const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/'; // the app's version; a little faster than the library's 1.20
const MODEL_BASE = 'https://huggingface.co/vlapky/pocket-tts-onnx/resolve/c469236dbc5f68287fa2fbf175b66de3b80123af/onnx';
const LANGUAGE = 'english_2026-04';
// Kyutai's voice states for that model, one file each (4–8 MB), so only the chosen voice is downloaded; the
// library's own voices.bin is all eight original voices in one 52 MB file. The ungated repo has the same files.
const VOICE_BASE = `https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/a7056f505a4a8ca72d8b5fb1440071d6f1a35739/languages/${LANGUAGE}/embeddings/`;
const MODEL_BYTES = 59339 + 16388384 + 76341079 + 9962530 + 22684077; // tokenizer + the four int8 graphs
const CACHE = 'tts-pocket';

// Kyutai's English voices. Genders were measured on what the model says, not taken from the names: pitch,
// formants and AudioSet's speech classifier agree on each, and all three hear Alba, Kyutai's default and often
// listed as female, as a man (around 130 Hz). Accents from VCTK's speaker list and Voice-Zero's notes. Anna is
// the default: over 40 s of coaching lines she scored highest of the women on DNSMOS (Microsoft's speech-quality
// predictor; tied with Fantine), Whisper understood her almost word for word, and she is clearly female and
// CC BY 4.0. Licences: Marius and Javert (voice donations) and the LibriVox readers (Caro Davy, Bill Boerst,
// Peter Yearsley, Stuart Bell) CC0; Cosette (Expresso) and Jean (EARS) CC BY-NC 4.0, non-commercial use only;
// Alba and the rest (VCTK) CC BY 4.0. Kyutai's six voices from other languages were left out.
export const ENGINE = {
 id: 'pocket', name: 'Pocket TTS',
 about: 'Kyutai\'s natural-sounding voices, run on this device: 125 MB for the model plus 4–8 MB per voice, kept for next time.',
 license: 'pocket-tts-js and ONNX Runtime MIT; model weights by Kyutai, CC-BY-4.0 (credit Kyutai); voices CC BY 4.0 or CC0, except Cosette and Jean (non-commercial).',
 voices: [
  { id: 'anna', label: 'Anna (UK, female)', female: true },
  { id: 'vera', label: 'Vera (UK, female)', female: true },
  { id: 'fantine', label: 'Fantine (UK, female)', female: true },
  { id: 'eponine', label: 'Eponine (Scottish, female)', female: true },
  { id: 'azelma', label: 'Azelma (Canadian, female)', female: true },
  { id: 'mary', label: 'Mary (US, female)', female: true },
  { id: 'jane', label: 'Jane (US, female)', female: true },
  { id: 'eve', label: 'Eve (US, female)', female: true },
  { id: 'caro_davy', label: 'Caro Davy (UK, female)', female: true },
  { id: 'cosette', label: 'Cosette (female, non-commercial)', female: true },
  { id: 'alba', label: 'Alba (male)', female: false },
  { id: 'marius', label: 'Marius (male)', female: false },
  { id: 'javert', label: 'Javert (male)', female: false },
  { id: 'charles', label: 'Charles (UK, male)', female: false },
  { id: 'paul', label: 'Paul (UK, male)', female: false },
  { id: 'george', label: 'George (US, male)', female: false },
  { id: 'michael', label: 'Michael (US, male)', female: false },
  { id: 'bill_boerst', label: 'Bill Boerst (US, male)', female: false },
  { id: 'peter_yearsley', label: 'Peter Yearsley (UK, male)', female: false },
  { id: 'stuart_bell', label: 'Stuart Bell (UK, male)', female: false },
  { id: 'jean', label: 'Jean (male, non-commercial)', female: false },
 ],
 defaultVoice: 'anna',
};

const MB = n => Math.round(n / 1e6);
let progress = null; // the onProgress of the load in hand

// Fetches a file, or takes it from the cache; onBytes(got, total) reports progress. Returns a Uint8Array.
async function cachedBytes(url, onBytes) {
 let cache = null;
 try { cache = await caches.open(CACHE); } catch { /* no Cache Storage: just download */ }
 try { const hit = await cache?.match(url); if (hit) return new Uint8Array(await hit.arrayBuffer()); } catch { /* treat as a miss */ }
 const res = await fetch(url);
 if (!res.ok) throw new Error(`Pocket TTS download failed (${res.status}).`);
 const total = +res.headers.get('content-length') || 0, reader = res.body.getReader(), chunks = [];
 let got = 0;
 for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value); got += value.length; onBytes?.(got, total);
 }
 const out = new Uint8Array(got);
 let at = 0;
 for (const c of chunks) { out.set(c, at); at += c.length; }
 try { await cache?.put(url, new Response(out)); } catch { /* over quota: fine, it just won't be cached */ }
 return out;
}

// The library reads built-in voices from one "PTVB1" file; this packs Kyutai's safetensors voice states into one.
// Per voice: name, tensor count, then per tensor its key, dtype (0 f32, 1 i64, 2 bool), shape and bytes.
const DTYPE = { F32: 0, I64: 1, BOOL: 2 };
function voicesBin(voices) {
 const enc = new TextEncoder(), parts = [enc.encode('PTVB1'), u32(voices.size)];
 for (const [name, bytes] of voices) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = Number(view.getBigUint64(0, true)), base = 8 + headerLen;
  const tensors = Object.entries(JSON.parse(new TextDecoder().decode(bytes.subarray(8, base)))).filter(([k]) => k !== '__metadata__');
  parts.push(str(name), u16(tensors.length));
  for (const [key, { dtype, shape, data_offsets: [a, b] }] of tensors) {
   if (!(dtype in DTYPE)) throw new Error(`Pocket TTS: unexpected ${dtype} in the ${name} voice.`);
   parts.push(str(key), new Uint8Array([DTYPE[dtype], shape.length]), ...shape.map(u32), u32(b - a), bytes.subarray(base + a, base + b));
  }
 }
 return new Blob(parts);
 function str(s) { const b = enc.encode(s); return new Blob([u16(b.length), b]); }
}
function u16(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }
function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }

let Pocket = null, workerUrl = null, tts = null, inWorker = new Set(), current = null;
const voiceBytes = new Map(); // the last few voices used, so a restart brings them along (oldest first)
const KEEP_VOICES = 4; // each is 4–8 MB here and again in the worker
let queue = Promise.resolve();
// One thing at a time: the library has a single chunk callback, and a voice change can restart the worker.
const serial = fn => (queue = queue.catch(() => {}).then(fn));
const MODEL_FILES = ['tokenizer', 'text_conditioner', 'flow_lm_main', 'flow_lm_flow', 'mimi_decoder'];

// The library reads built-in voices once per worker, so a voice it hasn't got means starting a new worker with
// it and the last few used; the models then come from the cache, under a second.
async function ensure(voiceId, onProgress) {
 const voice = ENGINE.voices.find(v => v.id === voiceId);
 if (!voice) throw new Error(`"${voiceId}" isn't a Pocket TTS voice.`);
 progress = onProgress || null;
 if (tts && current === voiceId) return;
 if (tts && inWorker.has(voiceId)) { await tts.loadVoice(voiceId); current = voiceId; return; }
 const name = voice.label.split(' (')[0];
 const bytes = voiceBytes.get(voiceId) || await cachedBytes(`${VOICE_BASE}${voiceId}.safetensors`, (got, total) =>
  progress?.({ text: `Pocket TTS: the ${name} voice, ${MB(got)} of ${MB(total)} MB`, progress: total ? got / total : undefined }));
 voiceBytes.delete(voiceId); voiceBytes.set(voiceId, bytes);
 while (voiceBytes.size > KEEP_VOICES) voiceBytes.delete(voiceBytes.keys().next().value);
 tts?.destroy(); tts = null; current = null;
 progress?.({ text: 'Pocket TTS: loading the runtime…' });
 Pocket ||= pocketClass((await import(/* @vite-ignore */ LIB_URL)).PocketTTS);
 const url = URL.createObjectURL(voicesBin(voiceBytes));
 const engine = new Pocket({ language: LANGUAGE, quantized: true, voiceCloning: false, modelBaseUrl: MODEL_BASE, ortBaseUrl: ORT_DIST, voicesUrl: url, cacheName: CACHE });
 const got = {};
 try {
  await engine.load(p => {
   if (p.type !== 'progress' || !MODEL_FILES.includes(p.label)) return;
   got[p.label] = p.loaded;
   const sum = Object.values(got).reduce((a, b) => a + b, 0);
   progress?.({ text: p.fromCache ? 'Pocket TTS: starting the model…' : `Pocket TTS: ${MB(sum)} of ${MB(MODEL_BYTES)} MB`, progress: Math.min(1, sum / MODEL_BYTES) });
  });
  await engine.loadVoice(voiceId); // reads the voices file, so the blob: URL must live until here
 } catch (e) { engine.destroy(); throw e; }
 finally { URL.revokeObjectURL(url); }
 tts = engine; inWorker = new Set(voiceBytes.keys()); current = voiceId;
}

// pocket-tts-js starts its worker from its own URL, which a page can't do across origins; a blob: worker on
// this origin that imports the library's worker script from jsDelivr does the same job.
function pocketClass(PocketTTS) {
 return class extends PocketTTS {
  _ensureWorker() {
   if (this.worker) return;
   workerUrl ||= URL.createObjectURL(new Blob([`import ${JSON.stringify(WORKER_URL)};`], { type: 'text/javascript' }));
   this.worker = new Worker(workerUrl, { type: 'module' });
   this.worker.onmessage = e => this._handleMessage(e.data);
   this.worker.onerror = e => {
    const err = new Error(e.message || 'Pocket TTS couldn\'t start (its worker failed to load).');
    for (const { reject } of this._pending.values()) reject(err);
    this._pending.clear();
   };
  }
 };
}

// Downloads and starts the model and the voice; later calls with a voice already loaded return at once.
export function load(voiceId = ENGINE.defaultVoice, onProgress) {
 return serial(() => ensure(voiceId, onProgress));
}

// Speaks text in a voice: { samples: Float32Array (mono, -1..1), sampleRate }. Sentences are generated in turn
// with a short pause between them, as the library streams them. The voices come out at very different levels
// (Stuart Bell 16 dB below Jean), so each reply is brought to about -20 dBFS, as far as its peaks allow.
export function synthesize(text, voiceId = ENGINE.defaultVoice) {
 return serial(async () => {
  await ensure(voiceId);
  const chunks = [];
  if (String(text).trim()) await tts.generate(String(text), { voice: `builtin:${voiceId}`, onChunk: a => chunks.push(a) });
  const samples = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0, sum = 0, peak = 0;
  for (const c of chunks) { samples.set(c, at); at += c.length; }
  for (const v of samples) { sum += v * v; peak = Math.max(peak, Math.abs(v)); }
  const rms = Math.sqrt(sum / (samples.length || 1));
  if (rms > 1e-4) { const gain = Math.min(0.1 / rms, 0.95 / peak); for (let i = 0; i < samples.length; i++) samples[i] *= gain; }
  return { samples, sampleRate: tts.sampleRate };
 });
}
