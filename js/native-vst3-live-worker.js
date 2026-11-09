const BLOCK = 256, AHEAD = 1536;
let processor = null, guest = null, port = null, stopped = false, produced = 0, consumed = 0, underruns = 0;
const pending = [];

function report(fields = {}) { self.postMessage({ type: 'state', produced, consumed, underruns, blocks: processor?.blocksProcessed ?? 0, ...fields }); }
function fail(error) {
 stopped = true;
 self.postMessage({ type: 'error', message: error.message || String(error), details: error.details ?? null, stage: guest?.audioHost?.failureStage || guest?.audioHost?.stage || null });
}

async function pump() {
 const channel = new MessageChannel();
 const breathe = () => new Promise(resolve => { channel.port1.onmessage = resolve; channel.port2.postMessage(0); });
 let lastReport = 0;
 while (!stopped) {
  if (produced - consumed >= AHEAD) { await new Promise(resolve => setTimeout(resolve, 2)); }
  else {
   const output = processor.process(BLOCK, { events: pending.splice(0, 256) })[0];
   const left = output[0], right = output[1] ?? left.slice();
   port.postMessage({ left, right }, [left.buffer, right.buffer]);
   produced += BLOCK;
   await breathe();
  }
  if (performance.now() - lastReport > 250) { lastReport = performance.now(); report(); }
 }
}

async function start({ file, network, sampleRate, port: audioPort }) {
 port = audioPort;
 port.onmessage = ({ data }) => { consumed = data.consumed; underruns = data.underruns; };
 const { readNativeVst3 } = await import('./native-vst3-input.js');
 self.postMessage({ type: 'progress', stage: 'reading' });
 const binary = await readNativeVst3(file, file.name);
 self.postMessage({ type: 'progress', stage: 'loading-emulator' });
 const { loadNativeEngine } = await import('./native-vst3-engine.js');
 const uc = await loadNativeEngine();
 const { NativeVst3Guest } = await import('./native-vst3-runtime.js');
 const { NativeVst3Processor } = await import('./native-vst3-audio.js');
 const bundle = binary.name.match(/([^/]+\.vst3)\/Contents\/MacOS\/[^/]+$/i)?.[1] || 'Plugin.vst3';
 const send = network ? (await import('./native-vst3-network.js')).sendGuestRequest : null;
 guest = new NativeVst3Guest(uc, binary.bytes, { bundlePath: `/plugin/${bundle}`, executableName: binary.name.split('/').at(-1), heapSize: 256 << 20, network: send });
 processor = new NativeVst3Processor(guest);
 self.postMessage({ type: 'progress', stage: 'opening-processor' });
 const info = processor.open({ sampleRate, maxBlock: BLOCK });
 if (!info.eventInputs) throw new Error('This plugin has no MIDI event input, so it cannot be played from a keyboard');
 self.postMessage({ type: 'ready', name: binary.name, info });
 pump().catch(fail);
}

self.onmessage = ({ data }) => {
 if (data.type === 'start') start(data).catch(fail);
 else if (data.type === 'midi') pending.push(...data.events);
 else if (data.type === 'stop') {
  stopped = true;
  try { processor?.close(); guest?.close(); } catch {}
  self.postMessage({ type: 'stopped' });
 }
};
