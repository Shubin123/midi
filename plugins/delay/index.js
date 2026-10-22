// Delay: feedback echo with a low-pass filter in the feedback loop.
export default function createPlugin(ctx) {
 const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
 const delay = ctx.createDelay(2), feedback = ctx.createGain(), tone = ctx.createBiquadFilter();
 tone.type = 'lowpass';
 input.connect(dry).connect(output);
 input.connect(delay).connect(tone).connect(wet).connect(output);
 tone.connect(feedback).connect(delay);
 const params = [
  { id: 'time', label: 'Time', min: 10, max: 2000, step: 1, value: 375, unit: 'ms' },
  { id: 'feedback', label: 'Feedback', min: 0, max: 90, step: 1, value: 35, unit: '%' },
  { id: 'tone', label: 'Tone', min: 500, max: 16000, step: 100, value: 5000, unit: 'Hz' },
  { id: 'mix', label: 'Mix', min: 0, max: 100, step: 1, value: 30, unit: '%' }
 ];
 const ramp = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.03);
 const setParam = (id, value) => {
  const p = params.find(x => x.id === id); if (!p) return;
  p.value = Math.max(p.min, Math.min(p.max, value));
  if (id === 'time') ramp(delay.delayTime, p.value / 1000);
  if (id === 'feedback') ramp(feedback.gain, p.value / 100);
  if (id === 'tone') ramp(tone.frequency, p.value);
  if (id === 'mix') { ramp(wet.gain, p.value / 100); ramp(dry.gain, 1 - p.value / 200); }
 };
 params.forEach(p => setParam(p.id, p.value));
 const destroy = () => [input, dry, delay, tone, feedback, wet, output].forEach(n => n.disconnect());
 return { name: 'Delay', input, output, params, setParam, destroy };
}
