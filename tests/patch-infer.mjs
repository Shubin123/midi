// Patch inference in the app, in headless Chrome (tests/support/browser.mjs): random known patches inferred back,
// and the Sound match widget, a clip and the teacher using it (tests/patch-infer-app.js).
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch();
let failed = 0;
try {
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#match-record") && document.querySelector("#teacher-panel .question-input") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })');
 const { checks } = await browser.evaluate(`import('./tests/patch-infer-app.js').then(m => m.runPatchInfer())`, { timeout: 240000 });
 checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
 print(`Sound match: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
 failed += checks.filter(c => !c.ok).length;
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'sound match: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
