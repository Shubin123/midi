// The widgets that take the Listening widget's input, in the app in headless Chrome (tests/support/browser.mjs):
// Record from audio into the step sequencer, loops of notes and of audio, the oscilloscope's Input view
// (tests/listening-app.js runTools).
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch();
let failed = 0;
try {
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#teacher-panel .question-input") && document.querySelector("#seq-record") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })');
 const { checks } = await browser.evaluate(`import('./tests/listening-app.js').then(m => m.runTools())`, { timeout: 120000 });
 checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
 print(`Listening in the widgets: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
 failed += checks.filter(c => !c.ok).length;
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'listening in the widgets: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
