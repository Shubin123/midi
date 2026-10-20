import { read, save } from './storage.js';
export function setupWidgets(workspace) {
 const widgets = [...workspace.children];
 widgets.forEach((el,i)=>el.dataset.order=i);
 const saved = read('synth-layout-v1', {});
 const order = Array.isArray(saved.order) ? saved.order : [];
 widgets.sort((a,b) => (order.includes(a.id) ? order.indexOf(a.id) : 999) - (order.includes(b.id) ? order.indexOf(b.id) : 999)).forEach(el => workspace.append(el));
 const persist = () => save('synth-layout-v1', { order: [...workspace.children].map(el=>el.id), hidden: widgets.filter(el=>el.hidden).map(el=>el.id), wide: widgets.filter(el=>el.classList.contains('wide')).map(el=>el.id) });
 const menu = document.createElement('details');
 menu.className = 'widget-menu';
 menu.innerHTML = '<summary aria-label="Widget menu">☰ <span>Widgets</span></summary><div class="widget-menu-body"><strong>Your workspace</strong><p>Show, hide, resize, or reorder modules.</p></div>';
 document.querySelector('h1').before(menu);
 const body = menu.querySelector('div');
 widgets.forEach((el,index) => {
  el.classList.add('widget');
  el.hidden = Array.isArray(saved.hidden) && saved.hidden.includes(el.id);
  if (Array.isArray(saved.wide)) el.classList.toggle('wide', saved.wide.includes(el.id));
  const name = el.dataset.title || el.querySelector('.control-title')?.childNodes[0].textContent.trim() || 'Module';
  const label = document.createElement('label');
  const check = document.createElement('input'); check.type='checkbox'; check.checked=!el.hidden;
  label.append(check,document.createTextNode(name)); body.append(label);
  check.onchange=()=>{el.hidden=!check.checked;persist();window.dispatchEvent(new Event('resize'));};
  const header = document.createElement('div'); header.className='widget-header';
  const handle = document.createElement('button'); handle.className='drag-handle'; handle.textContent='⠿ '+name; handle.title='Drag to reorder. Use arrow keys to move.';
  const move = delta => { const all=[...workspace.children]; const at=all.indexOf(el); const other=all[at+delta]; if(other){workspace.insertBefore(el,delta<0?other:other.nextSibling);persist();} };
  handle.onkeydown=e=>{if(e.key==='ArrowUp'||e.key==='ArrowLeft'){e.preventDefault();move(-1);}if(e.key==='ArrowDown'||e.key==='ArrowRight'){e.preventDefault();move(1);}};
  let dragging=false;
  handle.onpointerdown=e=>{if(e.button!==0)return; dragging=true;handle.setPointerCapture(e.pointerId);el.classList.add('dragging');};
  handle.onpointermove=e=>{
   if(!dragging)return;
   const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('.widget');
   if(target&&target!==el&&target.parentElement===workspace){
    const current=[...workspace.children];
    workspace.insertBefore(el,current.indexOf(el)<current.indexOf(target)?target.nextSibling:target);
   }
   if(e.clientY<70)window.scrollBy(0,-14);else if(e.clientY>innerHeight-70)window.scrollBy(0,14);
  };
  const end=()=>{dragging=false;el.classList.remove('dragging');persist();};handle.onpointerup=end;handle.onpointercancel=end;
  const size=document.createElement('button');size.textContent='↔';size.title='Toggle wide module';size.onclick=()=>{el.classList.toggle('wide');persist();window.dispatchEvent(new Event('resize'));};
  const hide=document.createElement('button');hide.textContent='×';hide.title='Hide '+name;hide.onclick=()=>{el.hidden=true;check.checked=false;persist();};
  header.append(handle,size,hide);el.prepend(header);
 });
 const reset=document.createElement('button');reset.textContent='Reset layout';reset.onclick=()=>{widgets.sort((a,b)=>Number(a.dataset.order)-Number(b.dataset.order)).forEach(el=>{workspace.append(el);el.hidden=false;el.classList.toggle('wide',el.dataset.wide==='true');});body.querySelectorAll('input').forEach(x=>x.checked=true);persist();};body.append(reset);

}
