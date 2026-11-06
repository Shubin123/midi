// The app's own sections of the Settings menu (js/widgets.js builds the menu): stopping every sound, the
// floating PANIC button, the AI teacher and its 🎓 buttons. Each switch is saved when changed. The teacher is
// told of its switch with a 'teacher:enabled' event on window (detail: true or false) and reads the same saved
// value when it starts.
import { read, save } from './storage.js';

export const TEACHER_KEY = 'teacher-enabled-v1', PANIC_BUTTON_KEY = 'panic-button-v2', TEACH_BUTTONS_KEY = 'teach-buttons-v1';

// The floating PANIC button and the 🎓 buttons take room, so they are off unless switched on: the page hides
// them (workspace.css) until these classes say otherwise, set here before the teacher adds its buttons.
const html = document.documentElement;
html.classList.toggle('panic-button-on', read(PANIC_BUTTON_KEY, false));
html.classList.toggle('teach-buttons-on', read(TEACH_BUTTONS_KEY, false));

const el = (tag, props = {}, ...children) => { const e = Object.assign(document.createElement(tag), props); e.append(...children); return e; };
const toggle = (id, text, on, onChange) => {
 const box = el('input', { type: 'checkbox', id, checked: on });
 box.onchange = () => onChange(box.checked);
 return el('label', {}, box, text);
};
const shows = (cls, key) => on => { html.classList.toggle(cls, on); save(key, on); };

export function addAppSettings(section) {
 // Sound: the panic, here and (when switched on) on a floating button.
 const stop = el('button', { type: 'button', id: 'settings-panic', textContent: 'Stop all sounds (panic)', title: 'Stops every note, loop, the sequencer and the metronome' });
 stop.onclick = () => window.synth?.panic();
 section('Sound',
  el('div', { className: 'widget-menu-actions' }, stop),
  toggle('settings-panic-button', 'PANIC button on the page', read(PANIC_BUTTON_KEY, false), shows('panic-button-on', PANIC_BUTTON_KEY)),
  el('p', { textContent: 'Every sound also stops by itself when you come back to this tab.' }));

 // The AI teacher, and its 🎓 buttons (which it hides with itself, so their switch rests while it is off).
 const teach = toggle('settings-teach-buttons', '🎓 buttons on widgets, each opening its guide', read(TEACH_BUTTONS_KEY, false), shows('teach-buttons-on', TEACH_BUTTONS_KEY));
 const teacherOn = read(TEACHER_KEY, true);
 teach.querySelector('input').disabled = !teacherOn;
 const ownSwitch = toggle('settings-teacher', 'AI teacher', teacherOn, on => {
  save(TEACHER_KEY, on);
  teach.querySelector('input').disabled = !on;
  window.dispatchEvent(new CustomEvent('teacher:enabled', { detail: on }));
 });
 ownSwitch.dataset.notForTeacher = ''; // the teacher can change the rest of Settings, but not switch itself off
 section('AI teacher',
  ownSwitch,
  teach,
  el('p', { textContent: 'Off, the teacher is hidden and stops listening, talking and coaching; your conversation and lessons are kept.' }));
}
