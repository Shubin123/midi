// The Listening widget: start and stop listening, the input (a microphone or an audio interface's input), the
// mode, a level meter with the noise gate on it, a tuner (the note, how many cents off, the frequency), snapping
// to the sequencer's key and scale, headphones and whether what you sing plays through the synth, and latency
// calibration. While the mic is open a red "Mic on" pill shows at the top of the page (click it to stop). Over
// the falling notes, a pitch trail draws what you sing as it moves between the keys, coloured by how far off
// the nearest note it is. Everything is kept (js/listening.js).
import { listening, MODES, keyAndScale } from './listening.js';
import { el, card } from './plugin-ui.js';
import { detectChord } from './pitch-analyzer.js';

const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const SCI = midi => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`; // scientific pitch: 60 is C4
const KEY_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
// Within 10 cents is in tune, within 25 close; beyond is off. The same colours as the timing grades.
export const centsColor = c => (Math.abs(c) <= 10 ? '#6bcb77' : Math.abs(c) <= 25 ? '#f4a261' : '#ff6b6b');

export function createListeningWidget() {
 const { section, content } = card('listening-module', 'Listening');
 section.classList.remove('wide'); delete section.dataset.wide;
 const s = listening.settings;
 const check = (id, text, on, title = '') => { const box = el('input', { type: 'checkbox', id, checked: on }); return [box, el('label', { className: 'listen-check', title }, box, ` ${text}`)]; };
 const toggle = el('button', { type: 'button', id: 'listen-toggle', className: 'std-button', textContent: '🎙 Listen' });
 toggle.setAttribute('aria-pressed', 'false');
 const device = el('select', { id: 'listen-device' }, el('option', { value: '', textContent: 'Default microphone' }));
 device.setAttribute('aria-label', 'Input device');
 const mode = el('select', { id: 'listen-mode' }, ...Object.entries(MODES).map(([v, t]) => el('option', { value: v, textContent: t })));
 mode.setAttribute('aria-label', 'Listening mode'); mode.value = MODES[s.mode] ? s.mode : 'melody';
 const fill = el('div', { className: 'listen-meter-fill' }), gateMark = el('div', { className: 'listen-meter-gate' });
 const meter = el('div', { className: 'listen-meter', title: 'Input level; the line is the noise gate' }, fill, gateMark);
 const db = el('output', { className: 'listen-db', textContent: '—' });
 const note = el('span', { className: 'listen-note', textContent: '–' }), cents = el('span', { className: 'listen-cents', textContent: '' }), hz = el('span', { className: 'listen-hz', textContent: '' });
 const needle = el('div', { className: 'listen-needle' });
 const tuner = el('div', { className: 'listen-tuner' }, el('div', { className: 'listen-tuner-read' }, note, cents, hz), el('div', { className: 'listen-scale' }, el('span', { textContent: '−50' }), el('span', { textContent: '0' }), el('span', { textContent: '+50' }), needle));
 // Chords: how a clip is transcribed (live listening always uses the built-in one, which keeps up).
 const engine = el('select', { id: 'listen-chord-engine' }, el('option', { value: 'builtin', textContent: 'Built in (instant)' }), el('option', { value: 'basic-pitch', textContent: 'Basic Pitch (machine learning, 2.6 MB download)' }));
 engine.setAttribute('aria-label', 'How clips are transcribed in Chords'); engine.value = s.chordEngine;
 const engineRow = el('label', { className: 'listen-engine' }, 'Clips transcribed by ', engine);
 engine.onchange = () => listening.set({ chordEngine: engine.value });
 const [snapBox, snapLabel] = check('listen-snap', 'Snap to the sequencer\'s key and scale', s.snap);
 const keyName = el('span', { className: 'module-hint listen-key' });
 snapLabel.append(' ', keyName);
 const [phonesBox, phonesLabel] = check('listen-headphones', 'I\'m wearing headphones', s.headphones, 'On speakers the microphone also hears the app: its own notes are ignored and what you sing stays silent');
 const [playBox, playLabel] = check('listen-play', 'Play what I sing through the synth', s.playThrough, 'Only with headphones, or the microphone would hear it and keep it going');
 const gate = el('input', { type: 'range', id: 'listen-gate', className: 'horizontal-slider', min: -80, max: -20, step: 1, value: s.gateDb });
 const gateOut = el('output', { textContent: `${s.gateDb} dB` });
 const calibrate = el('button', { type: 'button', id: 'listen-calibrate', textContent: 'Calibrate latency' });
 const latency = el('output', { id: 'listen-latency' });
 const status = el('p', { className: 'listen-status', role: 'status' });
 // In Metronome & Tempo: claps (or any onset heard) tap the tempo, as Tap BPM does.
 const [clapBox, clapLabel] = check('clapTempo', 'Clap to set the tempo (while listening)', s.clapTempo, 'Every clap or tap the Listening widget hears taps Tap BPM, at the moment it was made');
 clapLabel.className = 'midi-sync';
 document.querySelector('#metronome-tempo-group .metronome-controls')?.append(clapLabel);
 clapBox.onchange = () => listening.set({ clapTempo: clapBox.checked });
 const hint = el('p', { className: 'module-hint listen-hint' });
 content.append(
  el('div', { className: 'sequence-toolbar' }, toggle, device),
  el('div', { className: 'sequence-toolbar' }, el('label', {}, 'Mode ', mode), engineRow),
  el('div', { className: 'listen-level' }, meter, db),
  tuner,
  el('div', { className: 'listen-options' }, snapLabel, phonesLabel, playLabel,
   el('label', { className: 'listen-gate' }, el('span', {}, 'Noise gate ', gateOut), gate)),
  el('div', { className: 'sequence-toolbar' }, calibrate, latency),
  status, hint);

 // The mic-on pill.
 const mic = el('button', { type: 'button', className: 'mic-indicator', textContent: '● Mic on', title: 'The microphone is open for listening. Click to stop.', hidden: true });
 mic.onclick = () => listening.stop();
 document.body.append(mic);
 const describeKey = () => { const { key, scale } = keyAndScale(); keyName.textContent = `(${KEY_NAMES[key]} ${scale})`; };
 const render = st => {
  toggle.textContent = st.active ? '■ Stop listening' : '🎙 Listen';
  toggle.setAttribute('aria-pressed', String(st.active));
  toggle.classList.toggle('listening', st.active);
  status.textContent = st.error || (st.active ? `Listening to ${st.label}.` : 'Not listening. Sing, whistle or play an instrument into the microphone, and the app plays along as if from a keyboard.');
  status.classList.toggle('error', !!st.error);
  playBox.disabled = !st.headphones; playLabel.classList.toggle('disabled', !st.headphones);
  latency.textContent = `Latency ${st.latencyMs} ms${st.measured ? ' (measured)' : ' (estimated)'}`;
  engineRow.hidden = st.mode !== 'chords';
  hint.textContent = st.mode === 'chords' ? `Chords: several notes at once, for a piano or a guitar. Approximate: a note can be missed or one heard an octave out, and each is found a fifth of a second late (but stamped from when it was struck).${st.headphones ? '' : ' On speakers, notes the app plays are left out.'}` : st.mode === 'rhythm' ? `Rhythm only: every clap or tap is graded on the beat, with no pitch.${st.headphones ? '' : ' On speakers a metronome click is told from a clap by its level; headphones work best.'}` : st.headphones ? 'Headphones: nothing the app plays can reach the microphone.' : 'On speakers, notes the app plays itself are ignored. Headphones work best.';
  gateMark.style.left = `${((st.gateDb + 80) / 80) * 100}%`;
  mic.hidden = !(st.active && st.kind === 'mic');
  describeKey();
 };
 const fillDevices = async () => {
  const list = await listening.devices(), keep = s.deviceId;
  device.replaceChildren(el('option', { value: '', textContent: 'Default microphone' }), ...list.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => el('option', { value: d.deviceId, textContent: d.label || `Input ${i + 1}` })));
  device.value = [...device.options].some(o => o.value === keep) ? keep : '';
 };
 navigator.mediaDevices?.addEventListener?.('devicechange', fillDevices);

 toggle.onclick = async () => {
  if (listening.active) { listening.stop(); return; }
  toggle.disabled = true;
  try { if (await listening.start()) fillDevices(); } finally { toggle.disabled = false; }
 };
 device.onchange = async () => { listening.set({ deviceId: device.value }); if (listening.active && listening.kind === 'mic') await listening.start(); };
 mode.onchange = () => listening.set({ mode: mode.value });
 snapBox.onchange = () => listening.set({ snap: snapBox.checked });
 phonesBox.onchange = () => listening.set({ headphones: phonesBox.checked });
 playBox.onchange = () => listening.set({ playThrough: playBox.checked });
 gate.oninput = () => { gateOut.textContent = `${gate.value} dB`; listening.set({ gateDb: Number(gate.value) }); };
 calibrate.onclick = async () => {
  calibrate.disabled = true;
  try {
   if (!listening.active && !(await listening.start())) return;
   status.textContent = s.headphones ? 'Clap along with the eight clicks…' : 'Listening for eight clicks: keep quiet for a few seconds…';
   const r = await listening.calibrate();
   status.textContent = r ? `Heard ${r.heard} of 8 clicks: the round trip is ${Math.round(r.ms)} ms, now taken off every note.` : (s.headphones ? 'Too few claps were heard with the clicks. Try again, a little louder.' : 'The clicks weren\'t heard back. Turn the speakers up, or with headphones on, clap along instead.');
  } catch (err) { status.textContent = err.message; } finally { calibrate.disabled = false; }
 };
 ['seq-key', 'seq-scale'].forEach(id => document.addEventListener('change', e => { if (e.target.id === id) describeKey(); }));

 // The meter and tuner follow the frames, at most once a frame.
 let drawn = false, claps = 0, clapShown = -Infinity;
 const show = () => {
  drawn = false;
  const f = listening.last;
  if (f && s.mode === 'chords') { // the tuner names the chord instead
   fill.style.width = `${Math.max(0, Math.min(100, ((f.db + 80) / 80) * 100))}%`; db.textContent = `${Math.max(-80, Math.round(f.db))} dB`;
   const held = listening.heldChord || [], name = held.length >= 3 ? detectChord(held, held[0])[0]?.chordName : '';
   note.textContent = name || (held.length ? held.map(SCI).join(' ') : '–'); cents.textContent = held.length ? `${held.length} note${held.length === 1 ? '' : 's'} · approximate` : ''; hz.textContent = '';
   tuner.classList.toggle('voiced', held.length > 0);
   return;
  }
  if (f && s.mode === 'rhythm') { // the tuner counts claps instead
   fill.style.width = `${Math.max(0, Math.min(100, ((f.db + 80) / 80) * 100))}%`; db.textContent = `${Math.max(-80, Math.round(f.db))} dB`;
   note.textContent = performance.now() - clapShown < 150 ? '👏' : '·'; cents.textContent = `${claps} clap${claps === 1 ? '' : 's'}`; hz.textContent = ''; tuner.classList.toggle('voiced', performance.now() - clapShown < 400);
   return;
  }
  if (!f) { fill.style.width = '0%'; db.textContent = '—'; note.textContent = '–'; cents.textContent = ''; hz.textContent = ''; needle.style.left = '50%'; return; }
  fill.style.width = `${Math.max(0, Math.min(100, ((f.db + 80) / 80) * 100))}%`;
  fill.classList.toggle('gated', f.db < s.gateDb);
  db.textContent = `${Math.max(-80, Math.round(f.db))} dB`;
  const p = f.pitch;
  if (p.voiced && p.midi !== null) {
   note.textContent = SCI(p.midi); cents.textContent = `${p.cents >= 0 ? '+' : '−'}${Math.abs(Math.round(p.cents))}¢`; hz.textContent = `${p.hz.toFixed(1)} Hz`;
   needle.style.left = `${50 + Math.max(-50, Math.min(50, p.cents))}%`; needle.style.background = centsColor(p.cents);
   tuner.classList.add('voiced');
  } else tuner.classList.remove('voiced');
 };
 listening.subscribe((type, detail) => {
  if (type === 'state') { render(detail); show(); }
  if (type === 'frame' && !drawn) { drawn = true; requestAnimationFrame(show); wakeTrail(); }
  if (type === 'clap') { claps++; clapShown = performance.now(); }
 });

 render(listening.state());
 fillDevices();
 setTimeout(describeKey); // the sequencer is added after this widget
 return section;
}

/* ---- The pitch trail over the falling notes ---- */

// Each key's middle across the falling-notes area, measured as the falling notes place themselves.
function keyCentres(area) {
 const kb = document.getElementById('keyboard'), kr = kb?.getBoundingClientRect();
 if (!kr?.width) return null;
 const ar = area.getBoundingClientRect(), scale = ar.width / kr.width, map = new Map();
 kb.querySelectorAll('[data-midi]').forEach(k => { const r = k.getBoundingClientRect(); map.set(Number(k.dataset.midi), (r.left + r.width / 2 - kr.left) * scale); });
 return map;
}
// Where a fractional note falls between the keys' middles.
export function xOf(centres, semis) {
 const lo = Math.floor(semis), a = centres.get(lo), b = centres.get(lo + 1);
 if (a === undefined || b === undefined) return a ?? null;
 return a + (b - a) * (semis - lo);
}

let trailCanvas = null, trailFrame = false;
const TRAIL_MS = 2500;
function wakeTrail() { if (!trailFrame) { trailFrame = true; requestAnimationFrame(drawTrail); } }
function drawTrail() {
 trailFrame = false;
 const area = document.getElementById('synthesiaContainer');
 if (!area) return;
 if (!trailCanvas || !trailCanvas.isConnected) { trailCanvas = el('canvas', { className: 'listen-trail' }); trailCanvas.setAttribute('aria-hidden', 'true'); area.append(trailCanvas); }
 const dpr = devicePixelRatio || 1, w = area.clientWidth, h = area.clientHeight;
 if (trailCanvas.width !== Math.round(w * dpr) || trailCanvas.height !== Math.round(h * dpr)) { trailCanvas.width = Math.round(w * dpr); trailCanvas.height = Math.round(h * dpr); }
 const g = trailCanvas.getContext('2d'), now = performance.now();
 g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
 const points = listening.trail.filter(p => now - p.t < TRAIL_MS);
 trailCanvas.dataset.points = points.length; // for the tests
 if (!points.length || !area.classList.contains('active')) return;
 const centres = keyCentres(area);
 if (!centres) return;
 // Newest at the top, as falling notes start; older further down, fading.
 const y = t => ((now - t) / TRAIL_MS) * h;
 g.lineWidth = 3; g.lineCap = 'round';
 for (let i = 1; i < points.length; i++) {
  const a = points[i - 1], b = points[i], xa = xOf(centres, a.semis), xb = xOf(centres, b.semis);
  if (xa === null || xb === null || b.t - a.t > 60) continue;
  g.globalAlpha = Math.max(0.1, 1 - (now - b.t) / TRAIL_MS);
  g.strokeStyle = centsColor(b.cents);
  g.beginPath(); g.moveTo(xa, y(a.t)); g.lineTo(xb, y(b.t)); g.stroke();
 }
 const last = points.at(-1), x = xOf(centres, last.semis);
 if (x !== null && now - last.t < 150) {
  g.globalAlpha = 1; g.fillStyle = centsColor(last.cents);
  g.beginPath(); g.arc(x, y(last.t), 5, 0, Math.PI * 2); g.fill();
  g.font = '600 11px Poppins, sans-serif'; g.textAlign = 'center';
  g.fillText(`${last.cents >= 0 ? '+' : '−'}${Math.abs(Math.round(last.cents))}¢`, x, Math.max(12, y(last.t) - 9) + 22);
 }
 g.globalAlpha = 1;
 wakeTrail();
}
