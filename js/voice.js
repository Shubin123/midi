// Talk mode for the teacher: listen with the browser's speech recognition and read replies aloud, either with
// the browser's speech synthesis (the Web Speech API) or a neural voice that runs in the page: Pocket TTS,
// Supertonic or Piper (js/tts-*.js, each downloaded once when first chosen). Listening pauses while the
// teacher speaks, so it doesn't hear itself. Recognition runs on the device where the browser offers that;
// otherwise the browser's own speech service does it (online, in Chrome), and the panel says which. Any voice
// can be sped up or slowed down without changing its pitch: the browser's by its own rate, a neural one by
// time-stretching what it says (stretch()).

const Recognition = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
export const canListen = () => !!Recognition();
const browserSpeaks = () => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
export const canSpeak = () => browserSpeaks() || typeof AudioContext !== 'undefined';

// The voices on offer. Each neural engine module exports ENGINE ({ name, about, license, voices, defaultVoice }),
// load(voiceId, onProgress) and synthesize(text, voiceId) → { samples, sampleRate }.
export const ENGINES = { pocket: './tts-pocket.js', supertonic: './tts-supertonic.js', piper: './tts-piper.js' };
const modules = {};
export const loadEngine = id => (modules[id] ||= import(ENGINES[id]).catch(err => { delete modules[id]; throw err; }));
// A choice is { engine, voice }; engine 'browser' is the Web Speech voice.
export const BROWSER = { engine: 'browser', voice: '' };

// How fast the teacher talks: 1 is the voice's own speed.
export const SPEED = { min: 0.5, max: 2, step: 0.05, normal: 1 };
const clampSpeed = x => Math.round(Math.min(SPEED.max, Math.max(SPEED.min, Number(x) || 1)) * 100) / 100;

// Plays speech faster or slower without changing its pitch (WSOLA): the sound is cut into overlapping 25 ms
// frames, read `speed` times as far apart as they are laid down, and each frame is taken from where it best
// continues the last one (within a few milliseconds of where it should be), so the waveform joins without
// clicks or a warble. Returns new samples, about length / speed long.
export function stretch(samples, sampleRate, speed) {
 if (Math.abs(speed - 1) < 1e-3 || samples.length < 2) return samples;
 const n = Math.max(64, Math.round(sampleRate * 0.025) & ~1), hop = n / 2, seek = Math.round(n / 4);
 const win = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)); // overlapping halves sum to 1
 const outLen = Math.round(samples.length / speed), out = new Float32Array(outLen + n), last = samples.length - n;
 const skip = Math.max(1, Math.round(sampleRate / 12000)); // the match is judged on every few samples: speech is band-limited enough
 if (last < 0) return samples;
 let prev = 0;
 for (let k = 0; k * hop < outLen; k++) {
  let at = Math.min(last, Math.round(k * hop * speed));
  if (k > 0) {
   // Where the last frame would naturally go on, and the place near `at` that sounds most like it.
   const want = Math.min(last, prev + hop);
   let best = -Infinity, bestAt = at;
   for (let p = Math.max(0, at - seek); p <= Math.min(last, at + seek); p++) {
    let c = 0;
    for (let i = 0; i < hop; i += skip) c += samples[p + i] * samples[want + i];
    if (c > best) { best = c; bestAt = p; }
   }
   at = bestAt;
  }
  for (let i = 0; i < n; i++) out[k * hop + i] += samples[at + i] * win[i];
  prev = at;
 }
 // The first half-frame had no frame before it to overlap: it is taken as it was.
 for (let i = 0; i < hop; i++) out[i] = samples[i];
 return out.subarray(0, outLen);
}

// "Talk faster", "speak a little slower", "voice speed 1.5", "talk at normal speed": the new speed, or null when
// the words aren't about how fast the teacher talks.
export function speedFrom(text, current = 1) {
 const s = String(text).toLowerCase();
 if (!/\b(talk|talking|speak|speaking|speech|voice|read|reading|say|saying)\b/.test(s)) return null;
 const n = s.match(/\b(\d(?:\.\d+)?)\s*(x|times)?\b/);
 if (/\bnormal\b|\breset\b|\busual\b/.test(s) && /\b(speed|pace|rate|fast|slow)\b/.test(s)) return 1;
 if (n && /\b(speed|pace|rate|at|x|times)\b/.test(s)) return clampSpeed(n[1]);
 const by = /\b(a (little|bit|touch|tad)|slightly)\b/.test(s) ? 0.1 : /\b(much|a lot|way)\b/.test(s) ? 0.5 : 0.25;
 if (/\b(faster|quicker|speed up|hurry)\b/.test(s)) return clampSpeed(current + by);
 if (/\b(slower|slow down)\b/.test(s)) return clampSpeed(current - by);
 return null;
}

// Reading one sentence at a time lets the first be heard while the rest are made; a short pause between
// sentences sounds natural (the engines leave none at the edges).
const SENTENCE_GAP = 0.25;
export const sentences = text => String(text).match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map(s => s.trim()).filter(Boolean) || [];

const NUMBER = { 6: 'six', 7: 'seven', 9: 'nine', 11: 'eleven', 13: 'thirteen' };
const QUALITY = { maj: 'major', M: 'major', min: 'minor', m: 'minor', dim: 'diminished', aug: 'augmented', sus: 'suspended', add: 'add' };
const ROMAN = { i: 'one', ii: 'two', iii: 'three', iv: 'four', v: 'five', vi: 'six', vii: 'seven' };

// Rewrites music notation so a speech voice says it properly: "Dm7" → "D minor seven", "Bb" → "B flat",
// "ii–V–I" → "two, five, one", "→" → "then". Plain words are left alone.
export function sayable(text) {
 return String(text)
  .replace(/\b([iIvV]{1,4})((?:\s?[–-]\s?[iIvV]{1,4}°?)+)\b/g, m => m.split(/\s?[–-]\s?/).map(r => ROMAN[r.replace('°', '').toLowerCase()] || r).join(', '))
  .replace(/\b([A-G])([#♯b♭]?)(maj|min|dim|aug|sus|add|M|m)?(\d{1,2})?(b5)?(?![A-Za-z#♯♭])/g, (m, root, acc, q, n, b5) => {
   if (!acc && !q && !n) return m; // a bare letter is just a letter (or the word "A")
   const parts = [root];
   if (acc) parts.push(acc === '#' || acc === '♯' ? 'sharp' : 'flat');
   if (q) parts.push(QUALITY[q]);
   if (n) parts.push(NUMBER[n] || n);
   if (b5) parts.push('flat five');
   return parts.join(' ');
  })
  .replace(/°7/g, ' diminished seven').replace(/°/g, ' diminished').replace(/ø7?/g, ' half-diminished')
  .replace(/\s*→\s*/g, ', then ').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim();
}

// Picks a voice for the page's language, preferring one that runs on the device.
function pickVoice(lang) {
 const voices = speechSynthesis.getVoices(), base = lang.split('-')[0];
 const same = voices.filter(v => v.lang?.toLowerCase().startsWith(base.toLowerCase()));
 return same.find(v => v.localService && v.lang === lang) || same.find(v => v.localService) || same.find(v => v.lang === lang) || same[0] || null;
}

export class Voice {
 // onHeard(text) gets each finished utterance; onInterim(text) the words so far; onState(state, note) one of
 // 'off', 'listening', 'speaking', or 'error' with a message.
 constructor({ onHeard, onInterim, onState, lang = (globalThis.navigator?.language || 'en-US') } = {}) {
  this.onHeard = onHeard; this.onInterim = onInterim; this.onState = onState; this.lang = lang;
  this.active = false; this.speaking = false; this.rec = null; this.local = false;
  this.choice = BROWSER; this.onProgress = null; this._token = null; this._sources = []; this.speed = SPEED.normal;
 }
 // How fast replies are read (0.5 to 2); takes effect from the next one.
 setSpeed(x) { this.speed = clampSpeed(x); }

 // Which voice reads replies. A neural voice that fails to load falls back to the browser's, once.
 setVoice(choice) { this.choice = choice?.engine ? choice : BROWSER; }

 get listens() { return canListen(); }

 async start() {
  if (this.active) return;
  this.active = true;
  if (canListen()) {
   const SR = Recognition(), rec = new SR();
   rec.lang = this.lang; rec.continuous = true; rec.interimResults = true;
   // Ask for on-device recognition where the browser supports it (newer Chrome); fall back quietly.
   try {
    if (typeof SR.available === 'function' && 'processLocally' in rec) {
     const status = await SR.available({ langs: [this.lang], processLocally: true });
     if (status === 'downloadable' || status === 'downloading') await SR.install?.({ langs: [this.lang], processLocally: true });
     if (status !== 'unavailable') { rec.processLocally = true; this.local = true; }
    }
   } catch { this.local = false; }
   rec.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
     const r = e.results[i], text = r[0].transcript;
     if (r.isFinal) { if (text.trim()) this.onHeard?.(text.trim()); }
     else interim += text;
    }
    this.onInterim?.(interim.trim());
   };
   rec.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return; // silence, or our own pause
    const why = { 'not-allowed': 'Microphone access was blocked. Allow it for this site to talk.', 'service-not-allowed': 'This browser\'s speech service isn\'t available here.', network: 'The browser\'s speech service couldn\'t be reached.', 'audio-capture': 'No microphone was found.' }[e.error] || `Listening stopped (${e.error}).`;
    this.stop(); this.onState?.('error', why);
   };
   // Browsers end recognition after a pause even when continuous; keep it going while talk mode is on.
   rec.onend = () => { if (this.active && !this.speaking) setTimeout(() => this._listen(), 150); };
   this.rec = rec;
   this._listen();
  }
  this.onState?.(this.speaking ? 'speaking' : 'listening');
 }

 stop() {
  this.active = false;
  try { this.rec?.abort(); } catch { /* not running */ }
  this.rec = null;
  this.cancelSpeech();
  this.onState?.('off');
 }

 _listen() { try { this.rec?.start(); } catch { /* already started */ } }

 // Reads text aloud, pausing recognition meanwhile. Resolves when it finishes or is cancelled.
 speak(text) {
  const words = sayable(text);
  if (!words) return Promise.resolve();
  if (this.choice.engine !== 'browser') return this._speakNeural(words).catch(err => { this.onState?.('voice-error', err.message); this.choice = BROWSER; return this.speak(text); });
  if (!browserSpeaks()) return Promise.resolve();
  return new Promise(resolve => {
   const u = new SpeechSynthesisUtterance(words);
   u.lang = this.lang; u.rate = this.speed;
   const voice = pickVoice(this.lang);
   if (voice) u.voice = voice;
   const done = () => {
    if (this._utterance !== u) return resolve();
    this._utterance = null; this.speaking = false;
    if (this.active) { this._listen(); this.onState?.('listening'); }
    resolve();
   };
   u.onend = done; u.onerror = done;
   this._utterance = u; this.speaking = true;
   try { this.rec?.abort(); } catch { /* not running */ }
   this.onState?.('speaking');
   speechSynthesis.cancel(); // a newer reply replaces one still being read
   speechSynthesis.speak(u);
  });
 }

 // A neural voice: sentence by sentence, the next one made while the current one plays.
 async _speakNeural(words) {
  const { engine } = this.choice, mod = await loadEngine(engine), voice = this.choice.voice || mod.ENGINE.defaultVoice;
  await mod.load(voice, p => this.onProgress?.(p));
  const token = this._token = {}, ctx = this._ctx ||= new AudioContext();
  await ctx.resume();
  this.speaking = true;
  try { this.rec?.abort(); } catch { /* not running */ }
  this.onState?.('speaking');
  const parts = sentences(words);
  let at = ctx.currentTime + 0.05, next = parts.length ? mod.synthesize(parts[0], voice) : null;
  for (let i = 0; i < parts.length; i++) {
   const made = await next;
   if (this._token !== token) return;
   next = i + 1 < parts.length ? mod.synthesize(parts[i + 1], voice) : null;
   const sampleRate = made.sampleRate, samples = stretch(made.samples, sampleRate, this.speed);
   const buf = ctx.createBuffer(1, samples.length, sampleRate);
   buf.copyToChannel(samples, 0);
   const src = ctx.createBufferSource();
   src.buffer = buf; src.connect(ctx.destination);
   at = Math.max(at, ctx.currentTime); src.start(at); at += buf.duration + (i + 1 < parts.length ? SENTENCE_GAP : 0);
   this._sources.push(src);
  }
  await new Promise(resolve => { const wait = () => (this._token !== token || ctx.currentTime >= at ? resolve() : setTimeout(wait, 100)); wait(); });
  if (this._token !== token) return;
  this._token = null; this._sources = []; this.speaking = false;
  if (this.active) { this._listen(); this.onState?.('listening'); }
 }

 // Stops reading aloud (the student started playing, or talk mode ended); listening resumes if still on.
 cancelSpeech() {
  const was = this.speaking;
  this._token = null; this._sources.forEach(s => { try { s.stop(); } catch { /* already ended */ } }); this._sources = [];
  if (!browserSpeaks()) { this.speaking = false; if (was && this.active) { this._listen(); this.onState?.('listening'); } return; }
  const u = this._utterance;
  this._utterance = null; this.speaking = false;
  speechSynthesis.cancel();
  u?.onend?.(); // settles that reply's promise
  if (was && this.active) { this._listen(); this.onState?.('listening'); }
 }
}
