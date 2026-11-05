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

const { AiTeacher, parsePlayCommand } = await import('../js/ai-teacher.js');
const { createPkcePair, completeSignIn } = await import('../js/ai-auth.js');
const P = await import('../js/providers.js');

// A routing fetch stub; each test sets `respond` for chat calls and `exchange` for the OAuth key exchange.
const requests = [];
let respond, exchange;
globalThis.fetch = (url, init = {}) => {
 requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
 const { ok, status, body, wait } = (url.endsWith('/auth/keys') ? exchange : respond)();
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
 assert.equal(phrases[0].scales[0].tonicName, 'C');
}

/* ---- Suggestions: single notes, chords, and mixes ---- */
// Single notes become one-note steps.
assert.deepEqual(parsePlayCommand('Try Dorian.\n{"play": [62, 64, 65], "bpm": 90}'), { text: 'Try Dorian.', play: { steps: [[62], [64], [65]], bpm: 90 } });
// Nested arrays are chords struck together; the brace matcher survives the inner brackets.
assert.deepEqual(parsePlayCommand('I to IV.\n{"play": [[60,64,67], [65,69,72]], "bpm": 80}'), { text: 'I to IV.', play: { steps: [[60, 64, 67], [65, 69, 72]], bpm: 80 } });
// A bass note then a chord, mixed in one command.
assert.deepEqual(parsePlayCommand('{"play": [48, [60,64,67]]}').play, { steps: [[48], [60, 64, 67]], bpm: 120 });
// Code fences, invalid notes, and an out-of-range tempo are cleaned up.
assert.deepEqual(parsePlayCommand('Here:\n```json\n{"play":[[60,200,61.5,64], 999, 62],"bpm":1000}\n```'), { text: 'Here:', play: { steps: [[60, 64], [62]], bpm: 300 } });
// No suggestion, or nothing valid, gives no playback.
assert.deepEqual(parsePlayCommand('No notes this time. '), { text: 'No notes this time.', play: null });
assert.equal(parsePlayCommand('{"play": [128, [200]]}').play, null);
// At most 32 notes are kept across all steps.
assert.equal(parsePlayCommand(`{"play": [${Array.from({ length: 12 }, () => '[60,64,67]').join(',')}]}`).play.steps.flat().length, 32);

/* ---- The teacher with an injected engine ---- */
class FakeEngine {
 constructor() { this.calls = []; this.reply = () => 'C major.\n{"play":[[60,64,67]],"bpm":100}'; this.interrupted = 0; }
 async generate(messages) { this.calls.push(messages); return this.reply(messages); }
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
 t.onResponse = (text, play) => replies.push({ text, play });
 t.onError = m => errors.push(m);
 await t.analyzePhrase({ noteCount: 3, durationMs: 412.4, noteOns: [{ note: 60 }, { note: 64 }, { note: 67 }], pitchClasses: [0, 4, 7], scales: [{ tonicName: 'C', scaleName: 'Major Pentatonic', score: 0.6 }], chords: [] });
 assert.equal(engine.calls[0][0].role, 'system');
 assert.match(engine.calls[0][0].content, /array of numbers played together as a chord/);
 assert.equal(engine.calls[0][1].content, '[PLAYED] 3 notes, 412ms | midi: [60, 64, 67] | pcs: [0, 4, 7] | best: C Major Pentatonic (0.60)');
 assert.deepEqual(replies, [{ text: 'C major.', play: { steps: [[60, 64, 67]], bpm: 100 } }]);

 engine.reply = () => '';
 await t.ask('Why?');
 engine.reply = () => { throw new Error('out of memory'); };
 await t.ask('Why?');
 assert.deepEqual(errors, ['The model returned nothing. Try again, or pick another model.', 'out of memory']);
 assert.equal(t.conversationHistory.length, 2, 'failed turns leave the history untouched');

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

/* ---- Provider settings live in cookies ---- */
{
 assert.equal(P.getProviderId(), 'local', 'defaults to on-device');
 assert.ok(P.PROVIDERS.every(p => p.id && p.label && p.auth));
 const groq = P.providerById('groq');
 assert.match(P.engineFor(groq).error, /Add a key/);
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
 assert.match(P.engineFor(groq).error, /Add a key/);
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
