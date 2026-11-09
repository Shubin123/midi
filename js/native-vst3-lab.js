import { probeNativeVst3 } from './native-vst3-probe.js';
import { encodeAudio } from './audio-files.js';
import { NativeVst3Live, midiToEvents } from './native-vst3-live.js';

const input = document.querySelector('#plugin'), startup = document.querySelector('#startup'), factory = document.querySelector('#factory');
const processor = document.querySelector('#processor'), render = document.querySelector('#render'), preview = document.querySelector('#preview');
const live = document.querySelector('#live'), keys = document.querySelector('#keys'), liveHelp = document.querySelector('#live-help');
const network = document.querySelector('#network'), stop = document.querySelector('#stop'), status = document.querySelector('#status'), output = document.querySelector('#result'), download = document.querySelector('#download');
let controller = null, report = null, previewUrl = null, session = null, meter = 0, midiInputs = [];
const clearPreview = () => {
 preview.pause(); preview.removeAttribute('src'); preview.load(); preview.hidden = true;
 if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
};
const controls = running => {
 input.disabled = running;
 for (const button of [startup, factory, processor, render, live]) button.disabled = running || !input.files.length;
 stop.disabled = !running; download.disabled = running || !report;
};
input.addEventListener('change', () => { clearPreview(); report = null; output.textContent = ''; status.textContent = input.files[0]?.name || 'Choose a plugin to begin.'; controls(false); });
async function run(mode) {
 const file = input.files[0];
 if (!file || controller) return;
 clearPreview(); controller = new AbortController(); report = null; output.textContent = ''; controls(true);
 try {
  const result = await probeNativeVst3(file, { mode, timeout: ['processor', 'render'].includes(mode) ? 120000 : 30000, network: network.checked, signal: controller.signal, onProgress: stage => { status.textContent = stage.replaceAll('-', ' '); } });
  if (result.audio) {
   const audio = result.audio;
   previewUrl = URL.createObjectURL(encodeAudio(audio.buses[0], audio.sampleRate)); preview.src = previewUrl; preview.hidden = false;
   report = { ...result, audio: { ...audio, buses: audio.buses.map(bus => bus.length) } };
  } else report = result;
  output.textContent = JSON.stringify(report, null, 2);
  status.textContent = report.error ? `Stopped during ${report.stage}: ${report.error.message}. Not playable.` : report.audio ? report.audio.silent ? 'Native processing completed but rendered silence. Preview available; not realtime playback.' : 'Native audio rendered. Preview available; not realtime playback.' : report.configuration ? 'Audio processor initialized. No audio has been rendered.' : 'Factory diagnostic completed. No audio has been rendered.';
 } catch (error) { status.textContent = error.name === 'AbortError' ? 'Stopped; worker terminated.' : error.message; }
 finally { controller = null; controls(false); }
}
startup.addEventListener('click', () => run('startup'));
factory.addEventListener('click', () => run('factory'));
processor.addEventListener('click', () => run('processor'));
render.addEventListener('click', () => run('render'));
stop.addEventListener('click', () => { if (session) endLive(); else controller?.abort(); });
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'], KEY_MAP = new Map([...'awsedftgyhujk'].map((key, index) => [key, 60 + index]));
for (let pitch = 48; pitch <= 72; pitch++) {
 const key = document.createElement('button'), name = NOTE_NAMES[pitch % 12];
 key.type = 'button'; key.dataset.pitch = pitch; key.textContent = name; key.setAttribute('aria-label', `${name}${Math.floor(pitch / 12) - 1}`); key.className = name.length > 1 ? 'black' : 'white';
 key.addEventListener('pointerdown', event => { key.setPointerCapture(event.pointerId); session?.noteOn(pitch); key.classList.add('down'); });
 for (const type of ['pointerup', 'pointercancel']) key.addEventListener(type, () => { session?.noteOff(pitch); key.classList.remove('down'); });
 keys.append(key);
}
const keyDown = event => {
 if (!session || event.repeat || event.metaKey || event.ctrlKey || event.altKey || !KEY_MAP.has(event.key.toLowerCase())) return;
 const pitch = KEY_MAP.get(event.key.toLowerCase()); session.noteOn(pitch); keys.querySelector(`[data-pitch="${pitch}"]`)?.classList.add('down');
};
const keyUp = event => {
 if (!session || !KEY_MAP.has(event.key.toLowerCase())) return;
 const pitch = KEY_MAP.get(event.key.toLowerCase()); session.noteOff(pitch); keys.querySelector(`[data-pitch="${pitch}"]`)?.classList.remove('down');
};
function endLive(message) {
 window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp);
 for (const midi of midiInputs) midi.onmidimessage = null;
 midiInputs = []; clearInterval(meter); session?.stop(); session = null;
 keys.hidden = true; liveHelp.hidden = true; controls(false);
 status.textContent = message ?? 'Live playing stopped.';
}
live.addEventListener('click', async () => {
 const file = input.files[0];
 if (!file || session || controller) return;
 clearPreview(); report = null; output.textContent = ''; controls(true);
 const active = new NativeVst3Live(file, { network: network.checked, onProgress: stage => { status.textContent = stage.replaceAll('-', ' '); }, onFailure: error => endLive(`Stopped: ${error.message}`) });
 session = active;
 try {
  await active.start();
  keys.hidden = false; liveHelp.hidden = false;
  window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp);
  try {
   const access = await navigator.requestMIDIAccess?.();
   midiInputs = access ? [...access.inputs.values()] : [];
   for (const midi of midiInputs) midi.onmidimessage = event => session && midiToEvents(session, event.data);
  } catch {}
  meter = setInterval(() => { if (session) status.textContent = `Live: ${session.name}. ${session.state.blocks} audio blocks rendered, ${session.state.underruns} audio dropouts.`; }, 500);
 } catch (error) { if (session) endLive(`Stopped during ${error.stage ?? 'startup'}: ${error.message}. Not playable.`); }
});
window.addEventListener('pagehide', () => { controller?.abort(); session?.stop(); clearPreview(); });
download.addEventListener('click', () => {
 if (!report) return;
 const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
 const link = document.createElement('a'); link.href = url; link.download = 'native-vst3-report.json'; link.click();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
});
