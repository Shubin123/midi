// The teacher's view of the workspace: every widget and plug-in window, the ☰ Settings menu, their controls and
// current values, and ways to act on them: point at a control (show), change one (set), and hide, minimise or
// expand a widget (arrange). Everything is read from the page, so a new widget or a newly loaded plug-in is
// covered without being registered anywhere. Buttons are never pressed for the student, and nothing outside
// these (the teacher panel and its own switch in Settings, file pickers) can be changed.

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
export const norm = s => clean(s).toLowerCase().replace(/[^a-z0-9#♯♭.\- ]+/g, ' ').replace(/\s+/g, ' ').trim();

/* ---- Widgets ---- */

const titleOf = el => clean(el.dataset.title || el.querySelector('.control-title')?.childNodes[0]?.textContent || el.getAttribute('aria-label') || el.id);

// Workspace widgets in their current order, then plug-in windows (open or closed: a closed one keeps running),
// then the app's own sections of the ☰ Settings menu (js/settings.js) as one more, called Settings.
export function widgets() {
 const list = [...document.querySelectorAll('#workspace > .widget')].map(el => ({ id: el.id, title: titleOf(el), el, plugin: false, hidden: el.hidden, minimized: el.classList.contains('minimized') }));
 for (const el of document.querySelectorAll('.plugin-windows > .plugin-window')) list.push({ id: `plugin:${titleOf(el)}`, title: titleOf(el), el, plugin: true, hidden: el.hidden, minimized: false });
 const menu = document.querySelector('.widget-menu .settings-sections');
 if (menu) list.push({ id: 'settings', title: 'Settings', el: menu, plugin: false, menu: true, hidden: false, minimized: false });
 return list;
}
export const widgetById = id => widgets().find(w => w.id === id) || null;

/* ---- Controls ---- */

// A label's own words, without the option texts of a select inside it.
const ownText = node => [...node.childNodes].map(n => (n.nodeType === 3 ? n.textContent : /^(SELECT|OPTION|INPUT|TEXTAREA|OUTPUT)$/.test(n.tagName) ? '' : ownText(n))).join(' ');

export function labelOf(c) {
 const aria = c.getAttribute('aria-label');
 if (aria) return clean(aria);
 const wrap = (c.id && document.querySelector(`label[for="${c.id}"]`)) || c.closest('label');
 const own = wrap && clean(ownText(wrap));
 if (own) return own;
 if (c.type === 'checkbox' && c.closest('.control-title')) return 'On';
 return clean(c.tagName === 'BUTTON' ? c.textContent || c.title : c.title || c.placeholder || c.name || c.id);
}

// Step cells and automation step values are summed up instead of listed one by one (there are dozens).
// The teacher's own switch in Settings is left to the student.
const usable = c => !c.closest('.widget-header, [data-not-for-teacher]') && c.type !== 'file' && c.type !== 'hidden' && !c.dataset.step && !/ step \d+( value)?$/.test(c.getAttribute('aria-label') || '');
const kindOf = c => (c.tagName === 'SELECT' ? 'select' : c.tagName === 'BUTTON' ? 'button' : c.type === 'checkbox' ? 'checkbox' : c.type === 'range' || c.type === 'number' ? 'number' : 'text');

// The controls of one widget: { label, kind, el }, with repeated labels numbered ("Arm 1", "Arm 2").
export function controls(w) {
 const list = [...w.el.querySelectorAll('input, select, button, textarea')].filter(usable).map(el => ({ label: labelOf(el), kind: kindOf(el), el }));
 const count = {};
 list.forEach(c => { count[c.label] = (count[c.label] || 0) + 1; });
 const seen = {};
 list.forEach(c => { if (count[c.label] > 1) c.label = `${c.label} ${(seen[c.label] = (seen[c.label] || 0) + 1)}`; });
 return list.filter(c => c.label);
}

const optionText = (sel, value) => clean([...sel.options].find(o => o.value === String(value))?.textContent ?? value);
export function valueOf(c) {
 const el = c.el || c;
 if (el.tagName === 'SELECT') return optionText(el, el.value);
 if (el.type === 'checkbox') return el.checked ? 'on' : 'off';
 if (el.tagName === 'BUTTON') return null;
 return el.value;
}
const range = el => (el.tagName === 'SELECT' ? [...el.options].map(o => clean(o.textContent)).join(', ') : el.type === 'range' || el.type === 'number' ? [el.min, el.max].filter(v => v !== '').join(' to ') : '');

// What a widget is doing, where its controls alone don't say.
function status(w) {
 const q = s => w.el.querySelectorAll(s);
 if (w.id === 'step-sequencer') {
  const on = q('[data-step][aria-pressed="true"]').length, play = w.el.querySelector('#seq-play');
  return `${on} step${on === 1 ? '' : 's'} on, ${play && !/Play/.test(play.textContent) ? 'playing' : 'stopped'}`;
 }
 if (w.id === 'looper-module') return [...q('.loop-slot-status')].map((s, i) => `slot ${i + 1}: ${clean(s.textContent)}`).join(', ');
 if (w.id === 'plugin-host-module') {
  const rows = [...q('.plugin-row')].map(r => `${clean(r.querySelector('strong')?.textContent)}${r.querySelector('input[type=checkbox]')?.checked ? ' (bypassed)' : ''}`);
  return rows.length ? `loaded: ${rows.join(', ')}` : 'no plug-ins loaded';
 }
 if (w.id === 'automation') {
  const lanes = [...q('input[type=checkbox]')].map(c => `${labelOf(c)} ${c.checked ? 'on' : 'off'}`);
  return lanes.length ? `lanes: ${lanes.join(', ')}` : 'no lanes';
 }
 return '';
}

/* ---- What the model reads ---- */

// One line per widget, and for the widgets in `focus`, every control with its value and range. Kept short,
// since an on-device model has little room.
export function describe(focus = []) {
 const all = widgets();
 const line = w => `${w.title}${w.plugin ? ' (plug-in window)' : ''}${w.hidden ? ' [hidden]' : w.minimized ? ' [minimised]' : ''}${status(w) ? `: ${status(w)}` : ''}`;
 const out = [`Widgets: ${all.map(line).join('; ')}.`];
 for (const w of all.filter(x => focus.includes(x.id))) {
  const items = controls(w).filter(c => c.kind !== 'button').map(c => `${c.label} = ${valueOf(c)}${range(c.el) ? ` (${range(c.el)})` : ''}`);
  const buttons = controls(w).filter(c => c.kind === 'button').map(c => c.label);
  out.push(`${w.title} controls: ${items.join('; ') || 'none'}${buttons.length ? `. Buttons: ${buttons.join(', ')}` : ''}.`);
 }
 return out.join('\n');
}

// The widgets a question is about: named outright, or through one of their controls or `keywords` (lists of
// words by widget title).
export function relevant(question, keywords = {}, max = 2) {
 const q = ` ${norm(question)} `;
 const has = s => { const n = norm(s); return n.length > 2 && q.includes(` ${n} `); };
 return widgets().map(w => {
  let score = has(w.title) ? 5 : 0;
  for (const word of keywords[w.title] || []) if (has(word)) score += 3;
  // Buttons and short labels ("▶ Play", "Key", "On") are words every request uses; they don't count.
  for (const c of controls(w)) { const label = c.label.replace(/\s*\(.*\)$/, ''); if (c.kind !== 'button' && label.length >= 5 && has(label)) score += 2; }
  return { id: w.id, score };
 }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).filter((x, _, all) => x.score * 2 > all[0].score).slice(0, max).map(x => x.id); // a clear favourite stands alone
}

/* ---- Finding, showing and setting ---- */

// "Filter › Cutoff", "filter > cutoff", "filter/cutoff", "Cutoff (Hz)", "filterCutoff" or "Filter" → { widget,
// control } (control is null for a whole widget), or null. Exact names win over partial ones. A slash only
// separates when it has no spaces round it: "Import / Export" is one widget.
export function find(name) {
 const raw = String(name ?? '').trim();
 if (!raw) return null;
 const byId = document.getElementById(raw);
 if (byId && !byId.closest('#teacher-panel')) {
  const w = widgets().find(x => x.el.contains(byId));
  if (w) return { widget: w, control: w.el === byId ? null : controls(w).find(c => c.el === byId) || null };
 }
 const [a, b] = /[›>]/.test(raw) ? raw.split(/\s*[›>]\s*/) : raw.split(/(?<=\S)\/(?=\S)/);
 const score = (text, want) => { const t = norm(text), s = norm(want), bare = norm(String(text).replace(/\s*\(.*\)$/, '')); return !s ? 0 : t === s || bare === s ? 3 : t.startsWith(s) || bare.startsWith(s) ? 2 : t.includes(s) ? 1 : 0; };
 let best = null;
 for (const w of widgets()) {
  const ws = score(w.title, a);
  if (b === undefined && ws) { const s = ws * 10; if (!best || s > best.s) best = { s, widget: w, control: null }; }
  for (const c of controls(w)) {
   const s = b === undefined ? score(c.label, a) * 3 : ws ? ws * 4 + score(c.label, b) * 5 - (score(c.label, b) ? 0 : 100) : 0;
   if (s > 0 && (!best || s > best.s)) best = { s, widget: w, control: c };
  }
 }
 if (!best && b !== undefined) return find(a) || find(b); // "Delay › Wet" with no Wet: the Delay, or a Wet elsewhere
 return best && { widget: best.widget, control: best.control };
}
export const nameOf = ({ widget, control }) => (control ? `${widget.title} › ${control.label}` : widget.title);

// Brings a widget into view: shown again if hidden, expanded if minimised, a plug-in window opened. Uses the
// page's own buttons, so the layout is saved as usual.
export function reveal(w) {
 if (w.menu) { const m = w.el.closest('details'); if (m) m.open = true; return; }
 if (w.plugin) {
  if (w.el.hidden) [...document.querySelectorAll('#plugin-host-module .plugin-row')].find(r => clean(r.querySelector('strong')?.textContent) === w.title)?.querySelector('button')?.click();
  return;
 }
 if (w.el.hidden) [...document.querySelectorAll('.widget-menu-body label')].find(l => clean(l.textContent) === w.title)?.querySelector('input')?.click();
 if (w.el.classList.contains('minimized')) w.el.querySelector('.min-btn')?.click();
}

// Points at a widget or control: reveals it, scrolls to it and makes it pulse for a few seconds.
export function show(name) {
 const hit = typeof name === 'string' ? find(name) : name;
 if (!hit) return null;
 reveal(hit.widget);
 const target = hit.control?.el.closest('label, .plugin-param') || hit.control?.el || hit.widget.el;
 target.scrollIntoView({ block: 'center', behavior: 'smooth' });
 target.classList.remove('teach-highlight'); void target.offsetWidth; target.classList.add('teach-highlight');
 setTimeout(() => target.classList.remove('teach-highlight'), 4000);
 return nameOf(hit);
}

// Sets a control as if the student had: the value is matched to an option's value or text, clamped to the
// slider's range, and the control's own input and change events fire. Returns { name, from, to } (from is
// the raw value, for undo), or throws with a reason the teacher can show.
export function set(name, value) {
 const hit = typeof name === 'string' ? find(name) : name;
 if (!hit?.control) throw new Error(`There is no control called "${name}".`);
 const el = hit.control.el, from = el.type === 'checkbox' ? el.checked : el.value;
 if (hit.control.kind === 'button' || hit.control.kind === 'text') throw new Error(`${nameOf(hit)} is something to press or type in yourself.`);
 reveal(hit.widget);
 if (el.tagName === 'SELECT') {
  const want = norm(value), opt = [...el.options].find(o => o.value === String(value)) || [...el.options].find(o => norm(o.textContent) === want) || [...el.options].find(o => norm(o.textContent).startsWith(want));
  if (!opt) throw new Error(`${nameOf(hit)} has no option "${value}".`);
  el.value = opt.value;
 } else if (el.type === 'checkbox') {
  el.checked = typeof value === 'boolean' ? value : !/^(off|false|0|no|disabled?)$/i.test(String(value));
 } else {
  let n = Number(String(value).replace(/[^0-9.\-e]/gi, ''));
  if (!Number.isFinite(n)) throw new Error(`${nameOf(hit)} needs a number.`);
  if (el.min !== '') n = Math.max(Number(el.min), n);
  if (el.max !== '') n = Math.min(Number(el.max), n);
  el.value = n;
 }
 el.dispatchEvent(new Event('input', { bubbles: true }));
 el.dispatchEvent(new Event('change', { bubbles: true }));
 show(hit);
 return { name: nameOf(hit), from, to: valueOf(el) };
}
// Hides, shows or minimises a widget with the page's own controls (the Settings menu's switch, its – button),
// so the layout is saved as usual. `to` is 'hidden', 'shown' or 'minimised'. Returns { name, from, to }.
export const LAYOUTS = ['shown', 'hidden', 'minimised'];
export const layoutOf = w => (w.hidden ? 'hidden' : w.minimized ? 'minimised' : 'shown');
export function arrange(name, to) {
 const hit = typeof name === 'string' ? find(name) : name, w = hit?.widget;
 if (!w || hit.control || w.plugin || w.menu || !LAYOUTS.includes(to)) throw new Error(`${name} can't be ${to}.`);
 const from = layoutOf(w);
 const menuSwitch = () => [...document.querySelectorAll('.widget-menu-body > label')].find(l => clean(l.textContent) === w.title)?.querySelector('input');
 if (to === 'hidden') { if (!w.el.hidden) menuSwitch()?.click(); }
 else {
  reveal(w);
  if (to === 'minimised' && !w.el.classList.contains('minimized')) w.el.querySelector('.min-btn')?.click();
 }
 if (to !== 'hidden') show({ widget: { ...w, hidden: false }, control: null });
 return { name: w.title, from, to };
}
// Puts a control back to a raw value saved by set(), or a widget to a layout saved by arrange().
export function restore(name, raw) {
 const hit = find(name);
 if (hit && !hit.control && LAYOUTS.includes(raw)) { arrange(hit, raw); return true; }
 if (!hit?.control) return false;
 const el = hit.control.el;
 if (el.type === 'checkbox') el.checked = raw; else el.value = raw;
 el.dispatchEvent(new Event('input', { bubbles: true }));
 el.dispatchEvent(new Event('change', { bubbles: true }));
 return true;
}

// Every control the teacher may change and every widget it may arrange, as js/commands.js reads them.
// `more(widget, control)` adds what else is known about a control (a plug-in's learned words and unit).
export function commandItems(more = () => ({})) {
 const out = [];
 for (const w of widgets()) {
  if (!w.plugin && !w.menu) out.push({ name: w.title, widget: w.title, label: w.title, id: w.id, kind: 'widget', value: layoutOf(w) });
  for (const c of controls(w)) {
   if (!['number', 'select', 'checkbox'].includes(c.kind)) continue;
   const e = c.el;
   out.push({ name: nameOf({ widget: w, control: c }), widget: w.title, label: c.label, id: e.id, kind: c.kind, min: e.min ?? '', max: e.max ?? '', step: e.step ?? '',
    value: c.kind === 'checkbox' ? e.checked : c.kind === 'number' ? Number(e.value) : e.value,
    options: c.kind === 'select' ? [...e.options].map(o => ({ value: o.value, text: clean(o.textContent) })) : undefined, ...more(w, c) });
  }
 }
 return out;
}

/* ---- What the workspace lessons check ---- */

// Buttons the student pressed recently, by label: some tasks (Export MIDI) leave nothing else to check.
const pressed = [];
if (typeof document !== 'undefined') document.addEventListener('click', e => {
 const b = e.target.closest?.('button');
 if (b && !b.closest('#teacher-panel')) { pressed.push(labelOf(b)); if (pressed.length > 20) pressed.shift(); }
}, true);

// A snapshot for workspace lessons. `value` takes an element id or a "Widget › Control" name.
export function state() {
 const value = ref => { const el = document.getElementById(ref) || find(ref)?.control?.el; return !el ? null : el.type === 'checkbox' ? el.checked : el.value; };
 const plugins = [...document.querySelectorAll('#plugin-host-module .plugin-row strong')].map(s => clean(s.textContent));
 let edits = false;
 try { edits = (JSON.parse(localStorage.getItem('synth-web-plugins-v1')) || []).some(r => Object.keys(r.values || {}).length); } catch { /* none */ }
 const stepValues = [...document.querySelectorAll('#automation input[type=number]')].filter(i => / step \d+ value$/.test(i.getAttribute('aria-label') || '')).map(i => i.value);
 return {
  value,
  minimized: widgets().filter(w => w.minimized).map(w => w.id),
  seqSteps: document.querySelectorAll('#step-sequencer [data-step][aria-pressed="true"]').length,
  seqPlaying: !/Play/.test(document.querySelector('#seq-play')?.textContent || 'Play'),
  loops: [...document.querySelectorAll('.loop-slot-status')].map(s => /\(\d/.test(s.textContent) && !/Abort/.test(s.textContent)),
  lanesOn: [...document.querySelectorAll('#automation input[type=checkbox]')].filter(c => c.checked).length,
  automationShaped: new Set(stepValues).size > 1,
  plugins, pluginEdits: edits,
  pressed: [...pressed],
 };
}
