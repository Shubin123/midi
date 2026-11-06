// The teacher's two layers. System 1 is always Laya (js/laya.js), on this device: fast, it coaches each phrase,
// keeps time, teaches the widgets and changes settings. System 2 thinks and explains, and is the student's
// choice from the list below: Qwen on this device, or a hosted model. Each hosted one is a separate, direct
// connection: requests go straight from the page to that provider with that provider's own credentials, and
// one System 2 is active at a time, alongside Laya. Every
// hosted provider here answers cross-origin requests (CORS), so no server of ours sits in between. Keys and
// the chosen model are kept in cookies (js/ai-auth.js). The on-device option runs js/local-model.js instead.
import { getCookie, setCookie, deleteCookie } from './ai-auth.js';

// auth decides the sign-in and the group the panel lists it under: 'local' (no sign-in), 'openrouter' (OAuth
// sign-in or a pasted key), 'key' (the provider's own API key) or 'custom' (your endpoint). `how`, `where` and
// `cost` are the plain-language summary shown in the list. `defaultModel` and `prefer` pick a model once the
// provider's live model list is known; `models` are fallbacks until then.
export const PROVIDERS = [
 // On this device: Qwen thinks in the browser, with Laya beside it (loaded with it if it isn't yet).
 { id: 'local', name: 'Qwen, on this device', auth: 'local', how: 'No sign-in · WebGPU', where: 'Qwen 3.5 thinks in this browser; nothing you play leaves it', cost: 'Free' },
 {
  id: 'openrouter', name: 'OpenRouter', auth: 'openrouter', how: 'Sign in, or an OpenRouter key', where: 'openrouter.ai, which forwards to many model makers', cost: 'Free models; others paid',
  base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', keyHint: 'sk-or-…', defaultModel: 'google/gemma-4-31b-it:free',
 },
 {
  id: 'groq', name: 'Groq', auth: 'key', how: 'Your Groq API key', where: 'api.groq.com', cost: 'Free tier',
  base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', keyHint: 'gsk_…',
  defaultModel: 'llama-3.3-70b-versatile', prefer: [/^llama-3\.3-70b/, /^llama-4/, /gpt-oss-120b/, /^llama/], models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
 },
 {
  id: 'cerebras', name: 'Cerebras', auth: 'key', how: 'Your Cerebras API key', where: 'api.cerebras.ai', cost: 'Free tier',
  base: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', keyHint: 'csk-…',
  defaultModel: 'llama-3.3-70b', prefer: [/^llama-3\.3-70b/, /^llama-4/, /gpt-oss/, /^qwen/, /^llama/], models: ['llama-3.3-70b', 'llama3.1-8b'],
 },
 {
  id: 'gemini', name: 'Google Gemini', auth: 'key', how: 'Your Google AI Studio key', where: 'generativelanguage.googleapis.com', cost: 'Free tier',
  base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…',
  defaultModel: 'gemini-2.5-flash', prefer: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash/, /^gemini/], models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
 },
 {
  id: 'mistral', name: 'Mistral', auth: 'key', how: 'Your Mistral API key', where: 'api.mistral.ai', cost: 'Free tier',
  base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', keyHint: 'API key',
  defaultModel: 'mistral-small-latest', prefer: [/^mistral-small-latest$/, /^mistral-medium-latest$/, /small/], models: ['mistral-small-latest', 'mistral-medium-latest'],
 },
 {
  id: 'openai', name: 'OpenAI', auth: 'key', how: 'Your OpenAI API key', where: 'api.openai.com', cost: 'Paid',
  base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…',
  defaultModel: 'gpt-4o-mini', prefer: [/^gpt-[\d.]+-mini$/, /^gpt-[\d.o]+-mini$/, /^gpt-/], models: ['gpt-4o-mini', 'gpt-4.1-mini'],
 },
 { id: 'custom', name: 'Custom endpoint', auth: 'custom', how: 'Your base URL and key', where: 'Any OpenAI-compatible API', cost: 'Depends on the service', keyHint: 'API key', defaultModel: '' },
];

// System 1: always Laya. Shown above the System 2 list, never one of its choices.
export const SYSTEM_ONE = { id: 'laya', name: 'Laya', how: 'No sign-in · 291 MB', where: 'A fast decision model in this browser: coaches each phrase, keeps time, teaches the widgets and plug-ins and changes settings', cost: 'Free' };
// Choosing no System 2: Laya alone, with nothing sent anywhere.
export const NO_SYSTEM_TWO = 'none';

// The System 2 list's sections, in order, keyed by `auth`.
export const GROUPS = [
 { auth: 'local', title: 'On this device, no sign-in' },
 { auth: 'openrouter', title: 'Sign in' },
 { auth: 'key', title: 'Your own API key' },
 { auth: 'custom', title: 'Advanced' },
];

export const providerById = id => PROVIDERS.find(p => p.id === id);

// Per-provider settings in cookies, so a reload comes back connected and on the same model.
export const getProviderId = () => getCookie('teacher-provider') || 'local';
export const setProviderId = id => setCookie('teacher-provider', id);
export const getKey = id => getCookie(`teacher-key-${id}`);
export const setKey = (id, v) => setCookie(`teacher-key-${id}`, v);
export const clearKey = id => deleteCookie(`teacher-key-${id}`);
export const getModelFor = id => getCookie(`teacher-model-${id}`);
export const setModelFor = (id, v) => setCookie(`teacher-model-${id}`, v);
export const getBase = id => getCookie(`teacher-base-${id}`);
export const setBase = (id, v) => setCookie(`teacher-base-${id}`, v);

function httpError(status, data) {
 const detail = data?.error?.message || data?.message;
 if (status === 401 || status === 403) return 'The key was rejected. Check it and try again.';
 if (status === 402) return 'That model needs credit on this provider. Pick a free one, or add credit.';
 if (status === 429) return 'Rate limited. Free tiers have a cap; wait a bit or switch provider.';
 if (status === 404) return `Model not found${detail ? ': ' + detail : ''}. Pick another model.`;
 return `Request failed (${status})${detail ? ': ' + detail : ''}.`;
}
const apiError = (status, data) => Object.assign(new Error(httpError(status, data)), { status });

// An engine for any OpenAI-compatible chat endpoint: POST {base}/chat/completions with a Bearer key. With
// `tools` ({ definitions, run(name, args) → text }) the model may call them, in up to four rounds, each call's
// answer sent back before it replies; the teacher's tools read and change the workspace (js/teacher-bridge.js).
// A model or provider that won't take tools is asked again without them, and from then on the teacher's JSON
// line is how it changes things (js/ai-teacher.js).
export const TOOL_ROUNDS = 6; // a lesson set up as an agent takes a few rounds of actions
const refusesTools = err => [400, 404, 405, 422].includes(err.status) && /tool|function/i.test(err.message);
export function openAiEngine({ base, apiKey, model, headers = {} }) {
 const url = base.replace(/\/$/, '') + '/chat/completions';
 let controller = null, noTools = false;
 const post = async body => {
  const res = await fetch(url, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...headers },
   body: JSON.stringify(body),
   signal: controller.signal,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw apiError(res.status, data);
  if (data.error) throw new Error(data.error.message || 'The provider returned an error.');
  return data;
 };
 return {
  get toolsRefused() { return noTools; },
  async generate(messages, { tools = null } = {}) {
   controller = new AbortController();
   const convo = [...messages];
   for (let round = 0; ; round++) {
    const offer = tools && !noTools && round < TOOL_ROUNDS;
    let data;
    try { data = await post({ model, messages: convo, max_tokens: 1024, ...(offer ? { tools: tools.definitions, tool_choice: 'auto' } : {}) }); }
    catch (err) { if (offer && refusesTools(err)) { noTools = true; round--; continue; } throw err; }
    const choice = data.choices?.[0], msg = choice?.message;
    if (choice?.finish_reason === 'content_filter' || msg?.refusal) {
     throw new Error('The model declined to answer that one. Try rephrasing it.');
    }
    if (offer && msg?.tool_calls?.length) {
     convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
     for (const call of msg.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function?.arguments || '{}'); } catch { /* answered as a mistake below */ }
      const result = await Promise.resolve(tools.run(call.function?.name, args)).catch(err => `Error: ${err.message}`);
      convo.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
     }
     continue;
    }
    return msg?.content || '';
   }
  },
  interrupt() { controller?.abort(); },
 };
}

const baseFor = provider => (provider.auth === 'custom' ? getBase(provider.id) : provider.base);

// Builds the engine for a hosted provider from its stored settings, or says what is missing.
export function engineFor(provider) {
 const base = baseFor(provider), apiKey = getKey(provider.id);
 const model = getModelFor(provider.id) || provider.defaultModel;
 if (!base) return { error: 'Enter the API base URL.' };
 if (!apiKey) return { error: provider.auth === 'openrouter' ? 'Sign in or paste a key first.' : 'Enter an API key first.' };
 if (!model) return { error: 'Enter a model name.' };
 const headers = provider.id === 'openrouter' ? { 'X-Title': 'Ultimate Synthesia Online' } : {};
 return { engine: openAiEngine({ base, apiKey, model, headers }) };
}

// Model ids a provider lists that can't chat (speech, embeddings, image, safety classifiers and the like).
const NOT_CHAT = /(whisper|tts|transcri|embed|guard|moderation|dall-e|image|imagen|audio|realtime|speech|search|rerank|ocr|aqa|veo|learnlm|computer-use)/i;

// Checks a key and returns the provider's chat models, in one free request (no model is run). A rejected key
// throws with status 401; Gemini reports a bad key as 400, so that counts as rejected here too.
export async function listModels(provider, apiKey) {
 const root = baseFor(provider).replace(/\/$/, '');
 if (provider.id === 'openrouter') {
  const check = await fetch(`${root}/key`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!check.ok) throw apiError(check.status === 400 ? 401 : check.status, await check.json().catch(() => null));
  const { free, premium } = await fetchOpenRouterModels();
  return [...free, ...premium].map(m => m.id);
 }
 const res = await fetch(`${root}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
 const data = await res.json().catch(() => null);
 if (!res.ok || !data) throw apiError(res.status === 400 ? 401 : res.status, data);
 let ids = (data.data || []).map(m => String(m.id || '').replace(/^models\//, '')).filter(id => id && !NOT_CHAT.test(id));
 if (provider.id === 'openai') ids = ids.filter(id => /^(gpt|o\d|chatgpt)/.test(id) && !/instruct/.test(id));
 if (provider.id === 'gemini') ids = ids.filter(id => /^(gemini|gemma)/.test(id));
 return [...new Set(ids)].sort();
}

// Chooses a model from a live list: the saved one, else the default, else the newest match of the provider's
// preferences, else the first.
export function pickModel(provider, ids, saved) {
 if (saved && ids.includes(saved)) return saved;
 if (provider.defaultModel && ids.includes(provider.defaultModel)) return provider.defaultModel;
 for (const re of provider.prefer || []) {
  const hits = ids.filter(id => re.test(id)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  if (hits.length) return hits[0];
 }
 return ids[0] || saved || provider.defaultModel || '';
}

// OpenRouter lists its models publicly: the free ones (largest context first) and a premium shortlist.
export async function fetchOpenRouterModels() {
 const data = await (await fetch('https://openrouter.ai/api/v1/models')).json();
 const models = (data.data || []).filter(m => m.id);
 const free = models.filter(m => parseFloat(m.pricing?.prompt) === 0).sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
 const premium = models.filter(m => /^(openai|anthropic|google)\//.test(m.id) && parseFloat(m.pricing?.prompt) > 0)
  .filter(m => /(gpt|o[0-9]|claude|gemini)/.test(m.id)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 40);
 const label = m => (m.name || m.id).replace(/\s*\(free\)\s*$/i, '');
 return { free: free.map(m => ({ id: m.id, label: label(m) })), premium: premium.map(m => ({ id: m.id, label: label(m) })) };
}
