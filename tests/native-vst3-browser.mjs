import assert from 'node:assert/strict';
import { launch } from './support/browser.mjs';

const browser = await launch();
try {
 await browser.open('tools/native-vst3.html');
 const checks = await browser.evaluate(`(async () => {
  const { probeNativeVst3 } = await import('../js/native-vst3-probe.js');
  const { nativeFixture, nativePackage, nativeScanFixture, nativeMutexFixture, nativeLimitFixture, nativeObjCFixture, nativeStringFixture, nativeLocaleFixture, nativeBundleFixture, nativeZoneFixture, nativeRTTIFixture, nativeThreadFixture, nativeTimedWaitFixture, nativeStatfsFixture, nativeRunningApplicationFixture, nativeURLFixture, nativeRequestFixture, nativeDataFixture, nativeSleepFixture, nativeSessionConfigurationFixture } = await import('../tests/support/native-vst3-fixture.js');
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
  const zones = await probeNativeVst3(new File([nativeZoneFixture()], 'zone-fixture'));
  check('native zone vtables and atomic CAS execute in the browser worker', zones.initialized && zones.factory?.classes[0].cid === '20000000000000000100000000000000' && zones.calls.__midi_zone_size === 1 && zones.calls._OSAtomicCompareAndSwapPtrBarrier === 1 && zones.calls._malloc_destroy_zone === 1);
  const rtti = await probeNativeVst3(new File([nativeRTTIFixture()], 'rtti-fixture'));
  check('native dynamic_cast walks compiler-ABI RTTI in the browser worker', rtti.initialized && rtti.factory?.classes[0].cid === '01000000000000000000000000000000' && rtti.calls.___dynamic_cast === 1);
  const threaded = await probeNativeVst3(new File([nativeThreadFixture()], 'thread-fixture'));
  check('native pthread entry and join execute on distinct guest stacks in the browser worker', threaded.initialized && threaded.factory?.classes[0].cid === '01020304050607080000000000000000' && threaded.threads.created === 1 && threaded.threads.completed === 1 && threaded.threads.stackBytes === 0);
  const timed = await probeNativeVst3(new File([nativeTimedWaitFixture()], 'timed-wait-fixture'));
  check('native timed condition wait expires and reacquires its mutex in the browser worker', timed.initialized && timed.factory?.classes[0].cid === '01000000000000000000000000000000' && timed.calls.__ZNSt3__15mutex6unlockEv === 1);
  const filesystem = await probeNativeVst3(new File([nativeStatfsFixture()], 'filesystem-fixture'));
  const runningApplication = await probeNativeVst3(new File([nativeRunningApplicationFixture()], 'running-application-fixture'));
  const url = await probeNativeVst3(new File([nativeURLFixture()], 'url-fixture'));
  const request = await probeNativeVst3(new File([nativeRequestFixture()], 'request-fixture'));
  const data = await probeNativeVst3(new File([nativeDataFixture()], 'data-fixture'));
  const sleep = await probeNativeVst3(new File([nativeSleepFixture()], 'sleep-fixture'));
  const sessionConfiguration = await probeNativeVst3(new File([nativeSessionConfigurationFixture()], 'session-configuration-fixture'));
  const { nativeSessionTaskFixture } = await import('../tests/support/native-vst3-fixture.js');
  const sessionTask = await probeNativeVst3(new File([nativeSessionTaskFixture()], 'session-task-fixture'));
  check('native session constructs a suspended data task without sending a request', sessionTask.initialized && sessionTask.factory?.classes[0].cid === '01000000000000000000000000000000' && sessionTask.calls._objc_msgSend === 7 && sessionTask.calls._objc_autoreleasePoolPop === 1);
  check('native Cocoa session configuration stores XMM0 timeouts and drains owned objects', sessionConfiguration.initialized && sessionConfiguration.factory?.classes[0].cid === '01000000000000000000000000000000' && sessionConfiguration.calls._objc_msgSend === 3 && sessionConfiguration.calls._objc_autoreleasePoolPop === 1);
  check('native nanosleep resumes only after its monotonic deadline in the browser worker', sleep.initialized && sleep.factory?.classes[0].cid === '01000000000000000000000000000000' && sleep.calls._nanosleep >= 2);
  check('native mutable data shares its actual bytes with CFData and drains its storage', data.initialized && data.factory?.classes[0].cid === '01000000000000000000000000000000' && data.calls._CFDataGetLength === 1 && data.calls._CFDataGetBytePtr === 1);
  check('native Cocoa request construction passes floating timeout arguments and releases retained URLs', request.initialized && request.factory?.classes[0].cid === '01000000000000000000000000000000' && request.calls._objc_msgSend === 4 && request.calls._objc_autoreleasePoolPop === 1);
  check('native Cocoa URL parsing preserves its URL and drains owned objects without network I/O', url.initialized && url.factory?.classes[0].cid === '01000000000000000000000000000000' && url.calls._objc_msgSend === 4 && url.calls._objc_autoreleasePoolPop === 1);
  check('native Cocoa current application and PID lookup share a real guest identity', runningApplication.initialized && runningApplication.factory?.classes[0].cid === '01000000000000000000000000000000' && runningApplication.calls._objc_msgSend === 4);
  check('native filesystem statistics describe the loaded executable without claiming a disk daemon', filesystem.initialized && filesystem.factory?.classes[0].cid === '01000000000000000000000000000000' && filesystem.calls['_statfs$INODE64'] === 1 && filesystem.files.mountedFiles === 1 && filesystem.services.diskArbitration === 'unavailable');
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
  {
   const { NativeVst3Live, midiToEvents } = await import('../js/native-vst3-live.js'), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
   const session = new NativeVst3Live(new File([nativeAudioFixture()], 'live-fixture'));
   await session.start();
   for (let tries = 0; tries < 200 && session.state.blocks < 40; tries++) await wait(25);
   const sent = []; const fake = { noteOn: (pitch, velocity) => sent.push(['on', pitch, velocity]), noteOff: pitch => sent.push(['off', pitch]) };
   midiToEvents(fake, [0x90, 60, 127]); midiToEvents(fake, [0x90, 60, 0]); midiToEvents(fake, [0x80, 61, 64]); midiToEvents(fake, [0xb0, 1, 64]);
   session.noteOn(60); session.noteOn(60); session.noteOff(60); await wait(100);
   check('live mode streams real plugin blocks through an AudioWorklet and accepts notes', session.info.eventInputs === 1 && session.state.blocks >= 40 && session.state.consumed > 0 && session.held.size === 0 && JSON.stringify(sent) === JSON.stringify([['on', 60, 1], ['off', 60], ['off', 61]]));
   session.stop();
   check('stopping live mode ends the worker and audio graph', session.worker === null && session.context === null);
  }
  check('silent plugin output is labeled silence, never claimed as a working Arcade', previewReport.audio.silent && document.querySelector('#status').textContent.includes('silence') && !previewReport.playable);
  return checks;
 })()`, { timeout: 90000 });
 for (const check of checks) { console.log(`${check.ok ? 'ok' : 'FAIL'} ${check.name}`); assert.ok(check.ok, check.name); }
 assert.deepEqual(browser.errors, []);
 if (process.env.ARCADE_PKG) {
  const { root } = await browser.page('DOM.getDocument');
  const { nodeId } = await browser.page('DOM.querySelector', { nodeId: root.nodeId, selector: '#plugin' });
  await browser.page('DOM.setFileInputFiles', { nodeId, files: [process.env.ARCADE_PKG] });
  for (const mode of ['factory', 'startup', 'processor', 'render']) {
   let report;
   if (mode !== 'factory') report = await browser.evaluate(`(async () => {
    const { probeNativeVst3 } = await import('../js/native-vst3-probe.js');
    const result = await probeNativeVst3(document.querySelector('#plugin').files[0], { mode: '${mode}', timeout: 120000 });
    return result.audio ? { ...result, audio: { ...result.audio, buses: result.audio.buses.map(bus => bus.length) } } : result;
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
    assert.deepEqual(report.objc, { dynamicClasses: 3, registeredClasses: 5, selectors: 551, methods: 19, ivars: 4, instances: 15, protocols: 7 });
    assert.equal(report.heap.limitBytes, 32 << 20);
    assert.deepEqual(report.files.descriptorLimits, { soft: 256, hard: 256 });
   } else {
    assert.equal(report.error, undefined); assert.equal(report.initialized, true); assert.equal(report.initializersCompleted, 768);
    assert.equal(report.heap.limitBytes, 256 << 20); assert.ok(report.heap.highWaterBytes > (128 << 20));
    assert.equal(report.network.access, 'offline'); assert.ok(report.network.requests.every(request => request.outcome === 'offline')); assert.ok(report.network.requests.some(request => request.url === 'https://api.output.com/v1/blocked_loops'));
    assert.equal(report.network.completed, report.network.resumed); assert.ok(report.network.resumed >= 3 && report.network.delegateCalls >= report.network.resumed);
    assert.ok(report.files.stdout !== undefined); assert.equal(report.objc.dynamicClasses, 4);
    assert.ok(report.threads.created > 8 && report.threads.completed >= 1);
    if (mode === 'processor') {
     assert.equal(report.stage, 'processor-ready'); assert.deepEqual(report.configuration, { name: 'Arcade', sampleRate: 48000, maxBlock: 128, inputs: [], outputs: [2], eventInputs: 1 });
     assert.equal(report.processor.blocksProcessed, 0);
    } else {
     assert.equal(report.stage, 'rendered'); assert.equal(report.audio.closeError, undefined); assert.equal(report.audio.blocksProcessed, 94); assert.equal(report.processor.blocksProcessed, 94); assert.equal(report.processor.framesProcessed, 12000);
     assert.equal(report.audio.silent, true, 'without a signed-in Output account Arcade renders silence');
     assert.equal(report.audio.peak, 0);
    }
   }
  }
 }
 if (process.env.DEXED_PKG) {
  const { root } = await browser.page('DOM.getDocument');
  const { nodeId } = await browser.page('DOM.querySelector', { nodeId: root.nodeId, selector: '#plugin' });
  await browser.page('DOM.setFileInputFiles', { nodeId, files: [process.env.DEXED_PKG] });
  const result = await browser.evaluate(`(async () => {
   const wait = ms => new Promise(resolve => setTimeout(resolve, ms)), file = document.querySelector('#plugin').files[0];
   const { probeNativeVst3 } = await import('../js/native-vst3-probe.js');
   const render = await probeNativeVst3(file, { mode: 'render', timeout: 120000 });
   const { NativeVst3Live } = await import('../js/native-vst3-live.js');
   const session = new NativeVst3Live(file);
   await session.start();
   const measure = async duration => { let peak = 0; const end = performance.now() + duration; while (performance.now() < end) { peak = Math.max(peak, session.level()); await wait(10); } return peak; };
   const quiet = await measure(400);
   session.noteOn(60); const sounding = await measure(500); session.noteOff(60);
   await wait(900); const released = await measure(300);
   session.noteOn(64); session.noteOn(67); await wait(1500); session.noteOff(64); session.noteOff(67);
   await wait(400); const state = session.state, info = session.info;
   session.stop();
   document.querySelector('#plugin').dispatchEvent(new Event('change'));
   document.querySelector('#live').click();
   for (let tries = 0; tries < 600 && document.querySelector('#keys').hidden; tries++) await wait(50);
   const keysShown = !document.querySelector('#keys').hidden;
   window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); await wait(1300);
   const keyDown = document.querySelector('#keys [data-pitch="60"]').classList.contains('down'), text = document.querySelector('#status').textContent;
   window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }));
   document.querySelector('#stop').click();
   return { peak: render.audio.peak, silent: render.audio.silent, blocks: render.audio.blocksProcessed, closeError: render.audio.closeError ?? null, renderError: render.error ?? null, quiet, sounding, released, state, info, keysShown, keyDown, text, keysHidden: document.querySelector('#keys').hidden };
  })()`, { timeout: 200000 });
  console.log(`Dexed: ${JSON.stringify(result)}`);
  assert.equal(result.renderError, null); assert.equal(result.silent, false); assert.ok(result.peak > 0.01); assert.equal(result.blocks, 94); assert.equal(result.closeError, null);
  assert.equal(result.quiet, 0, 'no MIDI, no sound'); assert.ok(result.sounding > 0.01, 'a live note sounds'); assert.ok(result.released < result.sounding / 5, 'note-off releases the sound');
  assert.ok(result.state.blocks > 100); assert.equal(result.info.eventInputs, 1);
  assert.ok(result.keysShown && result.keyDown && result.keysHidden && /^Live: /.test(result.text), result.text);
  assert.deepEqual(browser.errors, []);
 }
 assert.deepEqual(browser.errors, []);
 console.log('native VST3 browser experiment: all checks passed (not an audio-playback certification)');
} finally { await browser.close(); }
