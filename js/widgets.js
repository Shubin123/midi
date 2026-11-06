import { read, save } from './storage.js';
// Lays the modules out as a packed grid: each module spans as many 2 px grid rows as its height needs, so short
// modules stack up under tall ones instead of leaving a gap the height of the tallest module in the row.
// Modules can be reordered by dragging or with arrow keys, resized from the grip in their corner (width in
// whole columns, any height), minimised to their title bar, or hidden; order, sizes, minimised and hidden
// state all persist.
const ROW = 2; // px; matches grid-auto-rows in workspace.css
// Outlines drawn on the page while a module is dragged: where it was lifted from, and where it will land.
export const marker=(rect,kind,text)=>{const m=document.createElement('div');m.className=`drag-marker ${kind}`;m.dataset.label=text;m.setAttribute('aria-hidden','true');document.body.append(m);placeMarker(m,rect);return m;};
export const placeMarker=(m,r)=>Object.assign(m.style,{left:`${r.left+scrollX}px`,top:`${r.top+scrollY}px`,width:`${r.width}px`,height:`${r.height}px`});

// A resize grip for a widget or window corner. onMove(dx, dy, start) runs as it is dragged (start is the
// element's rect when the drag began), onEnd() when it is let go, onReset() on a double-click; arrow keys
// nudge it (onMove with a step), so it works without a mouse too.
export function resizeGrip(el, { name, onMove, onEnd, onReset, step = () => [40, 40] }) {
 const grip=document.createElement('div');grip.className='resize-grip';grip.tabIndex=0;grip.setAttribute('role','button');
 grip.title='Drag to resize. Double-click to reset the size.';grip.setAttribute('aria-label',`Resize ${name}. Arrow keys change the size.`);
 let start=null;
 const move=e=>{if(start)onMove(e.clientX-start.x,e.clientY-start.y,start.rect);};
 const up=()=>{if(!start)return;start=null;el.classList.remove('resizing');removeEventListener('pointermove',move);removeEventListener('pointerup',up);removeEventListener('pointercancel',up);onEnd?.();};
 grip.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();start={x:e.clientX,y:e.clientY,rect:el.getBoundingClientRect()};el.classList.add('resizing');addEventListener('pointermove',move);addEventListener('pointerup',up);addEventListener('pointercancel',up);};
 grip.ondblclick=()=>{onReset?.();onEnd?.();};
 grip.onkeydown=e=>{const dir={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(!dir)return;e.preventDefault();const rect=el.getBoundingClientRect();const [sx,sy]=step();onMove(dir[0]*sx*(e.shiftKey?4:1),dir[1]*sy*(e.shiftKey?4:1),rect);onEnd?.();};
 return grip;
}
export function setupWidgets(workspace) {
 const widgets = [...workspace.children];
 widgets.forEach((el,i)=>el.dataset.order=i);
 const saved = read('synth-layout-v1', {});
 const list = key => Array.isArray(saved[key]) ? saved[key] : [];
 const order = list('order');
 widgets.sort((a,b) => (order.includes(a.id) ? order.indexOf(a.id) : 999) - (order.includes(b.id) ? order.indexOf(b.id) : 999)).forEach(el => workspace.append(el));
 const persist = () => save('synth-layout-v1', { order: [...workspace.children].map(el=>el.id), hidden: widgets.filter(el=>el.hidden).map(el=>el.id), wide: widgets.filter(el=>el.classList.contains('wide')).map(el=>el.id), spans: Object.fromEntries(widgets.filter(el=>el.dataset.span).map(el=>[el.id,Number(el.dataset.span)])), heights: Object.fromEntries(widgets.filter(el=>el.style.height).map(el=>[el.id,parseFloat(el.style.height)])), minimized: widgets.filter(el=>el.classList.contains('minimized')).map(el=>el.id) });

 // Masonry packing: in order, each module goes to the column (or pair of columns, if wide) that currently ends
 // highest, and spans as many rows as its height plus the gap. Positions never change a module's width, so its
 // height (and this layout) can't feed back on itself; it reruns when a module resizes or the order changes.
 const layout = () => {
  const style = getComputedStyle(workspace);
  const cols = parseInt(style.getPropertyValue('--cols'), 10) || 1; // not gridTemplateColumns: placed modules can add tracks
  const gap = parseFloat(style.columnGap) || 0;
  const bottoms = Array(cols).fill(0);
  const items = [...workspace.children].filter(el => !el.hidden && el.classList.contains('widget'))
   .map(el => ({ el, span: el.classList.contains('minimized') ? 1 : Math.max(1, Math.min(cols, Number(el.dataset.span) || (el.classList.contains('wide') ? 2 : 1))) }));
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
  const span = saved.spans?.[el.id], height = saved.heights?.[el.id];
  if (span) { el.dataset.span = span; el.classList.toggle('wide', span > 1); }
  if (height) { el.style.height = `${height}px`; el.classList.add('sized'); }
  const name = el.dataset.title || el.querySelector('.control-title')?.childNodes[0].textContent.trim() || 'Module';
  const label = document.createElement('label');
  const check = document.createElement('input'); check.type='checkbox'; check.checked=!el.hidden;
  label.append(check,document.createTextNode(name)); body.append(label);
  check.onchange=()=>{el.hidden=!check.checked;persist();window.dispatchEvent(new Event('resize'));};
  const header = document.createElement('div'); header.className='widget-header';
  const handle = document.createElement('button'); handle.className='drag-handle'; handle.textContent='⠿ '+name; handle.title='Drag to reorder. Use arrow keys to move. Double-click to minimise.';
  const move = delta => { const all=[...workspace.children]; const at=all.indexOf(el); const other=all[at+delta]; if(other){workspace.insertBefore(el,delta<0?other:other.nextSibling);layout();persist();} };
  handle.onkeydown=e=>{if(e.key==='ArrowUp'||e.key==='ArrowLeft'){e.preventDefault();move(-1);}if(e.key==='ArrowDown'||e.key==='ArrowRight'){e.preventDefault();move(1);}};
  // Dragging lifts the module out of the grid: it follows the pointer, a dashed outline stays at the liftoff
  // point, and a highlighted outline shows where it will land as the other modules make room. Escape (or a
  // cancelled touch) puts it back where it was. A press that doesn't move stays a click.
  let drag=null;
  // Moving the module in the page drops the handle's pointer capture, so the drag listens on the window.
  handle.onpointerdown=e=>{if(e.button!==0)return;const r=el.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,ox:e.clientX-r.left,oy:e.clientY-r.top,from:r,scrollY,order:[...workspace.children],lifted:false};addEventListener('pointermove',dragMove);addEventListener('pointerup',up);addEventListener('pointercancel',cancel);};
  const follow=e=>{el.style.transform='none';const r=el.getBoundingClientRect();placeMarker(drag.landing,r);drag.liftoff.hidden=Math.abs(r.left-drag.from.left)+Math.abs(r.top+scrollY-drag.from.top-drag.scrollY)<4;/* until it moves, both outlines are one */el.style.transform=`translate(${e.clientX-drag.ox-r.left}px,${e.clientY-drag.oy-r.top}px)`;};
  const dragMove=e=>{
   if(!drag)return;
   if(!drag.lifted){if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;drag.lifted=true;drag.liftoff=marker(drag.from,'liftoff','Lifted from here');drag.landing=marker(drag.from,'landing','Drops here');el.classList.add('dragging');}
   // The module under the pointer, looking past the lifted one.
   const target=document.elementsFromPoint(e.clientX,e.clientY).map(n=>n.closest?.('.widget')).find(w=>w&&w!==el&&w.parentElement===workspace);
   if(target){
    const current=[...workspace.children];
    workspace.insertBefore(el,current.indexOf(el)<current.indexOf(target)?target.nextSibling:target);
    layout();
   }
   follow(e);
   if(e.clientY<70)window.scrollBy(0,-14);else if(e.clientY>innerHeight-70)window.scrollBy(0,14);
  };
  const end=restore=>{
   const d=drag;drag=null;removeEventListener('pointermove',dragMove);removeEventListener('pointerup',up);removeEventListener('pointercancel',cancel);
   if(!d?.lifted)return;
   if(restore){d.order.forEach(n=>workspace.append(n));layout();}
   d.liftoff.remove();d.landing.remove();el.classList.remove('dragging');
   // Settle into the slot from wherever it was dropped.
   el.classList.add('settling');el.style.transform='';setTimeout(()=>el.classList.remove('settling'),220);
   persist();
  };
  const up=()=>end(false),cancel=()=>end(true);
  addEventListener('keydown',e=>{if(e.key==='Escape'&&drag){e.preventDefault();end(true);}});
  // Minimised: only the title bar shows, one column wide, so it stacks as a slim bar.
  const mini=document.createElement('button');mini.className='min-btn';
  el._setMinimized=on=>{el.classList.toggle('minimized',on);mini.textContent=on?'+':'–';mini.title=(on?'Expand ':'Minimise ')+name;mini.setAttribute('aria-expanded',!on);};
  el._setMinimized(list('minimized').includes(el.id));
  mini.onclick=()=>{el._setMinimized(!el.classList.contains('minimized'));persist();window.dispatchEvent(new Event('resize'));};
  handle.ondblclick=mini.onclick;
  const size=document.createElement('button');size.textContent='↔';size.title='Toggle wide module';size.onclick=()=>{const wide=!el.classList.contains('wide');el.classList.toggle('wide',wide);el.dataset.span=wide?2:1;persist();window.dispatchEvent(new Event('resize'));};
  // The corner grip: width snaps to whole columns, height is free (the content scrolls inside it).
  const grip=resizeGrip(el,{name,
   onMove:(dx,dy,start)=>{
    const style=getComputedStyle(workspace),cols=parseInt(style.getPropertyValue('--cols'),10)||1,gap=parseFloat(style.columnGap)||0;
    const colWidth=(workspace.clientWidth-gap*(cols-1))/cols,span=Math.max(1,Math.min(cols,Math.round((start.width+dx+gap)/(colWidth+gap))));
    el.dataset.span=span;el.classList.toggle('wide',span>1);
    if(dy){el.style.height=`${Math.max(120,Math.round(start.height+dy))}px`;el.classList.add('sized');}
    layout();
   },
   onEnd:()=>{persist();window.dispatchEvent(new Event('resize'));},
   onReset:()=>{delete el.dataset.span;el.classList.toggle('wide',el.dataset.wide==='true');el.style.height='';el.classList.remove('sized');},
   step:()=>{const style=getComputedStyle(workspace),cols=parseInt(style.getPropertyValue('--cols'),10)||1,gap=parseFloat(style.columnGap)||0;return[(workspace.clientWidth-gap*(cols-1))/cols+gap,40];}});
  const hide=document.createElement('button');hide.textContent='×';hide.title='Hide '+name;hide.onclick=()=>{el.hidden=true;check.checked=false;persist();};
  header.append(handle,hide,size,mini);el.prepend(header); // close, width, minimise: the same order on every widget
  el.append(grip);
  observer.observe(el);
 });
 const all=on=>{widgets.forEach(el=>el._setMinimized(on));persist();window.dispatchEvent(new Event('resize'));};
 const actions=document.createElement('div');actions.className='widget-menu-actions';
 const minAll=document.createElement('button');minAll.textContent='Minimise all';minAll.onclick=()=>all(true);
 const expandAll=document.createElement('button');expandAll.textContent='Expand all';expandAll.onclick=()=>all(false);
 const reset=document.createElement('button');reset.textContent='Reset layout';reset.onclick=()=>{widgets.sort((a,b)=>Number(a.dataset.order)-Number(b.dataset.order)).forEach(el=>{workspace.append(el);el.hidden=false;el._setMinimized(false);el.classList.toggle('wide',el.dataset.wide==='true');delete el.dataset.span;el.style.height='';el.classList.remove('sized');});body.querySelectorAll('input').forEach(x=>x.checked=true);layout();persist();window.dispatchEvent(new Event('resize'));};
 actions.append(minAll,expandAll,reset);body.append(actions);
}
