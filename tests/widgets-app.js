// Checks run inside the app (index.html) by node tests/widgets.mjs: dragging widgets, as a pointer would. Every
// widget is lifted and carried onto every other one, and at each step the place it will drop must be a space
// already open, outlined, and empty of other widgets, with the widget itself under the pointer; resting on a
// widget must not make the space jump back and forth; Escape puts everything back; and a drop lands exactly
// in the outlined space. Returns { checks: [{ name, ok, problems }] }.

const wait = ms => new Promise(r => setTimeout(r, ms));
const workspace = () => document.getElementById('workspace');
const visible = () => [...workspace().children].filter(w => w.classList.contains('widget') && !w.hidden);
const order = () => [...workspace().children].map(w => w.id).join();
const title = w => w.querySelector('.drag-handle').textContent.replace('⠿', '').trim();

// Where a widget sits in the layout, in page coordinates, ignoring any transform (a lifted widget is moved with
// one): its slot.
function slot(el) {
 let left = 0, top = 0;
 for (let n = el; n; n = n.offsetParent) { left += n.offsetLeft; top += n.offsetTop; }
 return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}
const markerRect = kind => { const m = document.querySelector(`.drag-marker.${kind}`); return m && { left: parseFloat(m.style.left), top: parseFloat(m.style.top), width: parseFloat(m.style.width), height: parseFloat(m.style.height), hidden: m.hidden }; };
const same = (a, b, tol = 1.5) => ['left', 'top', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= tol);
const overlap = (a, b) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));
const fmt = r => `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`;

const pointer = (type, x, y, target = window) => target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerId: 1, isPrimary: true, pointerType: 'mouse', bubbles: true }));
const clampY = y => Math.max(90, Math.min(innerHeight - 90, y)); // clear of the edges, where dragging scrolls the page

// Everything that must hold at every moment of a drag. `grab` is where on the widget the pointer holds it.
function steady(el, x, y, grab, say) {
 const landing = markerRect('landing'), space = slot(el);
 if (!landing) { say('no "Drops here" outline'); return; }
 if (!same(landing, space)) say(`"Drops here" is at ${fmt(landing)}, but the widget would drop at ${fmt(space)}`);
 const ws = workspace().getBoundingClientRect();
 if (space.left < ws.left + scrollX - 1 || space.left + space.width > ws.right + scrollX + 1) say(`the space ${fmt(space)} is outside the workspace`);
 for (const other of visible()) if (other !== el && overlap(space, slot(other)) > 4) say(`the space overlaps ${title(other)}`);
 const r = el.getBoundingClientRect();
 if (Math.abs(r.left - (x - grab.x)) > 1.5 || Math.abs(r.top - (y - grab.y)) > 1.5) say(`the widget is at ${Math.round(r.left)},${Math.round(r.top)}, not under the pointer (${Math.round(x - grab.x)},${Math.round(y - grab.y)})`);
}

// Lifts `el`, carries it onto `onto` in steps (to its middle, or to the point `at` of it, as fractions of its
// width and height), rests there, and then cancels (Escape) or drops. Returns the problems seen.
async function drag(el, onto, { drop = false, at = [0.5, 0.5] } = {}) {
 const problems = [], say = why => { if (!problems.includes(why)) problems.push(why); };
 const before = order();
 const handle = el.querySelector('.drag-handle');
 handle.scrollIntoView({ block: 'center' });
 const h = handle.getBoundingClientRect(), x0 = h.left + 20, y0 = h.top + h.height / 2;
 const r0 = el.getBoundingClientRect(), grab = { x: x0 - r0.left, y: y0 - r0.top };
 pointer('pointerdown', x0, y0, handle);
 pointer('pointermove', x0 + 12, y0 + 8); // past the 5 px that tells a drag from a click
 if (!el.classList.contains('dragging')) { say('it did not lift'); pointer('pointerup', x0, y0); return problems; }
 steady(el, x0 + 12, y0 + 8, grab, say);
 // Bring the target into view (the page scrolls under a held widget), then carry the widget to it, aiming each
 // step at where the target is now, as a person would while the widgets make room.
 const t = slot(onto);
 window.scrollTo(0, Math.max(0, t.top + t.height * at[1] - innerHeight / 2));
 const aim = () => { const now = slot(onto); return [now.left + now.width * at[0] - scrollX, clampY(now.top + now.height * at[1] - scrollY)]; };
 const sx = x0 + 12, sy = clampY(y0 + 8);
 let [tx, ty] = aim();
 for (let i = 1; i <= 10; i++) {
  [tx, ty] = aim();
  const x = sx + ((tx - sx) * i) / 10, y = sy + ((ty - sy) * i) / 10;
  pointer('pointermove', x, y);
  steady(el, x, y, grab, say);
 }
 // Resting on the target, with the small movements a hand makes: the space may still settle once, but must
 // never go back to where it just was.
 const seen = [order()];
 for (const [dx, dy] of [[1, 0], [-1, 1], [0, -1], [1, 1], [-1, 0], [0, 0], [1, -1], [-1, -1]]) {
  pointer('pointermove', tx + dx, ty + dy);
  steady(el, tx + dx, ty + dy, grab, say);
  if (order() !== seen.at(-1)) { if (seen.includes(order())) say(`resting on ${title(onto)} moves the space back and forth`); seen.push(order()); }
 }
 if (seen.length > 2) say(`resting on ${title(onto)} moves the space ${seen.length - 1} times`);
 const landing = markerRect('landing');
 if (drop) {
  pointer('pointerup', tx, ty);
  await wait(260); // the widget settles into its space
  const r = el.getBoundingClientRect(), now = { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height };
  if (landing && !same(now, landing)) say(`it dropped at ${fmt(now)}, not in the outlined space ${fmt(landing)}`);
  if (el.style.transform) say(`it kept a transform (${el.style.transform}) after the drop`);
 } else {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  if (order() !== before) say('Escape did not put the widgets back');
  await wait(0);
 }
 if (document.querySelector('.drag-marker')) say('an outline was left behind');
 if (el.classList.contains('dragging')) say('the widget is still lifted');
 return problems;
}

export async function runWidgets() {
 const checks = [];
 const add = (name, problems) => checks.push({ name, ok: !problems.length, problems });
 const widgets = visible();
 // Every widget onto every other one, cancelled each time so each starts from the same layout.
 for (const el of widgets) {
  const problems = [];
  for (const onto of widgets) {
   if (onto === el) continue;
   (await drag(el, onto)).forEach(p => problems.push(`onto ${title(onto)}: ${p}`));
  }
  add(`${title(el)}: lifted onto every other widget, its drop space is open, outlined and steady`, problems.slice(0, 6).concat(problems.length > 6 ? [`…and ${problems.length - 6} more`] : []));
 }
 // Then real drops: each widget onto the next one, landing in the outlined space.
 for (let i = 0; i < widgets.length; i++) {
  const el = widgets[i], onto = widgets[(i + 1) % widgets.length];
  add(`${title(el)}: dropped onto ${title(onto)}, it lands in the outlined space`, await drag(el, onto, { drop: true }));
 }
 // Every place can be reached: the first (carried onto the first widget's top left) and the last (onto the
 // last one's bottom right).
 for (const el of [widgets[6], widgets[1]]) {
  const first = visible().find(w => w !== el), problems = await drag(el, first, { drop: true, at: [0.15, 0.15] });
  if (visible()[0] !== el) problems.push(`it went to place ${visible().indexOf(el) + 1}, not the first`);
  const last = visible().filter(w => w !== el).at(-1);
  problems.push(...(await drag(el, last, { drop: true, at: [0.85, 0.85] })));
  if (visible().at(-1) !== el) problems.push(`it went to place ${visible().indexOf(el) + 1} of ${visible().length}, not the last`);
  add(`${title(el)}: can be carried to the first place and to the last`, problems);
 }
 // The packed layout never overlaps, after all that.
 const all = visible(), overlaps = [];
 all.forEach((a, i) => all.slice(i + 1).forEach(b => { if (overlap(slot(a), slot(b)) > 4) overlaps.push(`${title(a)} overlaps ${title(b)}`); }));
 add('no two widgets overlap', overlaps);
 window.scrollTo(0, 0);
 return { checks };
}
