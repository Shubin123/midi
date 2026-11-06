import assert from 'node:assert/strict';
import { launch } from './support/browser.mjs';

const browser = await launch();
try {
 await browser.open('tools/native-vst3.html');
 const checks = await browser.evaluate(`(async () => {
  const { probeNativeVst3 } = await import('../js/native-vst3-probe.js');
  const { nativeFixture, nativePackage, nativeScanFixture, nativeMutexFixture, nativeLimitFixture } = await import('../tests/support/native-vst3-fixture.js');
  const file = new File([nativeFixture()], 'fixture');
  const checks = [];
  const check = (name, ok) => checks.push({ name, ok });
  const factory = await probeNativeVst3(file, { mode: 'factory' });
  check('x86 machine-code VST3 factory executes in the browser worker', factory.factory?.vendor === 'Fixture vendor' && factory.factory.classes[0].cid === '0102030405060708090a0b0c0d0e0f10');
  check('factory-only report never claims initialized or playable', !factory.initialized && !factory.playable && factory.warning.includes('NOT run'));
  const pkg = new File([await nativePackage(nativeFixture({ initializer: true }))], 'fixture.pkg');
  const startup = await probeNativeVst3(pkg);
  check('package extraction and initializers execute without a native helper', startup.initialized && startup.initializersCompleted === 1 && startup.factory?.classes[0].name === 'Native fixture');
  const scanned = await probeNativeVst3(new File([nativeScanFixture()], 'scan-fixture'));
  check('native initializer scans into guest memory and changes the factory class ID', scanned.initialized && scanned.calls._sscanf === 1 && scanned.factory?.classes[0].cid === '7856341205060708090a0b0c0d0e0f10');
  const locked = await probeNativeVst3(new File([nativeMutexFixture()], 'mutex-fixture'));
  check('native initializer acquires a statically initialized guest mutex in the worker', locked.initialized && locked.calls._pthread_mutex_lock === 1);
  const limits = await probeNativeVst3(new File([nativeLimitFixture()], 'limit-fixture'));
  check('native initializer reads the real guest descriptor limits through the syscall ABI', limits.initialized && limits.factory?.classes[0].cid === '00010000000000000001000000000000' && limits.files.descriptorLimits.soft === 256 && limits.files.openDescriptors === 3);
  const unsupported = await probeNativeVst3(new File([nativeFixture({ code: [0x0f, 0x05, 0xc3], initializer: true })], 'syscall'));
  check('unsupported startup fails explicitly instead of faking success', unsupported.error?.kind === 'syscall' && unsupported.stage === 'initializers' && !unsupported.playable && !unsupported.initialized);
  const controller = new AbortController();
  try { await probeNativeVst3(file, { signal: controller.signal, onProgress: () => controller.abort() }); check('active worker cancellation', false); }
  catch (error) { check('active worker cancellation', error.name === 'AbortError'); }
  try { await probeNativeVst3(file, { timeout: 1 }); check('wall-clock watchdog', false); }
  catch (error) { check('wall-clock watchdog', /wall-clock/.test(error.message)); }
  const fresh = await probeNativeVst3(file, { mode: 'factory' });
  check('fresh worker succeeds after cancellation and timeout', fresh.factory?.vendor === 'Fixture vendor');
  const bad = await probeNativeVst3(new File(['not a plugin'], 'bad'));
  check('bad files produce a structured failure', !!bad.error && !bad.playable);
  return checks;
 })()`, { timeout: 90000 });
 for (const check of checks) { console.log(`${check.ok ? 'ok' : 'FAIL'} ${check.name}`); assert.ok(check.ok, check.name); }
 assert.deepEqual(browser.errors, []);
 if (process.env.ARCADE_PKG) {
  const { root } = await browser.page('DOM.getDocument');
  const { nodeId } = await browser.page('DOM.querySelector', { nodeId: root.nodeId, selector: '#plugin' });
  await browser.page('DOM.setFileInputFiles', { nodeId, files: [process.env.ARCADE_PKG] });
  for (const mode of ['factory', 'startup']) {
   await browser.evaluate(`document.querySelector('#${mode}').click()`);
   const report = await browser.evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
     const output = document.querySelector('#result').textContent;
     if (output && !document.querySelector('#download').disabled) return resolve(JSON.parse(output));
     if (Date.now() - start > 35000) return reject(new Error(document.querySelector('#status').textContent));
     setTimeout(poll, 50);
    }; poll();
   })`);
   assert.equal(report.playable, false);
   if (mode === 'factory') {
    assert.equal(report.factory.vendor, 'Output'); assert.equal(report.factory.classes[0].name, 'Arcade');
    assert.equal(report.initialized, false); assert.equal(report.initializerCount, 768);
    assert.ok(report.calls.__Znwm > 0 && report.calls._memcpy > 0);
   } else {
    assert.equal(report.stage, 'initializers'); assert.equal(report.error.kind, 'unsupported-import');
    assert.equal(report.error.name, '_objc_allocateClassPair'); assert.equal(report.initializersCompleted, 77);
    assert.equal(report.calls._CFUUIDCreate, 1); assert.equal(report.calls._CFUUIDGetUUIDBytes, 1); assert.equal(report.calls._CFRelease, 1);
    assert.equal(report.calls._sprintf, 22); assert.equal(report.calls._strcpy, 2); assert.equal(report.calls._strcat, 20); assert.equal(report.calls._sscanf, 2);
    assert.equal(report.calls._pthread_mutex_init, 5); assert.equal(report.calls._pthread_mutex_lock, 109); assert.equal(report.calls._pthread_mutex_unlock, 109);
    assert.equal(report.calls._exp2, 378); assert.equal(report.calls._pow, 8237); assert.equal(report.calls._tan, 15);
    assert.equal(report.calls._getrlimit, 9); assert.equal(report.calls._setrlimit, 9);
    assert.equal(report.calls._mach_timebase_info, 1); assert.equal(report.calls._mach_absolute_time, 2); assert.equal(report.calls._gettimeofday, 1); assert.equal(report.calls._objc_msgSend, 1);
    assert.deepEqual(report.files.descriptorLimits, { soft: 256, hard: 256 });
   }
   console.log(`Arcade ${mode}: ${JSON.stringify(report)}`);
  }
 }
 assert.deepEqual(browser.errors, []);
 console.log('native VST3 browser experiment: all checks passed (not an audio-playback certification)');
} finally { await browser.close(); }
