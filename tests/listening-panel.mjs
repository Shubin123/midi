// The Listening widget in the app, in headless Chrome (tests/support/browser.mjs): sounds with known notes played
// into its input (tests/listening-app.js), then Chrome's fake microphone playing a sung melody from a file.
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, print, unexpected } from './support/browser.mjs';
import { sing, melody } from './support/signals.js';

// A 16-bit mono WAV of samples.
const wav = (samples, rate) => {
 const b = Buffer.alloc(44 + samples.length * 2);
 b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
 b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
 samples.forEach((v, i) => b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), 44 + i * 2));
 return b;
};
const ready = 'new Promise(r => { const go = () => (document.querySelector("#teacher-panel .question-input") && document.querySelector("#listen-toggle") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })';

const t0 = Date.now();
let failed = 0;
const run = async (title, options, expr) => {
 const browser = await launch(options);
 try {
  await browser.open('index.html');
  await browser.evaluate(ready);
  const { checks } = await browser.evaluate(expr, { timeout: 120000 });
  checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
  print(`${title}: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
  failed += checks.filter(c => !c.ok).length;
 } catch (err) {
  console.error(`\nThe run stopped: ${err.message}`);
  failed++;
 } finally { await browser.close(); }
};
await run('Listening', {}, `import('./tests/listening-app.js').then(m => m.runListening())`);
const dir = await mkdtemp(join(tmpdir(), 'midi-mic-')), file = join(dir, 'melody.wav');
await writeFile(file, wav(sing(melody(), { sampleRate: 48000, noise: 0.003 }), 48000));
// Chrome reads the file only with its audio service in its own process.
await run('The microphone', { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox', `--use-file-for-fake-audio-capture=${file}`] }, `import('./tests/listening-app.js').then(m => m.runMicrophone())`);
await rm(dir, { recursive: true, force: true });
console.log(`\n${failed ? `${failed} failed` : 'listening panel: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
