export const targets = {
 tempo: { label: 'Tempo · BPM', min: 30, max: 300, initial: 120 },
 filterCutoff: { label: 'Filter cutoff · Hz', min: 20, max: 20000, initial: 5000 },
 filterResonance: { label: 'Filter resonance · Q', min: 0.001, max: 30, initial: 2 },
 masterVolume: { label: 'Master volume', min: 0, max: 1, initial: 0.7 },
 detuneOsc1: { label: 'Oscillator 1 detune', min: -100, max: 100, initial: 0 }
};
export function valueAt(points, phase, mode = 'linear') {
 const x = Math.max(0, Math.min(15, phase));
 const i = Math.floor(x);
 return mode === 'hold' ? points[i] : points[i] + (points[Math.min(15, i + 1)] - points[i]) * (x - i);
}
export function apply(target, value) {
 if (target === 'tempo') window.synth.tempo = Math.round(value * 10) / 10;
 else {
  const input = document.getElementById(target);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
 }
}
