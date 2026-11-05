// The teacher's conversation logic, independent of which engine answers. It keeps a short rolling history,
// sends one request at a time, and pulls note and chord suggestions out of the replies. The engine is
// injected (see js/providers.js and js/local-model.js): any object with `generate(messages) -> text` and an
// optional `interrupt()`.
const MAX_HISTORY = 30; // messages, dropped oldest-first in user/assistant pairs

export const SYSTEM_PROMPT = `You are a music theory teacher built into a live piano app.
Messages that start with [PLAYED] are automatic summaries of the phrase the student just played: note count and length, the MIDI notes in order, the pitch classes mod 12 (C=0, C#=1, D=2 ... B=11), the best local scale or mode match, and any chords. The local match is a guess from the pitch set alone; correct it when the note order points to a different tonic. Any other message is a question the student typed.
For a [PLAYED] summary, say what scale, mode, chord or progression they played, explain the theory in one to three sentences, and suggest one thing to try next.
Keep every reply short: this is a live session, not a lecture. Write plain text without Markdown.
To have the app play notes for the student, end the reply with one line of JSON, not in a code block: {"play": [60, 64, 67], "bpm": 120}
Each item is a step played in turn at that tempo (60 is middle C). A step can be a single MIDI number, or an array of numbers played together as a chord: {"play": [[60,64,67], [65,69,72]], "bpm": 90} plays a C major triad then an F major triad. Mix them freely, e.g. a bass note then a chord.`;

const validNote = n => Number.isInteger(n) && n >= 0 && n <= 127;

// Finds a {"play": ...} object in the reply by matching braces (so nested chord arrays survive), and returns
// its text with that object removed plus a normalised suggestion. Each step becomes an array of MIDI notes
// (a single note becomes a one-note step); invalid notes are dropped, empty steps removed, 32 notes max, and
// the tempo held to 30-300 BPM like the synth's. Code fences around the JSON are tolerated.
export function parsePlayCommand(reply) {
 const start = reply.search(/\{\s*"play"\s*:/);
 if (start < 0) return { text: reply.trim(), play: null };
 let depth = 0, end = -1, inStr = false, esc = false;
 for (let i = start; i < reply.length; i++) {
  const c = reply[i];
  if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
  else if (c === '"') inStr = true;
  else if (c === '{' || c === '[') depth++;
  else if (c === '}' || c === ']') { if (--depth === 0) { end = i + 1; break; } }
 }
 const clean = () => reply.trim();
 if (end < 0) return { text: clean(), play: null };
 let cmd;
 try { cmd = JSON.parse(reply.slice(start, end)); } catch { return { text: clean(), play: null }; }
 const bpm = Number.isFinite(cmd.bpm) && cmd.bpm > 0 ? Math.max(30, Math.min(300, cmd.bpm)) : 120;
 let left = 32;
 const steps = [];
 for (const item of Array.isArray(cmd.play) ? cmd.play : []) {
  const notes = (Array.isArray(item) ? item : [item]).filter(validNote).slice(0, left);
  if (notes.length) { steps.push(notes); left -= notes.length; }
  if (left <= 0) break;
 }
 const text = (reply.slice(0, start) + reply.slice(end)).replace(/```(?:json)?/g, '').trim();
 return { text, play: steps.length ? { steps, bpm } : null };
}

export class AiTeacher {
 constructor() {
  this.engine = null;
  this.conversationHistory = [];
  this.onResponse = null; this.onError = null; this.onStatus = null;
  this._queue = Promise.resolve(); this._generation = 0;
 }
 get isConfigured() { return !!this.engine; }
 setEngine(engine) { this.engine = engine; }

 analyzePhrase(a) {
  const midi = a.noteOns.slice(0, 48).map(n => n.note).join(', ') + (a.noteOns.length > 48 ? ', ...' : '');
  const parts = [`${a.noteCount} notes, ${Math.round(a.durationMs)}ms`, `midi: [${midi}]`, `pcs: [${a.pitchClasses.join(', ')}]`];
  if (a.scales.length) {
   const b = a.scales[0];
   parts.push(`best: ${b.tonicName} ${b.scaleName} (${b.score.toFixed(2)})`);
  }
  if (a.chords.length) parts.push(`chords: ${a.chords.map(c => c.best.chordName).join(' → ')}`);
  return this._send(`[PLAYED] ${parts.join(' | ')}`);
 }

 ask(q) { return this._send(q); }
 reset() { this._generation++; this.conversationHistory = []; this.engine?.interrupt?.(); }

 // One request at a time, so the history always alternates user and assistant turns.
 // Requests queued before a reset() are skipped.
 _send(msg) {
  const generation = this._generation;
  return this._queue = this._queue.then(() => generation === this._generation ? this._request(msg) : null);
 }

 async _request(msg) {
  if (!this.engine) { this.onError?.('Set up a model in Settings first.'); return null; }
  this.onStatus?.('thinking');
  const history = this.conversationHistory, generation = this._generation;
  while (history.length >= MAX_HISTORY) history.splice(0, 2); // still opens with a user turn
  history.push({ role: 'user', content: msg });
  let reply;
  try {
   reply = (await this.engine.generate([{ role: 'system', content: SYSTEM_PROMPT }, ...history])).trim();
   if (generation !== this._generation) { history.pop(); return null; } // reset() while generating: discard
   if (!reply) throw new Error('The model returned nothing. Try again, or pick another model.');
  } catch (err) {
   history.pop();
   this.onStatus?.('ready');
   // A reset() (interrupt) aborts the request; that is not an error to report.
   if (err.name !== 'AbortError' && generation === this._generation) this.onError?.(err.message || 'The model failed to answer.');
   return null;
  }
  history.push({ role: 'assistant', content: reply });
  this.onStatus?.('ready');
  const { text, play } = parsePlayCommand(reply);
  this.onResponse?.(text, play);
  return { text, playCmd: play };
 }
}
