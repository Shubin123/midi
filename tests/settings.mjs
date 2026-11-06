// The Settings menu in the app, in headless Chrome (tests/support/browser.mjs): the AI teacher's switch, the
// panic in Settings and on the page, and the panic on coming back to the tab (tests/settings-app.js). The page
// is reloaded halfway, to check what the switches keep.
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch();
const ready = () => browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#settings-teacher") && document.querySelector(".teacher-toggle") ? r() : setTimeout(go, 50)); go(); })');
let failed = 0;
try {
 for (const phase of ['first', 'reloaded']) {
  await browser.open('index.html');
  await ready();
  const { checks } = await browser.evaluate(`import('./tests/settings-app.js').then(m => m.runSettings('${phase}'))`);
  checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
  print(phase === 'first' ? `Settings: ${checks.filter(c => c.ok).length} of ${checks.length}` : `After a reload: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
  failed += checks.filter(c => !c.ok).length;
 }
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'settings: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
