// A floating window for one plug-in, styled like a workspace widget. Drag it by its title bar (arrow keys move
// it too), resize it from the grip in its corner, and close it with × or Escape; the plug-in keeps running while
// its window is closed. `state` holds { x, y, w, h, open } and is kept up to date so the caller can persist it.
import { el } from './plugin-ui.js';
import { marker, resizeGrip } from './widgets.js';

let layer, front = 1000, cascade = 0;
const windows = new Set();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function pluginWindow({ title, state, opener, onChange }) {
 if (!layer) {
  layer = document.body.appendChild(el('div', { className: 'plugin-windows' }));
  window.addEventListener('resize', () => windows.forEach(w => w.place()));
 }
 const name = el('span', { textContent: title });
 const handle = el('button', { className: 'drag-handle', title: 'Drag to move. Use arrow keys to move.' }, '⠿ ', name);
 const close = el('button', { textContent: '×', title: `Close ${title}` });
 const content = el('div', { className: 'module-content' });
 const header = el('div', { className: 'widget-header' }, handle, close);
 const win = el('section', { className: 'widget plugin-window', hidden: true }, header, content);
 win.setAttribute('role', 'dialog'); win.setAttribute('aria-label', title);
 layer.append(win);
 // Any size from 260 × 160 up to the window; the size is kept with its position.
 const fit = () => {
  win.style.width = state.w ? `${Math.min(state.w, innerWidth - 24)}px` : '';
  win.style.height = state.h ? `${Math.min(state.h, innerHeight - 24)}px` : '';
  win.style.maxHeight = state.h ? 'none' : '';
 };
 win.append(resizeGrip(win, { name: title,
  onMove: (dx, dy, start) => { state.w = Math.max(260, Math.round(start.width + dx)); state.h = Math.max(160, Math.round(start.height + dy)); fit(); },
  onEnd: () => onChange?.(true),
  onReset: () => { delete state.w; delete state.h; fit(); } }));
 fit();
 // New windows cascade down from the top right, clear of the keyboard in the default layout.
 if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) { state.x = innerWidth - 484 - (cascade % 8) * 28; state.y = 90 + (cascade % 8) * 28; cascade++; }

 // Windows stay on screen and clear of the AI teacher's panel when it is open beside the workspace.
 const room = () => innerWidth - (document.documentElement.classList.contains('teacher-open') && innerWidth >= 900 ? document.getElementById('teacher-panel')?.offsetWidth || 0 : 0);
 const place = () => {
  if (win.hidden) return;
  const margin = 12; // keep the window, or at least its title bar, on screen
  state.x = Math.round(clamp(state.x, margin, Math.max(margin, room() - win.offsetWidth - margin)));
  state.y = Math.round(clamp(state.y, margin, Math.max(margin, innerHeight - 48)));
  win.style.left = `${state.x}px`; win.style.top = `${state.y}px`;
 };
 const raise = () => { win.style.zIndex = ++front; };
 const show = open => {
  if (!open && win.contains(document.activeElement)) opener?.focus();
  win.hidden = !open; state.open = open;
  if (open) { raise(); place(); }
  onChange?.(open);
 };
 win.addEventListener('pointerdown', raise);
 win.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); show(false); } });
 close.onclick = () => show(false);

 let drag = null;
 // While it moves, an empty dashed outline marks where it was lifted from.
 handle.onpointerdown = e => { if (e.button !== 0) return; drag = { dx: e.clientX - state.x, dy: e.clientY - state.y, from: win.getBoundingClientRect(), liftoff: null }; handle.setPointerCapture(e.pointerId); };
 handle.onpointermove = e => {
  if (!drag) return;
  if (!drag.liftoff) { drag.liftoff = marker(drag.from, 'liftoff'); drag.liftoff.style.position = 'fixed'; drag.liftoff.style.left = `${drag.from.left}px`; drag.liftoff.style.top = `${drag.from.top}px`; drag.liftoff.style.zIndex = front; win.classList.add('moving'); }
  state.x = e.clientX - drag.dx; state.y = e.clientY - drag.dy; place();
 };
 handle.onpointerup = handle.onpointercancel = () => { if (drag) { drag.liftoff?.remove(); win.classList.remove('moving'); drag = null; onChange?.(true); } };
 handle.onkeydown = e => {
  const step = e.shiftKey ? 80 : 20, move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (!move) return;
  e.preventDefault(); state.x += move[0]; state.y += move[1]; place(); onChange?.(true);
 };

 const api = {
  content, place, show,
  // The title bar, for controls that belong to the window (the Editor / Generic switch), before ×.
  addToHeader: node => header.insertBefore(node, close),
  // Makes the window wide enough for content `w` px wide (a plug-in editor's own size), unless the student has
  // sized it themselves; its height follows its content, up to the screen.
  fitContent: w => {
   if (state.w || state.h) return;
   const pad = parseFloat(getComputedStyle(content).paddingLeft) + parseFloat(getComputedStyle(content).paddingRight);
   win.style.width = `${Math.min(innerWidth - 24, Math.max(260, Math.ceil(w + pad + win.offsetWidth - content.clientWidth)))}px`;
   win.style.maxHeight = 'calc(100vh - 24px)';
   place();
  },
  get open() { return !win.hidden; },
  toggle: () => show(win.hidden),
  setTitle: text => { name.textContent = text; close.title = `Close ${text}`; win.setAttribute('aria-label', text); },
  remove: () => { windows.delete(api); win.remove(); }
 };
 windows.add(api);
 if (state.open) show(true);
 return api;
}
