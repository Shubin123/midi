import assert from 'node:assert/strict';
import { detectScale, detectChord, PhraseTracker } from '../js/pitch-analyzer.js';

// --- Browser globals the modules touch, stubbed just enough to run under node. ---
const jar = new Map(); // a cookie jar so several cookies coexist, as in a browser
globalThis.document = {
 get cookie() { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); },
 set cookie(str) {
  const [pair, ...attrs] = str.split(';');
  const eq = pair.indexOf('='), name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1);
  const maxAge = attrs.map(a => a.trim()).find(a => /^max-age=/i.test(a));
  if (maxAge && Number(maxAge.split('=')[1]) <= 0) jar.delete(name); else jar.set(name, value);
 },
};
const ls = new Map();
globalThis.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };
globalThis.history = { replaceState() {} };
globalThis.location = { search: '', origin: 'https://app.test', pathname: '/midi/', protocol: 'https:', assign() {} };

const { AiTeacher, parsePlayCommand, stripThinking, SYSTEM_PROMPT } = await import('../js/ai-teacher.js');
const { createPkcePair, completeSignIn } = await import('../js/ai-auth.js');
const P = await import('../js/providers.js');

// A routing fetch stub; each test sets `respond` for chat calls and `exchange` for the OAuth key exchange.
const requests = [];
let respond, exchange;
globalThis.fetch = (url, init = {}) => {
 requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
 const { ok, status, body, wait } = (url.endsWith('/auth/keys') ? exchange : respond)(url);
 return new Promise((resolve, reject) => {
  const done = () => resolve({ ok, status, statusText: '', json: async () => body });
  init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  wait ? wait.then(done) : done();
 });
};

/* ---- Local analysis ---- */
const C_MAJOR = [0, 2, 4, 5, 7, 9, 11];
const name = s => `${s.tonicName} ${s.scaleName}`;
assert.equal(name(detectScale(C_MAJOR)[0]), 'C Ionian (Major)');
assert.equal(name(detectScale(C_MAJOR, [2])[0]), 'D Dorian');
assert.equal(name(detectScale(C_MAJOR, [9, 0])[0]), 'A Aeolian (Minor)');
assert.equal(name(detectScale([0, 2, 3, 5, 7, 8, 11])[0]), 'C Harmonic Minor');
assert.equal(detectChord([0, 4, 7])[0].chordName, 'Cmaj');
assert.equal(detectChord([0, 4, 7, 11])[0].chordName, 'Cmaj7');
assert.equal(detectChord([4, 7, 11])[0].chordName, 'Emin');
assert.equal(detectChord([9, 0, 4, 7])[0].chordName, 'Amin7');
assert.equal(detectChord([0, 3, 6, 9], 9)[0].chordName, 'Adim7');
assert.deepEqual(detectChord([0, 4]), []);
{
 const phrases = [];
 const t = new PhraseTracker(p => phrases.push(p), { gapMs: 10 });
 [[60, 0], [64, 100], [67, 200]].forEach(([n, at]) => { t.noteOn(n, 90, at); t.noteOff(n, at + 80); });
 t.noteOff(99, 290); // never held: ignored
 [65, 69, 72].forEach((n, i) => t.noteOn(n, 90, 300 + i * 10));
 t.noteOff(65, 500); t.noteOff(69, 500);
 await new Promise(r => setTimeout(r, 30));
 assert.equal(phrases.length, 0, 'a held note keeps the phrase open');
 t.noteOff(72, 510);
 await new Promise(r => setTimeout(r, 30));
 assert.equal(phrases.length, 1);
 assert.deepEqual(phrases[0].chords.map(c => c.best.chordName), ['Fmaj']);
 // C-E-G then an F chord ends on F in the bass: heard as V-I, so the phrase reads as F, not C.
 assert.equal(phrases[0].scales[0].tonicName, 'F');
}

/* ---- Suggestions: single notes, chords, and mixes ---- */
// Models name what to play and the notes are worked out here. Chords play one per beat (60 BPM by default).
const ex = r => r.play && { steps: r.play.steps, bpm: r.play.bpm, label: r.play.label };
assert.deepEqual(parsePlayCommand('The ii-V-I.\n{"chords": ["Dm7", "G7", "Cmaj7"]}'), { text: 'The ii-V-I.', play: { steps: [[50, 53, 57, 60], [55, 59, 62, 65], [48, 52, 55, 59]], bpm: 60, label: 'Dm7 → G7 → Cmaj7' } });
// A scale plays up and back down from its tonic.
assert.deepEqual(ex(parsePlayCommand('Try it.\n{"scale": "A minor pentatonic"}')), { steps: [57, 60, 62, 64, 67, 69, 67, 64, 62, 60, 57].map(n => [n]), bpm: 120, label: 'A minor pentatonic' });
// Note names use scientific pitch (C4 is middle C).
assert.deepEqual(ex(parsePlayCommand('{"notes": ["C4", "E4", "G4", "Bb4"], "bpm": 90}')), { steps: [[60], [64], [67], [70]], bpm: 90, label: '4 notes' });
// Unknown names are skipped; nothing playable means no example.
assert.deepEqual(ex(parsePlayCommand('{"chords": ["Dm7", "Zzz", "G7"]}')).label, 'Dm7 → G7');
assert.equal(parsePlayCommand('{"chords": ["Zzz"], "scale": "Q dorian"}').play, null);
// Key order, code fences and a stray earlier brace don't matter: the last JSON that names something wins.
assert.deepEqual(ex(parsePlayCommand('Sets look like {a, b}.\n```json\n{"bpm": 70, "chords": ["C", "Am"]}\n```')), { steps: [[48, 52, 55], [57, 60, 64]], bpm: 70, label: 'C → Am' });
assert.equal(parsePlayCommand('Sets look like {a, b}.\n```json\n{"bpm": 70, "chords": ["C", "Am"]}\n```').text, 'Sets look like {a, b}.');
// The older form with MIDI numbers still works: single notes and nested chord arrays.
assert.deepEqual(ex(parsePlayCommand('I to IV.\n{"play": [[60,64,67], [65,69,72]], "bpm": 80}')), { steps: [[60, 64, 67], [65, 69, 72]], bpm: 80, label: '6 notes' });
assert.deepEqual(parsePlayCommand('Here:\n```json\n{"play":[[60,200,61.5,64], 999, 62],"bpm":1000}\n```').play.steps, [[60, 64], [62]]);
assert.equal(parsePlayCommand('Here:\n{"play":[1],"bpm":1000}').play.bpm, 300);
// No example, and echoed [PLAYED] or Coach: lines are dropped from the text.
assert.deepEqual(parsePlayCommand('No notes this time. '), { text: 'No notes this time.', play: null });
assert.equal(parsePlayCommand('[PLAYED] 3 notes | midi: [60]\nCoach: try this\nNice C major.').text, 'Nice C major.');
// At most 40 notes are kept across all steps.
assert.equal(parsePlayCommand(`{"chords": [${Array(20).fill('"C"').join(',')}]}`).play.steps.flat().length, 39);
// Reasoning models think inline; only the answer after </think> counts, and an unfinished thought has none.
assert.equal(stripThinking('<think>\nC major has no sharps...\n</think>\n\nThat is C major.'), 'That is C major.');
assert.equal(stripThinking('<think>still going and ran out of room'), '');
assert.deepEqual(ex(parsePlayCommand('<think>{"chords": ["Dm"]} maybe?</think>Use this.\n{"chords": ["G7"]}')), { steps: [[55, 59, 62, 65]], bpm: 60, label: 'G7' });

/* ---- The teacher with an injected engine ---- */
class FakeEngine {
 constructor() { this.calls = []; this.opts = []; this.reply = () => 'C major.\n{"chords": ["C"], "bpm": 100}'; this.interrupted = 0; }
 async generate(messages, opts) { this.calls.push(messages); this.opts.push(opts); return this.reply(messages); }
 interrupt() { this.interrupted++; }
}
{
 const t = new AiTeacher();
 const errors = []; t.onError = m => errors.push(m);
 assert.equal(t.isConfigured, false);
 assert.equal(await t.ask('hi'), null);
 assert.deepEqual(errors, ['Set up a model in Settings first.']);
}
{
 const engine = new FakeEngine(), t = new AiTeacher();
 t.setEngine(engine);
 const replies = [], errors = [];
 const statuses = [];
 t.onResponse = (text, play, info) => replies.push({ text, play, think: info.think });
 t.onError = m => errors.push(m); t.onStatus = s => statuses.push(s);
 await t.analyzePhrase({ noteCount: 3, durationMs: 412.4, noteOns: [{ note: 60 }, { note: 64 }, { note: 67 }], pitchClasses: [0, 4, 7], scales: [{ tonicName: 'C', scaleName: 'Major Pentatonic', score: 0.6 }], chords: [] }, { coach: 'build the home chord', think: true });
 assert.equal(engine.calls[0][0].role, 'system');
 assert.match(engine.calls[0][0].content, /Use names, never numbers/);
 assert.equal(engine.calls[0][1].content, '[PLAYED] 3 notes, 412ms | midi: [60, 64, 67] | pcs: [0, 4, 7] | best: C Major Pentatonic (0.60)\nCoach: build the home chord');
 assert.deepEqual(engine.opts[0], { think: true }, 'only the thinking switch reaches the engine; the coach hint is in the message');
 assert.deepEqual(statuses, ['reasoning', 'ready']);
 assert.deepEqual(replies, [{ text: 'C major.', play: { steps: [[48, 52, 55]], bpm: 100, label: 'C' }, think: true }]);

 engine.reply = () => '';
 await t.ask('Why?');
 engine.reply = () => { throw new Error('out of memory'); };
 await t.ask('Why?');
 engine.reply = () => '<think>so many thoughts';
 await t.ask('Why?');
 assert.deepEqual(errors, ['The model returned nothing. Try again, or pick another model.', 'out of memory', 'The model ran out of room while thinking. Try again, or switch to Fast.']);
 assert.equal(t.conversationHistory.length, 2, 'failed turns leave the history untouched');
 assert.ok(!/<think>/.test(t.conversationHistory[1].content), 'thinking is not kept in the history');

 engine.reply = () => 'ok';
 for (let i = 0; i < 20; i++) await t.ask(`q${i}`);
 assert.equal(t.conversationHistory.length, 30);
 t.conversationHistory.forEach((m, i) => assert.equal(m.role, i % 2 ? 'assistant' : 'user'));
}
{
 // reset() mid-request interrupts the engine, reports nothing, and skips queued requests.
 const engine = new FakeEngine(), t = new AiTeacher();
 t.setEngine(engine);
 const replies = [], errors = [];
 t.onResponse = r => replies.push(r); t.onError = m => errors.push(m);
 let release;
 engine.reply = () => new Promise(r => { release = () => r('late'); });
 const pending = [t.ask('slow'), t.ask('queued')];
 await new Promise(r => setTimeout(r, 0));
 t.reset(); release();
 assert.deepEqual(await Promise.all(pending), [null, null]);
 assert.equal(engine.interrupted, 1);
 assert.equal(engine.calls.length, 1);
 assert.deepEqual([replies.length, errors.length], [0, 0]);
}

/* ---- Hosted providers: one OpenAI-compatible request shape ---- */
{
 respond = () => ({ ok: true, status: 200, body: { choices: [{ message: { content: 'hello' } }] } });
 const before = requests.length;
 const engine = P.openAiEngine({ base: 'https://api.groq.com/openai/v1/', apiKey: 'gsk_x', model: 'llama-3.3-70b-versatile' });
 assert.equal(await engine.generate([{ role: 'user', content: 'hi' }]), 'hello');
 const { url, init, body } = requests[before];
 assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions', 'trailing slash on the base is handled');
 assert.equal(init.headers.Authorization, 'Bearer gsk_x');
 assert.deepEqual(body, { model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024 });

 for (const [status, pattern] of [[401, /key was rejected/], [402, /needs credit/], [404, /Model not found/], [429, /Rate limited/], [500, /Request failed \(500\)/]]) {
  respond = () => ({ ok: false, status, body: { error: { message: 'detail' } } });
  await assert.rejects(engine.generate([]), pattern);
 }
 respond = () => ({ ok: true, status: 200, body: { choices: [{ finish_reason: 'content_filter', message: {} }] } });
 await assert.rejects(engine.generate([]), /declined/);

 // interrupt() aborts the request in flight.
 respond = () => ({ ok: true, status: 200, body: {}, wait: new Promise(() => {}) });
 const inflight = engine.generate([]);
 engine.interrupt();
 await assert.rejects(inflight, { name: 'AbortError' });
}

/* ---- Tools: a hosted model reads and changes the workspace by calling them ---- */
{
 const engine = P.openAiEngine({ base: 'https://api.example/v1', apiKey: 'k', model: 'm' }), calls = [];
 const tools = { definitions: [{ type: 'function', function: { name: 'set_control', parameters: { type: 'object', properties: {} } } }], run: async (name, args) => { calls.push([name, args]); return 'Done: Cutoff (Hz) 800.'; } };
 const turns = [
  { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_control', arguments: '{"control":"Filter › Cutoff (Hz)","value":800}' } }] } }] },
  { choices: [{ message: { content: 'I set the cutoff to 800 Hz, so it sounds darker.' } }] },
 ];
 requests.length = 0;
 respond = () => ({ ok: true, status: 200, body: turns.shift() });
 const reply = await engine.generate([{ role: 'user', content: 'make it darker' }], { tools });
 assert.equal(reply, 'I set the cutoff to 800 Hz, so it sounds darker.');
 assert.deepEqual(calls, [['set_control', { control: 'Filter › Cutoff (Hz)', value: 800 }]], 'the tool ran with the model\'s arguments');
 assert.equal(requests[0].body.tools.length, 1, 'the tools were offered');
 assert.deepEqual(requests[1].body.messages.slice(-2).map(m => m.role), ['assistant', 'tool'], 'the call and its answer went back to the model');
 assert.equal(requests[1].body.messages.at(-1).content, 'Done: Cutoff (Hz) 800.');
 assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'c1');

 // A model that keeps calling tools gets six rounds (a lesson set up as an agent takes a few), then must answer
 // without them.
 requests.length = 0;
 respond = () => ({ ok: true, status: 200, body: requests.length <= 6 ? { choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'set_control', arguments: '{}' } }] } }] } : { choices: [{ message: { content: 'done' } }] } });
 assert.equal(await engine.generate([], { tools }), 'done');
 assert.equal(requests.length, 7);
 assert.ok(!requests[6].body.tools, 'the last request has no tools');

 // A provider that won't take tools is asked again without them, and not offered them again.
 requests.length = 0;
 let first = true;
 respond = () => { if (first) { first = false; return { ok: false, status: 404, body: { error: { message: 'No endpoints found that support tool use.' } } }; } return { ok: true, status: 200, body: { choices: [{ message: { content: 'plain reply {"set": {"Filter › Cutoff (Hz)": 800}}' } }] } }; };
 assert.match(await engine.generate([], { tools }), /plain reply/);
 assert.equal(engine.toolsRefused, true);
 await engine.generate([], { tools });
 assert.ok(requests.every((r, i) => i === 0 || !r.body.tools), 'not offered again');

 // The teacher: tools offered with the prompt that explains them; a change made with a tool is not made again
 // from the JSON line, while "show" still is.
 const t = new AiTeacher(), seen = [];
 t.setEngine({ generate: async (messages, opts) => { seen.push({ system: messages[0].content, opts }); await opts.tools.run('set_control', { control: 'Filter › Cutoff (Hz)', value: 800 }); return 'Done.\n{"set": {"Filter › Cutoff (Hz)": 800}, "show": "Filter › Cutoff (Hz)"}'; } });
 let got = null; t.onResponse = (text, play, info) => { got = info.actions; };
 await t.ask('darker please', { tools: { definitions: [], run: async () => 'ok' } });
 assert.match(seen[0].system, /You also have tools/);
 assert.deepEqual(got, { show: ['Filter › Cutoff (Hz)'], set: [] });
}

/* ---- Provider settings live in cookies ---- */
{
 assert.equal(P.getProviderId(), 'local', 'defaults to on-device');
 assert.ok(P.PROVIDERS.every(p => p.id && p.name && p.how && p.where && p.cost && P.GROUPS.some(g => g.auth === p.auth)), 'every provider says how it signs in, where it sends and what it costs');
 const groq = P.providerById('groq');
 assert.match(P.engineFor(groq).error, /API key/);
 P.setKey('groq', 'gsk_saved'); P.setModelFor('groq', 'llama-3.1-8b-instant'); P.setProviderId('groq');
 assert.equal(P.getProviderId(), 'groq');
 assert.ok(P.engineFor(groq).engine, 'a saved key makes the provider usable after a reload');
 assert.match(document.cookie, /teacher-key-groq=gsk_saved/);

 const custom = P.providerById('custom');
 assert.match(P.engineFor(custom).error, /base URL/);
 P.setBase('custom', 'https://llm.example/v1'); P.setModelFor('custom', 'my-model'); P.setKey('custom', 'k');
 respond = () => ({ ok: true, status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
 await P.engineFor(custom).engine.generate([]);
 assert.equal(requests.at(-1).url, 'https://llm.example/v1/chat/completions');

 P.clearKey('groq');
 assert.match(P.engineFor(groq).error, /API key/);
}

/* ---- Connect: checking a key by listing models (free), and choosing a model ---- */
{
 const json = (status, body) => () => ({ ok: status < 400, status, body });
 const groq = P.providerById('groq'), gemini = P.providerById('gemini'), openai = P.providerById('openai'), openrouter = P.providerById('openrouter');

 respond = json(200, { data: [{ id: 'llama-3.3-70b-versatile' }, { id: 'whisper-large-v3' }, { id: 'meta-llama/llama-guard-4-12b' }, { id: 'llama-3.1-8b-instant' }, { id: 'playai-tts' }] });
 assert.deepEqual(await P.listModels(groq, 'gsk_x'), ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'], 'speech and safety models are left out');
 assert.equal(requests.at(-1).url, 'https://api.groq.com/openai/v1/models');
 assert.equal(requests.at(-1).init.headers.Authorization, 'Bearer gsk_x');

 respond = json(200, { data: [{ id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }, { id: 'models/gemini-2.0-flash' }, { id: 'models/imagen-3.0' }] });
 assert.deepEqual(await P.listModels(gemini, 'AIza'), ['gemini-2.0-flash', 'gemini-2.5-flash'], 'the models/ prefix is dropped');

 respond = json(200, { data: ['gpt-4.1-mini', 'gpt-5-mini', 'gpt-3.5-turbo-instruct', 'text-embedding-3-small', 'whisper-1', 'dall-e-3', 'o4-mini', 'tts-1', 'babbage-002'].map(id => ({ id })) });
 assert.deepEqual(await P.listModels(openai, 'sk'), ['gpt-4.1-mini', 'gpt-5-mini', 'o4-mini']);

 respond = json(401, { error: { message: 'invalid' } });
 await assert.rejects(P.listModels(groq, 'bad'), e => e.status === 401 && /rejected/.test(e.message));
 respond = json(400, { error: { message: 'API key not valid' } });
 await assert.rejects(P.listModels(gemini, 'bad'), e => e.status === 401, 'Gemini reports a bad key as 400');

 // OpenRouter checks the key first, then uses its public model list.
 respond = url => url.endsWith('/key') ? { ok: true, status: 200, body: { data: {} } } : { ok: true, status: 200, body: { data: [
  { id: 'google/gemma-4-31b-it:free', name: 'Gemma (free)', context_length: 9, pricing: { prompt: '0' } },
  { id: 'openai/gpt-5', name: 'GPT-5', pricing: { prompt: '0.001' } }] } };
 assert.deepEqual(await P.listModels(openrouter, 'sk-or'), ['google/gemma-4-31b-it:free', 'openai/gpt-5']);
 assert.equal(requests.at(-2).url, 'https://openrouter.ai/api/v1/key');
 respond = url => url.endsWith('/key') ? { ok: false, status: 401, body: {} } : { ok: true, status: 200, body: { data: [] } };
 await assert.rejects(P.listModels(openrouter, 'bad'), e => e.status === 401);

 // The saved model wins, then the default, then the newest match of the provider's preferences.
 assert.equal(P.pickModel(openai, ['gpt-4o-mini', 'gpt-5-mini'], 'gpt-5-mini'), 'gpt-5-mini');
 assert.equal(P.pickModel(openai, ['gpt-4o-mini', 'gpt-5-mini'], 'gone-model'), 'gpt-4o-mini');
 assert.equal(P.pickModel(openai, ['gpt-4.1-mini', 'gpt-5-mini', 'gpt-4o'], null), 'gpt-5-mini');
 assert.equal(P.pickModel(gemini, ['gemini-3.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'], null), 'gemini-3.0-flash');
 assert.equal(P.pickModel(groq, ['qwen-x', 'mixtral'], null), 'qwen-x', 'falls back to the first listed');
}

/* ---- OpenRouter's key-free sign-in (OAuth PKCE) ---- */
{
 const { verifier, challenge } = await createPkcePair();
 const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
 assert.equal(challenge, b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))));

 assert.equal(await completeSignIn(), null, 'no ?code=: nothing to do');
 exchange = () => ({ ok: true, status: 200, body: { key: 'sk-or-new' } });
 ls.set('openrouter_pkce_verifier', 'verifier-xyz'); location.search = '?code=the-code';
 assert.equal(await completeSignIn(), 'sk-or-new');
 assert.deepEqual(requests.at(-1).body, { code: 'the-code', code_verifier: 'verifier-xyz', code_challenge_method: 'S256' });
 assert.equal(ls.has('openrouter_pkce_verifier'), false, 'the verifier is one-time');

 exchange = () => ({ ok: false, status: 403, body: { error: { message: 'bad code' } } });
 location.search = '?code=stale';
 await assert.rejects(completeSignIn(), /bad code/);
 location.search = '';
}

console.log('teacher: all checks passed');
