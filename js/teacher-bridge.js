// AI music theory teacher: a side panel that follows the notes you play. Note names and the held chord show
// instantly, scale/mode and chords once a phrase ends (all local), and then a model explains the phrase.
// The panel has two tabs: Lesson (the conversation) and Provider (where answers come from). Each provider is
// a separate, direct connection: on-device (no sign-in), OpenRouter (sign-in), or a provider's own API key
// (Groq, Cerebras, Gemini, Mistral, OpenAI, or a custom endpoint). On-device runs two models that work as
// System 1 and System 2: Laya, a fast decision model, picks the next coaching step the moment a phrase ends
// (js/laya.js, js/coach.js), and Qwen thinks through explanations and questions. Fast mode stops at Laya's
// step; Slow mode also has the System 2 model think each phrase through. Suggested notes and chords play
// through the synth and light up the keyboard. The Talk button turns on voice: speak a question and hear the
// teacher answer (js/voice.js). The panel only needs the synth's `synth:note`
// events and `window.synth`, so loading this module is the whole integration.
import { PhraseTracker, NOTE_NAMES, detectChord, pitchClassName } from './pitch-analyzer.js';
import { AiTeacher } from './ai-teacher.js';
import { el } from './plugin-ui.js';
import { LocalEngine, MODELS as LOCAL_MODELS, DEFAULT_MODEL as LOCAL_DEFAULT, webgpuAvailable } from './local-model.js';
import { LayaCoach, LAYA_MB } from './laya.js';
import { buildMove, describePlayed } from './coach.js';
import { Voice, canListen, canSpeak } from './voice.js';
import { PROVIDERS, GROUPS, providerById, getProviderId, setProviderId, getKey, setKey, clearKey, getModelFor, setModelFor, getBase, setBase, engineFor, listModels, pickModel, fetchOpenRouterModels } from './providers.js';
import { signIn, completeSignIn } from './ai-auth.js';
import { read, save } from './storage.js';

// Notes the player struck; the sequencer, looper and the teacher's own playback are not analysed.
const PLAYED = /^(midi|computer|mouse|touch)/;
const toNote = midi => NOTE_NAMES[midi % 12] + Math.floor(midi / 12); // the synth calls MIDI 60 "C5"
const MAX_MESSAGES = 200;
const host = url => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

const STYLE = `
:root{--teacher-width:min(360px,100vw)}
#teacher-panel{position:fixed;right:0;top:0;bottom:0;width:var(--teacher-width);box-sizing:border-box;display:flex;flex-direction:column;z-index:10000;background:var(--primary-surface-color);color:var(--text-color);border-left:1px solid var(--border-color);box-shadow:-8px 0 30px #0005;font-size:13px;line-height:1.45;transition:transform .2s,visibility .2s}
#teacher-panel.collapsed{transform:translateX(100%);visibility:hidden}
#teacher-panel *{box-sizing:border-box}
#teacher-panel button{font:inherit;font-size:12px;border:1px solid var(--border-color);border-radius:6px;background:var(--secondary-surface-color);color:var(--text-color);padding:6px 10px;cursor:pointer}
#teacher-panel button:disabled{opacity:.5;cursor:default}
#teacher-panel .tp-primary{background:var(--accent-color);color:var(--bg-color);border-color:var(--accent-color);font-weight:600}
#teacher-panel .tp-link{background:none;border:0;padding:0;color:var(--accent-color);text-decoration:underline;font-size:11px}
#teacher-panel select,#teacher-panel input[type=text],#teacher-panel input[type=password]{font:inherit;font-size:13px;background:var(--bg-color);border:1px solid var(--border-color);color:var(--text-color);padding:7px 8px;border-radius:6px;width:100%;min-width:0;margin:0}
#teacher-panel a{color:var(--accent-color)}
#teacher-panel label{margin:0;font-size:inherit;transition:none}
#teacher-panel label input[type=checkbox],#teacher-panel label input[type=radio]{transform:none;margin-right:0}

#teacher-panel .tp-head{padding:12px 14px 10px;border-bottom:1px solid var(--border-color);display:flex;flex-direction:column;gap:6px}
#teacher-panel .tp-title-row{display:flex;justify-content:space-between;align-items:center}
#teacher-panel h2{margin:0;font-size:15px;color:var(--accent-color)}
#teacher-panel .tp-status{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--border-color);color:var(--text-muted-color);white-space:nowrap}
#teacher-panel .tp-status.ready{color:#6bcb77;border-color:#6bcb77}
#teacher-panel .tp-status.thinking,#teacher-panel .tp-status.loading{color:var(--accent-color);border-color:var(--accent-color)}
#teacher-panel .tp-summary{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;text-align:left;background:color-mix(in srgb,var(--bg-color) 45%,transparent)}
#teacher-panel .tp-summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#teacher-panel .tp-summary b{font-weight:600}
#teacher-panel .tp-summary .tp-change{color:var(--accent-color);flex:none;font-size:11px}

#teacher-panel .tp-tabs{display:flex;border-bottom:1px solid var(--border-color)}
#teacher-panel .tp-tabs button{flex:1;border:0;border-radius:0;background:none;padding:9px;color:var(--text-muted-color);border-bottom:2px solid transparent;font-weight:600}
#teacher-panel .tp-tabs button[aria-selected=true]{color:var(--text-color);border-bottom-color:var(--accent-color)}
#teacher-panel .tp-view{flex:1;min-height:0;display:flex;flex-direction:column}
#teacher-panel .tp-view[hidden]{display:none}

#teacher-panel .tp-live{display:flex;align-items:baseline;gap:8px;padding:8px 14px;background:var(--secondary-surface-color);border-bottom:1px solid var(--border-color);min-height:38px}
#teacher-panel .tp-live-note{font-size:18px;font-weight:700;min-width:26px}
#teacher-panel .tp-live-detail{font:11px monospace;color:var(--text-muted-color);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#teacher-panel .tp-chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--accent-color);color:var(--bg-color)}
#teacher-panel .tp-chip[hidden]{display:none}
#teacher-panel .tp-messages{flex:1;overflow-y:auto;padding:12px 14px}
#teacher-panel .tp-empty{color:var(--text-muted-color);font-size:12px;padding:14px;border:1px dashed var(--border-color);border-radius:8px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
#teacher-panel .teacher-msg{margin-bottom:10px;padding:8px 10px;border-radius:8px;overflow-wrap:anywhere;white-space:pre-line;border-left:3px solid var(--border-color);background:color-mix(in srgb,var(--bg-color) 50%,transparent)}
#teacher-panel .teacher-msg.local{font-size:12px;color:var(--text-muted-color);white-space:normal}
#teacher-panel .teacher-msg.local strong{color:var(--text-color);display:block}
#teacher-panel .teacher-msg.local .tp-dim{font:11px monospace;display:block;margin-top:2px}
#teacher-panel .teacher-msg.teacher{border-left-color:var(--accent-color)}
#teacher-panel .teacher-msg.user{border-left-color:var(--text-muted-color);text-align:right}
#teacher-panel .teacher-msg.info{font-size:12px;color:var(--text-muted-color);border-left-color:#6bcb77}
#teacher-panel .teacher-msg.error{border-left-color:#ff6b6b;color:#ff6b6b;font-size:12px}
#teacher-panel .teacher-msg button{display:block;margin-top:6px}
#teacher-panel .tp-foot{border-top:1px solid var(--border-color);padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px}
#teacher-panel .tp-foot-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--text-muted-color)}
#teacher-panel .tp-foot-row label{display:flex;align-items:center;gap:6px;cursor:pointer}
#teacher-panel .tp-foot-row input{accent-color:var(--accent-color);margin:0}
#teacher-panel .tp-ask{display:flex;gap:6px}
#teacher-panel .tp-talk{flex:none}
#teacher-panel .tp-talk[aria-pressed=true]{background:#e76f51;border-color:#e76f51;color:#fff;font-weight:600}
#teacher-panel .tp-talk.listening{animation:tp-pulse 1.4s ease-in-out infinite}
@keyframes tp-pulse{0%,100%{box-shadow:0 0 0 0 #e76f5199}50%{box-shadow:0 0 0 5px #e76f5100}}
#teacher-panel .tp-talk-note{margin:0;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-talk-note[hidden]{display:none}
#teacher-panel .tp-mode{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-mode[hidden]{display:none}
#teacher-panel .tp-seg{display:inline-flex;border:1px solid var(--border-color);border-radius:6px;overflow:hidden;flex:none}
#teacher-panel .tp-seg button{border:0;border-radius:0;padding:5px 12px}
#teacher-panel .tp-seg button[aria-checked=true]{background:var(--accent-color);color:var(--bg-color);font-weight:600}
#teacher-panel .tp-who{display:block;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted-color);margin-bottom:3px}
#teacher-panel .teacher-msg.coach{border-left-color:#f4a261}
#teacher-panel .tp-msg-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
#teacher-panel .teacher-msg .tp-msg-actions button{display:inline-block;margin:0}

#teacher-panel .tp-provider-view{overflow-y:auto;padding:12px 14px 16px}
#teacher-panel .tp-intro{margin:0 0 4px;font-size:12px;color:var(--text-muted-color)}
#teacher-panel .tp-group-title{margin:14px 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted-color)}
#teacher-panel .tp-card{border:1px solid var(--border-color);border-radius:8px;margin-bottom:6px;background:color-mix(in srgb,var(--bg-color) 35%,transparent)}
#teacher-panel .tp-card.selected{border-color:var(--accent-color)}
#teacher-panel .tp-card-head{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;cursor:pointer}
#teacher-panel .tp-card-head input{margin:3px 0 0;accent-color:var(--accent-color)}
#teacher-panel .tp-card-text{display:flex;flex-direction:column;gap:2px;min-width:0}
#teacher-panel .tp-card-name{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-weight:600;color:var(--text-color)}
#teacher-panel .tp-card-meta{font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-badge{font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;border:1px solid var(--border-color);color:var(--text-muted-color)}
#teacher-panel .tp-badge.free{border-color:#6bcb77;color:#6bcb77}
#teacher-panel .tp-badge.on{background:#6bcb77;border-color:#6bcb77;color:#0b1a10}
#teacher-panel .tp-badge.saved{border-color:var(--accent-color);color:var(--accent-color)}
#teacher-panel .tp-card-body{padding:2px 10px 12px 34px;display:flex;flex-direction:column;gap:8px}
#teacher-panel .tp-card-body[hidden]{display:none}
#teacher-panel .tp-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
#teacher-panel .tp-row .tp-primary{flex:1}
#teacher-panel .tp-note{margin:0;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-card-status{margin:0;font-size:11px;min-height:0}
#teacher-panel .tp-card-status.ok{color:#6bcb77}
#teacher-panel .tp-card-status.bad{color:#ff6b6b}
#teacher-panel details summary{font-size:11px;color:var(--text-muted-color);cursor:pointer}
#teacher-panel details[open] summary{margin-bottom:6px}
#teacher-panel progress{width:100%;height:6px}

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
  this._active = null; // { id, model } of the connected provider
  this._loading = false;
  this._selected = getProviderId(); // the provider card open in the Provider tab
  this.mode = read('teacher-mode-v1', 'fast'); // 'fast': System 1 only on phrases; 'slow': System 2 thinks too
  this.laya = null; this._localEngine = null; this._coachHistory = [];
  this._lastNoteAt = 0; this._askedAt = 0; // a reply's example plays only if no new note came after asking
  this.voice = null; this.talking = false;
 }

 hook() {
  this._createPanel(); this._listen(); this._setupCallbacks();
  this._autoActivate();
  this._renderProviders(); this._renderState(); this._renderEmpty();
  // Finish an OpenRouter sign-in if we came back from one; that connects it straight away.
  completeSignIn().then(key => {
   if (!key) return;
   setKey('openrouter', key);
   this._setOpen(true);
   this._connect(providerById('openrouter'));
  }).catch(err => { this._msg('error', err.message); this._showTab('provider'); });
 }

 // Reconnects a hosted provider that was set up before (its key is in a cookie). The on-device model is
 // never loaded automatically, since that is a large download.
 _autoActivate() {
  const provider = providerById(getProviderId());
  if (!provider || provider.auth === 'local') return;
  const { engine } = engineFor(provider);
  if (engine) { this.teacher.setEngine(engine); this._active = { id: provider.id, model: getModelFor(provider.id) || provider.defaultModel }; }
 }

 _listen() {
  window.addEventListener('synth:note', ({ detail: { midi, velocity, on, source = '' } }) => {
   const now = performance.now();
   // Every release counts, whatever its source: the tracker ignores notes it isn't holding.
   if (!on) { this.tracker.noteOff(midi, now); return; }
   if (!PLAYED.test(source)) return;
   const vel = Math.round(velocity * 127);
   this._lastNoteAt = now;
   if (this.voice?.speaking) this.voice.cancelSpeech(); // the student's turn: stop talking
   this.tracker.noteOn(midi, vel, now); this._showLive(midi, vel);
  });
  window.addEventListener('synth:panic', () => { this._stopPlayback(); this.tracker.reset(); });
 }

 _onPhrase(a) {
  this._showLocal(a);
  if (!this.autoAnalyze || a.noteCount < 3) return;
  if (this.laya) { this._coachNext = a; this._coachLoop(); }
  else if (this.teacher.isConfigured) this._queue(a, {});
 }

 // Laya decides one phrase at a time (a model session can't run twice at once); if more phrases end while
 // it is busy, only the latest is coached next.
 async _coachLoop() {
  if (this._coaching) return;
  this._coaching = true;
  while (this._coachNext) { const a = this._coachNext; this._coachNext = null; await this._coach(a); }
  this._coaching = false;
 }

 // System 1: Laya picks the next step at once, and the coaching menu supplies its words and notes, so they
 // are always right. In Slow mode the System 2 model then thinks the phrase through, building on that step.
 async _coach(a) {
  this._setStatus('coaching');
  let d;
  try { d = await this.laya.decide(a, this._coachHistory); }
  catch (err) { this._setStatus(null); this._msg('error', `Laya couldn't decide: ${err.message}`); return; }
  this._coachHistory.push(d.move);
  const move = buildMove(d.move, a), slow = this.mode === 'slow' && this.teacher.isConfigured;
  this._setStatus(null);
  this._coachMsg(a, move, d, slow);
  const at = performance.now();
  this._say(`${describePlayed(a)} ${move.say}`).then(() => { if (this._lastNoteAt <= at) this._playSteps(move.example.steps, move.example.bpm); });
  if (slow) this._queue(a, { think: true, coach: `${describePlayed(a)} Next step: ${move.say}` });
 }

 // While the model answers one phrase, only the most recent of the phrases played meanwhile is sent next.
 _queue(a, opts) { this._phraseQueue.push({ a, opts }); this._processQueue(); }
 async _processQueue() {
  if (this._processing || !this._phraseQueue.length) return;
  this._processing = true;
  const { a, opts } = this._phraseQueue[this._phraseQueue.length - 1];
  this._phraseQueue = [];
  this._askedAt = performance.now();
  await this.teacher.analyzePhrase(a, opts);
  this._processing = false;
  if (this._phraseQueue.length) this._processQueue();
 }

 _setupCallbacks() {
  this.teacher.onResponse = (text, play, info = {}) => {
   this._msg('teacher', text, play, info);
   // Play the example (after reading the reply aloud in talk mode), unless the student has started playing
   // again since asking.
   const asked = this._askedAt;
   this._say(text).then(() => { if (play && this._lastNoteAt <= asked) this._playSteps(play.steps, play.bpm); });
  };
  this.teacher.onError = m => this._msg('error', m);
  this.teacher.onStatus = s => this._setStatus(s === 'ready' ? null : s);
 }

 // Plays a suggestion through the synth (and any plug-in instrument following it). Each step is one beat; a
 // step with several notes is struck together as a chord.
 _playSteps(steps, bpm) {
  const synth = window.synth;
  if (!synth) return;
  this._stopPlayback(); synth.ensureAudio();
  const beat = 60000 / bpm;
  const key = n => document.querySelector(`#keyboard [data-midi="${n}"]`);
  steps.forEach((chord, i) => {
   this._later(i * beat, () => chord.forEach(n => { synth.noteOn(toNote(n)); this._sounding.add(n); key(n)?.classList.add('teacher-hint'); }));
   this._later(i * beat + beat * 0.8, () => chord.forEach(n => { synth.noteOff(toNote(n)); this._sounding.delete(n); key(n)?.classList.remove('teacher-hint'); }));
  });
 }
 _later(ms, fn) { this._timers.push(setTimeout(fn, ms)); }
 _stopPlayback() {
  this._timers.forEach(clearTimeout); this._timers = [];
  this._sounding.forEach(n => window.synth?.noteOff(toNote(n))); this._sounding.clear();
  document.querySelectorAll('#keyboard .teacher-hint').forEach(k => k.classList.remove('teacher-hint'));
 }

 /* ---- Panel ---- */

 _createPanel() {
  document.head.append(Object.assign(document.createElement('style'), { textContent: STYLE }));
  const p = document.createElement('aside'); p.id = 'teacher-panel';
  p.setAttribute('aria-label', 'AI music theory teacher');
  p.innerHTML = `
   <header class="tp-head">
    <div class="tp-title-row"><h2>AI Teacher</h2><span class="tp-status">Not connected</span></div>
    <button type="button" class="tp-summary" title="Change provider"><span class="tp-summary-text"></span><span class="tp-change">Change</span></button>
   </header>
   <nav class="tp-tabs" role="tablist">
    <button type="button" role="tab" id="tp-tab-lesson" aria-controls="tp-view-lesson" data-tab="lesson">Lesson</button>
    <button type="button" role="tab" id="tp-tab-provider" aria-controls="tp-view-provider" data-tab="provider">Provider</button>
   </nav>
   <section class="tp-view" id="tp-view-lesson" role="tabpanel" aria-labelledby="tp-tab-lesson">
    <div class="tp-live" aria-live="off"><span class="tp-live-note">♪</span><span class="tp-live-detail">Play something…</span><span class="tp-chip" hidden></span></div>
    <div class="tp-messages" role="log" aria-live="polite"></div>
    <div class="tp-foot">
     <div class="tp-mode" hidden><span class="tp-seg" role="radiogroup" aria-label="Teaching speed"><button type="button" role="radio" data-mode="fast">Fast</button><button type="button" role="radio" data-mode="slow">Slow</button></span><span class="tp-mode-note"></span></div>
     <div class="tp-foot-row"><label><input type="checkbox" class="auto-check"/>Coach each phrase I play</label><button type="button" class="clear-btn">Clear</button></div>
     <form class="tp-ask"><input type="text" class="question-input" placeholder="Ask about theory…" aria-label="Ask the teacher"/><button type="button" class="tp-talk" aria-pressed="false" title="Talk mode: speak to the teacher and hear it answer">🎙 Talk</button><button type="submit" class="tp-primary tp-ask-btn">Ask</button></form>
     <p class="tp-talk-note" role="status" hidden></p>
    </div>
   </section>
   <section class="tp-view tp-provider-view" id="tp-view-provider" role="tabpanel" aria-labelledby="tp-tab-provider" hidden>
    <p class="tp-intro">Choose where the teacher's answers come from. Each option is a separate, direct connection with its own sign-in; one is active at a time.</p>
    <div class="tp-providers" role="radiogroup" aria-label="Provider"></div>
   </section>`;
  document.body.append(p); this.panel = p;

  const toggle = document.createElement('button'); toggle.className = 'teacher-toggle';
  this._toggle = toggle;
  toggle.onclick = () => this._setOpen(p.classList.contains('collapsed'));
  document.body.append(toggle);
  this._setOpen(read('teacher-open-v1', innerWidth >= 900), false);

  p.querySelectorAll('.tp-tabs button').forEach(b => { b.onclick = () => this._showTab(b.dataset.tab); });
  p.querySelector('.tp-summary').onclick = () => this._showTab('provider');
  const auto = p.querySelector('.auto-check');
  auto.checked = this.autoAnalyze;
  auto.onchange = () => { this.autoAnalyze = auto.checked; save('teacher-auto-v1', this.autoAnalyze); };
  p.querySelector('.clear-btn').onclick = () => {
   p.querySelector('.tp-messages').replaceChildren();
   this.teacher.reset(); this.tracker.reset(); this._phraseQueue = []; this._coachHistory = []; this._stopPlayback(); this.voice?.cancelSpeech();
   this._renderEmpty();
  };
  p.querySelectorAll('.tp-seg button').forEach(b => { b.onclick = () => { this.mode = b.dataset.mode; save('teacher-mode-v1', this.mode); this._renderMode(); }; });
  p.querySelector('.tp-ask').onsubmit = e => { e.preventDefault(); this._ask(); };
  p.querySelector('.tp-talk').onclick = () => this._toggleTalk();
  if (!canListen() && !canSpeak()) { const t = p.querySelector('.tp-talk'); t.disabled = true; t.title = 'This browser can\'t listen or speak.'; }
  this._showTab('lesson');
 }

 _showTab(tab) {
  this.panel.querySelectorAll('.tp-tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  this.panel.querySelector('#tp-view-lesson').hidden = tab !== 'lesson';
  this.panel.querySelector('#tp-view-provider').hidden = tab !== 'provider';
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

 // The status chip, the header summary and the ask box all follow the connection.
 _setStatus(transient) {
  const chip = this.panel.querySelector('.tp-status');
  const [cls, text] = transient === 'thinking' ? ['thinking', 'Answering…']
   : transient === 'reasoning' ? ['thinking', 'Thinking it through…']
   : transient === 'coaching' ? ['thinking', 'Coaching…']
   : transient === 'loading' ? ['loading', 'Loading model…']
   : this.teacher.isConfigured ? ['ready', 'Ready'] : this.laya ? ['ready', 'Fast only'] : ['', 'Not connected'];
  chip.className = `tp-status ${cls}`; chip.textContent = text;
 }
 _renderState() {
  this._setStatus(null);
  const ready = this.teacher.isConfigured;
  this.panel.querySelector('.question-input').disabled = !ready;
  this.panel.querySelector('.tp-ask-btn').disabled = !ready;
  const summary = this.panel.querySelector('.tp-summary-text');
  summary.replaceChildren();
  if (this._active) {
   const provider = providerById(this._active.id);
   const qwen = this._localEngine ? LOCAL_MODELS.find(m => m.id === this._active.model)?.label.split(' —')[0] : null;
   const model = this._active.id === 'local' ? (qwen ? `Laya + ${qwen}` : 'Laya only') : this._active.model.replace(/^[^/]+\//, '');
   summary.append(el('b', { textContent: provider.name }), ` · ${model}`);
  } else summary.textContent = 'Not connected — choose a provider';
  this.panel.querySelector('.tp-change').textContent = this._active ? 'Change' : 'Choose';
  this.panel.querySelector('.question-input').placeholder = ready ? 'Ask about theory…' : this.laya ? 'Load Qwen (or connect a provider) to ask questions' : 'Ask about theory…';
  this._renderMode();
 }
 // The Fast/Slow switch appears once Laya (System 1) is loaded; Slow needs a System 2 model as well.
 _renderMode() {
  const box = this.panel.querySelector('.tp-mode');
  box.hidden = !this.laya;
  const slowOk = this.teacher.isConfigured, mode = slowOk ? this.mode : 'fast';
  box.querySelectorAll('button').forEach(b => { b.setAttribute('aria-checked', b.dataset.mode === mode); b.disabled = b.dataset.mode === 'slow' && !slowOk; });
  const system2 = this._active?.id === 'local' ? 'Qwen' : providerById(this._active?.id)?.name || 'the model';
  box.querySelector('.tp-mode-note').textContent = mode === 'slow' ? `Laya coaches at once, then ${system2} ${system2 === 'Qwen' ? 'thinks it through' : 'explains it'}.` : `Laya coaches each phrase at once.${slowOk ? ' Tap "Explain why" for more.' : ''}`;
 }
 _renderEmpty() {
  const box = this.panel.querySelector('.tp-messages');
  box.querySelector('.tp-empty')?.remove();
  if (box.querySelector('.teacher-msg')) return;
  const empty = el('div', { className: 'tp-empty' });
  if (this.laya) empty.append(`Play a phrase and pause for a moment: Laya names it and gives you the next step with an example to hear.${this.teacher.isConfigured ? ' Switch to Slow, or ask a question below, for a fuller explanation.' : ''}`);
  else if (this.teacher.isConfigured) empty.append('Play a phrase and pause for a moment: the teacher names it, explains it and plays a suggestion. Or ask a question below.');
  else {
   const go = el('button', { type: 'button', className: 'tp-primary', textContent: 'Choose a provider' });
   go.onclick = () => this._showTab('provider');
   empty.append('Note names, chords and scales show here as you play, with no setup. Connect a provider to have the teacher explain them and suggest what to try next.', go);
  }
  box.append(empty);
 }

 /* ---- Provider tab ---- */

 _renderProviders() {
  const list = this.panel.querySelector('.tp-providers');
  list.replaceChildren();
  for (const group of GROUPS) {
   const members = PROVIDERS.filter(pr => pr.auth === group.auth);
   if (!members.length) continue;
   list.append(el('h3', { className: 'tp-group-title', textContent: group.title }));
   members.forEach(pr => list.append(this._card(pr)));
  }
 }

 _card(provider) {
  const id = provider.id, selected = this._selected === id, active = this._active?.id === id;
  const radio = el('input', { type: 'radio', name: 'tp-provider', value: id, checked: selected });
  const name = el('span', { className: 'tp-card-name' }, provider.name,
   el('span', { className: `tp-badge${/^Free/.test(provider.cost) ? ' free' : ''}`, textContent: provider.cost }));
  if (active) name.append(el('span', { className: 'tp-badge on', textContent: 'Connected' }));
  else if (getKey(id)) name.append(el('span', { className: 'tp-badge saved', textContent: provider.auth === 'openrouter' ? 'Signed in' : 'Key saved' }));
  const head = el('label', { className: 'tp-card-head' }, radio,
   el('span', { className: 'tp-card-text' }, name, el('span', { className: 'tp-card-meta', textContent: `${provider.how} · ${provider.where}` })));
  const body = el('div', { className: 'tp-card-body', hidden: !selected });
  const card = el('div', { className: `tp-card${selected ? ' selected' : ''}` }, head, body);
  card.dataset.id = id;
  radio.onchange = () => {
   this._selected = id; this._renderProviders();
   this.panel.querySelector(`.tp-card[data-id="${id}"] input[type=radio]`)?.focus(); // keep arrow-key navigation
  };
  if (selected) this._fillBody(provider, body);
  return card;
 }

 _fillBody(provider, body) {
  const status = el('p', { className: 'tp-card-status', role: 'status' });
  if (provider.auth === 'local') return this._fillLocal(body, status);
  const id = provider.id, active = this._active?.id === id;
  const field = (text, node) => el('label', { className: 'tp-field' }, text, node);
  const connect = el('button', { type: 'button', className: 'tp-primary', textContent: active ? 'Reconnect' : 'Connect' });

  // Model: a dropdown filled from the provider's live list (or its suggestions until we have one); a custom
  // endpoint gets a free-text field, since there is no list to rely on.
  let model;
  if (provider.auth === 'custom') {
   model = el('input', { type: 'text', value: getModelFor(id) || '', placeholder: 'model name' });
  } else {
   model = el('select');
   this._fillModels(provider, model, provider.models?.length ? provider.models : [getModelFor(id) || provider.defaultModel]);
   if (id === 'openrouter') (this._openRouterModels ||= fetchOpenRouterModels()).then(({ free, premium }) => this._fillModelGroups(model, getModelFor(id) || provider.defaultModel, [['Free', free], ['Premium · needs credit', premium]])).catch(() => { this._openRouterModels = null; });
   model.onchange = () => { if (this._active?.id === id) { setModelFor(id, model.value); this._activate(provider, model.value, true); status.textContent = `Now using ${model.value}.`; status.className = 'tp-card-status ok'; } };
  }

  const keyInput = el('input', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: getKey(id) ? 'Key saved — paste a new one to replace it' : provider.keyHint });
  const forget = el('button', { type: 'button', className: 'tp-link', textContent: provider.auth === 'openrouter' ? 'Sign out' : 'Forget key' });
  forget.onclick = () => this._forget(provider);
  const keyLink = provider.keyUrl ? el('p', { className: 'tp-note' }, 'Get a key: ', el('a', { href: provider.keyUrl, target: '_blank', rel: 'noopener', textContent: host(provider.keyUrl) })) : null;

  if (provider.auth === 'openrouter') {
   if (getKey(id)) body.append(el('div', { className: 'tp-row' }, el('span', { className: 'tp-note', textContent: 'Signed in to OpenRouter.' }), forget));
   else {
    const signin = el('button', { type: 'button', className: 'tp-primary', textContent: 'Sign in with OpenRouter' });
    signin.onclick = () => signIn().catch(err => { status.textContent = err.message; status.className = 'tp-card-status bad'; });
    body.append(el('div', { className: 'tp-row' }, signin),
     el('p', { className: 'tp-note', textContent: 'No key to copy: approve on openrouter.ai and you come back connected. A free account can use the free models.' }),
     el('details', {}, el('summary', { textContent: 'Or paste an OpenRouter key' }), keyInput));
   }
   body.append(field('Model', model));
  } else if (provider.auth === 'custom') {
   const base = el('input', { type: 'text', value: getBase(id) || '', placeholder: 'https://api.example.com/v1' });
   body.append(field('API base URL', base), field('API key', keyInput), field('Model', model),
    el('p', { className: 'tp-note', textContent: 'Any service with an OpenAI-style /chat/completions endpoint that allows browser requests (CORS).' }));
   connect.onclick = () => this._connect(provider, { key: keyInput.value.trim(), base: base.value.trim(), model: model.value.trim() }, { connect, status, keyInput, model });
  } else {
   body.append(field('API key', keyInput));
   if (getKey(id)) body.append(el('div', { className: 'tp-row' }, forget));
   if (keyLink) body.append(keyLink);
   body.append(field('Model', model));
  }
  if (provider.auth !== 'custom') connect.onclick = () => this._connect(provider, { key: keyInput.value.trim(), model: model.value }, { connect, status, keyInput, model });
  body.append(el('div', { className: 'tp-row' }, connect), status);
 }

 _fillModels(provider, select, ids, chosen = getModelFor(provider.id) || provider.defaultModel) {
  select.replaceChildren(...ids.map(m => el('option', { value: m, textContent: m })));
  if (chosen && !ids.includes(chosen)) select.prepend(el('option', { value: chosen, textContent: chosen }));
  select.value = chosen || ids[0] || '';
 }
 _fillModelGroups(select, chosen, groups) {
  select.replaceChildren();
  for (const [title, list] of groups) {
   if (!list.length) continue;
   const g = el('optgroup'); g.label = title;
   list.forEach(m => g.append(el('option', { value: m.id, textContent: m.label })));
   select.append(g);
  }
  select.value = chosen;
  if (select.value !== chosen && select.options.length) select.selectedIndex = 0;
 }

 _fillLocal(body, status) {
  const select = el('select');
  LOCAL_MODELS.forEach(m => select.append(el('option', { value: m.id, textContent: m.label })));
  select.value = getModelFor('local') || LOCAL_DEFAULT;
  const gpu = webgpuAvailable(), loaded = this._active?.id === 'local';
  const btn = el('button', { type: 'button', className: 'tp-primary', textContent: loaded ? 'Reload' : gpu ? 'Download and load both' : 'Load Laya only' });
  const bar = el('progress', { max: 1, hidden: true });
  select.disabled = !gpu;
  btn.onclick = () => this._loadLocal(select.value, { btn, bar, status, select });
  body.append(
   el('p', { className: 'tp-note', textContent: `Two models work together here. Laya (System 1, ${LAYA_MB} MB) is a fast decision model: the moment you finish a phrase it picks your next step, and the app writes the words and plays the example, so the theory is always right. Qwen (System 2) thinks through explanations and answers your questions. No account, key or cookie, and nothing you play leaves the browser.` }),
   el('label', { className: 'tp-field' }, 'Qwen size', select), el('div', { className: 'tp-row' }, btn), bar, status,
   el('p', { className: 'tp-note', textContent: gpu
    ? 'The first load downloads both models; later visits load them from the browser cache.'
    : 'This browser has no WebGPU, so Qwen can\'t run here. Laya still can, on the CPU, for fast coaching. Use desktop Chrome or Edge for both.' }));
 }

 // Loads Laya (System 1) and, where WebGPU allows, Qwen (System 2). A Qwen already loaded at another size is
 // unloaded first to free GPU memory. If Laya fails to load, Qwen still runs on its own.
 async _loadLocal(modelId, { btn, bar, status, select }) {
  if (this._loading) return;
  this._loading = true;
  btn.disabled = select.disabled = true; btn.textContent = 'Loading…'; bar.hidden = false; bar.removeAttribute('value');
  status.className = 'tp-card-status'; status.textContent = 'Starting…';
  this._setStatus('loading');
  const show = prog => { status.textContent = prog.text || 'Loading…'; if (typeof prog.progress === 'number') bar.value = prog.progress; else bar.removeAttribute('value'); };
  let warning = '';
  try {
   if (!this.laya) {
    try { this.laya = await LayaCoach.load(show); }
    catch (err) { if (!webgpuAvailable()) throw err; warning = `Laya couldn't load (${err.message}), so fast coaching is off; Qwen works on its own.`; }
   }
   let engine = null;
   if (webgpuAvailable()) {
    if (this._localEngine) { this.teacher.setEngine(null); await this._localEngine.unload?.(); this._localEngine = null; }
    engine = await LocalEngine.load(modelId, prog => show({ ...prog, text: `Qwen: ${prog.text || 'loading…'}` }));
   }
   this._localEngine = engine;
   this.teacher.reset(); this.teacher.setEngine(engine);
   this._active = { id: 'local', model: modelId };
   setProviderId('local'); setModelFor('local', modelId);
   this._connected(providerById('local'));
   if (warning) this._msg('error', warning);
  } catch (err) {
   status.textContent = err.message; status.className = 'tp-card-status bad';
   btn.textContent = this._active?.id === 'local' ? 'Reload' : 'Download and load both';
   this._setStatus(null);
  } finally {
   this._loading = false; btn.disabled = false; select.disabled = !webgpuAvailable(); bar.hidden = true;
  }
 }

 // Saves what was entered, checks the key by listing the provider's models (free; nothing is generated),
 // picks a model, and connects. `ui` holds the card's controls when called from the Provider tab.
 async _connect(provider, { key = '', base = '', model = '' } = {}, ui = null) {
  const id = provider.id;
  const say = (text, ok) => { if (ui) { ui.status.textContent = text; ui.status.className = `tp-card-status${ok === true ? ' ok' : ok === false ? ' bad' : ''}`; } else if (ok === false) this._msg('error', text); };
  if (provider.auth === 'custom' && base) setBase(id, base);
  if (provider.auth === 'custom' && !getBase(id)) return say('Enter the API base URL.', false);
  const apiKey = key || getKey(id); // a newly typed key is only saved once it checks out
  if (!apiKey) return say(provider.auth === 'openrouter' ? 'Sign in or paste a key first.' : 'Paste an API key first.', false);
  if (ui) ui.connect.disabled = true;
  say('Checking the key…');
  let ids = null;
  try { ids = await listModels(provider, apiKey); }
  catch (err) {
   const rejected = err.status === 401 || err.status === 403;
   // A custom endpoint may simply have no /models list; anything else that fails is worth stopping on.
   if (rejected || provider.auth !== 'custom') { if (ui) ui.connect.disabled = false; return say(err.message, false); }
  }
  let chosen = model || getModelFor(id);
  if (ids?.length) {
   chosen = provider.auth === 'custom' ? (model || pickModel(provider, ids, getModelFor(id))) : pickModel(provider, ids, model || getModelFor(id));
   if (ui && provider.auth === 'key') this._fillModels(provider, ui.model, ids, chosen);
  }
  if (!chosen) { if (ui) ui.connect.disabled = false; return say('Enter a model name.', false); }
  if (key) setKey(id, key);
  if (ui) ui.keyInput.value = '';
  setModelFor(id, chosen); setProviderId(id);
  this._activate(provider, chosen);
  if (ui) ui.connect.disabled = false;
 }

 _activate(provider, model, quiet = false) {
  const { engine, error } = engineFor(provider);
  if (error) { this._msg('error', error); return; }
  // A hosted System 2 replaces the on-device Qwen, which is unloaded to free GPU memory; Laya stays loaded
  // and keeps coaching as System 1.
  if (this._localEngine) { this._localEngine.unload?.(); this._localEngine = null; }
  this.teacher.reset(); this.teacher.setEngine(engine);
  this._active = { id: provider.id, model };
  if (quiet) { this._renderState(); return; }
  this._selected = provider.id;
  this._connected(provider);
 }

 _connected(provider) {
  this._renderProviders(); this._renderState();
  this._msg('info', provider.id === 'local'
   ? `${this.laya && this._localEngine ? 'Laya and Qwen are' : this.laya ? 'Laya is' : 'Qwen is'} ready. Play a phrase and pause${this._localEngine ? ', or ask a question' : ''}.`
   : `Connected to ${provider.name}. Play a phrase and pause, or ask a question.`);
  this._showTab('lesson');
  document.activeElement?.blur?.(); // so the computer keyboard plays notes again straight away
 }

 _forget(provider) {
  clearKey(provider.id);
  if (this._active?.id === provider.id) { this.teacher.reset(); this.teacher.setEngine(null); this._active = null; }
  this._renderProviders(); this._renderState(); this._renderEmpty();
 }

 /* ---- Lesson tab ---- */

 _showLive(note, vel) {
  const live = this.panel?.querySelector('.tp-live');
  if (!live) return;
  live.querySelector('.tp-live-note').textContent = pitchClassName(note);
  live.querySelector('.tp-live-detail').textContent = `MIDI ${note} · velocity ${vel} · pitch class ${note % 12}`;
  const chip = live.querySelector('.tp-chip');
  const held = [...this.tracker.heldNotes];
  const chord = held.length >= 3 ? detectChord(held, Math.min(...held))[0] : null;
  chip.hidden = !chord; chip.textContent = chord?.chordName || '';
 }

 _showLocal(a) {
  const d = el('div', { className: 'teacher-msg local' });
  const s = a.scales[0];
  d.append(el('strong', { textContent: s ? `${s.tonicName} ${s.scaleName}` : `${a.noteCount} notes` }));
  if (a.chords.length) d.append(`Chords: ${a.chords.map(c => c.best.chordName).join(' → ')}`);
  d.append(el('span', { className: 'tp-dim', textContent: `${a.noteCount} notes${s ? ` · ${(s.score * 100).toFixed(0)}% match` : ''} · pitch classes ${a.pitchClasses.join(' ')}` }));
  this._append(d);
 }

 _msg(type, text, play = null, info = {}) {
  const d = el('div', { className: `teacher-msg ${type}` });
  if (type === 'teacher') {
   const who = this._active?.id === 'local' ? 'Qwen' : providerById(this._active?.id)?.name || 'Teacher';
   d.append(el('span', { className: 'tp-who', textContent: info.think ? `System 2 · ${who}, thought for ${info.seconds.toFixed(1)} s` : `${this.laya ? 'System 2 · ' : ''}${who}` }));
  }
  d.append(text);
  if (play) {
   const again = el('button', { type: 'button', textContent: `▶ ${play.label}` });
   again.onclick = () => this._playSteps(play.steps, play.bpm);
   d.append(el('div', { className: 'tp-msg-actions' }, again));
  }
  this._append(d);
 }

 // Laya's step: what was played, the next step and its example, and (in Fast mode) a way to ask System 2
 // why. Laya also judges whether an explanation would help; when it thinks so, that button is highlighted.
 _coachMsg(a, move, d, slow) {
  const box = el('div', { className: 'teacher-msg coach' }, el('span', { className: 'tp-who', textContent: `System 1 · Laya, ${d.ms} ms` }), `${describePlayed(a)} ${move.say}`);
  const hear = el('button', { type: 'button', textContent: '▶ Hear it' });
  hear.onclick = () => this._playSteps(move.example.steps, move.example.bpm);
  const actions = el('div', { className: 'tp-msg-actions' }, hear);
  if (!slow && this.teacher.isConfigured) {
   const why = el('button', { type: 'button', className: d.explain >= 0.5 ? 'tp-primary' : '', textContent: d.explain >= 0.5 ? 'Explain why (suggested)' : 'Explain why' });
   why.onclick = () => { why.disabled = true; this._queue(a, { think: true, coach: `${describePlayed(a)} Next step: ${move.say}` }); };
   actions.append(why);
  }
  box.append(actions);
  this._append(box);
 }

 _append(node) {
  const c = this.panel?.querySelector('.tp-messages');
  if (!c) return;
  c.querySelector('.tp-empty')?.remove();
  c.append(node);
  while (c.querySelectorAll('.teacher-msg').length > MAX_MESSAGES) c.querySelector('.teacher-msg').remove();
  c.scrollTop = c.scrollHeight;
 }

 _ask() {
  const i = this.panel?.querySelector('.question-input');
  const q = i?.value.trim();
  if (!q) return;
  if (!this.teacher.isConfigured) { this._showTab('provider'); return; }
  i.value = '';
  this._question(q);
 }
 _question(q) {
  this._askedAt = performance.now();
  this._msg('user', q); this.teacher.ask(q, { think: this.mode === 'slow' });
 }

 /* ---- Talk mode ---- */

 // Reads text aloud when talk mode is on; resolves straight away otherwise.
 _say(text) { return this.talking && this.voice ? this.voice.speak(text) : Promise.resolve(); }

 _toggleTalk() {
  if (this.talking) { this.voice.stop(); return; }
  this.voice ||= new Voice({
   onHeard: text => this._heard(text),
   onInterim: text => { this.panel.querySelector('.question-input').value = text; },
   onState: (state, note) => this._talkState(state, note),
  });
  this.voice.start();
 }

 // A finished spoken question: asked like a typed one, or answered aloud with what to set up first.
 _heard(text) {
  this.panel.querySelector('.question-input').value = '';
  if (this.teacher.isConfigured) { this._question(text); return; }
  this._msg('user', text);
  const reply = this.laya ? 'I can coach your playing right now. To answer questions, load Qwen or connect a provider in the Provider tab.' : 'Choose a provider in the Provider tab first, then I can answer.';
  this._msg('info', reply); this._say(reply);
 }

 _talkState(state, note) {
  this.talking = state === 'listening' || state === 'speaking';
  const btn = this.panel.querySelector('.tp-talk'), line = this.panel.querySelector('.tp-talk-note');
  btn.setAttribute('aria-pressed', this.talking);
  btn.classList.toggle('listening', state === 'listening');
  btn.textContent = state === 'listening' ? '🎙 Listening' : state === 'speaking' ? '🔊 Speaking' : '🎙 Talk';
  if (state === 'error') { this._msg('error', note); this.panel.querySelector('.question-input').value = ''; }
  if (!this.talking) { line.hidden = true; return; }
  const how = !canListen() ? 'This browser can\'t listen, so talk mode only reads replies aloud.'
   : this.voice.local ? 'Speech is recognised on this device.'
   : 'Your browser\'s speech service recognises what you say (in Chrome that is online).';
  line.hidden = false;
  line.textContent = state === 'speaking' ? 'Speaking. Play a note to interrupt.' : `Listening: ask a question out loud, or play and pause. ${how}`;
 }
}

let _bridge = null;
export function initTeacher() { if (_bridge) return _bridge; _bridge = new TeacherBridge(); _bridge.hook(); return _bridge; }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTeacher);
else initTeacher();
