// The page's half of VSTGUI's web platform (native/vstgui-web): what a VSTGUI editor compiled into a VST3 module
// asks the page for (its "vstgui" imports) — drawing on a canvas with Canvas 2D, bitmaps decoded by the browser
// from the PNGs in the bundle's Contents/Resources, the browser's fonts, setInterval timers, the .uidesc and
// other resources, the clipboard — and the adapter that shows such an editor in a plug-in window
// (js/plugin-editor.js). The editor runs in its own instance of the plug-in's module on this thread: its
// controller is the plug-in's, its edits go to the processor in the AudioWorklet, the processor's meters
// come back to it, and if it fails only it goes (the audio and the generic controls carry on).
import { Vst3Module } from './vst3-runtime.js';
import { registerAdapter } from './plugin-editor.js';

const CAPS = ['butt', 'round', 'square'], JOINS = ['miter', 'round', 'bevel'];
const CURSORS = ['default', 'wait', 'ew-resize', 'ns-resize', 'move', 'nesw-resize', 'nwse-resize', 'copy', 'not-allowed', 'pointer'];
const BOLD = 2, ITALIC = 4, UNDERLINE = 8, STRIKE = 16;
const rgba = (r, g, b, a) => `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
const offscreen = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

// The "vstgui" imports for one editor instance. `mod` is its Vst3Module (for its memory), `surface` the canvas
// it draws on (js/plugin-editor.js), `resources` the bundle's Contents/Resources files by name, `images` their
// decoded PNGs by name. on.invalidate() asks for a frame, on.timer(id) runs a VSTGUI timer.
export function vstguiImports({ mod, surface, resources, images, on }) {
 const mem = () => mod.x.memory.buffer;
 const f64 = (ptr, n) => new Float64Array(mem(), ptr, n);
 const text = ptr => mod.string(ptr);
 const bitmaps = new Map(); // id → { canvas or image, w, h }
 let nextBitmap = 1, ctx = null, font = '12px Arial, sans-serif', fontStyle = 0;
 const targets = [];
 const measure = offscreen(1, 1).getContext('2d');
 const timers = new Map();
 const pathOf = (ptr, count, into) => {
  const ops = f64(ptr, count);
  for (let i = 0; i < count;) {
   const op = ops[i];
   if (op === 0) { into.moveTo(ops[i + 1], ops[i + 2]); i += 3; }
   else if (op === 1) { into.lineTo(ops[i + 1], ops[i + 2]); i += 3; }
   else if (op === 2) { into.bezierCurveTo(ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 4], ops[i + 5], ops[i + 6]); i += 7; }
   else if (op === 3) { into.ellipse(ops[i + 1], ops[i + 2], Math.max(0, ops[i + 3]), Math.max(0, ops[i + 4]), 0, ops[i + 5], ops[i + 6], !!ops[i + 7]); i += 8; }
   else if (op === 4) { into.rect(ops[i + 1], ops[i + 2], ops[i + 3], ops[i + 4]); i += 5; }
   else { into.closePath(); i += 1; }
  }
 };
 const canvasOf = id => {
  const b = bitmaps.get(id);
  if (!b) return null;
  if (!b.canvas) { // a loaded image is copied to a canvas the first time it is drawn into or read
   b.canvas = offscreen(b.w, b.h);
   b.canvas.getContext('2d').drawImage(b.image, 0, 0);
  }
  return b.canvas;
 };
 const imports = {
  begin(target, scale) {
   targets.push(ctx);
   ctx = target ? canvasOf(target).getContext('2d') : surface.ctx;
   ctx.save();
   ctx.setTransform(scale, 0, 0, scale, 0, 0);
  },
  end() { ctx?.restore(); ctx = targets.pop() || null; },
  save() { ctx.save(); },
  restore() { ctx.restore(); },
  clip(x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); },
  transform(a, b, c, d, e, f) { ctx.transform(a, b, c, d, e, f); },
  alpha(a) { ctx.globalAlpha = a; },
  fill_color(r, g, b, a) { ctx.fillStyle = rgba(r, g, b, a); },
  stroke_color(r, g, b, a) { ctx.strokeStyle = rgba(r, g, b, a); },
  line_style(width, cap, join, dashPtr, dashCount, phase) {
   ctx.lineWidth = width; ctx.lineCap = CAPS[cap] || 'butt'; ctx.lineJoin = JOINS[join] || 'miter';
   ctx.setLineDash(dashCount ? Array.from(f64(dashPtr, dashCount)) : []); ctx.lineDashOffset = phase;
  },
  path(ptr, count) { ctx.beginPath(); pathOf(ptr, count, ctx); },
  fill(evenOdd) { ctx.fill(evenOdd ? 'evenodd' : 'nonzero'); },
  stroke() { ctx.stroke(); },
  hit(ptr, count, x, y, evenOdd) { const p = new Path2D(); pathOf(ptr, count, p); return measure.isPointInPath(p, x, y, evenOdd ? 'evenodd' : 'nonzero') ? 1 : 0; },
  gradient(radial, x0, y0, r0, x1, y1, r1, stopsPtr, count) {
   const g = radial ? ctx.createRadialGradient(x0, y0, r0, x1, y1, r1) : ctx.createLinearGradient(x0, y0, x1, y1);
   const s = f64(stopsPtr, count * 5);
   for (let i = 0; i < count; i++) g.addColorStop(Math.min(1, Math.max(0, s[i * 5])), rgba(s[i * 5 + 1], s[i * 5 + 2], s[i * 5 + 3], s[i * 5 + 4]));
   ctx.fillStyle = g;
  },
  clear(x, y, w, h) { ctx.clearRect(x, y, w, h); },
  image(id, sx, sy, sw, sh, dx, dy, dw, dh, alpha, smooth) {
   const b = bitmaps.get(id);
   if (!b || sw <= 0 || sh <= 0) return;
   // The part outside the bitmap is left undrawn, as VSTGUI's other backends do: the destination shrinks with it.
   const kx = dw / sw, ky = dh / sh;
   if (sx < 0) { dx -= sx * kx; dw += sx * kx; sw += sx; sx = 0; }
   if (sy < 0) { dy -= sy * ky; dh += sy * ky; sh += sy; sy = 0; }
   if (sx + sw > b.w) { const cut = sx + sw - b.w; sw -= cut; dw -= cut * kx; }
   if (sy + sh > b.h) { const cut = sy + sh - b.h; sh -= cut; dh -= cut * ky; }
   if (sw <= 0 || sh <= 0) return;
   ctx.save(); ctx.globalAlpha *= alpha; ctx.imageSmoothingEnabled = !!smooth;
   ctx.drawImage(b.canvas || b.image, sx, sy, sw, sh, dx, dy, dw, dh);
   ctx.restore();
  },
  font(familyPtr, size, style) {
   const family = text(familyPtr) || 'Arial';
   font = `${style & ITALIC ? 'italic ' : ''}${style & BOLD ? 'bold ' : ''}${size}px "${family.replace(/"/g, '')}", Arial, sans-serif`;
   fontStyle = style;
  },
  font_metrics(outPtr) {
   measure.font = font;
   const m = measure.measureText('ÀMgjy'), h = measure.measureText('H');
   const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent, descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
   f64(outPtr, 4).set([ascent, descent, 0, h.actualBoundingBoxAscent]);
  },
  text_width(ptr) { measure.font = font; return measure.measureText(text(ptr)).width; },
  text(ptr, x, y, style) {
   const t = text(ptr);
   ctx.font = font; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
   ctx.fillText(t, x, y);
   if (style & (UNDERLINE | STRIKE)) {
    const w = ctx.measureText(t).width, size = parseFloat(font.match(/(\d+(?:\.\d+)?)px/)?.[1] || 12);
    ctx.fillRect(x, style & UNDERLINE ? y + size * 0.12 : y - size * 0.3, w, Math.max(1, size / 14));
   }
  },
  bitmap_new(w, h) { const id = nextBitmap++; bitmaps.set(id, { canvas: offscreen(Math.max(1, w), Math.max(1, h)), w, h }); return id; },
  bitmap_load(namePtr, sizePtr) {
   const name = text(namePtr), image = images.get(name) || images.get(name.split('/').pop());
   if (!image) return 0;
   const id = nextBitmap++;
   bitmaps.set(id, { image, w: image.width, h: image.height });
   new Int32Array(mem(), sizePtr, 2).set([image.width, image.height]);
   return id;
  },
  bitmap_free(id) { bitmaps.delete(id); },
  bitmap_read(id, ptr, premultiplied) {
   const b = bitmaps.get(id), c = canvasOf(id);
   if (!c) return;
   const data = c.getContext('2d').getImageData(0, 0, b.w, b.h).data, out = new Uint8Array(mem(), ptr, b.w * b.h * 4);
   out.set(data);
   if (premultiplied) for (let i = 0; i < out.length; i += 4) { const a = out[i + 3] / 255; out[i] *= a; out[i + 1] *= a; out[i + 2] *= a; }
  },
  bitmap_write(id, ptr, premultiplied) {
   const b = bitmaps.get(id), c = canvasOf(id);
   if (!c) return;
   const px = new Uint8ClampedArray(new Uint8Array(mem(), ptr, b.w * b.h * 4));
   if (premultiplied) for (let i = 0; i < px.length; i += 4) { const a = px[i + 3] / 255 || 1; px[i] /= a; px[i + 1] /= a; px[i + 2] /= a; }
   c.getContext('2d').putImageData(new ImageData(px, b.w, b.h), 0, 0);
  },
  resource_size(namePtr) { const r = resources.get(text(namePtr)); return r ? r.length : -1; },
  resource_read(namePtr, to) { const r = resources.get(text(namePtr)); if (r) new Uint8Array(mem(), to, r.length).set(r); },
  invalidate() { on.invalidate?.(); },
  cursor(type) { surface.canvas.style.cursor = CURSORS[type] || 'default'; },
  tooltip(ptr) { surface.canvas.title = text(ptr); },
  timer_start(id, ms) { clearInterval(timers.get(id)); timers.set(id, setInterval(() => on.timer(id), Math.max(4, ms))); },
  timer_stop(id) { clearInterval(timers.get(id)); timers.delete(id); },
  clipboard(ptr) { navigator.clipboard?.writeText(text(ptr)).catch(() => {}); },
 };
 return { imports, stop: () => { timers.forEach(clearInterval); timers.clear(); bitmaps.clear(); } };
}

/* ---- Input, as VSTGUI reads it ---- */

const VIRTUAL = { Backspace: 1, Tab: 2, Clear: 3, Enter: 4, Pause: 5, Escape: 6, ' ': 7, End: 9, Home: 10, ArrowLeft: 11, ArrowUp: 12, ArrowRight: 13, ArrowDown: 14, PageUp: 15, PageDown: 16, Insert: 21, Delete: 22, Help: 23, NumLock: 52, ScrollLock: 53, Shift: 54, Control: 55, Alt: 56 };
for (let i = 1; i <= 12; i++) VIRTUAL[`F${i}`] = 39 + i;
// Shift, Alt, then Control as VSTGUI means it: the Command key on a Mac, Control elsewhere; Super is the other.
const mac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || navigator.userAgent);
export const modifierBits = e => (e.shift ? 1 : 0) | (e.alt ? 2 : 0) | ((mac ? e.command : e.control) ? 4 : 0) | ((mac ? e.control : e.command) ? 8 : 0);
const BUTTON = [1, 4, 2]; // DOM button 0 left, 1 middle, 2 right → VSTGUI's bits
export const keyCodes = e => ({ virt: VIRTUAL[e.key] || 0, character: e.key.length === 1 || [...e.key].length === 1 ? e.key.codePointAt(0) : e.key === 'Enter' ? 13 : 0 });

/* ---- The adapter ---- */

// A plug-in (js/plugin-host.js) that can have a VSTGUI editor gives: module (its WebAssembly.Module), classIndex,
// values() (its parameters' current normalized values), resources() (its Contents/Resources files by name),
// send(message) (a controller message for the processor), and connect({ output, message }) for what the
// processor sends back.
export const VSTGUI_ADAPTER = registerAdapter({
 id: 'vstgui', label: 'VSTGUI',
 async open({ surface, plugin, bridge }) {
  if (!plugin.module || !plugin.resources) return null;
  const resources = await plugin.resources();
  const images = new Map();
  await Promise.all([...resources].filter(([name]) => /\.png$/i.test(name)).map(async ([name, bytes]) => {
   images.set(name, await createImageBitmap(new Blob([bytes], { type: 'image/png' })));
  }));
  let mod = null, platform = null, wanted = true, closed = false;
  const fail = err => { if (!closed) bridge.fail(`The editor crashed: ${err.message || err}`); };
  const guard = fn => (...a) => { if (closed || !mod) return 0; try { return fn(...a); } catch (err) { fail(err); return 0; } };
  mod = new Vst3Module(plugin.module, m => {
   platform = vstguiImports({ mod: m, surface, resources, images, on: { invalidate: () => { wanted = true; }, timer: guard(id => m.x.vst3web_view_timer(id)) } });
   return {
    vstgui: platform.imports,
    vst3web: {
     // The editor moved a control: the processor and the generic controls follow.
     edit: (kind, id, value) => (kind === 1 ? bridge.edit(id, value) : kind === 0 ? bridge.begin(id) : bridge.end(id)),
     restart: () => {},
     message: (ptr, length) => plugin.send(m.bytes(ptr, length)),
     resize_view: (w, h) => { surface.resize(w, h); wanted = true; return 1; },
    },
   };
  });
  mod.open(plugin.classIndex, 48000, 128, 2); // the controller half: its messages go to the processor in the worklet
  for (const { id, value } of plugin.values()) mod.x.vst3web_controller_set(id, value);
  const size = mod.x.malloc(12), dims = () => Array.from(new Int32Array(mod.x.memory.buffer, size, 3));
  const opened = mod.x.vst3web_view_open(size);
  if (opened !== 0) {
   mod.x.free(size); mod.close();
   if (opened === -2) return null; // createView gave nothing: no editor
   throw new Error(opened === -3 ? 'it offers no platform type a browser can host' : opened === -1 ? 'the plug-in has no controller' : `it would not attach (${opened})`);
  }
  const [width, height, resizable] = dims();
  surface.size(width, height);
  // Its window is active from the start, as one a desktop host opens; VSTGUI gives views focus only then.
  mod.x.vst3web_view_focus(1);
  const disconnect = plugin.connect({
   output: guard((id, value) => mod.x.vst3web_controller_set(id, value)),
   message: guard(bytes => mod.deliver(bytes)),
  });
  const press = new Set();
  const editor = {
   get width() { return surface.width; }, get height() { return surface.height; }, resizable: !!resizable,
   // Draws what VSTGUI marked as changed; the first time, all of it.
   frame: first => { if (!wanted && !first) return false; wanted = false; return !!mod.x.vst3web_view_draw(surface.scale) || first; },
   resize: (w, h) => { const out = mod.x.malloc(8); mod.x.vst3web_view_resize(Math.round(w), Math.round(h), out); const [rw, rh] = new Int32Array(mod.x.memory.buffer, out, 2); mod.x.free(out); surface.size(rw, rh); wanted = true; return true; },
   pointer: e => {
    const type = { down: 0, move: 1, up: 2, leave: 3 }[e.type];
    let buttons = e.buttons ?? 0;
    if (e.type === 'down') press.add(BUTTON[e.button] ?? 1);
    if (e.type === 'up') { buttons = BUTTON[e.button] ?? 1; press.delete(buttons); }
    mod.x.vst3web_view_mouse(type, e.x, e.y, buttons, modifierBits(e), e.clicks || 1);
    wanted = true;
   },
   wheel: e => { mod.x.vst3web_view_wheel(e.x, e.y, -e.dx / 100, -e.dy / 100, modifierBits(e)); wanted = true; },
   key: e => { const { virt, character } = keyCodes(e); const used = mod.x.vst3web_view_key(e.type === 'down' ? 1 : 0, virt, character, modifierBits(e), 0); wanted = true; return !!used; },
   // The canvas lost focus: the window is inactive, and an open text edit commits what was typed.
   focus: on => { mod.x.vst3web_view_focus(on ? 1 : 0); wanted = true; },
   // A generic control moved: the editor's controller shows it (VSTGUI redraws the control from it).
   param: (id, value) => { mod.x.vst3web_controller_set(Number(id), value); wanted = true; },
   close: () => { closed = true; disconnect(); platform?.stop(); try { mod.x.vst3web_view_close(); mod.x.free(size); mod.close(); } catch { /* it is going anyway */ } },
  };
  return editor;
 },
});
