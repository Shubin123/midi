import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const encoder = new TextEncoder();
const responder = (body, headers = [['X-Probe', 'yes']]) => ({ status: 200, headers: [['Content-Length', String(body.length)], ...headers], response: encoder.encode(body) });

const guest = new NativeVst3Guest(uc, nativeFixture(), {});
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args, { instructionBudget: 4000000, milliseconds: 4000 });
 const send = (receiver, selector, ...args) => call('objc_msgSend', receiver, guest.objc.selector(selector), ...args);
 const text = value => guest.objc.foundationString(value);
 const pool = call('objc_autoreleasePoolPush');
 const session = send(guest.objc.foundationClass('NSURLSession'), 'sessionWithConfiguration:', send(guest.objc.foundationClass('NSURLSessionConfiguration'), 'defaultSessionConfiguration'));
 const request = send(guest.objc.foundationClass('NSMutableURLRequest'), 'requestWithURL:', send(guest.objc.foundationClass('NSURL'), 'URLWithString:', text('https://example.invalid/secret?token=hidden')));
 const task = send(session, 'dataTaskWithRequest:', request), suspended = send(session, 'dataTaskWithRequest:', request);
 send(task, 'retain'); send(suspended, 'retain');
 const state = guest.objc.objects.get(task).sessionTask;
 assert.throws(() => send(task, 'suspend'), error => error.details.selector === 'suspend');
 assert.equal(guest.objc.objects.get(session).session.tasks.size, 2);
 send(task, 'resume'); send(task, 'resume');
 assert.equal(state.state, 0); assert.equal(guest.urlTransport.resumed, 1);
 send(suspended, 'cancel'); assert.equal(guest.objc.objects.get(suspended).sessionTask.state, 2);
 call('objc_autoreleasePoolPop', pool);
} finally { guest.close(); }

if (process.platform === 'darwin') {
 const directory = mkdtempSync(join(tmpdir(), 'midi-session-transport-'));
 const server = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
   const body = request.url === '/echo' ? Buffer.concat(chunks).toString() : 'hello world';
   response.writeHead(200, { 'Content-Length': body.length, 'X-Probe': 'yes' }); response.end(body);
  });
 });
 try {
  const source = fileURLToPath(new URL('./support/native-session-transport-fixture.m', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'transport.dylib'), options = { timeout: 15000, maxBuffer: 1000000 };
  execFileSync('clang', ['-O0', '-fno-objc-arc', '-DNATIVE', source, '-framework', 'Foundation', '-o', binary], options);
  execFileSync('clang', ['-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-fno-objc-arc', '-U_FORTIFY_SOURCE', '-D_FORTIFY_SOURCE=0', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const refused = createServer(); await new Promise(resolve => refused.listen(0, '127.0.0.1', resolve));
  const closedOrigin = `http://127.0.0.1:${refused.address().port}`; await new Promise(resolve => refused.close(resolve));
  const scenarios = [
   { label: 'response, data, completion', mode: 0, url: `${origin}/ok`, network: () => responder('hello world') },
   { label: 'cancel disposition', mode: 1, url: `${origin}/cancel`, network: () => responder('hello world') },
   { label: 'POST body progress', mode: 2, url: `${origin}/echo`, network: request => { assert.equal(request.method, 'POST'); assert.deepEqual([...request.body], [97, 98, 99]); return responder('abc'); } },
   { label: 'refused connection', mode: 0, url: `${closedOrigin}/`, network: () => ({ error: { code: -1004, description: 'refused' } }) },
  ];
  for (const scenario of scenarios) {
   const { stdout } = await promisify(execFile)(binary, [scenario.url, String(scenario.mode)], options);
   const compiled = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)), { network: scenario.network });
   try {
    const address = compiled.allocate(256); compiled.write(address, encoder.encode(`${scenario.url}\0`));
    const result = compiled.call(compiled.export('_probe_transport'), [address, scenario.mode], { instructionBudget: 80000000, milliseconds: 15000 });
    assert.equal(compiled.string(result, 2048), stdout.trim(), scenario.label);
    const report = compiled.report();
    assert.equal(report.network.access, 'enabled'); assert.equal(report.network.completed, 1);
    assert.equal(report.threads.blocked, 1, 'the idle delivery worker parks');
    assert.equal([...compiled.objc.objects.values()].filter(object => object.session || object.urlResponse || object.urlError || object.headerFields).length, 0, 'session and response objects are released');
   } finally { compiled.close(); }
  }
  const offline = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   const address = offline.allocate(256); offline.write(address, encoder.encode('https://example.invalid/secret?token=hidden\0'));
   const result = offline.call(offline.export('_probe_transport'), [address, 0], { instructionBudget: 80000000, milliseconds: 15000 });
   assert.equal(offline.string(result, 2048), 'complete -1009;invalid;state 3;');
   assert.deepEqual(offline.report().network.requests, [{ method: 'GET', url: 'https://example.invalid/secret', outcome: 'offline' }]);
  } finally { offline.close(); }
 } finally { server.close(); rmSync(directory, { recursive: true, force: true }); }
}
console.log('native URL session transport: delegate order matches real Cocoa, completion dispositions, POST progress, failures, offline default, query-free logging and release passed');
