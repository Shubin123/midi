// Checks run inside the app (index.html) by node tests/settings.mjs: the Settings menu, switching the AI teacher
// off and on, stopping every sound from Settings, hiding the floating PANIC button, and the panic on coming back
// to the tab. runSettings('first') changes and checks; runSettings('reloaded') runs after a reload, to see what
// was kept, and puts everything back. Returns { checks: [{ name, ok, problems }] }.

const wait = ms => new Promise(r => setTimeout(r, ms));
const $ = s => document.querySelector(s);
const shown = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
const press = el => el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, isPrimary: true }));
const flip = (sel, on) => { const box = $(sel); if (box.checked !== on) box.click(); };
const html = document.documentElement;

// What comes out of the synth: the RMS of the last 4096 samples at its output.
async function loudness(ms = 150) {
 const ctx = window.synth.ensureAudio();
 if (ctx.state !== 'running') await ctx.resume();
 const tap = new AnalyserNode(ctx, { fftSize: 4096 }), x = new Float32Array(4096);
 window.synth.output.connect(tap);
 await wait(ms);
 tap.getFloatTimeDomainData(x);
 window.synth.output.disconnect(tap);
 return Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
}
let panics = 0;
window.addEventListener('synth:panic', () => { panics++; });
// A phrase as the keyboard plays it: the synth's own note events, from the computer keyboard.
const playPhrase = async notes => { for (const midi of notes) { for (const on of [true, false]) window.dispatchEvent(new CustomEvent('synth:note', { detail: { midi, velocity: 0.7, on, source: 'computer' } })); await wait(30); } };
const sequencerRunning = () => !/Play/.test($('#seq-play').textContent);
const startSequencer = async () => { const step = $('#step-sequencer [data-step]'); if (step.getAttribute('aria-pressed') !== 'true') step.click(); if (!sequencerRunning()) $('#seq-play').click(); await wait(120); };
// Pretends the tab was left (hidden) or come back to (visible), as the browser announces it.
const visibility = state => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state }); Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); };
const realVisibility = () => { delete document.visibilityState; delete document.hidden; };

const FIRST = [], RELOADED = [];
const check = (list, name, fn) => list.push({ name, fn });

check(FIRST, 'the menu is called Settings', async expect => {
 const summary = $('.widget-menu summary');
 expect(/Settings/.test(summary.textContent) && !/Widgets/.test(summary.textContent), `it says "${summary.textContent.trim()}"`);
 expect(summary.getAttribute('aria-label') === 'Settings', 'its accessible name is not Settings');
 expect($('#settings-teacher') && $('#settings-teach-buttons') && $('#settings-panic') && $('#settings-panic-button'), 'a setting is missing');
 expect([...document.querySelectorAll('.widget-menu-body > label')].length >= 13, 'the widget list is gone');
});
check(FIRST, 'clicking off Settings closes it; inside it stays open; Escape closes it', async expect => {
 const menu = $('.widget-menu');
 menu.querySelector('summary').click();
 expect(menu.open, 'it did not open');
 press($('#settings-panic-button'));
 expect(menu.open, 'clicking a setting closed it');
 press($('#workspace'));
 expect(!menu.open, 'clicking the workspace left it open');
 menu.open = true; press(document.body);
 expect(!menu.open, 'clicking the page left it open');
 menu.open = true; document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); // where a key press goes
 expect(!menu.open, 'Escape left it open');
});
const teachButtons = () => [...document.querySelectorAll('.teach-btn')];
check(FIRST, 'the PANIC button and the 🎓 buttons start off, for room', async expect => {
 expect(!shown($('#stopAllSoundsButton')) && !$('#settings-panic-button').checked, 'the PANIC button shows');
 const headers = document.querySelectorAll('#workspace > .widget .widget-header').length;
 expect(teachButtons().length >= headers, `only ${teachButtons().length} 🎓 buttons were made, for ${headers} widgets`);
 expect(!teachButtons().some(shown) && !$('#settings-teach-buttons').checked, `${teachButtons().filter(shown).length} 🎓 buttons show`);
 expect(!$('#settings-teach-buttons').disabled, 'the 🎓 switch is greyed out while the teacher is on');
 expect(shown($('.teacher-toggle')), 'the teacher itself is off');
});
check(FIRST, 'switched on, 🎓 buttons show on every widget and plug-in window, and open a guide', async expect => {
 // A plug-in window too: its 🎓 is the teacher's.
 const host = $('#plugin-host-module'), pick = host.querySelector('select[aria-label="Built-in effect"]');
 pick.value = [...pick.options].find(o => /delay/i.test(o.textContent)).value;
 [...host.querySelectorAll('button')].find(b => b.textContent === 'Add built-in').click();
 for (let i = 0; i < 40 && !document.querySelector('.plugin-window .teach-btn'); i++) await wait(50);
 flip('#settings-teach-buttons', true);
 const headers = [...document.querySelectorAll('#workspace > .widget .widget-header, .plugin-window:not([hidden]) .widget-header')];
 expect(document.querySelector('.plugin-window:not([hidden])'), 'the plug-in window did not open');
 expect(headers.every(h => shown(h.querySelector('.teach-btn'))), `${headers.filter(h => !shown(h.querySelector('.teach-btn'))).length} headers have no 🎓 showing`);
 expect(localStorage.getItem('teach-buttons-v1') === 'true', 'the switch was not saved');
 $('#filter-group .teach-btn').click();
 await wait(100);
 const last = [...document.querySelectorAll('#teacher-panel .teacher-msg')].at(-1);
 expect(shown($('#teacher-panel')) && /Filter/.test(last?.textContent || ''), 'pressing the Filter\'s 🎓 did not open its guide');
});
check(FIRST, 'switching the AI teacher off hides its panel, pull tab and every 🎓 button, and closes its tab', async expect => {
 flip('#settings-teacher', false);
 expect(html.classList.contains('teacher-off') && !html.classList.contains('teacher-open'), 'the page still has the teacher open');
 expect(!shown($('#teacher-panel')) && !shown($('.teacher-toggle')), 'the panel or its pull tab still shows');
 expect(!teachButtons().some(shown), `${teachButtons().filter(shown).length} 🎓 buttons still show, though switched on`);
 expect($('#settings-teach-buttons').disabled && $('#settings-teach-buttons').checked, 'the 🎓 switch is not resting (greyed out, still on)');
 expect(getComputedStyle(document.body).paddingRight === getComputedStyle(document.body).paddingLeft, 'the gutter for the pull tab is still there');
 expect(localStorage.getItem('teacher-enabled-v1') === 'false', 'the switch was not saved');
 // The Delay goes again: its echoes would ring on after the panics below (a panic stops notes, not echoes).
 const host = $('#plugin-host-module');
 [...host.querySelectorAll('.plugin-row button')].filter(b => b.textContent === 'Remove').forEach(b => b.click());
 await wait(100);
 expect(!host.querySelector('.plugin-row'), 'the Delay could not be removed');
});
check(FIRST, 'switched off, the teacher ignores what is played', async expect => {
 const live = $('#teacher-panel .tp-live'), before = live.textContent;
 await playPhrase([60, 64, 67, 72]);
 await wait(950);
 expect(live.textContent === before, 'it showed the notes');
});
check(FIRST, 'switched on again, it all comes back, hears notes again, and opens as it was left', async expect => {
 flip('#settings-teacher', true);
 expect(!html.classList.contains('teacher-off') && shown($('.teacher-toggle')) && [...document.querySelectorAll('#workspace .teach-btn')].every(shown), 'something is still hidden');
 expect(!$('#settings-teach-buttons').disabled, 'the 🎓 switch is still greyed out');
 const wasOpen = JSON.parse(localStorage.getItem('teacher-open-v1') ?? String(innerWidth >= 900));
 expect(shown($('#teacher-panel')) === wasOpen && html.classList.contains('teacher-open') === wasOpen, `the panel is ${shown($('#teacher-panel')) ? 'open' : 'closed'}, it was left ${wasOpen ? 'open' : 'closed'}`);
 const live = $('#teacher-panel .tp-live'), before = live.textContent;
 await playPhrase([62, 65, 69]);
 expect(live.textContent !== before, 'it did not show the notes');
 flip('#settings-teacher', false); // off for the reload, with the 🎓 buttons switched on
});
check(FIRST, 'Stop all sounds in Settings stops a held note and the sequencer', async expect => {
 await startSequencer();
 window.synth.noteOn('A5');
 const loud = await loudness();
 expect(loud > 0.01 && sequencerRunning(), `nothing was playing (RMS ${loud.toFixed(4)})`);
 const was = panics;
 $('#settings-panic').click();
 expect(panics === was + 1, 'no panic');
 const quiet = await loudness(250);
 expect(quiet < 0.001, `still sounding (RMS ${quiet.toFixed(4)})`);
 expect(!sequencerRunning(), 'the sequencer kept playing');
});
check(FIRST, 'switched on, the PANIC button shows and works; switched off it goes', async expect => {
 const button = $('#stopAllSoundsButton');
 flip('#settings-panic-button', true);
 expect(shown(button) && localStorage.getItem('panic-button-v2') === 'true', 'it does not show, or the switch was not saved');
 window.synth.noteOn('A5'); await wait(80);
 const was = panics; button.click();
 expect(panics === was + 1 && await loudness(250) < 0.001, 'it did not stop the note');
 flip('#settings-panic-button', false);
 expect(!shown(button) && localStorage.getItem('panic-button-v2') === 'false', 'it still shows, or the switch was not saved');
 flip('#settings-panic-button', true); // on for the reload
});
check(FIRST, 'coming back to the tab stops every sound; leaving it does not panic', async expect => {
 try {
  await startSequencer();
  const was = panics;
  visibility('hidden');
  expect(panics === was, 'leaving the tab panicked');
  window.synth.noteOn('A5'); await wait(80); // a note left sounding while away
  $('#seq-play').click(); await wait(80); // and the sequencer restarted
  visibility('visible');
  expect(panics === was + 1, 'coming back did not panic');
  const quiet = await loudness(250);
  expect(quiet < 0.001, `still sounding after coming back (RMS ${quiet.toFixed(4)})`);
  expect(!sequencerRunning(), 'the sequencer kept playing after coming back');
 } finally { realVisibility(); }
});

check(RELOADED, 'the teacher stays off after a reload, and never shows, 🎓 buttons included', async expect => {
 expect(html.classList.contains('teacher-off') && !$('#settings-teacher').checked, 'it came back on');
 expect(!shown($('#teacher-panel')) && !shown($('.teacher-toggle')) && !teachButtons().some(shown), 'part of it shows');
 expect($('#settings-teach-buttons').checked && $('#settings-teach-buttons').disabled, 'the 🎓 switch did not keep its place, or is not resting');
 const live = $('#teacher-panel .tp-live'), before = live.textContent;
 await playPhrase([60, 62, 64]);
 expect(live.textContent === before, 'it heard notes');
});
check(RELOADED, 'the PANIC button, switched on, stays on after a reload', async expect => {
 expect(shown($('#stopAllSoundsButton')) && $('#settings-panic-button').checked, 'it went');
});
check(RELOADED, 'with the teacher back on, the 🎓 buttons it kept come back; then all back as a new visitor finds them', async expect => {
 flip('#settings-teacher', true);
 expect(shown($('.teacher-toggle')) && [...document.querySelectorAll('#workspace .teach-btn')].every(shown), 'the teacher or its 🎓 buttons did not come back');
 flip('#settings-teach-buttons', false); flip('#settings-panic-button', false);
 expect(!teachButtons().some(shown) && !shown($('#stopAllSoundsButton')), 'they did not go');
});

export async function runSettings(phase) {
 const checks = [];
 for (const { name, fn } of phase === 'reloaded' ? RELOADED : FIRST) {
  const problems = [];
  try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); }
  checks.push({ name, ok: !problems.length, problems });
 }
 return { checks };
}
