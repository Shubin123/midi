let busy = false;
self.onmessage = async ({ data }) => {
 if (busy) return;
 busy = true;
 let guest, binary, stage = 'input';
 const progress = next => { stage = next; self.postMessage({ type: 'progress', stage }); };
 try {
  if (!['startup', 'factory'].includes(data.mode) || !(data.file instanceof Blob)) throw new Error('Expected a plugin file and startup or factory mode');
  progress('reading');
  const { readNativeVst3 } = await import('./native-vst3-input.js');
  binary = await readNativeVst3(data.file, data.file.name);
  progress('loading-emulator');
  const { loadNativeEngine } = await import('./native-vst3-engine.js');
  const uc = await loadNativeEngine();
  progress('mapping');
  const { NativeVst3Guest } = await import('./native-vst3-runtime.js');
  guest = new NativeVst3Guest(uc, binary.bytes);
  if (data.mode === 'startup') { progress('initializers'); guest.initialize(); }
  progress('factory');
  const factory = guest.factoryInfo();
  self.postMessage({ type: 'result', result: { name: binary.name, source: binary.source || null, mode: data.mode, stage, factory, ...guest.report(), warning: data.mode === 'factory' ? 'Factory-only diagnostic: initializers and bundleEntry were NOT run. This is not a working plugin or an audio conversion.' : 'Startup reached the factory. Audio processing and the editor are not implemented.' } });
 } catch (error) {
  self.postMessage({ type: 'result', result: { name: binary?.name || data.file?.name || null, source: binary?.source || null, mode: data.mode, stage, playable: false, error: { message: error.message || String(error), ...error.details }, ...guest?.report() } });
 } finally {
  try { guest?.close(); } catch {} finally { self.close(); }
 }
};
