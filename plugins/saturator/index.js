// Saturator: oversampled soft clipper with drive, tone, mix, and output level.
export default function createPlugin(ctx) {
 const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
 const drive = ctx.createGain(), shaper = ctx.createWaveShaper(), tone = ctx.createBiquadFilter();
 shaper.oversample = '4x'; tone.type = 'lowpass';
 const curve = new Float32Array(2048);
 for (let i = 0; i < curve.length; i++) { const x = i / 1023.5 - 1; curve[i] = Math.tanh(2 * x) / Math.tanh(2); }
 shaper.curve = curve;
 input.connect(dry).connect(output);
 input.connect(drive).connect(shaper).connect(tone).connect(wet).connect(output);
 const params = [
  { id: 'drive', label: 'Drive', min: 0, max: 36, step: 0.5, value: 12, unit: 'dB' },
  { id: 'tone', label: 'Tone', min: 1000, max: 20000, step: 100, value: 9000, unit: 'Hz' },
  { id: 'mix', label: 'Mix', min: 0, max: 100, step: 1, value: 100, unit: '%' },
  { id: 'output', label: 'Output', min: -24, max: 6, step: 0.5, value: -6, unit: 'dB' }
 ];
 const ramp = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.02);
 const setParam = (id, value) => {
  const p = params.find(x => x.id === id); if (!p) return;
  p.value = Math.max(p.min, Math.min(p.max, value));
  if (id === 'drive') ramp(drive.gain, 10 ** (p.value / 20));
  if (id === 'tone') ramp(tone.frequency, p.value);
  if (id === 'mix') { ramp(wet.gain, p.value / 100); ramp(dry.gain, 1 - p.value / 100); }
  if (id === 'output') ramp(output.gain, 10 ** (p.value / 20));
 };
 params.forEach(p => setParam(p.id, p.value));
 const destroy = () => [input, dry, drive, shaper, tone, wet, output].forEach(n => n.disconnect());
 return { name: 'Saturator', input, output, params, setParam, destroy };
}
