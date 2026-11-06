// The teacher as an agent, in the app in headless Chrome (tests/support/browser.mjs), with Chrome's fake
// microphone so the agent can open one: every action, what the agent decides, Undo, and a lesson run end to end
// by a scripted model (tests/agent-app.js).
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
let failed = 0;
try {
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#teacher-panel .agent-check") && document.querySelector("#seq-record") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })');
 const { checks } = await browser.evaluate(`import('./tests/agent-app.js').then(m => m.runAgent())`, { timeout: 150000 });
 checks.push({ name: 'no errors in the page', ok: !unexpected(browser.errors).length, problems: unexpected(browser.errors) });
 print(`The teacher as an agent: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
 failed += checks.filter(c => !c.ok).length;
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'agent: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
