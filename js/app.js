import { setupWidgets } from './widgets.js';
import { createSequencer } from './sequencer.js';
window.addEventListener('load',()=>{
 const container=document.querySelector('.container');
 const workspace=document.createElement('main');workspace.id='workspace';
 const {sequence,automation}=createSequencer();workspace.append(sequence,automation);
 document.querySelectorAll('.controls > .control-group').forEach((el,i)=>{el.id ||= 'settings-module-'+i;workspace.append(el);});
 const wrap=(selector,id,title)=>{const content=document.querySelector(selector);const panel=document.createElement('section');panel.id=id;panel.dataset.title=title;panel.dataset.wide='true';panel.className='wide';panel.append(content);workspace.append(panel);};
 wrap('.launchpad-looper-container','looper-module','Loop recorder');
 wrap('.visualizer','scope-module','Oscilloscope');
 wrap('#keyboard','keyboard-module','Keyboard');
 wrap('#synthesiaContainer','falling-module','Falling notes');
 document.querySelector('.controls').remove();document.querySelector('.looper-toggle-bar').remove();
 const looper=workspace.querySelector('#launchpadLooperContainer');looper.classList.add('open');looper.style.display='grid';
 container.append(workspace);setupWidgets(workspace);
 window.dispatchEvent(new Event('resize'));
});
