// Compressor: DynamicsCompressorNode with makeup gain.
export default function createPlugin(ctx) {
 const input = ctx.createGain(), output = ctx.createGain(), comp = ctx.createDynamicsCompressor();
 input.connect(comp).connect(output);
 const params = [
  { id: 'threshold', label: 'Threshold', min: -60, max: 0, step: 0.5, value: -18, unit: 'dB' },
  { id: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, value: 4, unit: ':1' },
  { id: 'attack', label: 'Attack', min: 0, max: 200, step: 0.5, value: 10, unit: 'ms' },
  { id: 'release', label: 'Release', min: 10, max: 1000, step: 5, value: 150, unit: 'ms' },
  { id: 'makeup', label: 'Makeup', min: 0, max: 24, step: 0.5, value: 4, unit: 'dB' }
 ];
 const ramp = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.02);
 const setParam = (id, value) => {
  const p = params.find(x => x.id === id); if (!p) return;
  p.value = Math.max(p.min, Math.min(p.max, value));
  if (id === 'threshold') ramp(comp.threshold, p.value);
  if (id === 'ratio') ramp(comp.ratio, p.value);
  if (id === 'attack') ramp(comp.attack, p.value / 1000);
  if (id === 'release') ramp(comp.release, p.value / 1000);
  if (id === 'makeup') ramp(output.gain, 10 ** (p.value / 20));
 };
 params.forEach(p => setParam(p.id, p.value));
 const destroy = () => [input, comp, output].forEach(n => n.disconnect());
 return { name: 'Compressor', input, output, params, setParam, destroy };
}
