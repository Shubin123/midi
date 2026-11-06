// The teacher's voice mode in the app, in headless Chrome (tests/support/browser.mjs), with speech recognition
// stubbed and sounds played into the Listening widget (tests/voice-mode-app.js).
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
let failed = 0;
try {
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#teacher-panel .tp-talk") && document.querySelector("#settings-audio-provider") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })');
 const { checks } = await browser.evaluate(`import('./tests/voice-mode-app.js').then(m => m.runVoiceMode())`, { timeout: 150000 });
 checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
 print(`Voice mode: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
 failed += checks.filter(c => !c.ok).length;
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'voice mode in the panel: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
