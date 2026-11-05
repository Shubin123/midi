// AI music theory teacher: a side panel that follows the notes you play. Note names and the held chord show
// instantly, scale/mode and chords once a phrase ends (all local), and then the model explains the phrase.
// Suggested notes play through the synth and light up the keyboard. Sign in once with OpenRouter (no API key
// to paste; a free account gets the free models, credit unlocks GPT/Claude/Gemini). The panel only needs the
// synth's `synth:note` events and `window.synth`, so loading this module is the whole integration.
import { PhraseTracker, NOTE_NAMES, detectChord, pitchClassName } from './pitch-analyzer.js';
import { AiTeacher, FALLBACK_MODEL } from './ai-teacher.js';
import { signIn, completeSignIn, getToken, setToken, clearToken, getModel, setModel } from './ai-auth.js';
import { read, save } from './storage.js';

// Notes the player struck; the sequencer, looper and the teacher's own playback are not analysed.
const PLAYED = /^(midi|computer|mouse|touch)/;
const toNote = midi => NOTE_NAMES[midi % 12] + Math.floor(midi / 12); // the synth calls MIDI 60 "C5"
const MAX_MESSAGES = 200;
const MODELS_URL = 'https://openrouter.ai/api/v1/models';

const STYLE = `
:root{--teacher-width:min(340px,100vw)}
#teacher-panel{position:fixed;right:0;top:0;bottom:0;width:var(--teacher-width);box-sizing:border-box;display:flex;flex-direction:column;z-index:10000;background:var(--primary-surface-color);color:var(--text-color);border-left:1px solid var(--border-color);box-shadow:-8px 0 30px #0005;font-size:14px;transition:transform .2s,visibility .2s}
#teacher-panel.collapsed{transform:translateX(100%);visibility:hidden}
#teacher-panel .teacher-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-bottom:1px solid var(--border-color)}
#teacher-panel h2{margin:0;font-size:15px;color:var(--accent-color)}
#teacher-panel .teacher-status{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--border-color);color:var(--text-muted-color)}
#teacher-panel .teacher-status.thinking{color:var(--accent-color);border-color:var(--accent-color)}
#teacher-panel .teacher-status.off{opacity:.6}
#teacher-panel .teacher-toolbar{display:flex;gap:6px;padding:8px 14px;border-bottom:1px solid var(--border-color)}
#teacher-panel button{font:inherit;font-size:12px;border:1px solid var(--border-color);border-radius:6px;background:var(--secondary-surface-color);color:var(--text-color);padding:6px 10px;cursor:pointer}
#teacher-panel button[aria-pressed=true],#teacher-panel .teacher-primary{background:var(--accent-color);color:var(--bg-color);border-color:var(--accent-color)}
#teacher-panel button:disabled{opacity:.5;cursor:default}
#teacher-panel .teacher-settings{display:flex;flex-direction:column;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border-color)}
#teacher-panel .teacher-settings[hidden]{display:none}
#teacher-panel .teacher-row{display:flex;gap:6px;align-items:center}
#teacher-panel .teacher-settings p{margin:0;font-size:11px;line-height:1.5;color:var(--text-muted-color)}
#teacher-panel label{font-size:12px;color:var(--text-muted-color)}
#teacher-panel input,#teacher-panel select{font:inherit;font-size:13px;background:var(--bg-color);border:1px solid var(--border-color);color:var(--text-color);padding:8px;border-radius:6px;width:100%;box-sizing:border-box;min-width:0}
#teacher-panel .signin-btn{width:100%;padding:11px;font-size:13px}
#teacher-panel details summary{font-size:11px;color:var(--text-muted-color);cursor:pointer}
#teacher-panel details .teacher-row{margin-top:8px}
#teacher-panel .teacher-live{padding:8px 14px;font:12px/1.5 monospace;min-height:18px;background:var(--secondary-surface-color);border-bottom:1px solid var(--border-color);overflow-wrap:anywhere}
#teacher-panel .teacher-messages{flex:1;overflow-y:auto;padding:10px 14px}
#teacher-panel .teacher-msg{margin-bottom:10px;padding:8px 10px;border-radius:8px;line-height:1.45;overflow-wrap:anywhere;white-space:pre-line;border-left:3px solid var(--border-color);background:color-mix(in srgb,var(--bg-color) 50%,transparent)}
#teacher-panel .teacher-msg.local{font:12px/1.5 monospace;color:var(--text-muted-color)}
#teacher-panel .teacher-msg.teacher{border-left-color:var(--accent-color)}
#teacher-panel .teacher-msg.user{border-left-color:var(--text-muted-color);text-align:right}
#teacher-panel .teacher-msg.error{border-left-color:#ff6b6b;color:#ff6b6b;font-size:12px}
#teacher-panel .teacher-msg button{display:block;margin-top:6px}
#teacher-panel .teacher-ask{display:flex;gap:6px;padding:10px;border-top:1px solid var(--border-color)}
#teacher-panel .teacher-ask input:disabled{opacity:.6}
.teacher-toggle{position:fixed;top:50%;right:min(var(--teacher-width),calc(100vw - 26px));transform:translateY(-50%);z-index:10001;width:26px;height:56px;padding:0;border:1px solid var(--border-color);border-right:0;border-radius:8px 0 0 8px;background:var(--primary-surface-color);color:var(--text-color);cursor:pointer;transition:right .2s}
html:not(.teacher-open) .teacher-toggle{right:0}
#keyboard .teacher-hint{box-shadow:inset 0 -14px 0 var(--accent-color)}
@media(min-width:900px){
 html.teacher-open body{margin-right:var(--teacher-width)}
 html.teacher-open .widget-menu{right:calc(24px + var(--teacher-width))}
 html.teacher-open .site-credits{right:calc(15px + var(--teacher-width))!important}
}`;

export class TeacherBridge {
 constructor() {
  this.teacher = new AiTeacher();
  this.tracker = new PhraseTracker(a => this._onPhrase(a), { gapMs: 800 });
  this.panel = null;
  this.autoAnalyze = read('teacher-auto-v1', true);
  this._phraseQueue = []; this._processing = false;
  this._timers = []; this._sounding = new Set();
  this._modelsLoaded = false;
 }

 hook() {
  this._createPanel(); this._listen(); this._setupCallbacks();
  this._renderAuth();
  // Finish an OpenRouter sign-in if the page just came back from it; otherwise prompt to sign in.
  completeSignIn().then(signedIn => {
   if (signedIn) {
    this._setOpen(true);
    this._renderAuth();
    this._msg('teacher', 'Signed in. Play something, or ask a question.');
   } else if (!this.teacher.isConfigured) {
    this._toggleSettings(true);
   }
  }).catch(err => { this._msg('error', err.message); this._toggleSettings(true); });
 }

 _listen() {
  window.addEventListener('synth:note', ({ detail: { midi, velocity, on, source = '' } }) => {
   const now = performance.now();
   // Every release counts, whatever its source: the tracker ignores notes it isn't holding.
   if (!on) { this.tracker.noteOff(midi, now); return; }
   if (!PLAYED.test(source)) return;
   const vel = Math.round(velocity * 127);
   this.tracker.noteOn(midi, vel, now); this._showLive(midi, vel);
  });
  window.addEventListener('synth:panic', () => { this._stopPlayback(); this.tracker.reset(); });
 }

 _onPhrase(a) {
  this._showLocal(a);
  if (this.autoAnalyze && this.teacher.isConfigured && a.noteCount >= 3) {
   this._phraseQueue.push(a); this._processQueue();
  }
 }

 // While the model answers one phrase, only the most recent of the phrases played meanwhile is sent next.
 async _processQueue() {
  if (this._processing || !this._phraseQueue.length) return;
  this._processing = true;
  const a = this._phraseQueue[this._phraseQueue.length - 1];
  this._phraseQueue = [];
  await this.teacher.analyzePhrase(a);
  this._processing = false;
  if (this._phraseQueue.length) this._processQueue();
 }

 _setupCallbacks() {
  this.teacher.onResponse = (text, play) => {
   this._msg('teacher', text, play);
   if (play) this._playNotes(play.play, play.bpm);
  };
  this.teacher.onError = m => this._msg('error', m);
  this.teacher.onStatus = s => {
   const el = this.panel?.querySelector('.teacher-status');
   if (el) { el.textContent = s === 'thinking' ? 'Thinking…' : 'Ready'; el.className = `teacher-status ${s}`; }
  };
 }

 // Plays a suggestion through the synth (and any plug-in instrument following it), one note per beat.
 _playNotes(notes, bpm) {
  const synth = window.synth;
  if (!synth) return;
  this._stopPlayback(); synth.ensureAudio();
  const beat = 60000 / bpm;
  const key = n => document.querySelector(`#keyboard [data-midi="${n}"]`);
  notes.forEach((n, i) => {
   this._later(i * beat, () => { synth.noteOn(toNote(n)); this._sounding.add(n); key(n)?.classList.add('teacher-hint'); });
   this._later(i * beat + beat * 0.8, () => { synth.noteOff(toNote(n)); this._sounding.delete(n); key(n)?.classList.remove('teacher-hint'); });
  });
 }
 _later(ms, fn) { this._timers.push(setTimeout(fn, ms)); }
 _stopPlayback() {
  this._timers.forEach(clearTimeout); this._timers = [];
  this._sounding.forEach(n => window.synth?.noteOff(toNote(n))); this._sounding.clear();
  document.querySelectorAll('#keyboard .teacher-hint').forEach(k => k.classList.remove('teacher-hint'));
 }

 /* ---- UI ---- */

 _createPanel() {
  document.head.append(Object.assign(document.createElement('style'), { textContent: STYLE }));
  const p = document.createElement('aside'); p.id = 'teacher-panel';
  p.setAttribute('aria-label', 'AI music theory teacher');
  p.innerHTML = `
   <div class="teacher-head"><h2>AI Teacher</h2><span class="teacher-status ready">Ready</span></div>
   <div class="teacher-toolbar"><button class="auto-btn" title="Explain each phrase automatically">Auto</button><button class="settings-btn" aria-expanded="false">Settings</button><button class="clear-btn">Clear</button></div>
   <div class="teacher-settings" hidden>
    <div class="teacher-connect">
     <button type="button" class="signin-btn teacher-primary">Sign in with OpenRouter</button>
     <p>No API key needed. A free OpenRouter account can use the free models; add credit there to use GPT, Claude or Gemini. Your sign-in is kept in a cookie in this browser only.</p>
     <details>
      <summary>Have an OpenRouter key? Paste it instead.</summary>
      <form class="key-form"><div class="teacher-row"><input type="password" class="key-input" placeholder="sk-or-…" autocomplete="off" spellcheck="false"/><button type="submit" class="teacher-primary">Save</button></div></form>
     </details>
    </div>
    <div class="teacher-account" hidden>
     <label for="teacher-model">Model</label>
     <select id="teacher-model" class="model-select"><option value="${FALLBACK_MODEL}">Loading models…</option></select>
     <div class="teacher-row"><button type="button" class="signout-btn">Sign out</button></div>
     <p class="account-note">Signed in with OpenRouter. Free models have a daily cap; switch model if you hit it.</p>
    </div>
   </div>
   <div class="teacher-live" aria-live="off">Play something…</div>
   <div class="teacher-messages" role="log" aria-live="polite"></div>
   <form class="teacher-ask"><input type="text" class="question-input" placeholder="Ask about theory…" aria-label="Ask the teacher"/><button type="submit" class="teacher-primary">Ask</button></form>`;
  document.body.append(p); this.panel = p;

  const toggle = document.createElement('button'); toggle.className = 'teacher-toggle';
  this._toggle = toggle;
  toggle.onclick = () => { this._setOpen(p.classList.contains('collapsed')); };
  document.body.append(toggle);
  this._setOpen(read('teacher-open-v1', innerWidth >= 900), false);

  const auto = p.querySelector('.auto-btn');
  auto.setAttribute('aria-pressed', this.autoAnalyze);
  auto.onclick = () => { this.autoAnalyze = !this.autoAnalyze; auto.setAttribute('aria-pressed', this.autoAnalyze); save('teacher-auto-v1', this.autoAnalyze); };
  p.querySelector('.settings-btn').onclick = () => this._toggleSettings();
  p.querySelector('.clear-btn').onclick = () => {
   p.querySelector('.teacher-messages').replaceChildren();
   this.teacher.reset(); this.tracker.reset(); this._phraseQueue = []; this._stopPlayback();
  };
  p.querySelector('.teacher-ask').onsubmit = e => { e.preventDefault(); this._ask(); };
  p.querySelector('.signin-btn').onclick = () => signIn().catch(err => this._msg('error', err.message));
  p.querySelector('.signout-btn').onclick = () => {
   clearToken(); this.teacher.reset(); this._phraseQueue = []; this._stopPlayback();
   this._renderAuth(); this._toggleSettings(true);
   this._msg('teacher', 'Signed out.');
  };
  const keyInput = p.querySelector('.key-input');
  p.querySelector('.key-form').onsubmit = e => {
   e.preventDefault();
   const k = keyInput.value.trim();
   if (!k) return;
   setToken(k); keyInput.value = '';
   this._renderAuth(); this._toggleSettings(false);
   this._msg('teacher', 'Key saved. Play something, or ask a question.');
  };
  p.querySelector('.model-select').onchange = e => {
   setModel(e.target.value); this.teacher.reset();
  };
 }

 _setOpen(open, persist = true) {
  const p = this.panel, toggle = this._toggle;
  p.classList.toggle('collapsed', !open);
  document.documentElement.classList.toggle('teacher-open', open);
  toggle.textContent = open ? '▶' : '◀';
  toggle.title = open ? 'Hide the AI teacher' : 'Show the AI teacher';
  toggle.setAttribute('aria-label', toggle.title); toggle.setAttribute('aria-expanded', open);
  if (persist) save('teacher-open-v1', open);
  window.dispatchEvent(new Event('resize'));
 }

 // Shows the connect block or the account block depending on whether we hold a sign-in, and reflects it in
 // the status chip and the ask box. Loads the model list the first time we are signed in.
 _renderAuth() {
  const p = this.panel, signedIn = this.teacher.isConfigured;
  p.querySelector('.teacher-connect').hidden = signedIn;
  p.querySelector('.teacher-account').hidden = !signedIn;
  p.querySelector('.question-input').disabled = !signedIn;
  p.querySelector('.teacher-ask button').disabled = !signedIn;
  const status = p.querySelector('.teacher-status');
  if (!signedIn) { status.textContent = 'Signed out'; status.className = 'teacher-status off'; }
  else { status.textContent = 'Ready'; status.className = 'teacher-status ready'; this._loadModels(); }
 }

 async _loadModels() {
  if (this._modelsLoaded) return;
  this._modelsLoaded = true;
  const select = this.panel.querySelector('.model-select');
  try {
   const data = await (await fetch(MODELS_URL)).json();
   const models = (data.data || []).filter(m => m.id);
   const free = models.filter(m => parseFloat(m.pricing?.prompt) === 0)
    .sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
   const premium = models.filter(m => /^(openai|anthropic|google)\//.test(m.id) && parseFloat(m.pricing?.prompt) > 0)
    .filter(m => /(gpt|o[0-9]|claude|gemini)/.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 40);
   if (!free.length && !premium.length) throw new Error('no models');
   const label = m => (m.name || m.id).replace(/\s*\(free\)\s*$/i, '');
   const group = (title, list) => {
    if (!list.length) return '';
    return `<optgroup label="${title}">` + list.map(m => `<option value="${m.id}">${label(m)}</option>`).join('') + '</optgroup>';
   };
   const chosen = getModel();
   select.innerHTML = group('Free', free) + group('Premium · needs credit', premium);
   if (chosen && select.querySelector(`option[value="${CSS.escape(chosen)}"]`)) select.value = chosen;
   else { const fallback = free[0]?.id || premium[0]?.id; if (fallback) { select.value = fallback; setModel(fallback); } }
  } catch {
   // Keep the panel usable even if the model list won't load; the stored or fallback model still works.
   const chosen = getModel() || FALLBACK_MODEL;
   select.innerHTML = `<option value="${chosen}">${chosen}</option>`;
   select.value = chosen;
  }
 }

 // Focus only on request: a focused text field would swallow the computer-keyboard notes.
 _toggleSettings(show, focus = false) {
  const f = this.panel.querySelector('.teacher-settings');
  f.hidden = !(show ?? f.hidden);
  this.panel.querySelector('.settings-btn').setAttribute('aria-expanded', !f.hidden);
  if (!f.hidden && focus) {
   const field = f.querySelector('.teacher-account:not([hidden]) select, .teacher-connect:not([hidden]) .signin-btn');
   field?.focus({ preventScroll: true });
  }
 }

 _showLive(note, vel) {
  const b = this.panel?.querySelector('.teacher-live');
  if (!b) return;
  let text = `Note: ${pitchClassName(note)} (MIDI ${note}, vel ${vel}, pc ${note % 12})`;
  const held = [...this.tracker.heldNotes];
  if (held.length >= 3) {
   const chord = detectChord(held, Math.min(...held))[0];
   if (chord) text += ` · Chord: ${chord.chordName}`;
  }
  b.textContent = text;
 }

 _showLocal(a) {
  const parts = [];
  if (a.scales.length) { const s = a.scales[0]; parts.push(`${s.tonicName} ${s.scaleName} (${(s.score * 100).toFixed(0)}%)`); }
  if (a.chords.length) parts.push(`Chords: ${a.chords.map(c => c.best.chordName).join(' → ')}`);
  parts.push(`${a.noteCount} notes, pcs: [${a.pitchClasses.join(',')}]`);
  this._msg('local', parts.join('\n'));
 }

 _msg(type, text, play = null) {
  const c = this.panel?.querySelector('.teacher-messages');
  if (!c) return;
  const d = document.createElement('div'); d.className = `teacher-msg ${type}`; d.textContent = text;
  if (play) {
   const again = document.createElement('button'); again.textContent = `▶ Play ${play.play.length} notes`;
   again.onclick = () => this._playNotes(play.play, play.bpm);
   d.append(again);
  }
  c.append(d);
  while (c.childElementCount > MAX_MESSAGES) c.firstElementChild.remove();
  c.scrollTop = c.scrollHeight;
 }

 _ask() {
  const i = this.panel?.querySelector('.question-input');
  const q = i?.value.trim();
  if (!q) return;
  if (!this.teacher.isConfigured) { this._toggleSettings(true); this._msg('error', 'Sign in to ask the teacher.'); return; }
  i.value = '';
  this._msg('user', q); this.teacher.ask(q);
 }
}

let _bridge = null;
export function initTeacher() { if (_bridge) return _bridge; _bridge = new TeacherBridge(); _bridge.hook(); return _bridge; }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTeacher);
else initTeacher();
