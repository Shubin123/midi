// The AI teacher's line to the model: calls OpenRouter's chat-completions endpoint (OpenAI-compatible, so
// GPT, Claude, Gemini and the free models all go through one request shape) straight from the browser. The
// sign-in token comes from the cookie set by ai-auth.js, never from a pasted key. A short rolling history
// keeps the session going, and note suggestions are pulled out of the replies.
import { getToken, getModel } from './ai-auth.js';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const FALLBACK_MODEL = 'google/gemma-4-31b-it:free'; // used only until the panel sets a chosen model
const MAX_HISTORY = 30; // messages, dropped oldest-first in user/assistant pairs

export const SYSTEM_PROMPT = `You are a music theory teacher built into a live piano app.
Messages that start with [PLAYED] are automatic summaries of the phrase the student just played: note count and length, the MIDI notes in order, the pitch classes mod 12 (C=0, C#=1, D=2 ... B=11), the best local scale or mode match, and any chords. The local match is a guess from the pitch set alone; correct it when the note order points to a different tonic. Any other message is a question the student typed.
For a [PLAYED] summary, say what scale, mode, chord or progression they played, explain the theory in one to three sentences, and suggest one thing to try next.
Keep every reply short: this is a live session, not a lecture. Write plain text without Markdown.
To have the app play notes for the student, end the reply with one line of JSON, not in a code block: {"play": [60, 64, 67], "bpm": 120}
The notes are MIDI numbers (60 is middle C) played one after another at that tempo.`;

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

export class AiTeacher {
 constructor() {
  this.conversationHistory = [];
  this.onResponse = null; this.onError = null; this.onStatus = null;
  this._abortController = null; this._queue = Promise.resolve(); this._generation = 0;
 }
 get isConfigured() { return !!getToken(); }
 get model() { return getModel() || FALLBACK_MODEL; }

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
  const token = getToken();
  if (!token) { this.onError?.('Sign in to turn on the teacher.'); return null; }
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
     'Authorization': `Bearer ${token}`,
     'X-Title': 'Ultimate Synthesia Online',
    },
    body: JSON.stringify({
     model: this.model,
     max_tokens: 1024,
     messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
    }),
    signal: controller.signal,
   });
   const data = await res.json().catch(() => null);
   if (!res.ok || !data) throw new Error(this._httpError(res.status, data));
   if (data.error) throw new Error(data.error.message || 'The model returned an error.');
   const choice = data.choices?.[0];
   if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) {
    throw new Error('The model declined to answer that one. Try rephrasing it.');
   }
   reply = (choice?.message?.content || '').trim();
   if (!reply) throw new Error('The model sent an empty reply. Try again, or pick another model in Settings.');
  } catch (err) {
   history.pop();
   this.onStatus?.('ready');
   if (err.name !== 'AbortError') this.onError?.(err.message);
   return null;
  } finally {
   if (this._abortController === controller) this._abortController = null;
  }
  history.push({ role: 'assistant', content: reply });
  this.onStatus?.('ready');
  if (generation !== this._generation) return null;
  const { text, play } = parsePlayCommand(reply);
  this.onResponse?.(text, play);
  return { text, playCmd: play };
 }

 _httpError(status, data) {
  const detail = data?.error?.message || data?.message;
  if (status === 401) return 'Your sign-in expired. Sign in again.';
  if (status === 402) return 'This model needs OpenRouter credit. Pick a free model in Settings, or add credit.';
  if (status === 429) return 'Rate limited. The free models have a daily cap; wait a bit or pick another model.';
  return `Request failed (${status})${detail ? ': ' + detail : ''}.`;
 }
}
