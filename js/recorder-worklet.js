// AudioWorklet that taps the master output and posts stereo blocks, stamped with their audio-clock frame.
const BLOCK = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
 constructor() {
  super();
  this.recording = false;
  this.port.onmessage = ({ data }) => {
   if (data === 'start') { this.recording = true; this.fill = 0; this.frame = -1; this.buffers = [new Float32Array(BLOCK), new Float32Array(BLOCK)]; }
   if (data === 'stop') { this.flush(); this.recording = false; this.port.postMessage({ stopped: true }); }
  };
 }
 flush() {
  if (!this.fill) return;
  this.port.postMessage({ frame: this.frame, data: this.buffers.map(b => b.slice(0, this.fill)) });
  this.frame += this.fill; this.fill = 0;
 }
 process([input]) {
  if (!this.recording) return true;
  if (this.frame < 0) { this.frame = currentFrame; this.port.postMessage({ started: currentFrame }); }
  const n = input[0]?.length || 128;
  for (let c = 0; c < 2; c++) {
   const src = input[c] || input[0];
   if (src) this.buffers[c].set(src, this.fill); else this.buffers[c].fill(0, this.fill, this.fill + n);
  }
  this.fill += n;
  if (this.fill + 128 > BLOCK) this.flush();
  return true;
 }
}
registerProcessor('master-recorder', RecorderProcessor);
