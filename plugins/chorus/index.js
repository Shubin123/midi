// Chorus: two LFO-modulated short delays panned left and right.
export default function createPlugin(ctx) {
 const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
 const lfo = ctx.createOscillator(), voices = [-1, 1].map(side => {
  const delay = ctx.createDelay(0.05), depth = ctx.createGain(), pan = ctx.createStereoPanner();
  pan.pan.value = side * 0.7;
  input.connect(delay).connect(pan).connect(wet);
  lfo.connect(depth).connect(delay.delayTime);
  return { delay, depth, pan, side };
 });
 input.connect(dry).connect(output); wet.connect(output);
 lfo.start();
 const params = [
  { id: 'rate', label: 'Rate', min: 0.05, max: 5, step: 0.05, value: 0.8, unit: 'Hz' },
  { id: 'depth', label: 'Depth', min: 0, max: 100, step: 1, value: 40, unit: '%' },
  { id: 'mix', label: 'Mix', min: 0, max: 100, step: 1, value: 50, unit: '%' }
 ];
 const ramp = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.03);
 const setParam = (id, value) => {
  const p = params.find(x => x.id === id); if (!p) return;
  p.value = Math.max(p.min, Math.min(p.max, value));
  if (id === 'rate') ramp(lfo.frequency, p.value);
  if (id === 'depth') voices.forEach(v => { ramp(v.delay.delayTime, 0.012 + v.side * 0.002); ramp(v.depth.gain, p.value / 100 * 0.006 * v.side); });
  if (id === 'mix') { ramp(wet.gain, p.value / 100); ramp(dry.gain, 1 - p.value / 200); }
 };
 params.forEach(p => setParam(p.id, p.value));
 const destroy = () => { lfo.stop(); [input, lfo, dry, wet, output, ...voices.flatMap(v => [v.delay, v.depth, v.pan])].forEach(n => n.disconnect()); };
 return { name: 'Chorus', input, output, params, setParam, destroy };
}
