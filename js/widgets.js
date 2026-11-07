import { read, save } from './storage.js';
// Lays the modules out as a packed grid: each module spans as many 2 px grid rows as its height needs, so short
// modules stack up under tall ones instead of leaving a gap the height of the tallest module in the row.
// Modules can be reordered by dragging or with arrow keys, resized from the grip in their corner (width in
// whole columns, any height), minimised to their title bar, or hidden; order, sizes, minimised and hidden
// state all persist.
const ROW = 2; // px; matches grid-auto-rows in workspace.css
// Outlines drawn on the page while a module is dragged: where it was lifted from (an empty outline: the open
// space it will drop into says enough), and where it will land.
export const marker=(rect,kind,text)=>{const m=document.createElement('div');m.className=`drag-marker ${kind}`;if(text)m.dataset.label=text;m.setAttribute('aria-hidden','true');document.body.append(m);placeMarker(m,rect);return m;};
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
 // Widgets that were merged keep the place of the first one they replace (three oscillators became one).
 const RENAMED = { 'osc1-group': 'oscillators-group' };
 const list = key => Array.isArray(saved[key]) ? saved[key].map(id => RENAMED[id] || id) : [];
 const order = list('order');
 widgets.sort((a,b) => (order.includes(a.id) ? order.indexOf(a.id) : 999) - (order.includes(b.id) ? order.indexOf(b.id) : 999)).forEach(el => workspace.append(el));
 const persist = () => save('synth-layout-v1', { order: [...workspace.children].map(el=>el.id), hidden: widgets.filter(el=>el.hidden).map(el=>el.id), wide: widgets.filter(el=>el.classList.contains('wide')).map(el=>el.id), spans: Object.fromEntries(widgets.filter(el=>el.dataset.span).map(el=>[el.id,Number(el.dataset.span)])), heights: Object.fromEntries(widgets.filter(el=>el.style.height).map(el=>[el.id,parseFloat(el.style.height)])), minimized: widgets.filter(el=>el.classList.contains('minimized')).map(el=>el.id) });

 // Masonry packing: in order, each module goes to the column (or pair of columns, if wide) that currently ends
 // highest, and spans as many rows as its height plus the gap. Positions never change a module's width, so its
 // height (and this layout) can't feed back on itself; it reruns when a module resizes or the order changes.
 const grid = () => { const style = getComputedStyle(workspace); return { style, cols: parseInt(style.getPropertyValue('--cols'), 10) || 1, gap: parseFloat(style.columnGap) || 0 }; }; // not gridTemplateColumns: placed modules can add tracks
 const placed = order => order.filter(el => !el.hidden && el.classList.contains('widget'));
 const spanOf = (el, cols) => el.classList.contains('minimized') ? 1 : Math.max(1, Math.min(cols, Number(el.dataset.span) || (el.classList.contains('wide') ? 2 : 1)));
 const rowsOf = (el, gap) => Math.max(1, Math.ceil((el.getBoundingClientRect().height + gap) / ROW - 0.01)); // 400.0002 px is 400 px, not a row more
 // Gives each item ({ span, rows }) its column (at) and first row (top).
 const pack = (items, cols) => {
  const bottoms = Array(cols).fill(0);
  for (const item of items) {
   let at = 0, top = Infinity;
   for (let c = 0; c + item.span <= cols; c++) { const t = Math.max(...bottoms.slice(c, c + item.span)); if (t < top) { top = t; at = c; } }
   Object.assign(item, { at, top });
   bottoms.fill(top + item.rows, at, at + item.span);
  }
  return items;
 };
 const layout = () => {
  const { cols, gap } = grid();
  const items = placed([...workspace.children]).map(el => ({ el, span: spanOf(el, cols) }));
  // Give each module its final width first, then measure, so heights match the columns they will sit in. Rows
  // are cleared too: an old row with a new span can push a module into an extra, implicit column of another
  // width, and it would be measured at the wrong height (and overlap its neighbours once placed). Meanwhile the
  // workspace keeps its height, or the page would be clamped to the collapsed grid and jump its scroll.
  workspace.style.minHeight = `${workspace.offsetHeight}px`;
  items.forEach(({ el, span }) => { el.style.gridColumn = `span ${span}`; el.style.gridRow = 'auto'; });
  items.forEach(item => { item.rows = rowsOf(item.el, gap); });
  for (const { el, span, rows, at, top } of pack(items, cols)) {
   el.style.gridColumn = `${at + 1} / span ${span}`;
   el.style.gridRow = `${top + 1} / span ${rows}`;
  }
  workspace.style.minHeight = '';
  refollow?.(); // a module being dragged stays under the pointer, and its outlines on their spaces
 };
 // Where `el` would sit (in the viewport) were the modules in `order`: packed as layout() packs them, at their
 // sizes now, without moving any of them.
 const spaceIn = (order, el) => {
  const { style, cols, gap } = grid();
  const { at, top, span } = pack(placed(order).map(n => ({ el: n, span: spanOf(n, cols), rows: rowsOf(n, gap) })), cols).find(i => i.el === el);
  const ws = workspace.getBoundingClientRect(), padLeft = parseFloat(style.paddingLeft) || 0, padRight = parseFloat(style.paddingRight) || 0;
  const col = (workspace.clientWidth - padLeft - padRight - gap * (cols - 1)) / cols;
  return { left: ws.left + workspace.clientLeft + padLeft + at * (col + gap), top: ws.top + workspace.clientTop + (parseFloat(style.paddingTop) || 0) + top * ROW, width: span * col + (span - 1) * gap, height: el.getBoundingClientRect().height };
 };
 let refollow = null;
 const observer = new ResizeObserver(layout);
 window.addEventListener('resize', layout); // column count and gap change at the breakpoints

 // The Settings menu: the app's own settings in sections other modules add (section()), then the widgets.
 const menu = document.createElement('details');
 menu.className = 'widget-menu';
 menu.innerHTML = '<summary aria-label="Settings">☰ <span>Settings</span></summary><div class="widget-menu-body"><div class="settings-sections"></div><strong>Widgets</strong><p>Show, hide, minimise, resize, or reorder them.</p></div>';
 document.querySelector('h1').before(menu);
 const body = menu.querySelector('.widget-menu-body');
 // Clicking anywhere else closes it, and so does Escape.
 document.addEventListener('pointerdown', e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
 document.addEventListener('keydown', e => { if (e.key === 'Escape' && menu.open) { menu.open = false; menu.querySelector('summary').focus(); } });
 const section = (title, ...nodes) => { const s = document.createElement('section'); s.className = 'settings-section'; s.append(Object.assign(document.createElement('strong'), { textContent: title }), ...nodes); menu.querySelector('.settings-sections').append(s); return s; };
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
  // Dragging lifts the module out of the grid: it follows the pointer, an empty dashed outline keeps the space it
  // was lifted from, and a highlighted outline shows where it will land. The other modules stay where they are
  // until it is dropped, and only then make room. Escape (or a cancelled touch) puts it back where it was. A press
  // that doesn't move stays a click.
  let drag=null;
  // Moving the module in the page drops the handle's pointer capture, so the drag listens on the window.
  handle.onpointerdown=e=>{if(e.button!==0)return;const r=el.getBoundingClientRect();drag={x:e.clientX,y:e.clientY,ox:e.clientX-r.left,oy:e.clientY-r.top,lifted:false,to:null,last:e,tx:0,ty:0};addEventListener('pointermove',dragMove);addEventListener('pointerup',up);addEventListener('pointercancel',cancel);};
  // The order it would leave, dropped now: `to` is the module it goes before or after (null: where it was).
  const dropOrder=to=>{const all=[...workspace.children],rest=all.filter(n=>n!==el),at=to?rest.indexOf(to.target):-1;if(at<0)return all;rest.splice(at+(to.after?1:0),0,el);return rest;};
  // Its own space is where it sits less the translation it is carried by: measured without taking the
  // translation off, which would shorten a page the module is carried past the end of, and shift what is measured.
  const ownSpace=()=>{const r=el.getBoundingClientRect();return{left:r.left-drag.tx,top:r.top-drag.ty,width:r.width,height:r.height};};
  const follow=e=>{
   const own=ownSpace(),space=spaceIn(dropOrder(drag.to),el);
   placeMarker(drag.liftoff,own);placeMarker(drag.landing,space);
   drag.liftoff.hidden=Math.abs(space.left-own.left)+Math.abs(space.top-own.top)<4; // dropped back where it was, both outlines are one
   drag.tx=e.clientX-drag.ox-own.left;drag.ty=e.clientY-drag.oy-own.top;
   el.style.transform=`translate(${drag.tx}px,${drag.ty}px)`;
   // The page may grow while a module is carried down it, but not shrink until the drop: shrinking would scroll
   // the page under the pointer.
   const page=document.documentElement,h=page.scrollHeight;if(h>(drag.pageHeight||0)){drag.pageHeight=h;page.style.minHeight=`${h}px`;}
  };
  const dragMove=e=>{
   if(!drag)return;
   if(!drag.lifted){
    if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<5)return;
    drag.lifted=true;
    el.classList.add('dragging');el.classList.remove('settling');el.style.transform=''; // picked up again while still settling from a drop
    const r=el.getBoundingClientRect();
    drag.liftoff=marker(r,'liftoff');drag.landing=marker(r,'landing','Drops here');
    document.documentElement.style.overflowAnchor='none'; // the page must not scroll itself under the module
    refollow=()=>follow(drag.last);
   }
   drag.last=e;
   // The module under the pointer, looking past the lifted one: carried onto its first half (in reading order: up
   // and to the left) the module will drop before it, onto the second half after it. Near its middle the choice
   // holds, so a hand's tremor can't make the landing outline jump back and forth. Back over its own open space,
   // it will drop where it was.
   const target=document.elementsFromPoint(e.clientX,e.clientY).map(n=>n.closest?.('.widget')).find(w=>w&&w!==el&&w.parentElement===workspace);
   if(target){
    const t=target.getBoundingClientRect(),past=(e.clientY-t.top-t.height/2)/t.height+(e.clientX-t.left-t.width/2)/t.width;
    if(drag.to?.target!==target||Math.abs(past)>0.1)drag.to={target,after:past>0};
   }else{const own=ownSpace();if(e.clientX>=own.left&&e.clientX<=own.left+own.width&&e.clientY>=own.top&&e.clientY<=own.top+own.height)drag.to=null;}
   follow(e);
   if(e.clientY<70)window.scrollBy(0,-14);else if(e.clientY>innerHeight-70)window.scrollBy(0,14);
  };
  const end=restore=>{
   const d=drag;drag=null;removeEventListener('pointermove',dragMove);removeEventListener('pointerup',up);removeEventListener('pointercancel',cancel);
   if(!d?.lifted)return;
   refollow=null;d.liftoff.remove();d.landing.remove();
   // Only now do the others make room: each slides from where it was to its new place, as the module settles
   // into its space from wherever it was dropped.
   const shown=placed([...workspace.children]),from=new Map(shown.map(n=>[n,n.getBoundingClientRect()]));
   if(!restore&&d.to)workspace.insertBefore(el,d.to.after?d.to.target.nextSibling:d.to.target);
   Object.assign(document.documentElement.style,{overflowAnchor:'',minHeight:''});
   el.style.transform='';layout();
   const moved=shown.filter(n=>{
    const a=from.get(n),b=n.getBoundingClientRect(),dx=a.left-b.left,dy=a.top-b.top;
    if(Math.abs(dx)+Math.abs(dy)<1)return false;
    n.classList.remove('settling');Object.assign(n.style,{transition:'none',transform:`translate(${dx}px,${dy}px)`});return true;
   });
   void workspace.offsetWidth; // the slides start from there
   el.classList.remove('dragging');
   moved.forEach(n=>{n.style.transition='';n.classList.add('settling');n.style.transform='';});
   setTimeout(()=>moved.forEach(n=>n.classList.remove('settling')),220);
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
 return { menu, section };
}
