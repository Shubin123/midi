// The timing layers fed from the Listening widget, in the app in headless Chrome (tests/support/browser.mjs):
// the same rhythm as MIDI, clapped and sung against the metronome; rushing claps; free claps; claps setting the
// tempo; the metronome following them; a click heard back on speakers (tests/listening-app.js runTiming).
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch();
let failed = 0;
try {
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#teacher-panel .question-input") && document.querySelector("#listen-toggle") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })');
 const { checks } = await browser.evaluate(`import('./tests/listening-app.js').then(m => m.runTiming())`, { timeout: 180000 });
 checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
 print(`Listening and timing: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
 failed += checks.filter(c => !c.ok).length;
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'listening and timing: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
