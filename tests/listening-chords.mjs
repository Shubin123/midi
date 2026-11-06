// Chords heard by the Listening widget, in the app in headless Chrome (tests/support/browser.mjs): live, from the
// app's own oscillators; then a clip transcribed with the download of Basic Pitch blocked (the built-in ear takes
// over, and says so), and with it allowed (tests/listening-app.js runChords).
import { launch, print, unexpected } from './support/browser.mjs';

const t0 = Date.now(), browser = await launch();
let failed = 0;
const run = async (title, phase) => {
 const { checks } = await browser.evaluate(`import('./tests/listening-app.js').then(m => m.runChords('${phase}'))`, { timeout: 150000 });
 print(`${title}: ${checks.filter(c => c.ok).length} of ${checks.length}`, checks);
 failed += checks.filter(c => !c.ok).length;
};
try {
 await browser.open('index.html');
 await browser.evaluate('new Promise(r => { const go = () => (document.querySelector("#teacher-panel .question-input") && document.querySelector("#listen-toggle") && document.querySelector("#workspace > .widget") ? r() : setTimeout(go, 50)); go(); })');
 await run('Chords, live', 'live');
 await browser.page('Network.enable');
 await browser.page('Network.setBlockedURLs', { urls: ['*cdn.jsdelivr.net*'] });
 await run('Basic Pitch, offline', 'offline');
 await browser.page('Network.setBlockedURLs', { urls: [] });
 // Basic Pitch comes from jsdelivr: with no network, that part is skipped (and said), not failed.
 const online = await fetch('https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json', { method: 'HEAD' }).then(r => r.ok, () => false);
 if (online) await run('Basic Pitch, online', 'online');
 else console.log('\nBasic Pitch, online: skipped (cdn.jsdelivr.net can\'t be reached)');
 // A blocked download is logged as an error by the browser; that one is expected.
 const errors = unexpected(browser.errors).filter(e => !/jsdelivr|ERR_BLOCKED/i.test(e));
 print('The page', [{ name: 'no errors in the page', ok: !errors.length, problems: errors }]);
 failed += errors.length ? 1 : 0;
} catch (err) {
 console.error(`\nThe run stopped: ${err.message}`);
 failed++;
} finally {
 await browser.close();
}
console.log(`\n${failed ? `${failed} failed` : 'listening to chords: all checks passed'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(failed ? 1 : 0);
