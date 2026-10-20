import { read, save } from './storage.js';
import { targets, valueAt, apply } from './automation.js';
export function createSequencer() {
 const stored=read('synth-sequence-v1',{});
 const notes=['C4','D4','E4','G4','A4','C5'];
 let pattern=Array.isArray(stored.pattern)&&stored.pattern.length===6&&stored.pattern.every(row=>Array.isArray(row)&&row.length===16)?stored.pattern:notes.map((_,r)=>Array.from({length:16},(_,i)=>r===[0,2,3,4,2,3,5,3,0,2,3,4,2,3,4,2][i]));
 let lanes=Array.isArray(stored.lanes)?stored.lanes.filter(l=>targets[l.target]&&l.points?.length===16&&l.points.every(v=>Number.isFinite(v)&&v>=targets[l.target].min&&v<=targets[l.target].max)).map(l=>({...l,enabled:!!l.enabled})):[];
 if(!lanes.length)lanes=[{target:'tempo',enabled:false,mode:'linear',points:Array(16).fill(120)}];
 const persist=()=>save('synth-sequence-v1',{pattern,lanes});
 const sequence=document.createElement('section');sequence.id='step-sequencer';sequence.className='wide';sequence.dataset.title='Step sequencer';sequence.dataset.wide='true';
 sequence.innerHTML='<div class="module-content"><div class="sequence-toolbar"><button id="seq-play" class="std-button">▶ Play</button><button id="seq-stop" class="std-button">■ Stop</button><label>Base BPM <input id="seq-bpm" type="number" min="30" max="300" value="120"></label><span id="seq-position" role="status">Ready · 16 steps / 1 bar</span><button id="seq-clear">Clear notes</button></div><p class="module-hint">Tap steps to compose. Each column is a sixteenth note. Patterns and automation save automatically.</p><div class="sequence-scroll"><div class="step-grid"></div></div></div>';
 const grid=sequence.querySelector('.step-grid');
 const cells=[];
 notes.forEach((note,row)=>{const label=document.createElement('span');label.textContent=note;grid.append(label);for(let i=0;i<16;i++){const cell=document.createElement('button');cell.className='step';cell.dataset.step=i;cell.setAttribute('aria-label',`${note}, step ${i+1}`);const update=()=>{cell.classList.toggle('on',!!pattern[row][i]);cell.setAttribute('aria-pressed',!!pattern[row][i]);};update();cell.onclick=()=>{pattern[row][i]=!pattern[row][i];update();persist();};grid.append(cell);cells.push(cell);}});
 const automation=document.createElement('section');automation.id='automation';automation.className='wide';automation.dataset.title='Automation';automation.dataset.wide='true';
 automation.innerHTML='<div class="module-content"><div class="sequence-toolbar"><strong>Motion, one step at a time.</strong><select id="automation-target" aria-label="Automation target"></select><button id="add-lane">+ Add lane</button></div><p class="module-hint">Enable a lane to automate it. Drag the values or type a value at any step. Linear blends between points; hold keeps each value until the next step. Lanes repeat with the pattern.</p><div id="lanes"></div></div>';
 const select=automation.querySelector('select');Object.entries(targets).forEach(([id,t])=>{const opt=document.createElement('option');opt.value=id;opt.textContent=t.label;select.append(opt);});
 let running=false,timer,phase=0,lastTime=0,lastStep=-1,active=new Set(),releaseAt=0,snapshot={};
 const release=()=>{active.forEach(note=>window.synth.noteOff(note));active.clear();};
 const restore=lane=>{if(snapshot[lane.target]!==undefined)apply(lane.target,snapshot[lane.target]);};
 const renderLanes=()=>{
  const host=automation.querySelector('#lanes');host.replaceChildren();
  lanes.forEach((lane,index)=>{
   const t=targets[lane.target],box=document.createElement('div');box.className='automation-lane';
   const toolbar=document.createElement('div');toolbar.className='sequence-toolbar';
   const label=document.createElement('label'),enabled=document.createElement('input');enabled.type='checkbox';enabled.checked=lane.enabled;label.append(enabled,t.label);
   enabled.onchange=()=>{lane.enabled=enabled.checked;if(running&&!lane.enabled)restore(lane);persist();};
   const mode=document.createElement('select');mode.setAttribute('aria-label',t.label+' interpolation');mode.innerHTML='<option value="linear">Linear ramp</option><option value="hold">Hold / steps</option>';mode.value=lane.mode;mode.onchange=()=>{lane.mode=mode.value;persist();};
   const ramp=document.createElement('button');ramp.textContent='Ramp up';ramp.onclick=()=>{lane.points=Array.from({length:16},(_,i)=>Math.round((t.min+(t.max-t.min)*i/15)*1000)/1000);renderLanes();persist();};
   const flat=document.createElement('button');flat.textContent='Flatten';flat.onclick=()=>{lane.points.fill(lane.points[0]);renderLanes();persist();};
   const remove=document.createElement('button');remove.textContent='Remove';remove.onclick=()=>{if(running)restore(lane);lanes.splice(index,1);renderLanes();persist();};
   toolbar.append(label,mode,ramp,flat,remove);box.append(toolbar);
   const scroll=document.createElement('div');scroll.className='sequence-scroll';const points=document.createElement('div');points.className='automation-points';
   lane.points.forEach((value,i)=>{const col=document.createElement('label');col.className='automation-point';col.textContent=i+1;const slider=document.createElement('input');slider.type='range';slider.min=t.min;slider.max=t.max;slider.step=(t.max-t.min)>100?1:0.001;slider.value=value;slider.setAttribute('aria-label',`${t.label} step ${i+1}`);const number=document.createElement('input');number.type='number';number.min=t.min;number.max=t.max;number.step=slider.step;number.value=value;number.setAttribute('aria-label',`${t.label} step ${i+1} value`);const set=v=>{if(!Number.isFinite(v))return;lane.points[i]=Math.max(t.min,Math.min(t.max,v));slider.value=number.value=lane.points[i];persist();};slider.oninput=()=>set(Number(slider.value));number.onchange=()=>set(Number(number.value));col.append(slider,number);points.append(col);});scroll.append(points);box.append(scroll);host.append(box);
  });
 };renderLanes();
 automation.querySelector('#add-lane').onclick=()=>{const target=select.value;if(lanes.some(l=>l.target===target))return;const initial=target==='tempo'?window.synth.tempo:Number(document.getElementById(target).value);lanes.push({target,enabled:false,mode:'linear',points:Array(16).fill(initial)});if(running)snapshot[target]=initial;renderLanes();persist();};
 const position=sequence.querySelector('#seq-position'),play=sequence.querySelector('#seq-play'),bpm=sequence.querySelector('#seq-bpm');
 bpm.onchange=()=>{const v=Math.max(30,Math.min(300,Number(bpm.value)||120));bpm.value=v;window.synth.tempo=v;if(running)snapshot.tempo=v;};
 const tick=()=>{
  const now=window.synth.context.currentTime;
  if(window.synth.context.state!=='running'){lastTime=now;return;}
  const elapsed=now-lastTime;lastTime=now;
  // Pause position while the page was throttled; never burst stale notes.
  phase=(phase+Math.min(elapsed,0.1)*window.synth.tempo/60*4)%16;
  lanes.filter(l=>l.enabled).forEach(l=>apply(l.target,valueAt(l.points,phase,l.mode)));
  const step=Math.floor(phase);
  if(now>=releaseAt)release();
  if(step!==lastStep){release();lastStep=step;notes.forEach((note,r)=>{if(pattern[r][step]){window.synth.noteOn(note);active.add(note);}});releaseAt=now+60/window.synth.tempo/4*0.72;if(step%4===0)window.synth.click();cells.forEach(c=>c.classList.toggle('playing',Number(c.dataset.step)===step));position.textContent=`Step ${step+1} / 16 · ${window.synth.tempo.toFixed(1)} BPM`;}
 };
 const stop=()=>{if(!running)return;running=false;clearInterval(timer);release();Object.entries(snapshot).forEach(([target,value])=>apply(target,value));window.synth.resumeClick();phase=0;lastStep=-1;play.textContent='▶ Play';position.textContent='Stopped · 16 steps / 1 bar';cells.forEach(c=>c.classList.remove('playing'));};
 play.onclick=async()=>{if(running){stop();return;}const context=window.synth.context;if(!context){position.textContent='Audio unavailable';return;}await context.resume();snapshot={tempo:window.synth.tempo};Object.keys(targets).filter(t=>t!=='tempo').forEach(t=>snapshot[t]=Number(document.getElementById(t).value));running=true;phase=0;lastStep=-1;lastTime=context.currentTime;window.synth.suspendClick();play.textContent='Ⅱ Stop';tick();timer=setInterval(tick,10);};
 sequence.querySelector('#seq-stop').onclick=stop;
 sequence.querySelector('#seq-clear').onclick=()=>{pattern=notes.map(()=>Array(16).fill(false));cells.forEach(c=>{c.classList.remove('on');c.setAttribute('aria-pressed','false');});persist();};
 document.getElementById('stopAllSoundsButton').addEventListener('click',stop,true);
 window.addEventListener('pagehide',stop);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
 return {sequence,automation};
}
