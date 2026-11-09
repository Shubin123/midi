class NativeVst3LiveProcessor extends AudioWorkletProcessor {
 constructor() {
  super();
  this.queue = []; this.offset = 0; this.consumed = 0; this.underruns = 0; this.started = false; this.audio = null; this.tick = 0;
  this.port.onmessage = ({ data }) => {
   this.audio = data.port;
   this.audio.onmessage = ({ data: chunk }) => this.queue.push(chunk);
  };
 }
 process(_, outputs) {
  const [left, right] = outputs[0], frames = left.length;
  let filled = 0;
  while (filled < frames && this.queue.length) {
   const chunk = this.queue[0], count = Math.min(frames - filled, chunk.left.length - this.offset);
   left.set(chunk.left.subarray(this.offset, this.offset + count), filled);
   right?.set(chunk.right.subarray(this.offset, this.offset + count), filled);
   filled += count; this.offset += count;
   if (this.offset >= chunk.left.length) { this.queue.shift(); this.offset = 0; }
  }
  if (filled) this.started = true;
  if (this.started && filled < frames) this.underruns++;
  this.consumed += filled;
  if (this.audio && ++this.tick % 4 === 0) this.audio.postMessage({ consumed: this.consumed, underruns: this.underruns });
  return true;
 }
}
registerProcessor('native-vst3-live', NativeVst3LiveProcessor);
