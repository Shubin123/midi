import assert from 'node:assert/strict';
import { detectScale, detectChord, PhraseTracker } from '../js/pitch-analyzer.js';
import { ClaudeTeacher, parsePlayCommand } from '../js/claude-teacher.js';

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

// The API client, against a stand-in for fetch.
globalThis.document = { cookie: '' };
globalThis.location = { protocol: 'https:', pathname: '/midi/index.html' };
const requests = [];
let respond = () => ({ ok: true, status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'That was C major.\n{"play":[60,62,64],"bpm":100}' }] } });
globalThis.fetch = (url, init) => {
 requests.push({ url, init, body: JSON.parse(init.body) });
 const { ok, status, body, wait } = respond();
 return new Promise((resolve, reject) => {
  const done = () => resolve({ ok, status, statusText: '', json: async () => body });
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  wait ? wait.then(done) : done();
 });
};

{
 const t = new ClaudeTeacher();
 assert.equal(t.isConfigured, false);
 t.setApiKey('sk-test');
 assert.match(document.cookie, /^anthropic_api_key=sk-test;.*path=\/midi\/;SameSite=Strict;Secure$/);
 assert.equal(new ClaudeTeacher().apiKey, 'sk-test', 'the key survives a reload');

 const replies = [], errors = [];
 t.onResponse = (text, play) => replies.push({ text, play });
 t.onError = m => errors.push(m);
 await t.analyzePhrase({ noteCount: 3, durationMs: 412.4, noteOns: [{ note: 60 }, { note: 64 }, { note: 67 }], pitchClasses: [0, 4, 7], scales: [{ tonicName: 'C', scaleName: 'Major Pentatonic', score: 0.6 }], chords: [] });
 const [{ url, init, body }] = requests;
 assert.equal(url, 'https://api.anthropic.com/v1/messages');
 assert.equal(init.headers['x-api-key'], 'sk-test');
 assert.equal(init.headers['anthropic-version'], '2026-10-21');
 assert.equal(init.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
 assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
 assert.equal(body.model, 'claude-sonnet-5-5');
 assert.deepEqual(body.output_config, { effort: 'low' });
 assert.equal(body.fallbacks, 'default');
 assert.ok(!('temperature' in body) && !('thinking' in body));
 assert.equal(body.messages[0].content, '[PLAYED] 3 notes, 412ms | midi: [60, 64, 67] | pcs: [0, 4, 7] | best: C Major Pentatonic (0.60)');
 assert.deepEqual(replies, [{ text: 'That was C major.', play: { play: [60, 62, 64], bpm: 100 } }]);
 assert.deepEqual(t.conversationHistory.map(m => m.role), ['user', 'assistant']);
 assert.equal(typeof t.conversationHistory[1].content, 'string', 'only text goes back into the history');

 // A refusal or an HTTP error reports and leaves the history as it was.
 respond = () => ({ ok: true, status: 200, body: { stop_reason: 'refusal', content: [] } });
 assert.equal(await t.ask('Why?'), null);
 respond = () => ({ ok: false, status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } });
 await t.ask('Why?');
 assert.deepEqual(errors, ['Claude declined to answer that one. Try rephrasing it.', 'API 401: invalid x-api-key']);
 assert.equal(t.conversationHistory.length, 2);

 // Concurrent asks run in order, and the window stays a run of whole exchanges that opens with the user.
 respond = () => ({ ok: true, status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] } });
 await Promise.all(Array.from({ length: 20 }, (_, i) => t.ask(`q${i}`)));
 const h = t.conversationHistory;
 assert.equal(h.length, 30);
 h.forEach((m, i) => assert.equal(m.role, i % 2 ? 'assistant' : 'user'));
 assert.equal(h.at(-2).content, 'q19');
 assert.equal(requests.at(-1).body.messages.at(-3).content, 'q18', 'each request sees the previous answer');

 // Clear aborts the request in flight and skips the queued ones, silently.
 let release; respond = () => ({ ok: true, status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'late' }] }, wait: new Promise(r => { release = r; }) });
 const before = requests.length, replyCount = replies.length, errorCount = errors.length;
 const pending = [t.ask('slow'), t.ask('queued')];
 await new Promise(r => setTimeout(r, 0));
 t.reset(); release();
 assert.deepEqual(await Promise.all(pending), [null, null]);
 assert.equal(requests.length, before + 1);
 assert.equal(replies.length, replyCount);
 assert.equal(errors.length, errorCount);
 assert.deepEqual(t.conversationHistory, []);

 t.clearApiKey();
 assert.match(document.cookie, /^anthropic_api_key=;max-age=0;path=\/midi\//);
}

console.log('teacher: all checks passed');
