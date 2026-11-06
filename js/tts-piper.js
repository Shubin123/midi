// Piper voices for the teacher's talk mode: Rhasspy's fast neural (VITS) speech models, run on the viewer's
// own device through ONNX Runtime Web. Text becomes phonemes with espeak-ng (compiled to wasm by piper-phonemize),
// then the voice model turns them into audio. ONNX Runtime runs in its own worker (a blob: URL, so it works
// without cross-origin isolation), so speaking doesn't freeze the page. The libraries come from jsDelivr and the
// voices from Hugging Face, both pinned, and everything downloaded is kept in Cache Storage under "tts-piper".
// Licences: Piper and its voices repository MIT; ONNX Runtime MIT; the piper-phonemize glue (from
// piper-tts-web) MIT; espeak-ng, inside the phonemizer wasm and its data, GPL-3.0. Each voice also carries its
// training data's licence, listed with the voices below.

const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.mjs';
const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
// piper-wasm ships its glue only as CommonJS; piper-tts-web carries the same glue as an ES module.
const PHONEMIZE_URL = 'https://cdn.jsdelivr.net/npm/@mintplex-labs/piper-tts-web@1.0.5/dist/piper-o91UDS6e.js';
const ESPEAK_URL = 'https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize'; // .wasm and .data
const ESPEAK_BYTES = 635212 + 18077249; // unpacked sizes: jsDelivr sends them compressed, so Content-Length can't be used
const VOICE_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/e7229f7d33a10e145e109b886d661984201ac3c4/';
const CACHE = 'tts-piper';
const SENTENCE_GAP = 0.2; // seconds of silence between sentences, as the Piper command line leaves

// English voices worth offering, with each one's download. Cori is the default: a clear, natural LibriVox
// narrator in the public domain. Listening round-ups rate Lessac the most polished English Piper voice (it is
// Home Assistant's default), but its training data is licensed for non-commercial research only, so it is
// offered, marked, rather than chosen for everyone on a public page. Its "high" build sounds a touch cleaner but ran slower than real time here
// (single-threaded WASM on an M-series Mac: 9.7 s to say 7 s, against 0.85 s for medium), so only medium
// builds are offered. Amy is warmer on short replies but rougher on long ones. Licences: Lessac is Blizzard
// 2013 data (non-commercial research only); HFC and Ryan are CC BY-NC-SA 4.0; Kristin and Cori are public
// domain (LibriVox); Jenny requires credit as "Jenny (Dioco)"; Joe is CC0; Amy's and Alan's are unstated.
export const ENGINE = {
 id: 'piper', name: 'Piper',
 about: 'Rhasspy\'s fast neural voices, run on this device: about 73 MB to download for the default voice, kept for next time.',
 license: 'Piper and voices repo MIT, ONNX Runtime MIT, espeak-ng GPL-3.0; each voice its data\'s licence (Cori and Kristin public domain; voices marked non-commercial are for non-commercial use only).',
 voices: [
  { id: 'en_US-lessac-medium', label: 'Lessac (US, female, non-commercial)', female: true, mb: 63 },
  { id: 'en_US-amy-medium', label: 'Amy (US, female)', female: true, mb: 63 },
  { id: 'en_US-hfc_female-medium', label: 'HFC (US, female, non-commercial)', female: true, mb: 63 },
  { id: 'en_US-kristin-medium', label: 'Kristin (US, female)', female: true, mb: 64 },
  { id: 'en_GB-cori-medium', label: 'Cori (UK, female)', female: true, mb: 64 },
  { id: 'en_GB-jenny_dioco-medium', label: 'Jenny (Dioco) (UK, female)', female: true, mb: 63 },
  { id: 'en_US-ryan-medium', label: 'Ryan (US, male, non-commercial)', female: false, mb: 63 },
  { id: 'en_US-joe-medium', label: 'Joe (US, male)', female: false, mb: 63 },
  { id: 'en_US-hfc_male-medium', label: 'HFC (US, male, non-commercial)', female: false, mb: 63 },
  { id: 'en_GB-alan-medium', label: 'Alan (UK, male)', female: false, mb: 63 },
 ],
 defaultVoice: 'en_GB-cori-medium',
};

// "en_US-lessac-medium" lives at en/en_US/lessac/medium/en_US-lessac-medium.onnx (names never contain "-").
const voiceUrl = id => {
 const [locale, name, quality] = id.split('-');
 if (!quality) throw new Error(`"${id}" isn't a Piper voice name.`);
 return `${VOICE_BASE}${locale.split('_')[0]}/${locale}/${name}/${quality}/${id}.onnx`;
};

// Fetches a file, or takes it from the cache; onBytes(got, total) reports progress. Returns an ArrayBuffer.
async function cachedBytes(url, onBytes, expected = 0) {
 let cache = null;
 try { cache = await caches.open(CACHE); } catch { /* no Cache Storage: just download */ }
 try { const hit = await cache?.match(url); if (hit) { const buf = await hit.arrayBuffer(); onBytes?.(buf.byteLength, buf.byteLength); return buf; } } catch { /* treat as a miss */ }
 const res = await fetch(url);
 if (!res.ok) throw new Error(`Piper download failed (${res.status}).`);
 const total = (!res.headers.get('content-encoding') && +res.headers.get('content-length')) || expected;
 const reader = res.body.getReader(), chunks = [];
 let got = 0;
 for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value); got += value.length; onBytes?.(got, Math.max(total, got));
 }
 const out = new Uint8Array(got);
 let at = 0;
 for (const c of chunks) { out.set(c, at); at += c.length; }
 try { await cache?.put(url, new Response(out)); } catch { /* over quota: fine, it just won't be cached */ }
 return out.buffer;
}

let ortPromise = null, espeakPromise = null, sink = () => {};
const voices = new Map(); // voiceId → Promise<{ id, session, config }>
let queue = Promise.resolve(); // ONNX Runtime runs one request per session at a time, so requests take turns

const loadOrt = () => (ortPromise ||= import(/* @vite-ignore */ ORT_URL).then(ort => {
 ort.env.wasm.wasmPaths = ORT_DIST;
 ort.env.wasm.proxy = true; // inference on ONNX Runtime's own worker, off the page's thread
 ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
 ort.env.logLevel = 'error';
 return ort;
}));

// One phonemizer instance serves every voice: espeak-ng starts afresh on each call, so it can be reused.
const loadEspeak = onBytes => (espeakPromise ||= (async () => {
 const seen = [0, 0];
 const part = i => got => { seen[i] = got; onBytes?.(seen[0] + seen[1], ESPEAK_BYTES); };
 const [{ createPiperPhonemize }, wasmBinary, data] = await Promise.all([
  import(/* @vite-ignore */ PHONEMIZE_URL),
  cachedBytes(ESPEAK_URL + '.wasm', part(0)),
  cachedBytes(ESPEAK_URL + '.data', part(1)),
 ]);
 return createPiperPhonemize({ wasmBinary, getPreloadedPackage: () => data, print: s => sink(s), printErr: () => {} });
})().catch(e => { espeakPromise = null; throw e; }));

// Text → one list of phoneme ids per sentence. The phonemizer prints a JSON line joining the sentences, each
// running ^ … $.
async function phonemize(text, voice, config) {
 const espeak = await loadEspeak();
 const lines = [];
 sink = s => lines.push(s);
 try { espeak.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']); }
 finally { sink = () => {}; }
 const ids = lines.flatMap(l => { try { return JSON.parse(l).phoneme_ids || []; } catch { return []; } });
 const eos = config.phoneme_id_map?.$?.[0] ?? 2, sentences = [];
 let current = [];
 for (const id of ids) { current.push(id); if (id === eos) { sentences.push(current); current = []; } }
 if (current.length) sentences.push(current);
 return sentences.filter(s => s.length > 3); // ^ and $ alone say nothing
}

// Downloads and starts a voice (once; later calls return the same promise). onProgress({ text, progress }) as
// the teacher's other models report it. Loading a different voice releases the previous one's memory.
export function load(voiceId = ENGINE.defaultVoice, onProgress = () => {}) {
 if (voices.has(voiceId)) return voices.get(voiceId);
 const url = voiceUrl(voiceId);
 const promise = (async () => {
  onProgress({ text: 'Piper: loading the voice…' });
  const label = ENGINE.voices.find(v => v.id === voiceId)?.label.split(' (')[0] || voiceId;
  const expected = (ENGINE.voices.find(v => v.id === voiceId)?.mb || 63) * 1e6;
  const seen = { espeak: 0, model: 0 }, totals = { espeak: espeakPromise ? 0 : ESPEAK_BYTES, model: expected };
  const report = (key, got, total) => {
   seen[key] = got; totals[key] = total;
   const all = totals.espeak + totals.model, have = seen.espeak + seen.model;
   onProgress({ text: `Piper (${label}): ${Math.round(have / 1e6)} of ${Math.round(all / 1e6)} MB`, progress: Math.min(1, have / all) });
  };
  const [ort, config, model] = await Promise.all([
   loadOrt(),
   cachedBytes(url + '.json').then(b => JSON.parse(new TextDecoder().decode(b))),
   cachedBytes(url, (got, total) => report('model', got, total), expected),
   loadEspeak((got, total) => report('espeak', got, total)),
  ]);
  onProgress({ text: `Piper (${label}): starting…`, progress: 1 });
  const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  // Keep one voice in memory (each holds 63 MB of weights); the cache makes switching back quick.
  for (const [id, other] of voices) {
   if (id === voiceId) continue;
   voices.delete(id);
   queue = queue.then(() => other).then(v => v.session.release()).catch(() => {});
  }
  return { id: voiceId, ort, session, config };
 })();
 voices.set(voiceId, promise);
 promise.catch(() => { if (voices.get(voiceId) === promise) voices.delete(voiceId); }); // let a failed load be retried
 return promise;
}

async function speak({ ort, session, config }, text) {
 const sampleRate = config.audio?.sample_rate || 22050;
 const sentences = await phonemize(text, config.espeak?.voice || 'en-us', config);
 const { noise_scale = 0.667, length_scale = 1, noise_w = 0.8 } = config.inference || {};
 const parts = [];
 for (const ids of sentences) {
  const feeds = {
   input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
   input_lengths: new ort.Tensor('int64', BigInt64Array.of(BigInt(ids.length)), [1]),
   scales: new ort.Tensor('float32', Float32Array.of(noise_scale, length_scale, noise_w), [3]),
  };
  if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.of(0n), [1]);
  const { output } = await session.run(feeds);
  parts.push(output.data);
 }
 const gap = Math.round(SENTENCE_GAP * sampleRate);
 const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1));
 let at = 0, peak = 0;
 for (const p of parts) { samples.set(p, at); at += p.length + gap; }
 for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
 // Voices come out at different levels (peaks from 0.3 to 0.75); Piper scales each to full volume, and so do
 // we, a little short of it.
 const gain = 0.9 / Math.max(peak, 0.01);
 for (let i = 0; i < samples.length; i++) samples[i] *= gain;
 return { samples, sampleRate };
}

// Speaks text with a voice, loading it first if need be. Returns { samples: Float32Array (mono, -1..1),
// sampleRate }. Sentences are spoken one after another with a short pause, all in one buffer.
export async function synthesize(text, voiceId = ENGINE.defaultVoice) {
 const voice = await load(voiceId);
 const words = String(text ?? '').trim();
 if (!words) return { samples: new Float32Array(0), sampleRate: voice.config.audio?.sample_rate || 22050 };
 // Asked again in turn, in case another voice loaded meanwhile and this one was released.
 const run = queue.then(async () => speak(await load(voiceId), words));
 queue = run.catch(() => {});
 return run;
}
