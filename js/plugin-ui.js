// Shared controls for plugins that describe their parameters as {id,label,min,max,step,value,unit}.
export function el(tag, props = {}, ...children) {
 const node = Object.assign(document.createElement(tag), props);
 node.append(...children);
 return node;
}
// Returns { set(id, value) }, which moves a control to a value changed elsewhere (the plug-in's own editor)
// without calling onChange back.
export function renderParams(host, params, onChange) {
 host.replaceChildren();
 const shown = new Map();
 params.forEach(p => {
  const out = el('output', { textContent: format(p, p.value) });
  const input = el('input', { type: 'range', className: 'horizontal-slider', min: p.min, max: p.max, step: p.step ?? (p.max - p.min) / 100, value: p.value });
  input.setAttribute('aria-label', p.label);
  input.oninput = () => { const v = Number(input.value); out.textContent = format(p, v); onChange(p.id, v); };
  host.append(el('label', { className: 'plugin-param' }, el('span', {}, p.label, ' ', out), input));
  shown.set(String(p.id), v => { input.value = v; out.textContent = format(p, v); });
 });
 return { set: (id, value) => shown.get(String(id))?.(value) };
}
const format = (p, v) => p.format ? p.format(v) : (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100) + (p.unit ? ' ' + p.unit : '');
export function card(id, title) {
 const section = el('section', { id, className: 'wide' });
 section.dataset.title = title; section.dataset.wide = 'true';
 const content = el('div', { className: 'module-content' });
 section.append(content);
 return { section, content };
}
