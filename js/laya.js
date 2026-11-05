// Laya, the teacher's fast "System 1": an English decision model (ModernBERT-large with typed heads) by ConvAI
// Innovations, run in the browser through ONNX Runtime Web as in layaForWeb (both Apache-2.0). It writes no
// text; it answers multiple-choice, rubric and yes/no questions about a situation in a fraction of a second.
// Here it chooses the next coaching step from the menu in js/coach.js and judges whether a slower System 2
// explanation would help. Everything loads from CDNs on demand (ONNX Runtime and the tokenizer from jsDelivr,
// the weights from Hugging Face) and the weights are kept in Cache Storage, so a second visit is quick.
import { layaState, layaQuestions, availableMoves, fallbackMove } from './coach.js';

const ORT_URL = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';
const ORT_DIST = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const TOKENIZERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/tokenizers@0.2.0/+esm';
const CORE_URL = 'https://cdn.jsdelivr.net/gh/vishalmysore/layaForWeb@6e67de8d8ccaf9474c9150c3f3877878d915020b/web/laya-core.js';
const MODEL_BASE = 'https://huggingface.co/VishalMysore/layaForWeb/resolve/cd232d276e3f22ca9788a9c8c1d223762808d8ed/';
const VARIANT = 'q4e8'; // int4 weights, 291 MB: the build that also runs on WebGPU
export const LAYA_MB = 291;

async function fetchBytes(url, onBytes) {
 const res = await fetch(url);
 if (!res.ok) throw new Error(`Laya download failed (${res.status}).`);
 const reader = res.body.getReader(), chunks = [];
 let got = 0;
 for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  chunks.push(value); got += value.length; onBytes?.(got);
 }
 const out = new Uint8Array(got);
 let at = 0;
 for (const c of chunks) { out.set(c, at); at += c.length; }
 return out;
}

// The weights are stored on Hugging Face as 24 MB parts; stitch them together, caching each part.
async function fetchWeights(entry, onProgress) {
 let cache = null;
 try { cache = await caches.open(`laya-${entry.sha256.slice(0, 16)}`); } catch { /* no Cache Storage: just download */ }
 const out = new Uint8Array(entry.size);
 let at = 0;
 for (const part of entry.parts) {
  const url = MODEL_BASE + part;
  let bytes = null;
  try { const hit = await cache?.match(url); if (hit) bytes = new Uint8Array(await hit.arrayBuffer()); } catch { /* treat as a miss */ }
  if (!bytes) {
   bytes = await fetchBytes(url, got => onProgress(at + got, entry.size));
   try { await cache?.put(url, new Response(bytes)); } catch { /* over quota: fine, it just won't be cached */ }
  }
  if (at + bytes.length > entry.size) throw new Error('Laya weights are larger than expected.');
  out.set(bytes, at); at += bytes.length; onProgress(at, entry.size);
 }
 if (at !== entry.size) throw new Error('Laya weights are incomplete.');
 return out;
}

export class LayaCoach {
 constructor(laya, backend) { this.laya = laya; this.backend = backend; }

 // onProgress({ text, progress }) mirrors WebLLM's callback so the panel can show both the same way.
 static async load(onProgress = () => {}) {
  onProgress({ text: 'Laya: loading the runtime…' });
  const [ort, { Tokenizer }, { Laya }] = await Promise.all([import(ORT_URL), import(TOKENIZERS_URL), import(CORE_URL)]);
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.logLevel = 'error'; // its node-placement notes are expected, not problems
  ort.env.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
  const json = f => fetch(MODEL_BASE + f).then(r => { if (!r.ok) throw new Error(`Laya ${f}: ${r.status}`); return r.json(); });
  const [manifest, tokenizerJson, tokenizerConfig, config] = await Promise.all(['manifest.json', 'tokenizer.json', 'tokenizer_config.json', 'rl_agent_config.json'].map(json));
  const v = manifest.variants[VARIANT];
  const graph = await fetchBytes(MODEL_BASE + v.onnx);
  const data = await fetchWeights(v.data, (got, total) => onProgress({ text: `Laya: ${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB`, progress: got / total }));
  const gpu = !!navigator.gpu && !!(await navigator.gpu.requestAdapter().catch(() => null));
  onProgress({ text: `Laya: starting on ${gpu ? 'the GPU' : 'the CPU'}…` });
  const session = await ort.InferenceSession.create(graph, {
   executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'],
   graphOptimizationLevel: 'all',
   externalData: [{ path: v.data.name, data }],
  });
  const laya = new Laya(ort, session, new Tokenizer(tokenizerJson, tokenizerConfig), config);
  await laya.systemOne('warm up', { w: { type: 'noul', instructions: 'This is a warm-up call' } });
  return new LayaCoach(laya, gpu ? 'webgpu' : 'wasm');
 }

 // Decides the next coaching step for a phrase. Returns { move, explain, level, confidence, ms, laya } where
 // move is a key of MOVES, explain is P(a deeper explanation would help), and level is 0-2.
 async decide(analysis, history = []) {
  const options = availableMoves(history, analysis);
  const res = await this.laya.systemOne(layaState(analysis, history), layaQuestions(options));
  const { move, explain, level } = res.answers;
  return { move: options.includes(move.choice) ? move.choice : fallbackMove(history, analysis), confidence: move.confidence, explain: explain.noul, level: level.score, ms: Math.round(res.latency_ms), laya: res };
 }
}
