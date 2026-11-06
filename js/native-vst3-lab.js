import { probeNativeVst3 } from './native-vst3-probe.js';

const input = document.querySelector('#plugin'), startup = document.querySelector('#startup'), factory = document.querySelector('#factory');
const stop = document.querySelector('#stop'), status = document.querySelector('#status'), output = document.querySelector('#result'), download = document.querySelector('#download');
let controller = null, report = null;
const controls = running => {
 input.disabled = running; startup.disabled = factory.disabled = running || !input.files.length; stop.disabled = !running; download.disabled = running || !report;
};
input.addEventListener('change', () => { report = null; output.textContent = ''; status.textContent = input.files[0]?.name || 'Choose a plugin to begin.'; controls(false); });
async function run(mode) {
 const file = input.files[0];
 if (!file || controller) return;
 controller = new AbortController(); report = null; output.textContent = ''; controls(true);
 try {
  report = await probeNativeVst3(file, { mode, signal: controller.signal, onProgress: stage => { status.textContent = stage.replaceAll('-', ' '); } });
  output.textContent = JSON.stringify(report, null, 2);
  status.textContent = report.error ? 'Stopped at an unsupported dependency or execution limit. Not playable.' : 'Factory diagnostic completed. Not playable.';
 } catch (error) { status.textContent = error.name === 'AbortError' ? 'Stopped; worker terminated.' : error.message; }
 finally { controller = null; controls(false); }
}
startup.addEventListener('click', () => run('startup'));
factory.addEventListener('click', () => run('factory'));
stop.addEventListener('click', () => controller?.abort());
window.addEventListener('pagehide', () => controller?.abort());
download.addEventListener('click', () => {
 if (!report) return;
 const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
 const link = document.createElement('a'); link.href = url; link.download = 'native-vst3-report.json'; link.click();
 setTimeout(() => URL.revokeObjectURL(url), 1000);
});
