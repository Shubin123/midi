import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NativeVst3Guest } from '../js/native-vst3-runtime.js';
import { nativeFixture, nativeSessionConfigurationFixture } from './support/native-vst3-fixture.js';

const uc = await createRequire(import.meta.url)('../vendor/unicorn/unicorn.cjs')();
const guest = new NativeVst3Guest(uc, nativeFixture());
try {
 const call = (name, ...args) => guest.call(guest.resolve(`_${name}`, 0, 'bind'), args);
 const send = (receiver, selector, ...args) => call('objc_msgSend', receiver, guest.objc.selector(selector), ...args);
 const klass = guest.objc.foundationClass('NSURLSessionConfiguration');
 assert.throws(() => send(klass, 'defaultSessionConfiguration'), /Autorelease requires/);
 const pool = call('objc_autoreleasePoolPush');
 const first = send(klass, 'defaultSessionConfiguration'), second = send(klass, 'defaultSessionConfiguration');
 assert.notEqual(first, second); assert.equal(send(first, 'identifier'), 0); assert.equal(send(first, 'sharedContainerIdentifier'), 0);
 const defaults = { requestCachePolicy: 0, networkServiceType: 0, HTTPCookieAcceptPolicy: 2, HTTPMaximumConnectionsPerHost: 6, allowsCellularAccess: 1, isDiscretionary: 0, HTTPShouldUsePipelining: 0, HTTPShouldSetCookies: 1, sessionSendsLaunchEvents: 0, waitsForConnectivity: 0, allowsExpensiveNetworkAccess: 1, allowsConstrainedNetworkAccess: 1, shouldUseExtendedBackgroundIdleMode: 0 };
 for (const [property, value] of Object.entries(defaults)) assert.equal(send(first, property), value, property);
 for (const [property, value] of [['timeoutIntervalForRequest', 60], ['timeoutIntervalForResource', 604800]]) {
  send(first, property); assert.equal(guest.floatingRegister(), value);
  for (const replacement of [2.75, 0, -1, Infinity, NaN]) {
   guest.setFloatingRegister(0, replacement); send(first, `set${property[0].toUpperCase()}${property.slice(1)}:`);
   send(first, property); assert.ok(Object.is(guest.floatingRegister(), replacement));
  }
 }
 for (const [property, initial] of Object.entries(defaults)) {
  const setting = property === 'isDiscretionary' ? 'discretionary' : property;
  send(first, `set${setting[0].toUpperCase()}${setting.slice(1)}:`, initial ? 0 : 1);
  assert.equal(send(first, property), initial ? 0 : 1);
 }
 send(first, 'setRequestCachePolicy:', 0xfedcba9876543210n);
 send(first, 'requestCachePolicy'); assert.equal(BigInt.asUintN(64, guest.engine.reg_read_i64(guest.uc.X86_REG_RAX)), 0xfedcba9876543210n);
 send(first, 'setHTTPMaximumConnectionsPerHost:', -1n);
 send(first, 'HTTPMaximumConnectionsPerHost'); assert.equal(BigInt.asUintN(64, guest.engine.reg_read_i64(guest.uc.X86_REG_RAX)), 0xffffffffffffffffn);
 guest.setFloatingRegister(0, 7.125); send(first, 'setTimeoutIntervalForRequest:');
 const copy = send(first, 'copyWithZone:', 0); assert.notEqual(copy, first);
 guest.setFloatingRegister(0, 2.75); send(first, 'setTimeoutIntervalForRequest:');
 send(copy, 'timeoutIntervalForRequest'); assert.equal(guest.floatingRegister(), 7.125);
 send(second, 'timeoutIntervalForRequest'); assert.equal(guest.floatingRegister(), 60);
 for (const selector of ['URLCache', 'HTTPCookieStorage', 'URLCredentialStorage', 'HTTPAdditionalHeaders', 'protocolClasses', 'setURLCache:', 'setHTTPAdditionalHeaders:']) assert.throws(() => send(first, selector, 0), error => error.details.className === 'NSURLSessionConfiguration' && error.details.selector === selector);
 assert.throws(() => send(klass, 'backgroundSessionConfigurationWithIdentifier:', 0), /Unsupported/);
 send(copy, 'retain'); call('objc_autoreleasePoolPop', pool);
 assert.equal(guest.objc.objects.size, 1); send(copy, 'release'); assert.equal(guest.objc.objects.size, 1);
 send(copy, 'release'); assert.equal(guest.objc.objects.size, 0);
 assert.equal(guest.core.objects.size, 0); assert.equal(guest.report().files.runtimeFiles, 0);
} finally { guest.close(); }

const fixture = new NativeVst3Guest(uc, nativeSessionConfigurationFixture());
try { fixture.initialize(); assert.equal(fixture.factoryInfo().classes[0].cid, '01000000000000000000000000000000'); assert.equal(fixture.objc.objects.size, 0); } finally { fixture.close(); }

if (process.platform === 'darwin') {
 const directory = mkdtempSync(join(tmpdir(), 'midi-session-configuration-'));
 try {
  const source = fileURLToPath(new URL('./support/native-session-configuration-fixture.m', import.meta.url)), binary = join(directory, 'native'), image = join(directory, 'configuration.dylib'), options = { timeout: 15000, maxBuffer: 1000000 };
  execFileSync('clang', ['-Wno-deprecated-declarations', '-O0', '-DNATIVE', source, '-framework', 'Foundation', '-o', binary], options);
  assert.deepEqual(execFileSync(binary, [], options).toString().trim().split('\n'), ['1023', '0 0 1 1 0', '-1.0 -1.0', '0.0 0.0', '1.0 1.0']);
  execFileSync('clang', ['-Wno-deprecated-declarations', '-target', 'x86_64-apple-macos10.13', '-O0', '-fno-stack-protector', '-dynamiclib', '-nostdlib', '-Wl,-undefined,dynamic_lookup', '-lSystem', source, '-o', image], options);
  const compiled = new NativeVst3Guest(uc, new Uint8Array(readFileSync(image)));
  try {
   const pool = compiled.call(compiled.resolve('_objc_autoreleasePoolPush', 0, 'bind'));
   assert.equal(compiled.call(compiled.export('_probe_session_configuration')), 1023);
   compiled.call(compiled.resolve('_objc_autoreleasePoolPop', 0, 'bind'), [pool]);
   assert.equal(compiled.objc.objects.size, 0); assert.equal(compiled.core.objects.size, 0);
  } finally { compiled.close(); }
 } finally { rmSync(directory, { recursive: true, force: true }); }
}
console.log('native session configuration: native/compiler ABI defaults, scalar settings, XMM0 timeouts, full-width integers, independent copies, pool ownership and explicit unsupported services passed; no network I/O');
