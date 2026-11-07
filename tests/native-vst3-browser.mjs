import assert from 'node:assert/strict';
import { launch } from './support/browser.mjs';

const browser = await launch();
try {
 await browser.open('tools/native-vst3.html');
 const checks = await browser.evaluate(`(async () => {
  const { probeNativeVst3 } = await import('../js/native-vst3-probe.js');
  const { nativeFixture, nativePackage, nativeScanFixture, nativeMutexFixture, nativeLimitFixture, nativeObjCFixture, nativeStringFixture, nativeLocaleFixture, nativeBundleFixture } = await import('../tests/support/native-vst3-fixture.js');
  const { nativeAudioFixture } = await import('../tests/support/native-audio-fixture.js');
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
  const objectiveC = await probeNativeVst3(new File([nativeObjCFixture()], 'objc-fixture'));
  const stringCopy = await probeNativeVst3(new File([nativeStringFixture()], 'string-fixture'));
  check('native libc++ string copy constructor writes an independent object in the worker', stringCopy.initialized && stringCopy.factory?.classes[0].cid === '0c636f70696564000000000000000000');
  const locale = await probeNativeVst3(new File([nativeLocaleFixture()], 'locale-fixture'));
  check('native locale facet dispatch and Darwin rune-table reads execute in the worker', locale.initialized && locale.factory?.classes[0].cid === '0a89050041060708090a0b0c0d0e0f10');
  const bundle = await probeNativeVst3(new File([nativeBundleFixture()], 'bundle-fixture'));
  check('native bundleEntry executes and resolves its real guest bundle path', bundle.initialized && bundle.calls._CFBundleCopyBundleURL === 1 && bundle.calls._CFURLGetFileSystemRepresentation === 1);
  const audioFile = new File([nativeAudioFixture()], 'audio-fixture');
  const processor = await probeNativeVst3(audioFile, { mode: 'processor' });
  check('native processor opens actual component/audio vtables and host callbacks', processor.stage === 'processor-ready' && processor.configuration.outputs[0] === 2 && processor.processor.blocksProcessed === 0);
  const audio = await probeNativeVst3(audioFile, { mode: 'render', render: { frames: 16, maxBlock: 4, velocity: 0.5, inputs: [[new Float32Array(16).fill(1), new Float32Array(16).fill(-1)]] } });
  check('native worker transfers real processed stereo audio and MIDI note-off silence', audio.stage === 'rendered' && audio.audio.peak === 0.5 && audio.audio.buses[0][0] instanceof Float32Array && audio.audio.buses[0][0].slice(0, 12).every(value => value === 0.5) && audio.audio.buses[0][0].slice(12).every(value => value === 0) && audio.processor.blocksProcessed === 4);
  check('offline rendering never claims realtime playability', !audio.playable && !audio.audio.realtime);
  const rejectedAudio = nativeAudioFixture(); rejectedAudio.set([0x48, 0xc7, 0xc0, 255, 255, 255, 255, 0xc3], 0x600);
  const rejectedRender = await probeNativeVst3(new File([rejectedAudio], 'rejected-audio'), { mode: 'render', render: { frames: 16 } });
  check('native processing failure preserves its stage and never publishes fabricated audio', rejectedRender.stage === 'processing' && rejectedRender.error?.message.includes('process failed (-1)') && !rejectedRender.audio && rejectedRender.processor.blocksProcessed === 0 && !rejectedRender.playable);
  check('native initializer creates a class and executes its x86 method through Objective-C dispatch', objectiveC.initialized && objectiveC.factory?.classes[0].cid === '2a00000005060708090a0b0c0d0e0f10' && objectiveC.objc.dynamicClasses === 1 && objectiveC.objc.methods === 1 && objectiveC.objc.instances === 1);
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
  const transfer = new DataTransfer(); transfer.items.add(audioFile);
  document.querySelector('#plugin').files = transfer.files; document.querySelector('#plugin').dispatchEvent(new Event('change'));
  document.querySelector('#render').click();
  const previewReport = await new Promise((resolve, reject) => {
   const start = Date.now(), poll = () => {
    const output = document.querySelector('#result').textContent;
    if (output && !document.querySelector('#download').disabled) return resolve(JSON.parse(output));
    if (Date.now() - start > 20000) return reject(new Error('Native preview UI did not finish'));
    setTimeout(poll, 25);
   }; poll();
  });
  const preview = document.querySelector('#preview'), wav = new Uint8Array(await (await fetch(preview.src)).arrayBuffer());
  check('offline render UI exposes a real WAV preview without embedding samples in JSON', !preview.hidden && new TextDecoder().decode(wav.slice(0, 4)) === 'RIFF' && wav.length === 72044 && previewReport.audio.buses[0] === 2);
  check('silent plugin output is labeled silence, never claimed as a working Arcade', previewReport.audio.silent && document.querySelector('#status').textContent.includes('silence') && !previewReport.playable);
  return checks;
 })()`, { timeout: 90000 });
 for (const check of checks) { console.log(`${check.ok ? 'ok' : 'FAIL'} ${check.name}`); assert.ok(check.ok, check.name); }
 assert.deepEqual(browser.errors, []);
 if (process.env.ARCADE_PKG) {
  const { root } = await browser.page('DOM.getDocument');
  const { nodeId } = await browser.page('DOM.querySelector', { nodeId: root.nodeId, selector: '#plugin' });
  await browser.page('DOM.setFileInputFiles', { nodeId, files: [process.env.ARCADE_PKG] });
  for (const mode of ['factory', 'startup', 'processor']) {
   let report;
   if (mode !== 'factory') report = await browser.evaluate(`(async () => {
    const { probeNativeVst3 } = await import('../js/native-vst3-probe.js');
    return probeNativeVst3(document.querySelector('#plugin').files[0], { mode: '${mode}', timeout: 120000 });
   })()`, { timeout: 125000 });
   else {
    await browser.evaluate(`document.querySelector('#${mode}').click()`);
    report = await browser.evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
     const output = document.querySelector('#result').textContent;
     if (output && !document.querySelector('#download').disabled) return resolve(JSON.parse(output));
     if (Date.now() - start > 35000) return reject(new Error(document.querySelector('#status').textContent));
     setTimeout(poll, 50);
    }; poll();
    })`);
   }
   console.log(`Arcade ${mode}: ${JSON.stringify(report)}`);
   assert.equal(report.playable, false);
   if (mode === 'factory') {
    assert.equal(report.factory.vendor, 'Output'); assert.equal(report.factory.classes[0].name, 'Arcade');
    assert.equal(report.initialized, false); assert.equal(report.initializerCount, 768);
    assert.ok(report.calls.__Znwm > 0 && report.calls._memcpy > 0);
   } else if (mode === 'startup') {
    assert.equal(report.stage, 'factory'); assert.equal(report.error, undefined);
    assert.equal(report.initializersCompleted, 768); assert.equal(report.initializerCount, 768); assert.equal(report.initialized, true);
    assert.deepEqual(report.factory.classes.map(entry => entry.cid), ['56535441524344617263616465000000', '56534541524344617263616465000000']);
    assert.equal(report.calls._CFRetain, 1); assert.equal(report.calls._CFBundleCopyBundleURL, 1); assert.equal(report.calls._CFURLGetFileSystemRepresentation, 1);
    assert.equal(report.calls._CFUUIDCreate, 1); assert.equal(report.calls._CFUUIDGetUUIDBytes, 1); assert.equal(report.calls._CFRelease, 50);
    assert.equal(report.calls._sprintf, 22); assert.equal(report.calls._strcpy, 2); assert.equal(report.calls._strcat, 20); assert.equal(report.calls._sscanf, 2);
    assert.equal(report.calls._pthread_mutex_init, 37); assert.equal(report.calls._pthread_mutex_lock, 6680); assert.equal(report.calls._pthread_mutex_unlock, 6680);
    assert.equal(report.calls._exp2, 378); assert.equal(report.calls._pow, 8237); assert.equal(report.calls._tan, 15);
    assert.equal(report.calls._getrlimit, 9); assert.equal(report.calls._setrlimit, 9);
    assert.equal(report.calls._mach_timebase_info, 1); assert.equal(report.calls._mach_absolute_time, 4); assert.equal(report.calls._gettimeofday, 2); assert.equal(report.calls._objc_msgSend, 27);
    assert.equal(report.calls._objc_allocateClassPair, 3); assert.equal(report.calls._objc_registerClassPair, 3); assert.equal(report.calls._class_addMethod, 19); assert.equal(report.calls._class_addIvar, 4); assert.equal(report.calls._class_addProtocol, 1); assert.equal(report.calls._realloc, 1);
    assert.equal(report.calls.__ZNSt3__112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEEC1ERKS5_, 24); assert.equal(report.calls.__ZNSt3__112__next_primeEm, 16);
    assert.equal(report.calls.__ZNSt3__16localeC1Ev, 1); assert.equal(report.calls.__ZNKSt3__16locale9use_facetERNS0_2idE, 2);
    for (const name of ['_CFDataCreateWithBytesNoCopy', '_CGDataProviderCreateWithCFData', '_CGFontCreateWithDataProvider', '_CTFontManagerRegisterGraphicsFont', '_CTFontCreateWithGraphicsFont', '_CFNumberCreate', '_CFDictionaryCreate', '_objc_autoreleasePoolPush', '_objc_autoreleasePoolPop']) assert.equal(report.calls[name], 12, name);
    assert.equal(report.calls._CFStringGetBytes, 48); assert.equal(report.calls.___exp10f, 3); assert.equal(report.calls._pthread_key_create, 1);
    assert.deepEqual(report.objc, { dynamicClasses: 3, registeredClasses: 5, selectors: 551, methods: 19, ivars: 4, instances: 0, protocols: 7 });
    assert.deepEqual(report.files.descriptorLimits, { soft: 256, hard: 256 });
   } else {
    assert.equal(report.stage, 'creating-component'); assert.equal(report.error.kind, 'unsupported-data'); assert.equal(report.error.name, '_NSMenuDidBeginTrackingNotification');
    assert.equal(report.objc.registeredClasses, 6); assert.equal(report.objc.instances, 2);
    assert.equal(report.calls._objc_msgSend, 29);
    assert.equal(report.initialized, true); assert.equal(report.initializersCompleted, 768); assert.equal(report.processor.componentCreated, false); assert.equal(report.processor.blocksProcessed, 0);
    assert.equal(report.calls._pthread_self, 1); assert.equal(report.calls._CFRunLoopGetMain, 1); assert.equal(report.calls._CFRunLoopSourceCreate, 1); assert.equal(report.calls._CFRunLoopAddSource, 1);
   }
  }
 }
 assert.deepEqual(browser.errors, []);
 console.log('native VST3 browser experiment: all checks passed (not an audio-playback certification)');
} finally { await browser.close(); }
