import { read, save } from './storage.js';
import { targets, valueAt, apply } from './automation.js';
import { SCALE_TEMPLATES, NOTE_NAMES } from './pitch-analyzer.js';

// Scales the step grid can use: every scale and mode the teacher's analyser knows, plus chromatic.
export const SCALES = { ...SCALE_TEMPLATES, 'Chromatic': [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
export const SCALE_GROUPS = [
 ['Major and its modes', ['Ionian (Major)', 'Dorian', 'Phrygian', 'Lydian', 'Mixolydian', 'Aeolian (Minor)', 'Locrian']],
 ['Minor', ['Harmonic Minor', 'Melodic Minor']],
 ['Other modes', ['Phrygian Dominant', 'Lydian Dominant', 'Altered']],
 ['Pentatonic and blues', ['Major Pentatonic', 'Minor Pentatonic', 'Blues']],
 ['Symmetric', ['Whole Tone', 'Diminished (HW)', 'Diminished (WH)', 'Chromatic']],
];
const KEY_LABELS = ['C', 'C♯ / D♭', 'D', 'D♯ / E♭', 'E', 'F', 'F♯ / G♭', 'G', 'G♯ / A♭', 'A', 'A♯ / B♭', 'B'];
const OCTAVES = [2, 3, 4, 5, 6];
const toNote = midi => NOTE_NAMES[midi % 12] + Math.floor(midi / 12); // synth naming: "C5" is MIDI 60
const toMidi = note => Number(note.match(/-?\d+$/)[0]) * 12 + NOTE_NAMES.indexOf(note.replace(/-?\d+$/, ''));

// The rows for a key (0 = C), scale and octave: one octave of the scale up from the tonic, then the tonic an
// octave higher, lowest first.
export function scaleNotes(key, scale, octave) {
 const base = octave * 12 + key;
 return [...SCALES[scale].map(s => base + s), base + 12].map(toNote);
}

// Moves a pattern onto new rows. Each old row is shifted by `shift` semitones (the key or octave change) and
// lands on the nearest new row (the lower one on a tie), so within the same scale a melody transposes exactly
// and into another scale it snaps to the nearest degree. Rows that land together are merged.
export function remapPattern(oldNotes, pattern, newNotes, shift = 0) {
 const newMidi = newNotes.map(toMidi);
 const out = newNotes.map(() => Array(16).fill(false));
 oldNotes.forEach((note, r) => {
  const target = toMidi(note) + shift;
  let best = 0;
  newMidi.forEach((m, i) => { if (Math.abs(m - target) < Math.abs(newMidi[best] - target)) best = i; });
  pattern[r]?.forEach((on, s) => { if (on) out[best][s] = true; });
 });
 return out;
}

export function createSequencer() {
 const stored=read('synth-sequence-v1',{});
 // Patterns saved before keys and scales existed are C major pentatonic in octave 4, which is still the default.
 let key=Number.isInteger(stored.key)&&stored.key>=0&&stored.key<12?stored.key:0;
 let scale=SCALES[stored.scale]?stored.scale:'Major Pentatonic';
 let octave=OCTAVES.includes(stored.octave)?stored.octave:4;
 let notes=scaleNotes(key,scale,octave);
 const fits=p=>Array.isArray(p)&&p.length===notes.length&&p.every(row=>Array.isArray(row)&&row.length===16);
 const demo=[0,2,3,4,2,3,5,3,0,2,3,4,2,3,4,2];
 let pattern=fits(stored.pattern)?stored.pattern:notes.map((_,r)=>Array.from({length:16},(_,i)=>notes.length===6&&r===demo[i]));
 let lanes=Array.isArray(stored.lanes)?stored.lanes.filter(l=>targets[l.target]&&l.points?.length===16&&l.points.every(v=>Number.isFinite(v)&&v>=targets[l.target].min&&v<=targets[l.target].max)).map(l=>({...l,enabled:!!l.enabled})):[];
 if(!lanes.length)lanes=[{target:'tempo',enabled:false,mode:'linear',points:Array(16).fill(120)}];
 const persist=()=>save('synth-sequence-v1',{pattern,lanes,key,scale,octave});
 const sequence=document.createElement('section');sequence.id='step-sequencer';sequence.className='wide';sequence.dataset.title='Step sequencer';sequence.dataset.wide='true';
 sequence.innerHTML='<div class="module-content"><div class="sequence-toolbar"><button id="seq-play" class="std-button">▶ Play</button><button id="seq-stop" class="std-button">■ Stop</button><label>Base BPM <input id="seq-bpm" type="number" min="30" max="300" value="120"></label><span id="seq-position" role="status">Ready · 16 steps / 1 bar</span><button id="seq-clear">Clear notes</button></div><div class="sequence-toolbar seq-scale-row"><label>Key <select id="seq-key"></select></label><label>Scale <select id="seq-scale"></select></label><label>Octave <select id="seq-octave"></select></label></div><p class="module-hint">Tap steps to compose. Each column is a sixteenth note and each row a note of the chosen scale; changing the key or octave transposes the pattern, and changing the scale moves each note to the nearest note of the new one. Patterns and automation save automatically.</p><div class="sequence-scroll"><div class="step-grid"></div></div></div>';
 const keySelect=sequence.querySelector('#seq-key'),scaleSelect=sequence.querySelector('#seq-scale'),octaveSelect=sequence.querySelector('#seq-octave');
 KEY_LABELS.forEach((label,i)=>keySelect.append(new Option(label,i)));
 SCALE_GROUPS.forEach(([title,names])=>{const group=document.createElement('optgroup');group.label=title;names.forEach(n=>group.append(new Option(n,n)));scaleSelect.append(group);});
 OCTAVES.forEach(o=>octaveSelect.append(new Option(o,o)));
 keySelect.value=key;scaleSelect.value=scale;octaveSelect.value=octave;
 const grid=sequence.querySelector('.step-grid');
 let cells=[];
 const renderGrid=()=>{
  grid.replaceChildren();cells=[];
  notes.forEach((note,row)=>{const label=document.createElement('span');label.textContent=note;grid.append(label);for(let i=0;i<16;i++){const cell=document.createElement('button');cell.className='step';cell.dataset.step=i;cell.setAttribute('aria-label',`${note}, step ${i+1}`);const update=()=>{cell.classList.toggle('on',!!pattern[row][i]);cell.setAttribute('aria-pressed',!!pattern[row][i]);};update();cell.onclick=()=>{pattern[row][i]=!pattern[row][i];update();persist();};grid.append(cell);cells.push(cell);}});
 };renderGrid();
 const automation=document.createElement('section');automation.id='automation';automation.className='wide';automation.dataset.title='Automation';automation.dataset.wide='true';
 automation.innerHTML='<div class="module-content"><div class="sequence-toolbar"><strong>Motion, one step at a time.</strong><select id="automation-target" aria-label="Automation target"></select><button id="add-lane">+ Add lane</button></div><p class="module-hint">Enable a lane to automate it. Drag the values or type a value at any step. Linear blends between points; hold keeps each value until the next step. Lanes repeat with the pattern.</p><div id="lanes"></div></div>';
 const select=automation.querySelector('select');Object.entries(targets).forEach(([id,t])=>{const opt=document.createElement('option');opt.value=id;opt.textContent=t.label;select.append(opt);});
 let running=false,timer,phase=0,lastTime=0,lastStep=-1,active=new Set(),releaseAt=0,snapshot={};
 // A bounce plays a set number of bars without metronome clicks and resolves when playback stops.
 let bars=0,barLimit=Infinity,clicks=true,onStopped=null;
 const release=()=>{active.forEach(note=>window.synth.noteOff(note));active.clear();};
 const restore=lane=>{if(snapshot[lane.target]!==undefined)apply(lane.target,snapshot[lane.target]);};
 const changeScale=()=>{
  const nextKey=Number(keySelect.value),nextScale=scaleSelect.value,nextOctave=Number(octaveSelect.value);
  const next=scaleNotes(nextKey,nextScale,nextOctave);
  release();
  pattern=remapPattern(notes,pattern,next,(nextOctave*12+nextKey)-(octave*12+key));
  key=nextKey;scale=nextScale;octave=nextOctave;notes=next;
  renderGrid();persist();
 };
 keySelect.onchange=scaleSelect.onchange=octaveSelect.onchange=changeScale;
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
  refreshTargets();
 };
 // One lane per target: the menu offers the targets without a lane (used ones are marked and can't be picked),
 // and says so when every target has one, so "+ Add lane" never does nothing.
 const addButton=automation.querySelector('#add-lane');
 const refreshTargets=()=>{
  const used=new Set(lanes.map(l=>l.target));
  [...select.options].forEach(o=>{o.disabled=used.has(o.value);o.textContent=targets[o.value].label+(o.disabled?' (has a lane)':'');});
  if(select.selectedOptions[0]?.disabled)select.value=[...select.options].find(o=>!o.disabled)?.value??select.value;
  const full=used.size===select.options.length;
  addButton.disabled=full;addButton.textContent=full?'Every target has a lane':'+ Add lane';
 };
 renderLanes();
 automation.querySelector('#add-lane').onclick=()=>{const target=select.value;if(lanes.some(l=>l.target===target))return;const initial=target==='tempo'?window.synth.tempo:Number(document.getElementById(target).value);lanes.push({target,enabled:false,mode:'linear',points:Array(16).fill(initial)});if(running)snapshot[target]=initial;renderLanes();persist();
  // Show the new lane: it may be below the fold.
  const added=automation.querySelectorAll('.automation-lane')[lanes.length-1];added?.scrollIntoView({block:'nearest',behavior:'smooth'});added?.classList.add('just-added');setTimeout(()=>added?.classList.remove('just-added'),1600);};
 const position=sequence.querySelector('#seq-position'),play=sequence.querySelector('#seq-play'),bpm=sequence.querySelector('#seq-bpm');
 bpm.onchange=()=>{const v=Math.max(30,Math.min(300,Number(bpm.value)||120));bpm.value=v;window.synth.tempo=v;if(running)snapshot.tempo=v;};
 // The tempo set anywhere else (Tap BPM, − and +, the teacher) shows here, except while a tempo lane moves it.
 window.addEventListener('synth:tempo',e=>{if(!running)bpm.value=e.detail;});
 // While it plays, the sequencer is the beat (js/timing-widget.js): its first step sounds at `at`.
 const beatClock=(running,at=0)=>window.dispatchEvent(new CustomEvent('synth:beat-clock',{detail:{source:'sequencer',running,bpm:window.synth.tempo,at}}));
 const tick=()=>{
  const now=window.synth.context.currentTime;
  if(window.synth.context.state!=='running'){lastTime=now;return;}
  const elapsed=now-lastTime;lastTime=now;
  // Pause position while the page was throttled; never burst stale notes.
  phase=(phase+Math.min(elapsed,0.1)*window.synth.tempo/60*4)%16;
  lanes.filter(l=>l.enabled).forEach(l=>apply(l.target,valueAt(l.points,phase,l.mode)));
  const step=Math.floor(phase);
  if(now>=releaseAt)release();
  if(step!==lastStep){if(lastStep>=0&&step<lastStep&&++bars>=barLimit){stop();return;}release();lastStep=step;notes.forEach((note,r)=>{if(pattern[r][step]){window.synth.noteOn(note);active.add(note);}});releaseAt=now+60/window.synth.tempo/4*0.72;if(step%4===0&&clicks)window.synth.click();cells.forEach(c=>c.classList.toggle('playing',Number(c.dataset.step)===step));position.textContent=`Step ${step+1} / 16 · ${window.synth.tempo.toFixed(1)} BPM`;}
 };
 const stop=()=>{if(!running)return;running=false;clearInterval(timer);release();beatClock(false);Object.entries(snapshot).forEach(([target,value])=>apply(target,value));window.synth.resumeClick();phase=0;lastStep=-1;play.textContent='▶ Play';position.textContent='Stopped · 16 steps / 1 bar';cells.forEach(c=>c.classList.remove('playing'));barLimit=Infinity;clicks=true;const done=onStopped;onStopped=null;done?.();};
 const start=async(options={})=>{if(running)return;const context=window.synth.context;if(!context){position.textContent='Audio unavailable';return;}await context.resume();snapshot={tempo:window.synth.tempo};Object.keys(targets).filter(t=>t!=='tempo').forEach(t=>snapshot[t]=Number(document.getElementById(t).value));running=true;phase=0;lastStep=-1;lastTime=context.currentTime;window.synth.suspendClick();beatClock(true,window.synth.perfTimeOf(context.currentTime));play.textContent='Ⅱ Stop';bars=0;barLimit=options.bars??Infinity;clicks=options.click??true;const stopped=new Promise(r=>onStopped=r);options.onStart?.();tick();timer=setInterval(tick,10);return stopped;};
 play.onclick=()=>running?stop():start();
 sequence.querySelector('#seq-stop').onclick=stop;
 sequence.querySelector('#seq-clear').onclick=()=>{pattern=notes.map(()=>Array(16).fill(false));cells.forEach(c=>{c.classList.remove('on');c.setAttribute('aria-pressed','false');});persist();};
 const refresh=()=>cells.forEach((c,k)=>{const on=!!pattern[Math.floor(k/16)][k%16];c.classList.toggle('on',on);c.setAttribute('aria-pressed',on);});
 const setPattern=p=>{pattern=p;refresh();persist();};
 window.addEventListener('synth:panic',stop); // however a panic starts: the button, Settings, or coming back to the tab
 window.addEventListener('pagehide',stop);
 document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
 return {sequence,automation,api:{get notes(){return notes;},get pattern(){return pattern;},setPattern,start,stop,get running(){return running;},get lanes(){return lanes;}}};
}
