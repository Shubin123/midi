// Air: presence and high-end enhancer built from native Web Audio nodes.
// Contract: default export (audioContext) => { name, input, output, params, setParam, destroy }.
export default function createPlugin(ctx) {
 const input = ctx.createGain(), output = ctx.createGain(), trim = ctx.createGain();
 const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 2800; mid.Q.value = 0.6;
 const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 9500;
 // Exciter: isolate the top octave, saturate it to generate upper harmonics, and blend it back in.
 const band = ctx.createBiquadFilter(); band.type = 'highpass'; band.frequency.value = 6000; band.Q.value = 0.5;
 const shaper = ctx.createWaveShaper(); shaper.oversample = '4x';
 const curve = new Float32Array(1024);
 for (let i = 0; i < curve.length; i++) { const x = i / 511.5 - 1; curve[i] = Math.tanh(3 * x) / Math.tanh(3); }
 shaper.curve = curve;
 const sparkle = ctx.createGain(); sparkle.gain.value = 0;
 input.connect(mid).connect(high).connect(trim).connect(output);
 input.connect(band).connect(shaper).connect(sparkle).connect(trim);
 const params = [
  { id: 'mid', label: 'Mid Air', min: 0, max: 100, step: 1, value: 0, unit: '%' },
  { id: 'high', label: 'High Air', min: 0, max: 100, step: 1, value: 0, unit: '%' },
  { id: 'trim', label: 'Trim', min: -12, max: 6, step: 0.1, value: 0, unit: 'dB' }
 ];
 const ramp = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.02);
 const setParam = (id, value) => {
  const p = params.find(x => x.id === id); if (!p) return;
  p.value = Math.max(p.min, Math.min(p.max, value));
  if (id === 'mid') ramp(mid.gain, p.value / 100 * 8);
  if (id === 'high') { ramp(high.gain, p.value / 100 * 12); ramp(sparkle.gain, p.value / 100 * 0.18); }
  if (id === 'trim') ramp(trim.gain, 10 ** (p.value / 20));
 };
 const destroy = () => [input, mid, high, band, shaper, sparkle, trim, output].forEach(n => n.disconnect());
 return { name: 'Air', input, output, params, setParam, destroy };
}
