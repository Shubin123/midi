// Runs the waveform lab (tests/waveforms.js) and the in-app checks (tests/waveforms-app.js) in headless Chrome
// (tests/support/browser.mjs: no dependencies), and compares their fingerprints with tests/waveforms.golden.json.
// Takes under ten seconds.
//   node tests/waveforms.mjs            run everything
//   node tests/waveforms.mjs --update   also rewrite tests/waveforms.golden.json from this run
//   node tests/waveforms.mjs --lab      only the lab (no app)
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { launch, print, unexpected, ROOT } from './support/browser.mjs';

const GOLDEN = join(ROOT, 'tests/waveforms.golden.json');
const update = process.argv.includes('--update'), labOnly = process.argv.includes('--lab');
const golden = existsSync(GOLDEN) ? JSON.parse(await readFile(GOLDEN, 'utf8')) : null;
const prints = {}; // this run's fingerprints, written back with --update
const t0 = Date.now();
const browser = await launch(), { open, evaluate, errors } = browser;

/* ---- The runs ---- */

let failed = 0;
try {
 await open('tests/waveforms.html');
 const lab = await evaluate(`import('./waveforms.js').then(m => m.runLab({ golden: ${JSON.stringify(golden)}, update: ${update} }))`);
 print(`Waveform lab: ${lab.passed} of ${lab.checks.length} in ${lab.ms} ms (rendered offline by the browser's Web Audio)`, lab.checks);
 failed += lab.failed;
 lab.checks.filter(c => c.fingerprint).forEach(c => { prints[c.name] = c.fingerprint; });
 if (!golden && !update) console.log('  (no tests/waveforms.golden.json: run with --update to record the fingerprints)');

 if (!labOnly) {
  await open('index.html');
  await evaluate('new Promise(r => { const ready = () => (window.oscillatorBank && document.getElementById("workspace") ? r() : setTimeout(ready, 50)); ready(); })');
  const app = await evaluate(`import('./tests/waveforms-app.js').then(m => m.runApp({ golden: ${JSON.stringify(golden)}, update: ${update} }))`);
  app.checks.filter(c => c.fingerprint).forEach(c => { prints[c.name] = c.fingerprint; });
  app.checks.push({ name: 'no errors in the page', ok: !unexpected(errors).length, problems: unexpected(errors) });
  print(`In the app: ${app.checks.filter(c => c.ok).length} of ${app.checks.length}`, app.checks);
  failed += app.checks.filter(c => !c.ok).length;
 }
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
// --update keeps the fingerprints this run didn't make (the app's, with --lab), and only after a clean run.
if (update && !failed) {
 const all = { ...golden, ...prints };
 await writeFile(GOLDEN, `{\n${Object.entries(all).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`); // a line per check, so a diff names it
 console.log(`\nWrote ${Object.keys(prints).length} fingerprints to tests/waveforms.golden.json.`);
} else if (update) console.log('\nNot updating tests/waveforms.golden.json: fix the failures first.');
console.log(`\n${failed ? `${failed} failed` : 'waveforms: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
