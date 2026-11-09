const SAMPLE_RATE = 48000, STARTUP_LIMIT = 120000, STALL_LIMIT = 8000;

export class NativeVst3Live {
 constructor(file, { network = false, onProgress = () => {}, onFailure = () => {} } = {}) {
  this.file = file; this.network = network; this.onProgress = onProgress; this.onFailure = onFailure; this.state = { produced: 0, consumed: 0, underruns: 0, blocks: 0 }; this.held = new Set();
 }
 async start() {
  this.context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
  await this.context.audioWorklet.addModule(new URL('./native-vst3-live-worklet.js', import.meta.url));
  await this.context.resume();
  this.node = new AudioWorkletNode(this.context, 'native-vst3-live', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  this.analyser = this.context.createAnalyser(); this.analyser.fftSize = 2048;
  this.node.connect(this.analyser); this.analyser.connect(this.context.destination);
  const channel = new MessageChannel();
  this.node.port.postMessage({ port: channel.port1 }, [channel.port1]);
  this.worker = new Worker(new URL('./native-vst3-live-worker.js', import.meta.url));
  return new Promise((resolve, reject) => {
   const startup = setTimeout(() => { this.dispose(); reject(new Error('The plugin did not finish starting within its time limit; worker terminated')); }, STARTUP_LIMIT);
   this.worker.onerror = event => { event.preventDefault(); clearTimeout(startup); this.dispose(); reject(new Error(event.message || 'Native live worker failed')); };
   this.worker.onmessage = ({ data }) => {
    if (data.type === 'progress') this.onProgress(data.stage);
    else if (data.type === 'ready') { clearTimeout(startup); this.info = data.info; this.name = data.name; this.watch(); resolve(this); }
    else if (data.type === 'state') { this.state = data; this.alive = performance.now(); }
    else if (data.type === 'error') { clearTimeout(startup); const error = Object.assign(new Error(data.message), { details: data.details, stage: data.stage }); this.dispose(); reject(error); this.onFailure(error); }
   };
   this.worker.postMessage({ type: 'start', file: this.file, network: this.network, sampleRate: SAMPLE_RATE, port: channel.port2 }, [channel.port2]);
  });
 }
 watch() {
  this.alive = performance.now();
  this.watchdog = setInterval(() => {
   if (performance.now() - this.alive < STALL_LIMIT) return;
   const error = new Error('The plugin stopped responding; worker terminated'); this.dispose(); this.onFailure(error);
  }, 1000);
 }
 send(events) { this.worker?.postMessage({ type: 'midi', events }); }
 noteOn(pitch, velocity = 0.8) { if (!this.held.has(pitch)) { this.held.add(pitch); this.send([{ type: 'on', pitch, velocity }]); } }
 noteOff(pitch) { if (this.held.delete(pitch)) this.send([{ type: 'off', pitch }]); }
 level() {
  if (!this.analyser) return 0;
  const samples = new Float32Array(this.analyser.fftSize); this.analyser.getFloatTimeDomainData(samples);
  return samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0);
 }
 dispose() {
  clearInterval(this.watchdog); this.worker?.terminate(); this.worker = null;
  this.node?.disconnect(); this.analyser?.disconnect(); this.context?.close().catch(() => {}); this.context = null; this.node = null; this.analyser = null;
 }
 stop() { this.dispose(); }
}

export function midiToEvents(session, [status, pitch, velocity]) {
 const kind = status & 0xf0;
 if (kind === 0x90 && velocity) session.noteOn(pitch, velocity / 127);
 else if (kind === 0x80 || kind === 0x90) session.noteOff(pitch);
}
