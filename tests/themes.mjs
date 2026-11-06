// The UI theme and scale come back on a reload before the page draws anything, not after it has loaded
// (js/themes.js). Run in headless Chrome (tests/support/browser.mjs): a probe, run before the page's own scripts,
// records the page's colours and scale when it has been parsed (before any deferred or module script has run, so
// only a script loaded at the top can have applied them) and at its first frame. Every theme in the menu is
// chosen, the page reloaded, and both moments checked.
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch(), { evaluate } = browser;
// What the page shows when parsed and at its first frame: every colour variable a theme sets (the names are
// written here, so a missing themes script shows as unset colours) and the scale.
const KEYS = ['--bg-color', '--primary-surface-color', '--secondary-surface-color', '--accent-color', '--accent-color-darker', '--text-color', '--text-muted-color', '--border-color', '--key-white-bg', '--key-black-bg', '--key-label-white-color', '--key-label-black-color', '--key-label-active-color'];
await browser.beforeScripts(`{
 const look = () => { const css = getComputedStyle(document.documentElement); return { colours: Object.fromEntries(${JSON.stringify(KEYS)}.map(k => [k, css.getPropertyValue(k).trim().toLowerCase()])), scale: css.getPropertyValue('--font-scale-factor').trim() }; };
 window.__early = {};
 document.addEventListener('readystatechange', () => { if (document.readyState === 'interactive') window.__early.parsed = look(); });
 requestAnimationFrame(() => { window.__early.firstFrame = look(); });
}`);
// Waits for the page to finish starting, or fails after 10 s (a page that breaks on start must not hang the run).
const ready = () => evaluate(`new Promise((r, j) => { const t0 = Date.now(), go = () => document.querySelector("#keyboard [data-midi]") && window.__early.parsed && window.__early.firstFrame ? r() : Date.now() - t0 > 10000 ? j(new Error("the page did not finish starting in 10 s")) : setTimeout(go, 30); go(); })`);
// Both early moments must show what is wanted.
const early = async (want, expect) => {
 const { parsed, firstFrame } = await evaluate('window.__early');
 for (const [when, seen] of [['when the page is parsed', parsed], ['at the first frame', firstFrame]]) {
  differ(seen.colours, want.colours).slice(0, 3).forEach(p => expect(false, `${when}: ${p}`));
  if (Number(seen.scale) !== want.scale) expect(false, `${when}: the scale is ${seen.scale}, not ${want.scale}`);
 }
};
const open = async () => { await browser.open('index.html'); await ready(); };
const reload = async () => { await browser.reload(); await ready(); };
// Changes a control as a person does.
const set = (id, value, type) => evaluate(`(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event(${JSON.stringify(type)}, { bubbles: true })); })()`);
const now = () => evaluate(`(() => { const css = getComputedStyle(document.documentElement), keys = ${JSON.stringify(KEYS)};
 return { colours: Object.fromEntries(keys.map(k => [k, css.getPropertyValue(k).trim().toLowerCase()])), inline: keys.filter(k => document.documentElement.style.getPropertyValue(k)), scale: css.getPropertyValue('--font-scale-factor').trim(),
  select: document.getElementById('uiTheme').value, slider: document.getElementById('uiScale').value, saved: localStorage.getItem('synthTheme'), keys: document.querySelectorAll('#keyboard [data-midi]').length }; })()`);
const lower = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toLowerCase()]));
const differ = (a, b) => Object.keys(b).filter(k => a[k] !== b[k]).map(k => `${k} is ${a[k] || '(unset)'}, not ${b[k]}`);

const checks = [];
const check = async (name, fn) => { const problems = []; try { await fn((ok, why) => { if (!ok) problems.push(why); }); } catch (err) { problems.push(`threw: ${err.message}`); } checks.push({ name, ok: !problems.length, problems }); };
let THEMES, DEFAULT_COLOURS;
try {
 await open();
 ({ THEMES } = await evaluate('({ THEMES: window.uiThemes.THEMES })'));
 const keys = Object.keys(THEMES['solarized-dark']);
 if (keys.join() !== KEYS.join()) throw new Error(`the themes set ${keys.join(', ')}; this test checks ${KEYS.join(', ')}`);

 await check('a first visit starts on Midnight Drive at 100%, from the first frame', async expect => {
  const page = await now();
  DEFAULT_COLOURS = page.colours;
  expect(page.select === 'midnight-drive' && !page.inline.length && page.slider === '100', `theme ${page.select}, ${page.inline.length} colours set, scale ${page.slider}`);
  await early({ colours: DEFAULT_COLOURS, scale: 1 }, expect);
 });
 await check('the theme menu and the themes match', async expect => {
  const options = await evaluate('[...document.getElementById("uiTheme").options].map(o => o.value)');
  expect(options.join() === Object.keys(THEMES).join(), `the menu lists ${options.join(', ')}; the themes are ${Object.keys(THEMES).join(', ')}`);
 });
 for (const name of Object.keys(THEMES)) {
  await check(`${name}: chosen, it applies and is saved; on a reload it is there from the first frame`, async expect => {
   await set('uiTheme', name, 'change');
   const want = name === 'midnight-drive' ? DEFAULT_COLOURS : { ...DEFAULT_COLOURS, ...lower(THEMES[name]) };
   const page = await now();
   differ(page.colours, want).forEach(p => expect(false, `chosen: ${p}`));
   expect(page.saved === name, `saved as ${page.saved}`);
   await reload();
   await early({ colours: want, scale: 1 }, expect);
   const after = await now();
   expect(after.select === name, `the menu shows ${after.select} after the reload`);
  });
 }
 await check('switching back to Midnight Drive leaves none of another theme\'s colours', async expect => {
  await set('uiTheme', 'crimson-peak', 'change');
  await set('uiTheme', 'midnight-drive', 'change');
  const page = await now();
  expect(!page.inline.length, `still set: ${page.inline.join(', ')}`);
  differ(page.colours, DEFAULT_COLOURS).forEach(p => expect(false, p));
 });
 await check('the UI scale is saved and back from the first frame of a reload', async expect => {
  await set('uiScale', '125', 'input');
  expect(Number((await now()).scale) === 1.25, 'it did not apply');
  await reload();
  await early({ colours: DEFAULT_COLOURS, scale: 1.25 }, expect);
  const after = await now();
  expect(after.slider === '125', `the slider shows ${after.slider}`);
  await set('uiScale', '100', 'input');
 });
 await check('a saved theme that no longer exists (or a bad scale) falls back to the defaults, and the page still starts', async expect => {
  await evaluate('localStorage.setItem("synthTheme", "retired-theme"); localStorage.setItem("synthUIScale", "huge")');
  await reload();
  await early({ colours: DEFAULT_COLOURS, scale: 1 }, expect);
  const after = await now();
  expect(after.select === 'midnight-drive' && after.slider === '100', `the controls show ${after.select} at ${after.slider}`);
  expect(!unexpected(browser.errors).length, unexpected(browser.errors).join('; '));
 });
 checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
} catch (err) {
 checks.push({ name: 'the run', ok: false, problems: [err.message] });
} finally {
 await browser.close();
}
print(`Themes: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
const failed = checks.filter(c => !c.ok).length;
console.log(`\n${failed ? `${failed} failed` : 'themes: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
