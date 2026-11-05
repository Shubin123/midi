// The on-device provider: a language model that runs entirely on the viewer's own GPU through WebLLM
// (WebGPU). No account, key, cookie or server: the weights download once from the model CDN, then every
// reply is generated locally. The WebLLM library is imported on demand (first load only), so nothing is
// fetched until someone actually loads a model here.
const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm';

// A short, curated list of small instruct models from WebLLM's prebuilt set, smallest first. Sizes are the
// quantised download, cached by the browser after the first run.
export const MODELS = [
 { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC', label: 'Llama 3.2 1B — fastest (~0.9 GB)' },
 { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 1.5B — balanced (~1.1 GB)' },
 { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B — best, slower (~2.3 GB)' },
];
export const DEFAULT_MODEL = MODELS[1].id;

export const webgpuAvailable = () => typeof navigator !== 'undefined' && !!navigator.gpu;

let webllmModule = null;
const loadLibrary = async () => (webllmModule ||= await import(/* @vite-ignore */ WEBLLM_URL));

// Wraps a loaded WebLLM engine behind the small interface the teacher calls: generate(messages) and
// interrupt(). Load one with `await LocalEngine.load(modelId, onProgress)`.
export class LocalEngine {
 constructor(engine, modelId) { this.engine = engine; this.modelId = modelId; }

 static async load(modelId, onProgress) {
  if (!webgpuAvailable()) {
   throw new Error('This browser has no WebGPU, so a local model can\'t run here. Try Chrome or Edge (desktop), or a browser with WebGPU enabled.');
  }
  const webllm = await loadLibrary();
  const engine = await webllm.CreateMLCEngine(modelId, { initProgressCallback: p => onProgress?.(p) });
  return new LocalEngine(engine, modelId);
 }

 async generate(messages) {
  const res = await this.engine.chat.completions.create({ messages, max_tokens: 512, temperature: 0.7 });
  return res.choices?.[0]?.message?.content || '';
 }

 // Stops the current generation, if one is running. Safe to call at any time.
 interrupt() { try { this.engine.interruptGenerate(); } catch { /* nothing generating */ } }
}
