import { probeNativeVst3 } from './native-vst3-probe.js';
import { encodeAudio } from './audio-files.js';

const input = document.querySelector('#plugin'), startup = document.querySelector('#startup'), factory = document.querySelector('#factory');
const processor = document.querySelector('#processor'), render = document.querySelector('#render'), preview = document.querySelector('#preview');
const stop = document.querySelector('#stop'), status = document.querySelector('#status'), output = document.querySelector('#result'), download = document.querySelector('#download');
let controller = null, report = null, previewUrl = null;
const clearPreview = () => {
 preview.pause(); preview.removeAttribute('src'); preview.load(); preview.hidden = true;
 if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null;
};
const controls = running => {
 input.disabled = running;
 for (const button of [startup, factory, processor, render]) button.disabled = running || !input.files.length;
 stop.disabled = !running; download.disabled = running || !report;
};
input.addEventListener('change', () => { clearPreview(); report = null; output.textContent = ''; status.textContent = input.files[0]?.name || 'Choose a plugin to begin.'; controls(false); });
async function run(mode) {
 const file = input.files[0];
 if (!file || controller) return;
 clearPreview(); controller = new AbortController(); report = null; output.textContent = ''; controls(true);
 try {
  const result = await probeNativeVst3(file, { mode, timeout: ['processor', 'render'].includes(mode) ? 120000 : 30000, signal: controller.signal, onProgress: stage => { status.textContent = stage.replaceAll('-', ' '); } });
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
stop.addEventListener('click', () => controller?.abort());
window.addEventListener('pagehide', () => { controller?.abort(); clearPreview(); });
download.addEventListener('click', () => {
 if (!report) return;
 const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
 const link = document.createElement('a'); link.href = url; link.download = 'native-vst3-report.json'; link.click();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
});
