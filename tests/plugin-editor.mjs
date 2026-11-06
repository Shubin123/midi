// The AI teacher's panel in the app, in headless Chrome (tests/support/browser.mjs), used by typing into its
// ask box as a student would (tests/plugin-editor-app.js). No model is downloaded: System 2 is a stub.
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch();
let failed = 0;
try {
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#plugin-host-module select") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })');
 const { checks } = await browser.evaluate(`import('./tests/plugin-editor-app.js').then(m => m.runPluginEditor())`, { timeout: 120000 });
 checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
 print(`Plug-in editors: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
 failed += checks.filter(c => !c.ok).length;
// Again at a 2x pixel ratio, in a fresh page.
 await browser.page('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 2, mobile: false });
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#plugin-host-module select") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })');
 const hi = await browser.evaluate(`import('./tests/plugin-editor-app.js').then(m => m.runHiDpi())`, { timeout: 60000 });
 hi.checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
 print(`At a 2x pixel ratio: ${hi.checks.filter(c => c.ok).length} of ${hi.checks.length}`, hi.checks);
 failed += hi.checks.filter(c => !c.ok).length;
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'plug-in editors: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
