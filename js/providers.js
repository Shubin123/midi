// The backends the teacher can talk to, and the one request shape most of them share. Everything here is
// chosen to work straight from a static page in the browser: each hosted provider below answers cross-origin
// requests (CORS), so no server of ours sits in between. Keys and the chosen model are kept in cookies
// (js/ai-auth.js). The on-device option (js/local-model.js) needs no provider from this file at all.
import { getCookie, setCookie, deleteCookie } from './ai-auth.js';

// auth: 'local' runs on the device; 'openrouter' has the key-free OAuth sign-in (or a pasted key); 'key'
// wants an API key; 'custom' wants a base URL and key. `models` are suggestions — the field stays editable,
// since model names change. `free` flags providers whose own free tier needs no payment.
export const PROVIDERS = [
 { id: 'local', label: 'On your device — no key, private', auth: 'local', free: true },
 {
  id: 'openrouter', label: 'OpenRouter — sign in, free models', auth: 'openrouter', free: true,
  base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys', keyHint: 'sk-or-…',
  defaultModel: 'google/gemma-4-31b-it:free',
 },
 {
  id: 'groq', label: 'Groq — free, very fast', auth: 'key', free: true,
  base: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys', keyHint: 'gsk_…',
  defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
 },
 {
  id: 'gemini', label: 'Google Gemini — free tier', auth: 'key', free: true,
  base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey', keyHint: 'AIza…',
  defaultModel: 'gemini-2.0-flash', models: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-1.5-flash'],
 },
 {
  id: 'cerebras', label: 'Cerebras — free, very fast', auth: 'key', free: true,
  base: 'https://api.cerebras.ai/v1', keyUrl: 'https://cloud.cerebras.ai', keyHint: 'csk-…',
  defaultModel: 'llama-3.3-70b', models: ['llama-3.3-70b', 'llama3.1-8b'],
 },
 {
  id: 'mistral', label: 'Mistral — free tier', auth: 'key', free: true,
  base: 'https://api.mistral.ai/v1', keyUrl: 'https://console.mistral.ai/api-keys', keyHint: '…',
  defaultModel: 'mistral-small-latest', models: ['mistral-small-latest', 'open-mistral-nemo'],
 },
 {
  id: 'openai', label: 'OpenAI', auth: 'key', free: false,
  base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…',
  defaultModel: 'gpt-4o-mini', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
 },
 {
  id: 'custom', label: 'Custom (OpenAI-compatible)', auth: 'custom', free: false,
  keyHint: 'API key', defaultModel: '',
 },
];

export const providerById = id => PROVIDERS.find(p => p.id === id);

// Per-provider settings in cookies, so a reload comes back signed in and on the same model.
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
 if (status === 401 || status === 403) return 'The key was rejected. Check it in Settings.';
 if (status === 402) return 'That model needs credit on this provider. Pick a free one, or add credit.';
 if (status === 429) return 'Rate limited. Free tiers have a cap; wait a bit or switch provider.';
 if (status === 404) return `Model not found${detail ? ': ' + detail : ''}. Check the model name in Settings.`;
 return `Request failed (${status})${detail ? ': ' + detail : ''}.`;
}

// An engine for any OpenAI-compatible chat endpoint: POST {base}/chat/completions with a Bearer key.
export function openAiEngine({ base, apiKey, model, headers = {} }) {
 const url = base.replace(/\/$/, '') + '/chat/completions';
 let controller = null;
 return {
  async generate(messages) {
   controller = new AbortController();
   const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...headers },
    body: JSON.stringify({ model, messages, max_tokens: 1024 }),
    signal: controller.signal,
   });
   const data = await res.json().catch(() => null);
   if (!res.ok || !data) throw new Error(httpError(res.status, data));
   if (data.error) throw new Error(data.error.message || 'The provider returned an error.');
   const choice = data.choices?.[0];
   if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
    throw new Error('The model declined to answer that one. Try rephrasing it.');
   }
   return choice?.message?.content || '';
  },
  interrupt() { controller?.abort(); },
 };
}

// Builds the hosted engine for a provider from its stored settings, or returns an error string explaining
// what is missing. (The 'local' provider is handled by the panel through js/local-model.js, not here.)
export function engineFor(provider) {
 const apiKey = getKey(provider.id);
 const model = getModelFor(provider.id) || provider.defaultModel;
 if (provider.auth === 'custom') {
  const base = getBase(provider.id);
  if (!base) return { error: 'Enter the API base URL in Settings.' };
  if (!model) return { error: 'Enter a model name in Settings.' };
  if (!apiKey) return { error: 'Enter the API key in Settings.' };
  return { engine: openAiEngine({ base, apiKey, model }) };
 }
 if (!apiKey) return { error: 'Add a key in Settings (or sign in).' };
 return { engine: openAiEngine({ base: provider.base, apiKey, model, headers: openRouterHeaders(provider) }) };
}

const openRouterHeaders = provider => (provider.id === 'openrouter' ? { 'X-Title': 'Ultimate Synthesia Online' } : {});

// OpenRouter lists its models publicly; used to fill its model dropdown (free tier plus a premium shortlist).
export async function fetchOpenRouterModels() {
 const data = await (await fetch('https://openrouter.ai/api/v1/models')).json();
 const models = (data.data || []).filter(m => m.id);
 const free = models.filter(m => parseFloat(m.pricing?.prompt) === 0).sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
 const premium = models.filter(m => /^(openai|anthropic|google)\//.test(m.id) && parseFloat(m.pricing?.prompt) > 0)
  .filter(m => /(gpt|o[0-9]|claude|gemini)/.test(m.id)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 40);
 const label = m => (m.name || m.id).replace(/\s*\(free\)\s*$/i, '');
 return { free: free.map(m => ({ id: m.id, label: label(m) })), premium: premium.map(m => ({ id: m.id, label: label(m) })) };
}
