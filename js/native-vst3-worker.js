let busy = false;
self.onmessage = async ({ data }) => {
 if (busy) return;
 busy = true;
 let guest, binary, stage = 'input';
 const progress = next => { stage = next; self.postMessage({ type: 'progress', stage }); };
 try {
  if (!['startup', 'factory', 'processor', 'render'].includes(data.mode) || !(data.file instanceof Blob)) throw new Error('Expected a plugin file and a supported native execution mode');
  progress('reading');
  const { readNativeVst3 } = await import('./native-vst3-input.js');
  binary = await readNativeVst3(data.file, data.file.name);
  progress('loading-emulator');
  const { loadNativeEngine } = await import('./native-vst3-engine.js');
  const uc = await loadNativeEngine();
  progress('mapping');
  const { NativeVst3Guest } = await import('./native-vst3-runtime.js');
  const network = data.network === true ? (await import('./native-vst3-network.js')).sendGuestRequest : null;
  const bundleName = binary.name.match(/([^/]+\.vst3)\/Contents\/MacOS\/[^/]+$/i)?.[1] || 'Plugin.vst3';
  guest = new NativeVst3Guest(uc, binary.bytes, { bundlePath: `/plugin/${bundleName}`, executableName: binary.name.split('/').at(-1), heapSize: data.mode === 'processor' || data.mode === 'render' ? 256 << 20 : undefined, network });
  if (data.mode === 'render' || data.mode === 'processor') {
   const { NativeVst3Processor, renderNativeNote } = await import('./native-vst3-audio.js');
   let audio, configuration;
   if (data.mode === 'render') audio = renderNativeNote(guest, data.render, progress);
   else {
    progress('opening-processor'); const processor = new NativeVst3Processor(guest);
    configuration = processor.open(); processor.close();
   }
   const transfer = audio ? audio.buses.flat().map(channel => channel.buffer) : [];
   self.postMessage({ type: 'result', result: { name: binary.name, source: binary.source || null, mode: data.mode, stage: audio ? 'rendered' : 'processor-ready', ...guest.report(), processor: guest.audioHost.report(), ...(audio ? { audio } : { configuration }), warning: 'Bounded offline native execution, not a realtime plugin or an editor conversion.' } }, transfer);
   return;
  }
  if (data.mode === 'startup') { progress('initializers'); guest.initialize(); }
  progress('factory');
  const factory = guest.factoryInfo();
  self.postMessage({ type: 'result', result: { name: binary.name, source: binary.source || null, mode: data.mode, stage, factory, ...guest.report(), warning: data.mode === 'factory' ? 'Factory-only diagnostic: initializers and bundleEntry were NOT run. This is not a working plugin or an audio conversion.' : 'Startup reached the factory. Use the processor or render probe to attempt audio; this report alone does not verify playback.' } });
 } catch (error) {
  self.postMessage({ type: 'result', result: { name: binary?.name || data.file?.name || null, source: binary?.source || null, mode: data.mode, stage: guest?.audioHost?.failureStage || guest?.audioHost?.stage || (stage === 'initializers' ? guest?.startupStage || stage : stage), playable: false, error: { message: error.message || String(error), ...error.details }, ...guest?.report(), ...(guest?.audioHost ? { processor: guest.audioHost.report() } : {}) } });
 } finally {
  try { guest?.close(); } catch {} finally { self.close(); }
 }
};
