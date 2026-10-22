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
