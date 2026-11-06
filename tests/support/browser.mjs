// Headless Chrome for the browser suites (tests/waveforms.mjs, tests/widgets.mjs), with no dependencies: the
// repo is served from here, and Chrome is driven over the DevTools protocol with Node's own WebSocket (Node 22
// or later). It finds Google Chrome, Chromium, Edge or a Playwright Chromium; set CHROME to use another.
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { existsSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir, homedir, platform } from 'node:os';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.zip': 'application/zip', '.png': 'image/png' };

async function findChrome() {
 if (process.env.CHROME) return process.env.CHROME;
 const home = homedir(), found = [];
 if (platform() === 'darwin') found.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
 if (platform() === 'win32') found.push('C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe');
 for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
  try { found.push(execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { /* not installed */ }
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

// Starts the server and a fresh headless Chrome with one page. Returns { base, open(url), reload(), evaluate(expr),
// beforeScripts(source), errors, close() }: `errors` collects what the page throws or logs as an error since the
// last open() or reload(); beforeScripts() runs `source` in every page from then on, before the page's own scripts;
// evaluate() fails after `timeout` ms (a page that never finishes fails the suite rather than hanging it).
export async function launch({ width = 1500, height = 1000 } = {}) {
 const server = createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
   const body = await readFile(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
   res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end(); }
 });
 await new Promise(r => server.listen(0, '127.0.0.1', r));
 const base = `http://127.0.0.1:${server.address().port}`;

 const profile = await mkdtemp(join(tmpdir(), 'midi-tests-'));
 const chrome = spawn(await findChrome(), ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', '--mute-audio', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
 // Stopped or interrupted, the run takes its Chrome and profile with it: nothing is left running or on disk.
 const quit = () => { chrome.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } };
 process.once('exit', quit);
 for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, () => { quit(); process.exit(130); });
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
 await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

 return {
  base,
  errors,
  page,
  async open(url) {
   errors.length = 0;
   const loaded = new Promise(r => listeners.push(function onLoad({ method, sessionId: s }) { if (s === sessionId && method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(onLoad), 1); r(); } }));
   await page('Page.navigate', { url: url.startsWith('http') ? url : `${base}/${url}` });
   await loaded;
  },
  async reload() {
   errors.length = 0;
   const loaded = new Promise(r => listeners.push(function onLoad({ method, sessionId: s }) { if (s === sessionId && method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(onLoad), 1); r(); } }));
   await page('Page.reload', {});
   await loaded;
  },
  beforeScripts: source => page('Page.addScriptToEvaluateOnNewDocument', { source }),
  async evaluate(expression, { timeout = 60000 } = {}) {
   let timer;
   const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeout / 1000} s from: ${expression.slice(0, 80)}`)), timeout); });
   const { result, exceptionDetails } = await Promise.race([page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), late]).finally(() => clearTimeout(timer));
   if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
   return result.value;
  },
  async close() {
   ws.close(); server.close();
   // Chrome writes to its profile until it has exited, so it is removed after that.
   if (chrome.exitCode === null && chrome.signalCode === null) {
    const gone = new Promise(r => chrome.once('exit', r));
    chrome.kill();
    await Promise.race([gone, new Promise(r => setTimeout(r, 5000))]);
   }
   await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
   process.removeListener('exit', quit);
  },
 };
}

// Prints a group of checks ({ name, ok, problems, ms? }) the way every browser suite does.
export const print = (title, checks) => {
 console.log(`\n${title}`);
 for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.ms !== undefined ? ` (${c.ms} ms)` : ''}${c.problems.map(p => `\n         ${p}`).join('')}`);
};
// Errors a headless page logs that are not the app's fault: Web MIDI is refused without a user.
export const unexpected = errors => errors.filter(e => !/Web MIDI|requestMIDIAccess|MIDI/i.test(e));
