// Every test, in parallel, with one answer: node tests/all.mjs. It runs each tests/*.mjs suite in its own
// process (tests/native-id.mjs only runs on macOS, where its tools are) and exits non-zero if anything failed or
// could not run. The suites that drive headless Chrome (tests/support/browser.mjs) run at most three at a time:
// six at once starved the live audio capture in tests/waveforms.mjs of CPU, and its fingerprints moved.
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ONLY_ON = { 'native-id.mjs': 'darwin' };
const suites = readdirSync(DIR).filter(f => f.endsWith('.mjs') && f !== 'all.mjs').sort();
const t0 = Date.now();

const BROWSERS_AT_ONCE = 3;
const browser = new Set(suites.filter(f => readFileSync(join(DIR, f), 'utf8').includes('support/browser.mjs')));
let running = 0;
const queue = [];
const slot = () => (running < BROWSERS_AT_ONCE ? (running++, Promise.resolve()) : new Promise(r => queue.push(r)).then(() => { running++; }));
const free = () => { running--; queue.shift()?.(); };
const run = async file => { if (!browser.has(file)) return runOne(file); await slot(); try { return await runOne(file); } finally { free(); } };
const runOne = file => new Promise(resolve => {
 if (ONLY_ON[file] && ONLY_ON[file] !== platform()) { resolve({ file, status: 'skip', why: `needs ${ONLY_ON[file]}` }); return; }
 const start = Date.now(), child = spawn(process.execPath, [join(DIR, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
 let out = '';
 child.stdout.on('data', d => { out += d; });
 child.stderr.on('data', d => { out += d; });
 child.on('close', code => resolve({ file, status: code === 0 ? 'pass' : 'fail', ms: Date.now() - start, out: out.trim() }));
});

const results = await Promise.all(suites.map(run));
for (const r of results) {
 const last = r.out?.split('\n').filter(Boolean).at(-1) || r.why || '';
 console.log(`${{ pass: 'ok  ', fail: 'FAIL', skip: 'skip' }[r.status]} ${r.file.padEnd(16)} ${r.ms !== undefined ? `${(r.ms / 1000).toFixed(1).padStart(5)} s` : '       '}  ${last.slice(0, 100)}`);
}
for (const r of results.filter(x => x.status === 'fail')) console.log(`\n---- ${r.file} ----\n${r.out}`);
const failed = results.filter(r => r.status === 'fail').length;
console.log(`\n${failed ? `${failed} of ${results.length} suites failed` : `all ${results.filter(r => r.status === 'pass').length} suites passed`}${results.some(r => r.status === 'skip') ? ` (${results.filter(r => r.status === 'skip').map(r => r.file).join(', ')} skipped)` : ''}, in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
