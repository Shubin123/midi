// Ordered insert chain between the synth's master gain and its limiter.
const slots = [];
export function fxSlot(order) {
 const slot = { order, node: null };
 slots.push(slot);
 return {
  set(node) { slot.node = node; rewire(); },
  clear() { slot.node = null; rewire(); }
 };
}
function rewire() {
 const { input, output } = window.synth.fx;
 if (!input) return;
 const cut = node => { try { node.disconnect(); } catch { /* Already disconnected. */ } };
 const active = slots.filter(s => s.node).sort((a, b) => a.order - b.order);
 cut(input); active.forEach(s => cut(s.node.output));
 let tail = input;
 active.forEach(s => { tail.connect(s.node.input); tail = s.node.output; });
 tail.connect(output);
}

// Plug-in instruments play into master volume beside the built-in voices, ahead of the effect chain, so
// effects, recording and the scope all hear them. While any is active and not layered, the built-in voices
// are muted; audio that enters the effect chain from elsewhere (clips) is left alone.
const instruments = new Set();
export function instrumentSlot() {
 const slot = { node: null };
 const clear = () => {
  if (!slot.node) return;
  try { slot.node.output.disconnect(window.synth.instrumentInput); } catch { /* Already disconnected. */ }
  slot.node = null; instruments.delete(slot); updateVoices();
 };
 return {
  set(node) { clear(); slot.node = node; instruments.add(slot); node.output.connect(window.synth.instrumentInput); updateVoices(); },
  clear
 };
}
export function updateVoices() {
 const voices = window.synth.voices;
 if (voices) voices.gain.value = [...instruments].some(s => !s.node.layer) ? 0 : 1;
}
