// AI music theory teacher: a side panel that follows the notes you play. Note names and the held chord show
// instantly, scale/mode and chords once a phrase ends (all local), and then a model explains the phrase.
// Pick a backend in Settings: on-device (WebGPU, no key), OpenRouter (sign in, free models), or another
// provider by key (Groq, Gemini, Cerebras, Mistral, OpenAI, or a custom OpenAI-compatible endpoint). The
// model's suggested notes and chords play through the synth and light up the keyboard. The panel only needs
// the synth's `synth:note` events and `window.synth`, so loading this module is the whole integration.
import { PhraseTracker, NOTE_NAMES, detectChord, pitchClassName } from './pitch-analyzer.js';
import { AiTeacher } from './ai-teacher.js';
import { el } from './plugin-ui.js';
import { LocalEngine, MODELS as LOCAL_MODELS, DEFAULT_MODEL as LOCAL_DEFAULT, webgpuAvailable } from './local-model.js';
import { PROVIDERS, providerById, getProviderId, setProviderId, getKey, setKey, getModelFor, setModelFor, getBase, setBase, engineFor, fetchOpenRouterModels } from './providers.js';
import { signIn, completeSignIn } from './ai-auth.js';
import { read, save } from './storage.js';

// Notes the player struck; the sequencer, looper and the teacher's own playback are not analysed.
const PLAYED = /^(midi|computer|mouse|touch)/;
const toNote = midi => NOTE_NAMES[midi % 12] + Math.floor(midi / 12); // the synth calls MIDI 60 "C5"
const MAX_MESSAGES = 200;

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
#teacher-panel .provider-config{display:flex;flex-direction:column;gap:8px}
#teacher-panel .teacher-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--text-muted-color)}
#teacher-panel .teacher-row{display:flex;gap:6px;align-items:center}
#teacher-panel .teacher-settings p{margin:0;font-size:11px;line-height:1.5;color:var(--text-muted-color)}
#teacher-panel .teacher-settings a{color:var(--accent-color)}
#teacher-panel details summary{font-size:11px;color:var(--text-muted-color);cursor:pointer}
#teacher-panel details .teacher-row{margin-top:8px}
#teacher-panel .teacher-field select,#teacher-panel .teacher-field input{margin:0}
#teacher-panel label{font-size:12px;color:var(--text-muted-color)}
#teacher-panel select,#teacher-panel input{font:inherit;font-size:13px;background:var(--bg-color);border:1px solid var(--border-color);color:var(--text-color);padding:8px;border-radius:6px;width:100%;box-sizing:border-box;min-width:0}
#teacher-panel .use-btn,#teacher-panel .signin-btn{flex:1}
#teacher-panel .load-progress{font-size:11px;color:var(--text-muted-color)}
#teacher-panel .load-progress progress{width:100%;height:6px;margin-top:4px}
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
  this._activeProvider = null; this._loading = false;
 }

 hook() {
  this._createPanel(); this._listen(); this._setupCallbacks();
  const current = getProviderId();
  this.panel.querySelector('.provider-select').value = providerById(current) ? current : 'local';
  this._renderConfig(this.panel.querySelector('.provider-select').value);
  this._renderReady();
  // Finish an OpenRouter sign-in if we came back from one, then activate whatever is already set up.
  completeSignIn().then(key => {
   if (key) {
    setKey('openrouter', key); setProviderId('openrouter');
    this.panel.querySelector('.provider-select').value = 'openrouter';
    this._renderConfig('openrouter'); this._setOpen(true);
    this._msg('teacher', 'Signed in to OpenRouter.');
   }
   this._autoActivate();
   if (!this.teacher.isConfigured) this._toggleSettings(true);
  }).catch(err => { this._msg('error', err.message); this._toggleSettings(true); });
 }

 // Activates a provider that is already configured and needs no download (a hosted provider with a key).
 // The on-device model is never auto-loaded, since that is a large download.
 _autoActivate() {
  const provider = providerById(getProviderId());
  if (!provider || provider.auth === 'local') return;
  const { engine } = engineFor(provider);
  if (engine) { this.teacher.setEngine(engine); this._activeProvider = provider.id; this._renderReady(); }
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
   if (play) this._playSteps(play.steps, play.bpm);
  };
  this.teacher.onError = m => this._msg('error', m);
  this.teacher.onStatus = s => {
   const el = this.panel?.querySelector('.teacher-status');
   if (el) { el.textContent = s === 'thinking' ? 'Thinking…' : 'Ready'; el.className = `teacher-status ${s}`; }
  };
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

 /* ---- UI ---- */

 _createPanel() {
  document.head.append(Object.assign(document.createElement('style'), { textContent: STYLE }));
  const p = document.createElement('aside'); p.id = 'teacher-panel';
  p.setAttribute('aria-label', 'AI music theory teacher');
  p.innerHTML = `
   <div class="teacher-head"><h2>AI Teacher</h2><span class="teacher-status off">No model</span></div>
   <div class="teacher-toolbar"><button class="auto-btn" title="Explain each phrase automatically">Auto</button><button class="settings-btn" aria-expanded="false">Settings</button><button class="clear-btn">Clear</button></div>
   <div class="teacher-settings" hidden>
    <label class="teacher-field">Provider<select class="provider-select"></select></label>
    <div class="provider-config"></div>
   </div>
   <div class="teacher-live" aria-live="off">Play something…</div>
   <div class="teacher-messages" role="log" aria-live="polite"></div>
   <form class="teacher-ask"><input type="text" class="question-input" placeholder="Ask about theory…" aria-label="Ask the teacher"/><button type="submit" class="teacher-primary">Ask</button></form>`;
  document.body.append(p); this.panel = p;

  const select = p.querySelector('.provider-select');
  PROVIDERS.forEach(pr => select.append(el('option', { value: pr.id, textContent: pr.label })));
  select.onchange = () => { setProviderId(select.value); this._renderConfig(select.value); };

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
 }

 // Rebuilds the Settings body for the chosen provider: a model loader for on-device, a sign-in for
 // OpenRouter, a key field for the hosted providers, or base URL + key for a custom endpoint.
 _renderConfig(id) {
  const provider = providerById(id), host = this.panel.querySelector('.provider-config');
  host.replaceChildren();
  const field = (text, node) => el('label', { className: 'teacher-field' }, text, node);
  const note = text => el('p', {}, text);

  if (provider.auth === 'local') { this._renderLocalConfig(host, field, note); return; }

  // Shared model control: a fetched dropdown for OpenRouter, an editable field for the rest.
  let modelInput;
  if (id === 'openrouter') {
   modelInput = el('select', { className: 'model-input' });
   modelInput.append(el('option', { value: provider.defaultModel, textContent: 'Loading models…' }));
   fetchOpenRouterModels().then(({ free, premium }) => {
    modelInput.replaceChildren();
    const group = (title, list) => { if (!list.length) return; const g = el('optgroup'); g.label = title; list.forEach(m => g.append(el('option', { value: m.id, textContent: m.label }))); modelInput.append(g); };
    group('Free', free); group('Premium · needs credit', premium);
    modelInput.value = getModelFor(id) || provider.defaultModel;
   }).catch(() => { modelInput.querySelector('option').textContent = getModelFor(id) || provider.defaultModel; });
  } else {
   modelInput = el('input', { type: 'text', className: 'model-input', value: getModelFor(id) || provider.defaultModel, placeholder: 'model name' });
   if (provider.models?.length) {
    const listId = `models-${id}`, dl = el('datalist', { id: listId });
    provider.models.forEach(m => dl.append(el('option', { value: m })));
    host.append(dl); modelInput.setAttribute('list', listId);
   }
  }

  const keyInput = el('input', { type: 'password', className: 'key-input', autocomplete: 'off', spellcheck: false, placeholder: getKey(id) ? 'key saved — paste to replace' : (provider.keyHint || 'API key') });
  const useBtn = el('button', { type: 'button', className: 'teacher-primary use-btn', textContent: 'Use this provider' });
  useBtn.onclick = () => { if (keyInput.value.trim()) setKey(id, keyInput.value.trim()); keyInput.value = ''; setModelFor(id, modelInput.value); this._activate(provider); };

  if (id === 'openrouter') {
   const signinBtn = el('button', { type: 'button', className: 'teacher-primary signin-btn', textContent: 'Sign in with OpenRouter' });
   signinBtn.onclick = () => signIn().catch(err => this._msg('error', err.message));
   host.append(
    el('div', { className: 'teacher-row' }, signinBtn),
    note('No API key needed — a free OpenRouter account can use the free models below; add credit there for GPT, Claude or Gemini.'),
    field('Model', modelInput),
    el('details', {}, el('summary', { textContent: 'Have an OpenRouter key? Paste it instead.' }), el('div', { className: 'teacher-row' }, keyInput)),
    el('div', { className: 'teacher-row' }, useBtn),
   );
  } else {
   const gotKey = provider.keyUrl ? el('p', {}, 'Get a key: ', el('a', { href: provider.keyUrl, target: '_blank', rel: 'noopener', textContent: provider.keyUrl.replace(/^https?:\/\//, '') })) : null;
   const custom = provider.auth === 'custom';
   let baseInput;
   if (custom) baseInput = el('input', { type: 'text', className: 'base-input', value: getBase(id) || '', placeholder: 'https://api.example.com/v1' });
   host.append(
    ...(custom ? [field('API base URL', baseInput)] : []),
    field('API key', keyInput),
    ...(gotKey ? [gotKey] : []),
    field('Model', modelInput),
    note(provider.free ? 'Free tier — a key is free to create, no card needed for most.' : 'Uses your paid key; billed by the provider.'),
    el('div', { className: 'teacher-row' }, useBtn),
   );
   if (custom) useBtn.onclick = () => { setBase(id, baseInput.value.trim()); if (keyInput.value.trim()) setKey(id, keyInput.value.trim()); keyInput.value = ''; setModelFor(id, modelInput.value.trim()); this._activate(provider); };
  }
 }

 _renderLocalConfig(host, field, note) {
  const sel = el('select', { className: 'model-input' });
  LOCAL_MODELS.forEach(m => sel.append(el('option', { value: m.id, textContent: m.label })));
  sel.value = getModelFor('local') || LOCAL_DEFAULT;
  const loaded = this._activeProvider === 'local';
  const btn = el('button', { type: 'button', className: 'teacher-primary use-btn', textContent: loaded ? 'Reload model' : 'Load model' });
  const bar = el('progress', { className: 'load-bar', max: 1 });
  const text = el('span', { className: 'load-text' });
  const box = el('div', { className: 'load-progress', hidden: true }, text, bar);
  const supported = webgpuAvailable();
  btn.disabled = sel.disabled = !supported;
  btn.onclick = () => this._loadLocal(sel.value, btn, box, text, bar);
  host.append(field('Model', sel), el('div', { className: 'teacher-row' }, btn), box,
   note(supported
    ? 'Runs on your device with WebGPU — no account, key or cookie, and nothing you play leaves the browser. The first load downloads the model (then it\'s cached), so give it a minute on a good connection.'
    : 'This browser has no WebGPU, so the on-device model can\'t run here. Use Chrome or Edge on a desktop, or pick another provider above.'));
 }

 async _loadLocal(modelId, btn, box, text, bar) {
  if (this._loading) return;
  this._loading = true;
  btn.disabled = true; btn.textContent = 'Loading…'; box.hidden = false; text.textContent = 'Starting…'; bar.removeAttribute('value');
  try {
   const engine = await LocalEngine.load(modelId, prog => {
    text.textContent = prog.text || 'Loading…';
    if (typeof prog.progress === 'number') bar.value = prog.progress; else bar.removeAttribute('value');
   });
   this.teacher.reset(); this.teacher.setEngine(engine);
   this._activeProvider = 'local'; setProviderId('local'); setModelFor('local', modelId);
   this._renderReady();
   btn.textContent = 'Reload model'; box.hidden = true;
   this._msg('teacher', `${LOCAL_MODELS.find(m => m.id === modelId)?.label || modelId} ready. Play something, or ask a question.`);
  } catch (err) {
   this._msg('error', err.message); text.textContent = 'Load failed.';
   btn.textContent = this._activeProvider === 'local' ? 'Reload model' : 'Load model';
  } finally {
   this._loading = false; btn.disabled = false;
  }
 }

 // Activates a hosted or custom provider from its stored settings.
 _activate(provider) {
  const { engine, error } = engineFor(provider);
  if (error) { this._msg('error', error); return; }
  this.teacher.reset(); this.teacher.setEngine(engine);
  this._activeProvider = provider.id; setProviderId(provider.id);
  this._renderReady(); this._toggleSettings(false);
  this._msg('teacher', `${provider.label} ready. Play something, or ask a question.`);
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

 // Reflects whether a model is ready in the status chip and the ask box.
 _renderReady() {
  const p = this.panel, ready = this.teacher.isConfigured;
  p.querySelector('.question-input').disabled = !ready;
  p.querySelector('.teacher-ask button').disabled = !ready;
  const status = p.querySelector('.teacher-status');
  if (ready) { status.textContent = 'Ready'; status.className = 'teacher-status ready'; }
  else { status.textContent = 'No model'; status.className = 'teacher-status off'; }
 }

 // Focus only on request: a focused text field would swallow the computer-keyboard notes.
 _toggleSettings(show, focus = false) {
  const f = this.panel.querySelector('.teacher-settings');
  f.hidden = !(show ?? f.hidden);
  this.panel.querySelector('.settings-btn').setAttribute('aria-expanded', !f.hidden);
  if (!f.hidden && focus) f.querySelector('.provider-select')?.focus({ preventScroll: true });
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
   const hasChord = play.steps.some(s => s.length > 1);
   const total = play.steps.reduce((n, s) => n + s.length, 0);
   const again = document.createElement('button');
   again.textContent = hasChord ? `▶ Play (${play.steps.length} steps)` : `▶ Play ${total} notes`;
   again.onclick = () => this._playSteps(play.steps, play.bpm);
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
  if (!this.teacher.isConfigured) { this._toggleSettings(true); this._msg('error', 'Set up a model in Settings first.'); return; }
  i.value = '';
  this._msg('user', q); this.teacher.ask(q);
 }
}

let _bridge = null;
export function initTeacher() { if (_bridge) return _bridge; _bridge = new TeacherBridge(); _bridge.hook(); return _bridge; }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTeacher);
else initTeacher();
