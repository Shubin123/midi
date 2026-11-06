// Checks run inside the app (index.html) by node tests/plugin-editor.mjs: a plug-in window's view, editor first
// and generic controls always. A real VST3 (Steinberg's AGain Sample Accurate, whose Gain starts at 0: silent)
// sits in the effect chain while a synth note plays, and stand-in editors fail in every way an editor can: no
// editor, a framework not supported yet, a throw or a WebAssembly trap while opening, no first frame, a blank
// one, a crash after opening (thrown, or reported). Each time the generic controls must show with the notice,
// their Gain must still reach the processor, and the sound must be what it was. A working stand-in checks the
// switch, the remembered choice, and that edits go both ways. Then the real thing: Steinberg's AGain, built with its
// VSTGUI editor (native/vstgui-web), is opened, looked at, dragged, typed into and listened to, and AGain Sample
// Accurate, which has no editor, falls back by itself. runHiDpi() checks the editor again at a 2x pixel ratio.
// Returns { checks: [{ name, ok, problems }] }.

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const NAME = 'AGain Sample Accurate', GAIN = 1;

// What comes out of the synth: the RMS of its output over `ms`.
async function loudness(ms = 250) {
 const ctx = window.synth.ensureAudio();
 if (ctx.state !== 'running') await ctx.resume();
 const tap = new AnalyserNode(ctx, { fftSize: 4096 }), x = new Float32Array(4096);
 window.synth.output.connect(tap);
 let sum = 0, n = 0;
 for (let t = 0; t < ms; t += 50) { await wait(50); tap.getFloatTimeDomainData(x); for (const v of x) sum += v * v; n += x.length; }
 window.synth.output.disconnect(tap);
 return Math.sqrt(sum / n);
}

// Stand-in editors. Each draws (or doesn't) on the surface it is given, as a real one would.
function draw(surface, value) {
 const g = surface.ctx, s = surface.scale;
 g.setTransform(s, 0, 0, s, 0, 0);
 g.fillStyle = '#20242c'; g.fillRect(0, 0, surface.width, surface.height);
 g.fillStyle = '#5ad'; g.fillRect(20, 50, 260 * value, 20);
 g.strokeStyle = '#fff'; g.strokeRect(20, 50, 260, 20);
}
const working = { edits: [], params: [] };
const STAND_INS = {
 'test-ok': ({ surface, bridge }) => {
  let value = 0, dragging = false;
  const set = x => { value = Math.max(0, Math.min(1, (x - 20) / 260)); bridge.edit(GAIN, value); working.edits.push(value); };
  return { width: 300, height: 120, resizable: false, frame: () => { draw(surface, value); return true; },
   pointer: e => { if (e.type === 'down') { dragging = true; set(e.x); } else if (e.type === 'move' && dragging) set(e.x); else if (e.type === 'up') dragging = false; },
   param: (id, v) => { if (id == GAIN) { value = v; working.params.push(v); } }, close() {} };
 },
 'test-null': () => null,
 'test-throw': () => { throw new Error('createView failed'); },
 'test-trap': () => { throw new WebAssembly.RuntimeError('unreachable'); },
 'test-timeout': () => new Promise(() => {}),
 'test-blank': ({ surface }) => ({ width: 300, height: 120, frame: () => { surface.ctx.clearRect(0, 0, 1e4, 1e4); return true; }, close() {} }),
 'test-crash-later': ({ surface }) => { let n = 0; return { width: 300, height: 120, frame: () => { if (++n > 20) throw new RangeError('memory access out of bounds'); draw(surface, 0.5); return true; }, close() {} }; },
 'test-reports-crash': ({ surface, bridge }) => { setTimeout(() => bridge.fail('The editor\'s module trapped.'), 300); return { width: 300, height: 120, frame: () => { draw(surface, 0.3); return true; }, close() {} }; },
};

export async function runPluginEditor() {
 const checks = [];
 const check = async (name, fn) => {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 };
 const editors = await import('../js/plugin-editor.js');
 for (const [id, open] of Object.entries(STAND_INS)) editors.registerAdapter({ id, label: id, open });
 const host = $('#plugin-host-module'), pick = host.querySelector('select[aria-label="Built-in effect"]');
 const windowOf = () => [...document.querySelectorAll('.plugin-window')].find(w => w.getAttribute('aria-label') === NAME);
 const remove = async () => { const w = windowOf(); [...(w?.querySelectorAll('button') || [])].find(b => b.textContent === 'Remove')?.click(); for (let i = 0; i < 40 && windowOf(); i++) await wait(25); };
 // Loads AGain Sample Accurate as if its editor were built with `framework`, and waits for the view to settle.
 const load = async framework => {
  await remove();
  editors.overrides.set(NAME, framework);
  pick.value = 'vst3/AGainSampleAccurate';
  [...host.querySelectorAll('button')].find(b => b.textContent === 'Add built-in').click();
  for (let i = 0; i < 80 && !windowOf()?.querySelector('.plugin-param'); i++) await wait(50);
  const w = windowOf();
  if (!w) throw new Error('the plug-in did not load');
  await wait(50);
  return w;
 };
 const slider = w => [...w.querySelectorAll('.plugin-param input')].find(i => i.getAttribute('aria-label') === 'Gain');
 const setGeneric = (w, v) => { const s = slider(w); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); };
 const shows = el => !!el && !el.hidden && el.getClientRects().length > 0;

 window.synth.ensureAudio();
 window.synth.noteOn('C5'); // held for the whole run, through the effect chain
 await wait(200);

 /* ---- Every way an editor can fail ---- */
 const failures = [
  ['test-null', 'the plug-in has no editor (createView returns nothing)', /no editor/],
  ['juce', 'its framework isn\'t supported yet (JUCE)', /JUCE/],
  ['test-throw', 'opening it throws', /couldn't open: createView failed/],
  ['test-trap', 'its module traps while opening', /couldn't open: unreachable/],
  ['test-timeout', 'no first frame within 2 s', /no first frame within 2 s/],
  ['test-blank', 'its first frame is blank', /blank frame/],
  ['test-crash-later', 'it crashes after opening (a frame throws)', /crashed: memory access out of bounds/],
  ['test-reports-crash', 'it reports a crash after opening', /trapped/],
 ];
 for (const [framework, what, why] of failures) {
  await check(`when ${what}: the generic controls show with the notice, Gain still reaches the processor, and the sound is unchanged`, async expect => {
   const w = await load(framework);
   setGeneric(w, 1);
   await wait(150);
   const before = await loudness();
   await wait(framework === 'test-timeout' ? 2300 : framework.endsWith('later') || framework.endsWith('crash') ? 700 : 150);
   const notice = w.querySelector('.editor-notice');
   expect(shows(notice) && notice.textContent.startsWith('Editor unavailable, showing generic controls'), `the notice is "${shows(notice) ? notice.textContent : ''}"`);
   expect(why.test(notice?.textContent || ''), `the notice doesn't say why: "${notice?.textContent}"`);
   expect(shows(w.querySelector('.plugin-params')) && slider(w), 'the generic controls are not showing');
   expect(!shows(w.querySelector('.plugin-editor canvas')), 'an editor canvas is still showing');
   expect(w.querySelector('.editor-toggle button[data-mode="editor"]').disabled, 'Editor can still be chosen');
   const after = await loudness();
   expect(before > 0.005 && Math.abs(after / before - 1) < 0.15, `the sound went from ${before.toFixed(4)} to ${after.toFixed(4)}`);
   setGeneric(w, 0);
   await wait(150); // what was already on its way out
   const silent = await loudness();
   expect(silent < before * 0.05, `Gain at 0 from the generic controls left ${silent.toFixed(4)} (was ${before.toFixed(4)})`);
  });
 }

 /* ---- A working editor ---- */
 await check('a working editor shows instead of the generic controls, and Editor / Generic switches between them; the choice is kept', async expect => {
  const w = await load('test-ok');
  const canvas = w.querySelector('.plugin-editor canvas');
  expect(shows(canvas) && !shows(w.querySelector('.plugin-params')) && !shows(w.querySelector('.editor-notice')), 'the editor is not what shows');
  expect(canvas?.width === 300 * Math.max(1, Math.round(devicePixelRatio)), `the canvas is ${canvas?.width} px wide`);
  w.querySelector('.editor-toggle button[data-mode="generic"]').click();
  expect(shows(w.querySelector('.plugin-params')) && !shows(canvas), 'Generic did not switch');
  const rec = JSON.parse(localStorage.getItem('synth-web-plugins-v1')).find(r => /AGainSampleAccurate/.test(r.main));
  expect(rec?.view === 'generic', `the choice kept is ${rec?.view}`);
  w.querySelector('.editor-toggle button[data-mode="editor"]').click();
  expect(shows(canvas), 'Editor did not switch back');
 });
 await check('edits go both ways: dragging in the editor moves the generic Gain and the sound; the generic Gain moves the editor', async expect => {
  const w = windowOf(), canvas = w.querySelector('.plugin-editor canvas');
  const r = canvas.getBoundingClientRect(), at = x => ({ clientX: r.left + x * (r.width / 300), clientY: r.top + 60 * (r.height / 120), bubbles: true, pointerId: 1, button: 0, buttons: 1 });
  canvas.setPointerCapture = () => {};
  canvas.dispatchEvent(new PointerEvent('pointerdown', at(20)));
  canvas.dispatchEvent(new PointerEvent('pointermove', at(150)));
  canvas.dispatchEvent(new PointerEvent('pointermove', at(280)));
  canvas.dispatchEvent(new PointerEvent('pointerup', { ...at(280), buttons: 0 }));
  expect(Math.abs(working.edits.at(-1) - 1) < 1e-6, `the editor's last edit was ${working.edits.at(-1)}`);
  expect(Number(slider(w).value) === 1, `the generic Gain is ${slider(w).value}`);
  const loud = await loudness();
  expect(loud > 0.005, `dragging Gain up in the editor left the sound at ${loud.toFixed(4)}`);
  setGeneric(w, 0.25);
  expect(working.params.at(-1) === 0.25, `the editor was told ${working.params.at(-1)}`);
 });
 await check('an editor that crashes while in use is torn down and the generic controls take over; the sound carries on', async expect => {
  const w = windowOf();
  setGeneric(w, 1);
  const before = await loudness();
  const view = (await import('../js/plugin-editor.js'));
  w.querySelector('.plugin-editor canvas').dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
  // Make the working editor's next frame throw, as a trap mid-session would.
  const editorCanvas = w.querySelector('.plugin-editor canvas');
  editorCanvas.getContext('2d').fillRect = () => { throw new Error('the module trapped mid-frame'); };
  await wait(150);
  expect(shows(w.querySelector('.editor-notice')) && /trapped mid-frame/.test(w.querySelector('.editor-notice').textContent), `the notice is "${w.querySelector('.editor-notice')?.textContent}"`);
  expect(shows(w.querySelector('.plugin-params')), 'the generic controls are not showing');
  const after = await loudness();
  expect(Math.abs(after / before - 1) < 0.15, `the sound went from ${before.toFixed(4)} to ${after.toFixed(4)}`);
  void view;
 });
 await check('a plug-in with no editor at all (built-in Delay) has its controls, the switch, and no notice', async expect => {
  pick.value = 'delay';
  [...host.querySelectorAll('button')].find(b => b.textContent === 'Add built-in').click();
  let w;
  for (let i = 0; i < 60 && !(w = [...document.querySelectorAll('.plugin-window')].find(x => x.getAttribute('aria-label') === 'Delay'))?.querySelector('.plugin-param'); i++) await wait(50);
  expect(w && shows(w.querySelector('.plugin-params')) && !shows(w.querySelector('.editor-notice')), 'the Delay has no controls, or a notice');
  expect(w?.querySelector('.editor-toggle button[data-mode="editor"]')?.disabled, 'the switch is missing, or Editor can be chosen');
 });

 await realEditor(check);
 window.synth.noteOff('C5');
 await remove();
 return { checks };
}

/* ---- Steinberg's AGain, with its own VSTGUI editor ---- */

const AGAIN = 'AGain VST3';
const againWindow = () => [...document.querySelectorAll('.plugin-window')].find(w => w.getAttribute('aria-label') === AGAIN);
// Messages the controller sends the processor, as they cross to the worklet.
const sent = [];
const post = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (data, ...rest) { if (data?.message) sent.push(new TextDecoder().decode(data.message)); return post.call(this, data, ...rest); };

async function loadAgain() {
 const host = $('#plugin-host-module'), pick = host.querySelector('select[aria-label="Built-in effect"]');
 const old = againWindow();
 if (old) { [...old.querySelectorAll('button')].find(b => b.textContent === 'Remove')?.click(); for (let i = 0; i < 40 && againWindow(); i++) await wait(25); }
 pick.value = 'vst3/AGain';
 [...host.querySelectorAll('button')].find(b => b.textContent === 'Add built-in').click();
 for (let i = 0; i < 120 && !(againWindow()?.querySelector('.plugin-editor canvas') || againWindow()?.querySelector('.editor-notice:not([hidden])')); i++) await wait(50);
 await wait(300);
 return againWindow();
}
// The editor's pixels in a rect of its own coordinates, as a string of RGBA, and how many colours a rect has.
const pixels = (canvas, x, y, w, h) => { const s = canvas.width / 350; return Array.from(canvas.getContext('2d').getImageData(Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s)).data).join(','); };
const colours = canvas => { const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, set = new Set(); for (let i = 0; i < d.length; i += 4 * 3) set.add(`${d[i]},${d[i + 1]},${d[i + 2]}`); return set.size; };
// Pointer events at the editor's own coordinates.
function drag(canvas, path) {
 const r = canvas.getBoundingClientRect(), k = r.width / 350;
 const ev = (type, [x, y], buttons) => canvas.dispatchEvent(new PointerEvent(type, { clientX: r.left + x * k, clientY: r.top + y * k, bubbles: true, pointerId: 1, button: 0, buttons, detail: 1 }));
 canvas.setPointerCapture = () => {};
 ev('pointerdown', path[0], 1);
 for (const p of path.slice(1)) ev('pointermove', p, 1);
 ev('pointerup', path.at(-1), 0);
}
const gainOf = w => Number([...w.querySelectorAll('.plugin-param input')].find(i => i.getAttribute('aria-label') === 'Gain')?.value);
const setGenericGain = (w, v) => { const i = [...w.querySelectorAll('.plugin-param input')].find(x => x.getAttribute('aria-label') === 'Gain'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
// Keys, as typed into the focused editor; [key, { modifiers }] for a shortcut. Select all is Command-A on a Mac.
const type = (canvas, keys) => { for (const k of keys) { const [key, mods = {}] = Array.isArray(k) ? k : [k]; for (const t of ['keydown', 'keyup']) canvas.dispatchEvent(new KeyboardEvent(t, { key, bubbles: true, ...mods })); } };
const selectAll = /Mac/.test(navigator.platform) ? ['a', { metaKey: true }] : ['a', { ctrlKey: true }];

async function realEditor(check) {
 const shows = el => !!el && !el.hidden && el.getClientRects().length > 0;
 await check('AGain\'s own VSTGUI editor opens in its window at its own size (350 × 120), drawn and not blank', async expect => {
  const w = await loadAgain(), canvas = w?.querySelector('.plugin-editor canvas');
  expect(shows(canvas), `no editor showing (${w?.querySelector('.editor-notice')?.textContent || 'no notice'})`);
  if (!canvas) return;
  expect(canvas.style.width === '350px' && canvas.style.height === '120px', `it is ${canvas.style.width} × ${canvas.style.height}`);
  expect(colours(canvas) > 50, `only ${colours(canvas)} colours drawn`);
  expect(!shows(w.querySelector('.plugin-params')) && !shows(w.querySelector('.editor-notice')), 'the generic controls or a notice show as well');
 });
 await check('dragging its Gain slider changes the sound, moves the generic Gain, and its VU meter follows the level', async expect => {
  const w = againWindow(), canvas = w.querySelector('.plugin-editor canvas');
  const loud = await loudness(), vuLoud = pixels(canvas, 330, 7, 12, 105);
  drag(canvas, [[214, 99], [160, 99], [92, 99]]);
  await wait(300);
  const quiet = await loudness();
  expect(quiet < loud * 0.1, `dragging Gain down took the sound from ${loud.toFixed(4)} to ${quiet.toFixed(4)}`);
  expect(gainOf(w) < 0.05, `the generic Gain is ${gainOf(w)}`);
  await wait(300);
  expect(pixels(canvas, 330, 7, 12, 105) !== vuLoud, 'the VU meter did not move when the sound went quiet');
 });
 await check('the generic Gain moves the editor\'s slider, and the sound', async expect => {
  const w = againWindow(), canvas = w.querySelector('.plugin-editor canvas');
  const before = pixels(canvas, 90, 90, 130, 18);
  w.querySelector('.editor-toggle button[data-mode="generic"]').click();
  setGenericGain(w, 1);
  w.querySelector('.editor-toggle button[data-mode="editor"]').click();
  await wait(200);
  expect(pixels(canvas, 90, 90, 130, 18) !== before, 'the slider did not move');
  expect((await loudness()) > 0.01, 'the sound did not come back');
 });
 await check('typing into its Gain field (-6 dB, Enter) sets the gain, and the keys don\'t play the synth', async expect => {
  const w = againWindow(), canvas = w.querySelector('.plugin-editor canvas');
  let notes = 0; const count = e => { if (e.detail.on) notes++; };
  window.addEventListener('synth:note', count);
  drag(canvas, [[275, 99]]);
  await wait(100);
  type(canvas, [selectAll, '-', '6', 'Enter']);
  await wait(200);
  window.removeEventListener('synth:note', count);
  expect(Math.abs(gainOf(w) - 0.501) < 0.01, `the gain is ${gainOf(w)}, not 0.501 (−6 dB)`);
  expect(notes === 0, `${notes} notes played while typing`);
 });
 await check('its Send! button sends the controller\'s message to the processor in the worklet', async expect => {
  const canvas = againWindow().querySelector('.plugin-editor canvas'), before = sent.length;
  drag(canvas, [[275, 63]]);
  await wait(200);
  expect(sent.length > before && sent.slice(before).some(m => /TextMessage|BinaryMessage|Hello World/.test(m)), `messages sent: ${sent.slice(before).join(' | ') || 'none'}`);
 });
 await check('forced to fail, AGain\'s window falls back to its generic controls, which still work', async expect => {
  const editors = await import('../js/plugin-editor.js');
  editors.overrides.set(AGAIN, 'test-throw');
  const w = await loadAgain();
  editors.overrides.delete(AGAIN);
  expect(shows(w.querySelector('.editor-notice')) && shows(w.querySelector('.plugin-params')), 'no fallback');
  setGenericGain(w, 0);
  await wait(250);
  expect((await loudness()) < 0.005, 'the generic Gain did not reach the processor');
  setGenericGain(w, 1);
 });
 await check('AGain Sample Accurate, which has no editor, says so and shows its generic controls', async expect => {
  const host = $('#plugin-host-module'), pick = host.querySelector('select[aria-label="Built-in effect"]');
  (await import('../js/plugin-editor.js')).overrides.delete('AGain Sample Accurate'); // as it declares itself, not as a stand-in
  const old = [...document.querySelectorAll('.plugin-window')].find(x => x.getAttribute('aria-label') === 'AGain Sample Accurate');
  if (old) { [...old.querySelectorAll('button')].find(b => b.textContent === 'Remove')?.click(); for (let i = 0; i < 40 && old.isConnected; i++) await wait(25); }
  pick.value = 'vst3/AGainSampleAccurate';
  [...host.querySelectorAll('button')].find(b => b.textContent === 'Add built-in').click();
  let w;
  for (let i = 0; i < 80 && !(w = [...document.querySelectorAll('.plugin-window')].find(x => x.getAttribute('aria-label') === 'AGain Sample Accurate'))?.querySelector('.plugin-param'); i++) await wait(50);
  const notice = w?.querySelector('.editor-notice');
  expect(shows(notice) && /no editor/.test(notice.textContent), `the notice is "${notice?.textContent}"`);
  expect(shows(w?.querySelector('.plugin-params')), 'no generic controls');
 });
}

// At a 2x pixel ratio: the editor's canvas has twice the pixels, is drawn sharp at that size, and a drag lands
// where it is aimed.
export async function runHiDpi() {
 const checks = [];
 const check = async (name, fn) => { const problems = []; try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); } checks.push({ name, ok: !problems.length, problems }); };
 await check('at a 2x pixel ratio AGain\'s editor is 700 × 240 pixels for 350 × 120, drawn, and a drag on its slider lands', async expect => {
  window.synth.ensureAudio();
  const w = await loadAgain(), canvas = w?.querySelector('.plugin-editor canvas');
  expect(canvas?.width === 700 && canvas?.height === 240 && canvas.style.width === '350px', `the canvas is ${canvas?.width} × ${canvas?.height} at ${canvas?.style.width}`);
  if (!canvas) return;
  expect(colours(canvas) > 50, `only ${colours(canvas)} colours`);
  drag(canvas, [[214, 99], [150, 99]]);
  await wait(200);
  const g = gainOf(w);
  expect(g > 0.2 && g < 0.8, `a drag to the middle of the slider set the gain to ${g}`);
 });
 return { checks };
}
