import { read, save } from './storage.js';
// Lays the modules out as a packed grid: each module spans as many 2 px grid rows as its height needs, so short
// modules stack up under tall ones instead of leaving a gap the height of the tallest module in the row.
// Modules can be reordered by dragging or with arrow keys, made wide, minimised to their title bar, or
// hidden; order, widths, minimised and hidden state all persist.
const ROW = 2; // px; matches grid-auto-rows in workspace.css
export function setupWidgets(workspace) {
 const widgets = [...workspace.children];
 widgets.forEach((el,i)=>el.dataset.order=i);
 const saved = read('synth-layout-v1', {});
 const list = key => Array.isArray(saved[key]) ? saved[key] : [];
 const order = list('order');
 widgets.sort((a,b) => (order.includes(a.id) ? order.indexOf(a.id) : 999) - (order.includes(b.id) ? order.indexOf(b.id) : 999)).forEach(el => workspace.append(el));
 const persist = () => save('synth-layout-v1', { order: [...workspace.children].map(el=>el.id), hidden: widgets.filter(el=>el.hidden).map(el=>el.id), wide: widgets.filter(el=>el.classList.contains('wide')).map(el=>el.id), minimized: widgets.filter(el=>el.classList.contains('minimized')).map(el=>el.id) });

 // Masonry packing: in order, each module goes to the column (or pair of columns, if wide) that currently ends
 // highest, and spans as many rows as its height plus the gap. Positions never change a module's width, so its
 // height (and this layout) can't feed back on itself; it reruns when a module resizes or the order changes.
 const layout = () => {
  const style = getComputedStyle(workspace);
  const cols = parseInt(style.getPropertyValue('--cols'), 10) || 1; // not gridTemplateColumns: placed modules can add tracks
  const gap = parseFloat(style.columnGap) || 0;
  const bottoms = Array(cols).fill(0);
  const items = [...workspace.children].filter(el => !el.hidden && el.classList.contains('widget'))
   .map(el => ({ el, span: Math.min(cols, el.classList.contains('wide') && !el.classList.contains('minimized') ? 2 : 1) }));
  // Give each module its final width first, then measure, so heights match the columns they will sit in.
  items.forEach(({ el, span }) => { el.style.gridColumn = `span ${span}`; });
  items.forEach(item => { item.rows = Math.max(1, Math.ceil((item.el.getBoundingClientRect().height + gap) / ROW)); });
  for (const { el, span, rows } of items) {
   let at = 0, top = Infinity;
   for (let c = 0; c + span <= cols; c++) { const t = Math.max(...bottoms.slice(c, c + span)); if (t < top) { top = t; at = c; } }
   el.style.gridColumn = `${at + 1} / span ${span}`;
   el.style.gridRow = `${top + 1} / span ${rows}`;
   bottoms.fill(top + rows, at, at + span);
  }
 };
 const observer = new ResizeObserver(layout);
 window.addEventListener('resize', layout); // column count and gap change at the breakpoints

 const menu = document.createElement('details');
 menu.className = 'widget-menu';
 menu.innerHTML = '<summary aria-label="Widget menu">☰ <span>Widgets</span></summary><div class="widget-menu-body"><strong>Your workspace</strong><p>Show, hide, minimise, resize, or reorder modules.</p></div>';
 document.querySelector('h1').before(menu);
 const body = menu.querySelector('div');
 widgets.forEach(el => {
  el.classList.add('widget');
  el.hidden = list('hidden').includes(el.id);
  if (Array.isArray(saved.wide)) el.classList.toggle('wide', saved.wide.includes(el.id));
  const name = el.dataset.title || el.querySelector('.control-title')?.childNodes[0].textContent.trim() || 'Module';
  const label = document.createElement('label');
  const check = document.createElement('input'); check.type='checkbox'; check.checked=!el.hidden;
  label.append(check,document.createTextNode(name)); body.append(label);
  check.onchange=()=>{el.hidden=!check.checked;persist();window.dispatchEvent(new Event('resize'));};
  const header = document.createElement('div'); header.className='widget-header';
  const handle = document.createElement('button'); handle.className='drag-handle'; handle.textContent='⠿ '+name; handle.title='Drag to reorder. Use arrow keys to move. Double-click to minimise.';
  const move = delta => { const all=[...workspace.children]; const at=all.indexOf(el); const other=all[at+delta]; if(other){workspace.insertBefore(el,delta<0?other:other.nextSibling);layout();persist();} };
  handle.onkeydown=e=>{if(e.key==='ArrowUp'||e.key==='ArrowLeft'){e.preventDefault();move(-1);}if(e.key==='ArrowDown'||e.key==='ArrowRight'){e.preventDefault();move(1);}};
  let dragging=false;
  handle.onpointerdown=e=>{if(e.button!==0)return; dragging=true;handle.setPointerCapture(e.pointerId);el.classList.add('dragging');};
  handle.onpointermove=e=>{
   if(!dragging)return;
   const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.widget');
   if(target&&target!==el&&target.parentElement===workspace){
    const current=[...workspace.children];
    workspace.insertBefore(el,current.indexOf(el)<current.indexOf(target)?target.nextSibling:target);
    layout();
   }
   if(e.clientY<70)window.scrollBy(0,-14);else if(e.clientY>innerHeight-70)window.scrollBy(0,14);
  };
  const end=()=>{dragging=false;el.classList.remove('dragging');persist();};handle.onpointerup=end;handle.onpointercancel=end;
  // Minimised: only the title bar shows, one column wide, so it stacks as a slim bar.
  const mini=document.createElement('button');mini.className='min-btn';
  el._setMinimized=on=>{el.classList.toggle('minimized',on);mini.textContent=on?'+':'–';mini.title=(on?'Expand ':'Minimise ')+name;mini.setAttribute('aria-expanded',!on);};
  el._setMinimized(list('minimized').includes(el.id));
  mini.onclick=()=>{el._setMinimized(!el.classList.contains('minimized'));persist();window.dispatchEvent(new Event('resize'));};
  handle.ondblclick=mini.onclick;
  const size=document.createElement('button');size.textContent='↔';size.title='Toggle wide module';size.onclick=()=>{el.classList.toggle('wide');persist();window.dispatchEvent(new Event('resize'));};
  const hide=document.createElement('button');hide.textContent='×';hide.title='Hide '+name;hide.onclick=()=>{el.hidden=true;check.checked=false;persist();};
  header.append(handle,mini,size,hide);el.prepend(header);
  observer.observe(el);
 });
 const all=on=>{widgets.forEach(el=>el._setMinimized(on));persist();window.dispatchEvent(new Event('resize'));};
 const actions=document.createElement('div');actions.className='widget-menu-actions';
 const minAll=document.createElement('button');minAll.textContent='Minimise all';minAll.onclick=()=>all(true);
 const expandAll=document.createElement('button');expandAll.textContent='Expand all';expandAll.onclick=()=>all(false);
 const reset=document.createElement('button');reset.textContent='Reset layout';reset.onclick=()=>{widgets.sort((a,b)=>Number(a.dataset.order)-Number(b.dataset.order)).forEach(el=>{workspace.append(el);el.hidden=false;el._setMinimized(false);el.classList.toggle('wide',el.dataset.wide==='true');});body.querySelectorAll('input').forEach(x=>x.checked=true);layout();persist();window.dispatchEvent(new Event('resize'));};
 actions.append(minAll,expandAll,reset);body.append(actions);
}
