import assert from 'node:assert/strict';
import { detectScale, detectChord, PhraseTracker } from '../js/pitch-analyzer.js';

// --- Browser globals the modules touch, stubbed just enough to run under node. ---
const jar = new Map(); // a cookie jar so several cookies coexist (document.cookie is a plain string otherwise)
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

const { createPkcePair, completeSignIn, getToken, setToken, setModel, getModel } = await import('../js/ai-auth.js');
const { AiTeacher, parsePlayCommand } = await import('../js/ai-teacher.js');

// A routing fetch stub: key-exchange requests and chat requests are answered separately.
const requests = [];
let exchange = () => ({ ok: true, status: 200, body: { key: 'sk-or-test' } });
let respond = () => ({ ok: true, status: 200, body: { choices: [{ message: { content: 'That was C major.\n{"play":[60,62,64],"bpm":100}' } }] } });
globalThis.fetch = (url, init = {}) => {
 requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
 const { ok, status, body, wait } = url.endsWith('/auth/keys') ? exchange() : respond();
 return new Promise((resolve, reject) => {
  const done = () => resolve({ ok, status, statusText: '', json: async () => body });
  init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  wait ? wait.then(done) : done();
 });
};

const C_MAJOR = [0, 2, 4, 5, 7, 9, 11];
const name = s => `${s.tonicName} ${s.scaleName}`;

// A diatonic set fits all seven modes; the tonic hint picks the mode, and Ionian is the fallback.
assert.equal(name(detectScale(C_MAJOR)[0]), 'C Ionian (Major)');
assert.equal(name(detectScale(C_MAJOR, [2])[0]), 'D Dorian');
assert.equal(name(detectScale(C_MAJOR, [9, 0])[0]), 'A Aeolian (Minor)');
assert.equal(name(detectScale([0, 2, 3, 5, 7, 8, 11])[0]), 'C Harmonic Minor');

// The chord that explains every note wins, then the one rooted on the bass.
assert.equal(detectChord([0, 4, 7])[0].chordName, 'Cmaj');
assert.equal(detectChord([0, 4, 7, 11])[0].chordName, 'Cmaj7');
assert.equal(detectChord([4, 7, 11])[0].chordName, 'Emin');
assert.equal(detectChord([9, 0, 4, 7])[0].chordName, 'Amin7');
assert.equal(detectChord([0, 3, 6, 9], 9)[0].chordName, 'Adim7');
assert.deepEqual(detectChord([0, 4]), []);

// A phrase ends once every key is up and the gap passes; a struck chord is found inside it.
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
 const [p] = phrases;
 assert.equal(p.noteCount, 6);
 assert.equal(p.durationMs, 510);
 assert.deepEqual(p.pitchClasses, [0, 4, 7, 5, 9]);
 assert.deepEqual(p.chords.map(c => c.best.chordName), ['Fmaj']);
 assert.equal(p.scales[0].tonicName, 'C');
}

// Note suggestions: validated, removed from the shown text, code fences tolerated.
assert.deepEqual(parsePlayCommand('Try Dorian.\n{"play": [62, 64, 65], "bpm": 90}'), { text: 'Try Dorian.', play: { play: [62, 64, 65], bpm: 90 } });
assert.deepEqual(parsePlayCommand('Here:\n```json\n{"play":[60,200,61.5,62],"bpm":1000}\n```'), { text: 'Here:', play: { play: [60, 62], bpm: 300 } });
assert.deepEqual(parsePlayCommand('No notes this time. '), { text: 'No notes this time.', play: null });
assert.deepEqual(parsePlayCommand('{"play": [128]}'), { text: '', play: null });

// PKCE: the challenge is the base64url SHA-256 of the verifier.
{
 const { verifier, challenge } = await createPkcePair();
 const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
 const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
 assert.equal(challenge, b64u(digest));
 assert.match(verifier, /^[A-Za-z0-9_-]+$/);
}

// Sign-in: ?code= is exchanged for a key, the key lands in the cookie, the verifier is sent and cleared.
{
 assert.equal(await completeSignIn(), false, 'no code: nothing to do');
 ls.set('openrouter_pkce_verifier', 'verifier-xyz');
 location.search = '?code=the-code';
 assert.equal(await completeSignIn(), true);
 const exch = requests.find(r => r.url.endsWith('/auth/keys'));
 assert.equal(exch.url, 'https://openrouter.ai/api/v1/auth/keys');
 assert.deepEqual(exch.body, { code: 'the-code', code_verifier: 'verifier-xyz', code_challenge_method: 'S256' });
 assert.equal(getToken(), 'sk-or-test');
 assert.equal(ls.get('openrouter_pkce_verifier'), undefined, 'the verifier is one-time');
 location.search = '';

 exchange = () => ({ ok: false, status: 403, body: { error: { message: 'bad code' } } });
 ls.set('openrouter_pkce_verifier', 'v2'); location.search = '?code=stale';
 await assert.rejects(completeSignIn(), /bad code/);
 location.search = '';
}

// The teacher, signed in, calls OpenRouter with the cookie token and the chosen model.
{
 setModel('x/test-model');
 assert.equal(getModel(), 'x/test-model');
 const t = new AiTeacher();
 assert.equal(t.isConfigured, true);
 assert.equal(t.model, 'x/test-model');

 const replies = [], errors = [];
 t.onResponse = (text, play) => replies.push({ text, play });
 t.onError = m => errors.push(m);
 const before = requests.length;
 await t.analyzePhrase({ noteCount: 3, durationMs: 412.4, noteOns: [{ note: 60 }, { note: 64 }, { note: 67 }], pitchClasses: [0, 4, 7], scales: [{ tonicName: 'C', scaleName: 'Major Pentatonic', score: 0.6 }], chords: [] });
 const { url, init, body } = requests[before];
 assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
 assert.equal(init.headers.Authorization, 'Bearer sk-or-test');
 assert.equal(body.model, 'x/test-model');
 assert.equal(body.max_tokens, 1024);
 assert.equal(body.messages[0].role, 'system');
 assert.equal(body.messages[1].content, '[PLAYED] 3 notes, 412ms | midi: [60, 64, 67] | pcs: [0, 4, 7] | best: C Major Pentatonic (0.60)');
 assert.deepEqual(replies, [{ text: 'That was C major.', play: { play: [60, 62, 64], bpm: 100 } }]);
 assert.deepEqual(t.conversationHistory.map(m => m.role), ['user', 'assistant']);

 // A content-filter finish and an HTTP error both report and leave the history untouched.
 respond = () => ({ ok: true, status: 200, body: { choices: [{ finish_reason: 'content_filter', message: {} }] } });
 assert.equal(await t.ask('Why?'), null);
 respond = () => ({ ok: false, status: 402, body: { error: { message: 'insufficient credits' } } });
 await t.ask('Why?');
 assert.deepEqual(errors, ['The model declined to answer that one. Try rephrasing it.', 'This model needs OpenRouter credit. Pick a free model in Settings, or add credit.']);
 assert.equal(t.conversationHistory.length, 2);

 // Concurrent asks run in order; the window stays a run of whole exchanges opening with the user.
 respond = () => ({ ok: true, status: 200, body: { choices: [{ message: { content: 'ok' } }] } });
 await Promise.all(Array.from({ length: 20 }, (_, i) => t.ask(`q${i}`)));
 const h = t.conversationHistory;
 assert.equal(h.length, 30);
 h.forEach((m, i) => assert.equal(m.role, i % 2 ? 'assistant' : 'user'));
 assert.equal(h.at(-2).content, 'q19');
 assert.equal(requests.at(-1).body.messages[0].role, 'system');
 assert.equal(requests.at(-1).body.messages.at(-3).content, 'q18', 'each request carries the prior answer');

 // Reset aborts the in-flight request and skips the queued ones, silently.
 let release; respond = () => ({ ok: true, status: 200, body: { choices: [{ message: { content: 'late' } }] }, wait: new Promise(r => { release = r; }) });
 const reqCount = requests.length, replyCount = replies.length, errorCount = errors.length;
 const pending = [t.ask('slow'), t.ask('queued')];
 await new Promise(r => setTimeout(r, 0));
 t.reset(); release();
 assert.deepEqual(await Promise.all(pending), [null, null]);
 assert.equal(requests.length, reqCount + 1);
 assert.equal(replies.length, replyCount);
 assert.equal(errors.length, errorCount);
 assert.deepEqual(t.conversationHistory, []);
}

console.log('teacher: all checks passed');
