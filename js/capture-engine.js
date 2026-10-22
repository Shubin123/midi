// The one general DSP engine for captured plugins: input drive -> measured curve -> measured stereo impulse response.
import { shaperCurve, isLinear } from './capture.js';

async function resample(channels, from, to) {
 if (from === to) return channels;
 const ctx = new OfflineAudioContext(channels.length, Math.ceil(channels[0].length * to / from), to);
 const b = ctx.createBuffer(channels.length, channels[0].length, from);
 channels.forEach((c, i) => b.copyToChannel(c, i));
 const src = ctx.createBufferSource(); src.buffer = b; src.connect(ctx.destination); src.start();
 const out = await ctx.startRendering();
 return channels.map((_, i) => out.getChannelData(i));
}

export async function createCapturedPlugin(ctx, model, ir) {
 const input = ctx.createGain(), output = ctx.createGain(), drive = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
 // A WaveShaper with no curve passes audio through unchanged; it is only given one when the capture is nonlinear.
 const shaper = new WaveShaperNode(ctx, isLinear(model.points) ? {} : { curve: shaperCurve(model.points) });
 const conv = new ConvolverNode(ctx, { disableNormalization: true });
 const channels = await resample(ir, model.sampleRate, ctx.sampleRate);
 const buffer = ctx.createBuffer(channels.length, channels[0].length, ctx.sampleRate);
 channels.forEach((c, i) => buffer.copyToChannel(c, i));
 conv.buffer = buffer;
 // Dry signal is delayed by the plugin's measured latency so Mix blends in phase.
 const align = ctx.createDelay(1); align.delayTime.value = Math.min(1, model.latency / model.sampleRate);
 input.connect(drive).connect(shaper).connect(conv).connect(wet).connect(output);
 input.connect(align).connect(dry).connect(output);
 const params = [
  { id: 'input', label: 'Input', min: -24, max: 24, step: 0.5, value: 0, unit: 'dB' },
  { id: 'mix', label: 'Mix', min: 0, max: 100, step: 1, value: 100, unit: '%' },
  { id: 'output', label: 'Output', min: -24, max: 12, step: 0.5, value: 0, unit: 'dB' }
 ];
 const ramp = (param, value) => param.setTargetAtTime(value, ctx.currentTime, 0.02);
 const setParam = (id, value) => {
  const p = params.find(x => x.id === id); if (!p) return;
  p.value = Math.max(p.min, Math.min(p.max, value));
  // Input drives the curve; the inverse gain after it keeps unity level when the curve is linear.
  if (id === 'input') { ramp(drive.gain, 10 ** (p.value / 20)); ramp(wet.gain, 10 ** (-p.value / 20) * (params[1].value / 100)); }
  if (id === 'mix') { ramp(wet.gain, 10 ** (-params[0].value / 20) * p.value / 100); ramp(dry.gain, 1 - p.value / 100); }
  if (id === 'output') ramp(output.gain, 10 ** (p.value / 20));
 };
 params.forEach(p => setParam(p.id, p.value));
 const destroy = () => [input, drive, shaper, conv, wet, align, dry, output].forEach(n => n.disconnect());
 return { name: model.name, input, output, params, setParam, destroy };
}
