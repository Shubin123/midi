// node tests/controller-panel.mjs: MIDI controllers in the app, in headless Chrome (tests/support/browser.mjs)
// with a mock Web MIDI device (tests/support/mock-midi.js): plain MIDI, the Arturia MiniLab 3 through its preset
// (every widget from its controls, feedback, programs, SysEx refused and allowed, hot-plugging), the Generic
// 8-knob preset and MIDI learn (tests/controller-app.js runControllers); then the teacher and its agent with it:
// every controller action, what the teacher is told, requests met at once, and lessons that light pads and grade
// the hits on them (runControllerTeacher).
import { readFile } from 'node:fs/promises';
import { launch, print, unexpected, ROOT } from './support/browser.mjs';
import { join } from 'node:path';

const t0 = Date.now(), browser = await launch();
let failed = 0;
try {
 await browser.beforeScripts(await readFile(join(ROOT, 'tests/support/mock-midi.js'), 'utf8'));
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#controllers-module") && document.querySelector("#workspace > .widget") && window.workspaceApi ? r() : setTimeout(go, 50)); go(); })');
 const { checks } = await browser.evaluate(`import('./tests/controller-app.js').then(m => m.runControllers())`, { timeout: 120000 });
 const teacher = await browser.evaluate(`import('./tests/controller-app.js').then(m => m.runControllerTeacher())`, { timeout: 120000 });
 checks.push(...teacher.checks);
 checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
 print(`Controllers: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
 failed += checks.filter(c => !c.ok).length;
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'controllers: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
