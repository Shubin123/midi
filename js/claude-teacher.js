// The AI teacher's line to Claude: calls the Anthropic Messages API straight from the browser (no server),
// keeps a short rolling conversation, and pulls note suggestions out of the replies. The API key is kept in
// a cookie scoped to this app's path and is only ever sent to api.anthropic.com by this code.
const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5-5';
const COOKIE = 'anthropic_api_key';
const MAX_HISTORY = 30; // messages, dropped oldest-first in user/assistant pairs

export const SYSTEM_PROMPT = `You are a music theory teacher built into a live piano app.
Messages that start with [PLAYED] are automatic summaries of the phrase the student just played: note count and length, the MIDI notes in order, the pitch classes mod 12 (C=0, C#=1, D=2 ... B=11), the best local scale or mode match, and any chords. The local match is a guess from the pitch set alone; correct it when the note order points to a different tonic. Any other message is a question the student typed.
For a [PLAYED] summary, say what scale, mode, chord or progression they played, explain the theory in one to three sentences, and suggest one thing to try next.
Keep every reply short: this is a live session, not a lecture. Write plain text without Markdown.
To have the app play notes for the student, end the reply with one line of JSON, not in a code block: {"play": [60, 64, 67], "bpm": 120}
The notes are MIDI numbers (60 is middle C) played one after another at that tempo.`;

const cookiePath = () => location.pathname.replace(/[^/]*$/, '') || '/';
function getCookie(name) {
 const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
 return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(name, val, days = 365) {
 const secure = location.protocol === 'https:' ? ';Secure' : ''; // http://localhost would drop a Secure cookie in Safari
 document.cookie = `${name}=${encodeURIComponent(val)};max-age=${days * 86400};path=${cookiePath()};SameSite=Strict${secure}`;
}
function deleteCookie(name) {
 document.cookie = `${name}=;max-age=0;path=${cookiePath()};SameSite=Strict`;
}

// Splits a reply into its text and an optional {"play": [...], "bpm": n} suggestion (code fences tolerated).
// Notes outside 0-127 are dropped, at most 32 play, and the tempo is held to 30-300 BPM like the synth's.
export function parsePlayCommand(reply) {
 const m = reply.match(/(?:```(?:json)?\s*)?(\{\s*"play"\s*:\s*\[[^\]]*\][^{}]*\})(?:\s*```)?/);
 let cmd = null;
 if (m) try { cmd = JSON.parse(m[1]); } catch { /* Not valid JSON: show the reply as written. */ }
 if (!cmd) return { text: reply.trim(), play: null };
 const notes = (Array.isArray(cmd.play) ? cmd.play : []).filter(n => Number.isInteger(n) && n >= 0 && n <= 127).slice(0, 32);
 const bpm = Number.isFinite(cmd.bpm) && cmd.bpm > 0 ? Math.max(30, Math.min(300, cmd.bpm)) : 120;
 const text = (reply.slice(0, m.index) + reply.slice(m.index + m[0].length)).trim();
 return { text, play: notes.length ? { play: notes, bpm } : null };
}

export class ClaudeTeacher {
 constructor() {
  this.apiKey = getCookie(COOKIE);
  this.conversationHistory = [];
  this.onResponse = null; this.onError = null; this.onStatus = null;
  this._abortController = null; this._queue = Promise.resolve(); this._generation = 0;
 }
 get isConfigured() { return !!this.apiKey; }
 setApiKey(key) { this.apiKey = key; setCookie(COOKIE, key); }
 clearApiKey() { this.apiKey = null; deleteCookie(COOKIE); }

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
 cancel() { this._abortController?.abort(); this._abortController = null; }
 reset() { this._generation++; this.conversationHistory = []; this.cancel(); }

 // One request at a time, so the history always alternates user and assistant turns.
 // Requests queued before a reset() are skipped.
 _send(msg) {
  const generation = this._generation;
  return this._queue = this._queue.then(() => generation === this._generation ? this._request(msg) : null);
 }

 async _request(msg) {
  if (!this.apiKey) { this.onError?.('No API key. Open Settings.'); return null; }
  this.onStatus?.('thinking');
  const controller = this._abortController = new AbortController();
  const history = this.conversationHistory, generation = this._generation;
  while (history.length >= MAX_HISTORY) history.splice(0, 2); // still opens with a user turn
  history.push({ role: 'user', content: msg });
  let reply;
  try {
   const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
     'Content-Type': 'application/json',
     'x-api-key': this.apiKey,
     'anthropic-version': '2026-10-21',
     'anthropic-beta': 'server-side-fallback-2026-07-01',
     'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
     model: MODEL, max_tokens: 4096,
     // Low effort keeps a live session responsive: the model skips thinking on most simple requests.
     output_config: { effort: 'low' },
     // If a safety classifier declines, the API reruns the request on another model instead.
     fallbacks: 'default',
     system: SYSTEM_PROMPT, messages: history,
    }),
    signal: controller.signal,
   });
   const data = await res.json().catch(() => null);
   if (!res.ok || !data) throw new Error(`API ${res.status}: ${data?.error?.message || res.statusText || 'unreadable response'}`);
   if (data.stop_reason === 'refusal') throw new Error('Claude declined to answer that one. Try rephrasing it.');
   // Read blocks by type: a reply can open with a (possibly empty) thinking block.
   reply = data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
   if (!reply) throw new Error(`Claude sent an empty reply (stop reason: ${data.stop_reason}).`);
  } catch (err) {
   history.pop();
   this.onStatus?.('ready');
   if (err.name !== 'AbortError') this.onError?.(err.message);
   return null;
  } finally {
   if (this._abortController === controller) this._abortController = null;
  }
  // Only the text goes back into the history. Trimming the window rewrites earlier turns, and the API
  // rejects replayed thinking blocks after such an edit; the teacher doesn't need its old reasoning.
  history.push({ role: 'assistant', content: reply });
  this.onStatus?.('ready');
  if (generation !== this._generation) return null;
  const { text, play } = parsePlayCommand(reply);
  this.onResponse?.(text, play);
  return { text, playCmd: play };
 }
}
