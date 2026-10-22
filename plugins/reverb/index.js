// Reverb: convolution with a generated, decaying stereo noise impulse response.
export default function createPlugin(ctx) {
 const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
 const predelay = ctx.createDelay(0.25), convolver = ctx.createConvolver(), damp = ctx.createBiquadFilter();
 damp.type = 'lowpass';
 input.connect(dry).connect(output);
 input.connect(predelay).connect(convolver).connect(damp).connect(wet).connect(output);
 const params = [
  { id: 'decay', label: 'Decay', min: 0.3, max: 8, step: 0.1, value: 2.2, unit: 's' },
  { id: 'predelay', label: 'Pre-delay', min: 0, max: 200, step: 1, value: 15, unit: 'ms' },
  { id: 'damping', label: 'Tone', min: 1000, max: 18000, step: 100, value: 7000, unit: 'Hz' },
  { id: 'mix', label: 'Mix', min: 0, max: 100, step: 1, value: 25, unit: '%' }
 ];
 const impulse = seconds => {
  const length = Math.round(ctx.sampleRate * seconds), buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3; }
  return buffer;
 };
 const ramp = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.02);
 const setParam = (id, value) => {
  const p = params.find(x => x.id === id); if (!p) return;
  p.value = Math.max(p.min, Math.min(p.max, value));
  if (id === 'decay') convolver.buffer = impulse(p.value);
  if (id === 'predelay') ramp(predelay.delayTime, p.value / 1000);
  if (id === 'damping') ramp(damp.frequency, p.value);
  if (id === 'mix') { ramp(wet.gain, p.value / 100); ramp(dry.gain, 1 - p.value / 200); }
 };
 params.forEach(p => setParam(p.id, p.value));
 const destroy = () => [input, dry, predelay, convolver, damp, wet, output].forEach(n => n.disconnect());
 return { name: 'Reverb', input, output, params, setParam, destroy };
}
