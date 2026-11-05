import { setupWidgets } from './widgets.js';
import { createSequencer } from './sequencer.js';
import { createAirWidget } from './air-widget.js';
import { createPluginHost } from './plugin-host.js';
import { createIoWidget } from './io-widget.js';
window.addEventListener('load',()=>{
 const container=document.querySelector('.container');
 const workspace=document.createElement('main');workspace.id='workspace';
 // The keyboard comes first and carries the falling notes directly above the keys, so each note lines up
 // with its key; their on/off switch moves here from Master & Settings.
 const fallingToggle=document.getElementById('synthesiaToggle').closest('label');fallingToggle.removeAttribute('style');fallingToggle.lastChild.textContent=' Falling notes';
 const keyboardBar=document.createElement('div');keyboardBar.className='keyboard-toolbar';keyboardBar.append(fallingToggle);
 const keyboard=document.createElement('section');keyboard.id='keyboard-module';keyboard.dataset.title='Keyboard';keyboard.dataset.wide='true';keyboard.className='wide';
 keyboard.append(keyboardBar,document.querySelector('#synthesiaContainer'),document.querySelector('#keyboard'));workspace.append(keyboard);
 const {sequence,automation,api}=createSequencer();workspace.append(sequence,automation);
 document.querySelectorAll('.controls > .control-group').forEach((el,i)=>{el.id ||= 'settings-module-'+i;workspace.append(el);});
 const wrap=(selector,id,title)=>{const content=document.querySelector(selector);const panel=document.createElement('section');panel.id=id;panel.dataset.title=title;panel.dataset.wide='true';panel.className='wide';panel.append(content);workspace.append(panel);};
 wrap('.launchpad-looper-container','looper-module','Loop recorder');
 wrap('.visualizer','scope-module','Oscilloscope');
 workspace.append(createAirWidget(),createPluginHost(),createIoWidget(api));
 document.querySelector('.controls').remove();document.querySelector('.looper-toggle-bar').remove();
 const looper=workspace.querySelector('#launchpadLooperContainer');looper.classList.add('open');looper.style.display='grid';
 container.append(workspace);setupWidgets(workspace);
 window.dispatchEvent(new Event('resize'));
});
