// The on-device "System 2": Qwen 3.5 running on the viewer's own GPU through WebLLM (WebGPU). No account,
// key, cookie or server: the weights download once from the model CDN, then every reply is generated
// locally. Qwen can think before it answers; the teacher switches that on per request, so Fast mode answers
// straight away and Slow mode reasons first, within a budget. The WebLLM library is imported on demand.
import { stripThinking } from './ai-teacher.js';

const WEBLLM_URL = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm';
// Reasoning tokens Slow mode allows before asking for the answer. Left alone, the 2B and 4B builds often
// thought for over 3,000 tokens (two to four minutes on an M4) without reaching an answer.
export const THINK_BUDGET = 400;

// Qwen 3.5 builds from WebLLM's prebuilt set, with the GPU memory each needs. Tested on the teacher's own
// requests: 4B named what was played correctly every time and got most examples right; 2B is lighter but
// makes theory mistakes; 0.8B was left out because it got nothing right.
export const MODELS = [
 { id: 'Qwen3.5-4B-q4f16_1-MLC', label: 'Qwen 3.5 4B — recommended (3.9 GB GPU memory)' },
 { id: 'Qwen3.5-2B-q4f16_1-MLC', label: 'Qwen 3.5 2B — lighter, less accurate (2.2 GB GPU memory)' },
];
export const DEFAULT_MODEL = MODELS[0].id;

export const webgpuAvailable = () => typeof navigator !== 'undefined' && !!navigator.gpu;

let webllmModule = null;
const loadLibrary = async () => (webllmModule ||= await import(/* @vite-ignore */ WEBLLM_URL));

// Wraps a loaded WebLLM engine behind the small interface the teacher calls: generate(messages, { think })
// and interrupt(). Load one with `await LocalEngine.load(modelId, onProgress)`.
export class LocalEngine {
 constructor(engine, modelId) { this.engine = engine; this.modelId = modelId; }

 static async load(modelId, onProgress) {
  if (!webgpuAvailable()) {
   throw new Error('This browser has no WebGPU, so Qwen can\'t run here. Try Chrome or Edge on a desktop, or a browser with WebGPU enabled.');
  }
  const webllm = await loadLibrary();
  const engine = await webllm.CreateMLCEngine(modelId, { initProgressCallback: p => onProgress?.(p) });
  return new LocalEngine(engine, modelId);
 }

 // Fast: answer straight away. Slow: think first, streaming the reasoning; if it is still thinking after
 // THINK_BUDGET tokens, stop and ask for the answer without thinking, handing over the notes made so far.
 async generate(messages, { think = false } = {}) {
  if (!think) return this._complete(messages);
  const stream = await this.engine.chat.completions.create({ messages, stream: true, max_tokens: THINK_BUDGET + 500, temperature: 0.6, top_p: 0.95, extra_body: { enable_thinking: true } });
  let text = '', tokens = 0;
  for await (const chunk of stream) {
   text += chunk.choices?.[0]?.delta?.content || '';
   if (++tokens > THINK_BUDGET && text.includes('<think>') && !text.includes('</think>')) { this.engine.interruptGenerate(); break; }
  }
  if (text.includes('</think>') && stripThinking(text)) return text; // it finished thinking and answered
  const notes = (text.split('<think>')[1] || '').split('</think>')[0].trim().slice(-1800);
  const last = messages[messages.length - 1];
  return this._complete([...messages.slice(0, -1), { ...last, content: `${last.content}\n\n(Your unfinished notes from thinking this over: ${notes})\nNow give your reply.` }]);
 }

 // Qwen's recommended sampling without thinking.
 async _complete(messages) {
  const res = await this.engine.chat.completions.create({ messages, max_tokens: 600, temperature: 0.7, top_p: 0.8, extra_body: { enable_thinking: false } });
  return res.choices?.[0]?.message?.content || '';
 }

 // Stops the current generation, if one is running. Safe to call at any time.
 interrupt() { try { this.engine.interruptGenerate(); } catch { /* nothing generating */ } }
 unload() { return this.engine.unload?.(); }
}
