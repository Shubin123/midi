// Talk mode for the teacher: listen with the browser's speech recognition and read replies aloud with its
// speech synthesis (the Web Speech API). Listening pauses while the teacher speaks, so it doesn't hear itself.
// Recognition runs on the device where the browser offers that; otherwise the browser's own speech service
// does it (online, in Chrome), and the panel says which. Voices that run locally are preferred for speaking.

const Recognition = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
export const canListen = () => !!Recognition();
export const canSpeak = () => typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';

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
 }

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
  if (!canSpeak() || !words) return Promise.resolve();
  return new Promise(resolve => {
   const u = new SpeechSynthesisUtterance(words);
   u.lang = this.lang;
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

 // Stops reading aloud (the student started playing, or talk mode ended); listening resumes if still on.
 cancelSpeech() {
  if (!canSpeak()) return;
  const u = this._utterance, was = this.speaking;
  this._utterance = null; this.speaking = false;
  speechSynthesis.cancel();
  u?.onend?.(); // settles that reply's promise
  if (was && this.active) { this._listen(); this.onState?.('listening'); }
 }
}
