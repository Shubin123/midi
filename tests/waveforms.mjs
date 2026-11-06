// Runs the waveform lab (tests/waveforms.js) and the in-app checks (tests/waveforms-app.js) in headless Chrome,
// with no dependencies: the repo is served from here, and Chrome is driven over the DevTools protocol with
// Node's own WebSocket (Node 22 or later). It finds Google Chrome, Chromium, Edge or a Playwright Chromium;
// set CHROME to use another. Takes a few seconds.
//   node tests/waveforms.mjs            run everything
//   node tests/waveforms.mjs --update   also rewrite tests/waveforms.golden.json from this run
//   node tests/waveforms.mjs --lab      only the lab (no app)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, homedir, platform } from 'node:os';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'tests/waveforms.golden.json');
const update = process.argv.includes('--update'), labOnly = process.argv.includes('--lab');
const golden = existsSync(GOLDEN) ? JSON.parse(await readFile(GOLDEN, 'utf8')) : null;
const prints = {}; // this run's fingerprints, written back with --update
const t0 = Date.now();

/* ---- Serving the repo ---- */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.zip': 'application/zip', '.png': 'image/png' };
const server = createServer(async (req, res) => {
 const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
 try {
  const body = await readFile(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
  res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
 } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ---- Chrome ---- */

async function findChrome() {
 if (process.env.CHROME) return process.env.CHROME;
 const home = homedir(), found = [];
 if (platform() === 'darwin') found.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
 if (platform() === 'win32') found.push('C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
 for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
  try { found.push(execFileSync('which', [name], { encoding: 'utf8' }).trim()); } catch { /* not installed */ }
 }
 for (const cache of [join(home, 'Library/Caches/ms-playwright'), join(home, '.cache/ms-playwright')]) {
  const dirs = await readdir(cache).catch(() => []);
  for (const d of dirs.filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
   found.push(join(cache, d, 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium'), join(cache, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'), join(cache, d, 'chrome-linux/chrome'), join(cache, d, 'chrome-linux64/chrome'));
  }
 }
 const chrome = found.find(p => p && existsSync(p));
 if (!chrome) { console.error('No Chrome, Chromium or Edge found; set CHROME to a Chromium-based browser.'); process.exit(2); }
 return chrome;
}

const profile = await mkdtemp(join(tmpdir(), 'waveforms-'));
const chrome = spawn(await findChrome(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const endpoint = await new Promise((resolve, reject) => {
 let err = '';
 chrome.stderr.on('data', d => { err += d; const m = /DevTools listening on (ws:\S+)/.exec(err); if (m) resolve(m[1]); });
 chrome.on('exit', code => reject(new Error(`Chrome exited (${code}): ${err.slice(-400)}`)));
});

// A small DevTools client: one browser connection, one page session.
const ws = new WebSocket(endpoint);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map(), listeners = [];
ws.onmessage = ({ data }) => {
 const msg = JSON.parse(data);
 if (msg.id && pending.has(msg.id)) { const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); }
 else listeners.forEach(fn => fn(msg));
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);
const errors = [];
listeners.push(({ method, params, sessionId: s }) => {
 if (s !== sessionId) return;
 if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description || params.exceptionDetails.text);
 if (method === 'Runtime.consoleAPICalled' && params.type === 'error') errors.push(params.args.map(a => a.value ?? a.description).join(' '));
});
await page('Runtime.enable');
await page('Page.enable');
const open = async url => {
 const loaded = new Promise(r => listeners.push(function onLoad({ method, sessionId: s }) { if (s === sessionId && method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(onLoad), 1); r(); } }));
 await page('Page.navigate', { url });
 await loaded;
};
const evaluate = async expression => {
 const { result, exceptionDetails } = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
 if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
 return result.value;
};

/* ---- The runs ---- */

const print = (title, checks) => {
 console.log(`\n${title}`);
 for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ms !== undefined ? ` (${c.ms} ms)` : ''}${c.problems.map(p => `\n         ${p}`).join('')}`);
};
let failed = 0;
try {
 await open(`${base}/tests/waveforms.html`);
 const lab = await evaluate(`import('./waveforms.js').then(m => m.runLab({ golden: ${JSON.stringify(golden)}, update: ${update} }))`);
 print(`Waveform lab: ${lab.passed} of ${lab.checks.length} in ${lab.ms} ms (rendered offline by the browser's Web Audio)`, lab.checks);
 failed += lab.failed;
 lab.checks.filter(c => c.fingerprint).forEach(c => { prints[c.name] = c.fingerprint; });
 if (!golden && !update) console.log('  (no tests/waveforms.golden.json: run with --update to record the fingerprints)');

 if (!labOnly) {
  errors.length = 0;
  await open(`${base}/index.html`);
  await evaluate('new Promise(r => { const ready = () => (window.oscillatorBank && document.getElementById("workspace") ? r() : setTimeout(ready, 50)); ready(); })');
  const app = await evaluate(`import('./tests/waveforms-app.js').then(m => m.runApp({ golden: ${JSON.stringify(golden)}, update: ${update} }))`);
  app.checks.filter(c => c.fingerprint).forEach(c => { prints[c.name] = c.fingerprint; });
  // Web MIDI is refused in a headless browser; anything else the page logged as an error counts.
  const unexpected = errors.filter(e => !/Web MIDI|requestMIDIAccess|MIDI/i.test(e));
  app.checks.push({ name: 'no errors in the page', ok: !unexpected.length, problems: unexpected });
  print(`In the app: ${app.checks.filter(c => c.ok).length} of ${app.checks.length}`, app.checks);
  failed += app.checks.filter(c => !c.ok).length;
 }
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 ws.close(); chrome.kill(); server.close();
 await rm(profile, { recursive: true, force: true }).catch(() => {});
}
// --update keeps the fingerprints this run didn't make (the app's, with --lab), and only after a clean run.
if (update && !failed) {
 const all = { ...golden, ...prints };
 await writeFile(GOLDEN, `{\n${Object.entries(all).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}\n`); // a line per check, so a diff names it
 console.log(`\nWrote ${Object.keys(prints).length} fingerprints to tests/waveforms.golden.json.`);
} else if (update) console.log('\nNot updating tests/waveforms.golden.json: fix the failures first.');
console.log(`\n${failed ? `${failed} failed` : 'waveforms: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
