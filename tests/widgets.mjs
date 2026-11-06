// Drags every widget in the app in headless Chrome (tests/support/browser.mjs) and checks the space it will
// drop into (tests/widgets-app.js), at the width of each layout: four columns, two, and one.
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now();
let failed = 0;
for (const [width, label] of [[1500, 'four columns'], [1000, 'two columns'], [560, 'one column']]) {
 const browser = await launch({ width, height: 1000 });
 try {
  await browser.open('index.html');
  await browser.evaluate('new Promise(r => { const ready = () => (document.querySelector("#workspace > .widget .drag-handle") ? r() : setTimeout(ready, 50)); ready(); })');
  const { checks } = await browser.evaluate(`import('./tests/widgets-app.js').then(m => m.runWidgets())`);
  checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
  print(`Dragging widgets, ${width} px wide (${label}): ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
  failed += checks.filter(c => !c.ok).length;
 } catch (err) {
  console.error(`\nThe run stopped: ${err.message}`);
  failed++;
 } finally {
  await browser.close();
 }
}
console.log(`\n${failed ? `${failed} failed` : 'widgets: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
