// What a plug-in window shows: the plug-in's own editor where it has one, and its generic controls always.
// Every GUI framework (VSTGUI, iPlug2, DPF, JUCE, GL editors) sits behind one adapter interface, chosen from
// what the plug-in's bundle declares; the generic controls are built first, so they exist even if the
// editor never loads, and are what the window falls back to, with a notice, when the editor:
// - doesn't exist (no editor, or none for a platform type we offer),
// - is built with a framework we can't show yet,
// - throws or traps while opening,
// - draws no first frame within FIRST_FRAME_MS, or a blank one,
// - fails later (its frame or an input handler throws, or it reports a crash): it is torn down, and the
//   audio, which runs in the AudioWorklet's own instance, carries on untouched.
// An Editor / Generic switch in every window's title bar flips between them; the choice is kept per plug-in.
// Edits in either reach the processor and show in the other.
//
// An adapter is { id, label, surface ('2d' or 'webgl2'), open({ surface, plugin, bridge }) → Promise<editor | null> }. The editor is
// { width, height, resizable, frame() (draws; true when it drew), resize?(w, h) → bool, pointer?(e), wheel?(e),
// key?(e), focus?(on), param?(id, value) (a generic control moved: frameworks that don't watch the controller
// themselves redraw from it), close() }; it calls bridge.edit(id, value) (and bridge.begin/end) when the user moves a
// control, bridge.fail(reason) when it breaks, and surface.resize(w, h) when it asks to be another size.

export const NOTICE = 'Editor unavailable, showing generic controls';
export const FIRST_FRAME_MS = 2000;

// What each framework's editors need here, and how far that has got (the README's table says the same).
export const FRAMEWORKS = {
 vstgui: { label: 'VSTGUI', status: 'supported' },
 iplug2: { label: 'iPlug2', status: 'fallback', why: 'iPlug2 editors are not built into WebAssembly bundles yet' },
 dpf: { label: 'DPF', status: 'fallback', why: 'DPF editors are not built into WebAssembly bundles yet' },
 juce: { label: 'JUCE', status: 'fallback', why: 'JUCE has no browser backend yet' },
 gl: { label: 'OpenGL / ImGui / NanoVG', status: 'fallback', why: 'GL editors are not mapped to WebGL yet' },
 imgui: { label: 'Dear ImGui', status: 'fallback', why: 'GL editors are not mapped to WebGL yet' },
 'vstgui-native': { label: 'VSTGUI', status: 'fallback', why: 'this build of it has no browser platform (rebuild it with native/build.sh and GUI vstgui)' },
 native: { label: 'Cocoa, Win32 or X11 directly', status: 'fallback', why: 'editors drawn with an operating system\'s own windows can\'t run in a browser' },
};
const adapters = new Map();
export const registerAdapter = adapter => { adapters.set(adapter.id, adapter); return adapter; };
// For tests: the framework a plug-in (by name) is treated as having, whatever it declares.
export const overrides = new Map();
// The adapter for a plug-in's editor: { adapter } to try, or { reason } why there is none to try; `quiet` when
// the plug-in is of a kind that never has one (a plain web effect), so there is nothing to tell.
export function adapterFor(plugin) {
 const framework = overrides.get(plugin.name) ?? plugin.editor?.framework;
 if (!framework) return { reason: 'This plug-in has no editor.', quiet: !plugin.editor };
 if (framework === 'none') return { reason: 'This plug-in has no editor.' };
 const adapter = adapters.get(framework);
 if (adapter) return { adapter };
 const known = FRAMEWORKS[framework];
 return { reason: known ? `Its ${known.label} editor can't be shown here: ${known.why}.` : `Its editor uses ${framework}, which can't be shown here.` };
}

/* ---- Shared services for every adapter ---- */

// A canvas the editor draws into, sized in CSS pixels and backed at the screen's pixel ratio; pointer, wheel,
// key and text events from it; a frame loop; and a check that what was drawn isn't blank. `kind` is the
// adapter's: '2d' (VSTGUI's Canvas 2D drawing) or 'webgl2' (editors drawn with OpenGL: ImGui, NanoVG, DGL).
export function createSurface(kind = '2d') {
 const canvas = Object.assign(document.createElement('canvas'), { className: 'plugin-editor-canvas', tabIndex: 0 });
 canvas.setAttribute('aria-label', 'Plug-in editor');
 const gl = kind === 'webgl2' ? canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: true }) : null;
 const surface = {
  canvas, ctx: gl ? null : canvas.getContext('2d'), gl, width: 0, height: 0, scale: Math.max(1, Math.round(globalThis.devicePixelRatio || 1)),
  onResize: null,
  size(w, h) {
   surface.width = w; surface.height = h;
   canvas.width = Math.round(w * surface.scale); canvas.height = Math.round(h * surface.scale);
   canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  },
  // The editor asks to be another size (IPlugFrame::resizeView): the window follows.
  resize(w, h) { surface.size(w, h); surface.onResize?.(w, h); return true; },
  // Blank: every pixel the same colour (nothing drawn, or one flat fill).
  blank() {
   if (!canvas.width || !canvas.height) return true;
   let d;
   if (gl) { d = new Uint8Array(canvas.width * canvas.height * 4); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, d); }
   else d = surface.ctx.getImageData(0, 0, canvas.width, canvas.height).data;
   for (let i = 4; i < d.length; i += 4 * 7) if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) return false;
   return true;
  },
  // Pointer position in the editor's own coordinates.
  point(e) { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * (surface.width / (r.width || 1)), y: (e.clientY - r.top) * (surface.height / (r.height || 1)) }; },
 };
 return surface;
}
const mods = e => ({ shift: e.shiftKey, alt: e.altKey, control: e.ctrlKey, command: e.metaKey });

/* ---- The view ---- */

// Puts the view into `box`: `generic` (the generic controls, already built), the editor where there is one, a
// notice when it falls back, and the Editor / Generic switch into `header`. `choice` is the remembered one
// ('editor' or 'generic'); onChoice(c) keeps a new one; onSize(w, h) asks the window to fit the editor.
// Returns { mode, setMode(m), editor, reason, close() }.
export function mountView({ box, header, generic, plugin, choice = 'editor', onChoice, onSize, bridge = {} }) {
 const notice = Object.assign(document.createElement('p'), { className: 'module-hint editor-notice', hidden: true });
 const host = Object.assign(document.createElement('div'), { className: 'plugin-editor', hidden: true });
 box.append(notice, host, generic);
 const toggle = Object.assign(document.createElement('span'), { className: 'editor-toggle' });
 toggle.setAttribute('role', 'radiogroup'); toggle.setAttribute('aria-label', 'Editor or generic controls');
 const button = (mode, text) => { const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text }); b.dataset.mode = mode; b.setAttribute('role', 'radio'); b.onclick = () => { view.setMode(mode); onChoice?.(mode); }; toggle.append(b); return b; };
 const editorButton = button('editor', 'Editor'); button('generic', 'Generic');
 header?.append(toggle);

 const { adapter, reason: none, quiet } = adapterFor(plugin);
 let surface = null, editor = null, raf = 0, failed = none || '', opening = null;
 const view = {
  mode: 'generic', get editor() { return editor; }, get reason() { return failed; },
  setMode(mode) {
   view.mode = mode === 'editor' && !failed ? 'editor' : 'generic';
   host.hidden = view.mode !== 'editor'; generic.hidden = view.mode === 'editor';
   toggle.querySelectorAll('button').forEach(b => b.setAttribute('aria-checked', b.dataset.mode === view.mode));
   if (view.mode === 'editor' && !editor && !opening) opening = open();
   if (view.mode === 'editor' && editor) onSize?.(editor.width, editor.height);
  },
  close: () => teardown(),
  opened: null, // a promise settled once the editor is up or has fallen back (for tests and the teacher)
 };
 const fallBack = why => {
  failed = why || 'The editor stopped.';
  teardown();
  notice.hidden = false; notice.textContent = NOTICE; notice.title = failed;
  notice.append(Object.assign(document.createElement('span'), { className: 'editor-notice-why', textContent: ` (${failed})` }));
  editorButton.disabled = true; editorButton.title = failed;
  view.setMode('generic');
 };
 function teardown() {
  cancelAnimationFrame(raf); raf = 0;
  if (editor) { const e = editor; editor = null; try { e.close(); } catch { /* it is going anyway */ } }
  if (surface) { surface.canvas.remove(); surface = null; }
 }
 // Anything the editor does runs guarded: if it throws, it is gone and the generic controls take over.
 const guarded = fn => (...args) => { if (!editor) return; try { return fn(...args); } catch (err) { fallBack(`The editor crashed: ${err.message}`); } };
 const fullBridge = {
  edit: (id, value) => bridge.edit?.(id, value), begin: id => bridge.begin?.(id), end: id => bridge.end?.(id),
  fail: why => fallBack(why || 'The editor stopped.'),
 };

 async function open() {
  surface = createSurface(adapter.surface);
  host.replaceChildren(surface.canvas);
  surface.onResize = (w, h) => onSize?.(w, h);
  let timer;
  try {
   const opened = Promise.resolve(adapter.open({ surface, plugin, bridge: fullBridge }));
   const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no first frame within ${FIRST_FRAME_MS / 1000} s`)), FIRST_FRAME_MS); });
   const e = await Promise.race([opened, late]);
   if (!e) { clearTimeout(timer); fallBack('This plug-in has no editor.'); return; }
   editor = e;
   if (!surface.width) surface.size(e.width, e.height);
   // The first frame: drawn, and not blank, before the timeout.
   const drew = await Promise.race([Promise.resolve().then(() => e.frame(true)), late]);
   clearTimeout(timer);
   if (!editor) return; // it failed while drawing
   if (drew === false || (!adapter.html && surface.blank())) { fallBack('The editor drew a blank frame.'); return; }
  } catch (err) {
   clearTimeout(timer);
   fallBack(/first frame/.test(err.message) ? `The editor drew no first frame within ${FIRST_FRAME_MS / 1000} s.` : `The editor couldn't open: ${err.message}`);
   return;
  } finally { opening = null; }
  const c = surface.canvas;
  c.onpointerdown = guarded(ev => { c.focus(); c.setPointerCapture?.(ev.pointerId); editor.pointer?.({ type: 'down', ...surface.point(ev), button: ev.button, buttons: ev.buttons, clicks: ev.detail, ...mods(ev) }); ev.preventDefault(); });
  c.onpointermove = guarded(ev => editor.pointer?.({ type: 'move', ...surface.point(ev), buttons: ev.buttons, ...mods(ev) }));
  c.onpointerup = guarded(ev => editor.pointer?.({ type: 'up', ...surface.point(ev), button: ev.button, buttons: ev.buttons, ...mods(ev) }));
  c.onpointerleave = guarded(ev => editor.pointer?.({ type: 'leave', ...surface.point(ev), ...mods(ev) }));
  c.onwheel = guarded(ev => { ev.preventDefault(); editor.wheel?.({ ...surface.point(ev), dx: ev.deltaX, dy: ev.deltaY, ...mods(ev) }); });
  // Focus in and out of the editor: frameworks that track whether their window is active (VSTGUI commits an
  // open text edit when it isn't) are told.
  c.onfocus = guarded(() => editor.focus?.(true));
  c.onblur = guarded(() => editor.focus?.(false));
  // Keys typed into the editor are its own: they don't also play the synth from the computer keyboard.
  c.onkeydown = guarded(ev => { ev.stopPropagation(); if (editor.key?.({ type: 'down', key: ev.key, code: ev.code, ...mods(ev) })) ev.preventDefault(); });
  c.onkeyup = guarded(ev => { ev.stopPropagation(); if (editor.key?.({ type: 'up', key: ev.key, code: ev.code, ...mods(ev) })) ev.preventDefault(); });
  const loop = guarded(() => { editor.frame(false); if (editor) raf = requestAnimationFrame(loop); });
  raf = requestAnimationFrame(loop);
  onSize?.(editor.width, editor.height);
 }

 // A plug-in that can't have an editor (a plain web effect) just has its generic controls; one that should
 // have one and doesn't says so.
 if (none) { if (!quiet) fallBack(none); else { failed = none; editorButton.disabled = true; editorButton.title = none; view.setMode('generic'); } }
 else { editorButton.title = `${FRAMEWORKS[adapter.id]?.label || adapter.label || adapter.id} editor`; view.setMode(choice); }
 view.opened = Promise.resolve(opening).then(() => view);
 return view;
}

// A Web Audio Module's own GUI (an HTML element it makes) is an editor too, drawn by the browser itself.
registerAdapter({
 id: 'html', label: 'Web Audio Module GUI', html: true,
 open: ({ surface, plugin }) => {
  const gui = plugin.gui;
  if (!gui) return null;
  surface.canvas.replaceWith(gui);
  const r = () => gui.getBoundingClientRect();
  return { get width() { return Math.round(r().width) || 400; }, get height() { return Math.round(r().height) || 300; }, resizable: true, frame: () => true, close: () => gui.remove() };
 },
});
