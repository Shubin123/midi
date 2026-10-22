// Builds real plugin bundles, binaries, and installer packages with macOS tools, then identifies them.
// Requires macOS (clang, lipo, plutil, pkgbuild, productbuild, zip).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readArchive } from '../js/archive.js';
import { identifyNative, standInFor, binaryInfo } from '../js/native-id.js';
import { parsePlist } from '../js/plist.js';

const dir = mkdtempSync(join(tmpdir(), 'native-id-'));
const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, stdio: 'pipe' });
const write = (path, data) => { mkdirSync(join(dir, path, '..'), { recursive: true }); writeFileSync(join(dir, path), data); };
const plist = dict => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${Object.entries(dict).map(([k, v]) => `<key>${k}</key>${v}`).join('')}</dict></plist>`;
const str = s => `<string>${s}</string>`;

// A universal (arm64 + x86_64) binary carrying the strings real JUCE VST3 effects embed.
write('src.c', 'const char *sig[] = { "JUCE v7.0.12", "\\0Fx|Reverb\\0", "VST 3.7.9" };\nconst char **juce_sig(void) { return sig; }\n');
run('clang', ['-arch', 'arm64', '-arch', 'x86_64', '-dynamiclib', '-o', 'Rev', 'src.c']);
write('root/Rev.vst3/Contents/Info.plist', plist({ CFBundleIdentifier: str('com.acme.rev'), CFBundleName: str('Rev'), CFBundleShortVersionString: str('2.1.0'), LSMinimumSystemVersion: str('10.13') }));
run('plutil', ['-convert', 'binary1', 'root/Rev.vst3/Contents/Info.plist']);
mkdirSync(join(dir, 'root/Rev.vst3/Contents/MacOS'), { recursive: true });
run('cp', ['Rev', 'root/Rev.vst3/Contents/MacOS/Rev']);

// A Windows VST3 bundle described by moduleinfo.json (JSON5-style trailing commas included).
const pe = new Uint8Array(256); pe.set([0x4d, 0x5a]); new DataView(pe.buffer).setUint32(0x3c, 0x80, true); pe.set([0x50, 0x45, 0, 0, 0x64, 0x86], 0x80);
write('root/Synth.vst3/Contents/x86_64-win/Synth.vst3', pe);
write('root/Synth.vst3/Contents/Resources/moduleinfo.json', '{\n "Name": "Synth",\n "Version": "1.4.0",\n "Factory Info": { "Vendor": "Acme Audio", },\n "Classes": [ { "Category": "Audio Module Class", "Name": "Synth Pro", "Vendor": "Acme Audio", "Version": "1.4.0", "SDK Version": "VST 3.7.8", "Sub Categories": [ "Instrument", "Synth" ], }, ],\n}\n');

// An Audio Unit whose type comes from AudioComponents.
write('root/Comp.component/Contents/Info.plist', plist({ CFBundleIdentifier: str('com.acme.comp'), CFBundleShortVersionString: str('3.0'),
 AudioComponents: `<array><dict><key>type</key><string>aufx</string><key>name</key><string>Acme: Bus Squash</string></dict></array>` }));
write('plain.c', 'int plain(void) { return 1; }\n');
run('clang', ['-arch', 'arm64', '-dynamiclib', '-o', 'root/Comp.component/Contents/MacOS-binary', 'plain.c']);
write('notes/readme.txt', 'not a plugin');

run('zip', ['-q', '-r', '-y', 'bundles.zip', 'root', 'notes']);
const bundles = await identifyNative(await readArchive(new Blob([readFileSync(join(dir, 'bundles.zip'))]), 'bundles.zip'));
const byName = Object.fromEntries(bundles.map(b => [b.name, b]));
assert.deepEqual(Object.keys(byName).sort(), ['Bus Squash', 'Rev', 'Synth Pro']);
assert.deepEqual({ ...byName.Rev, path: undefined }, { path: undefined, format: 'VST3', name: 'Rev', vendor: 'acme', version: '2.1.0', bundleId: 'com.acme.rev', kind: 'Effect',
 categories: ['Fx', 'Reverb'], platforms: ['macOS (x86_64 + arm64)'], frameworks: ['JUCE 7.0.12'], sdk: 'VST 3.7.9', minOS: '10.13', complete: true });
assert.equal(standInFor(byName.Rev), 'reverb');
assert.equal(byName['Synth Pro'].kind, 'Instrument');
assert.equal(byName['Synth Pro'].vendor, 'Acme Audio');
assert.deepEqual(byName['Synth Pro'].platforms, ['Windows (x64)']);
assert.equal(standInFor(byName['Synth Pro']), null);
assert.equal(byName['Bus Squash'].kind, 'Effect');
assert.equal(byName['Bus Squash'].vendor, 'Acme');
assert.equal(standInFor(byName['Bus Squash']), 'compressor');
console.log('Bundles: VST3 (macOS, Windows) and Audio Unit identified.');

// A product installer containing a component package, zipped, as vendors ship them.
mkdirSync(join(dir, 'pkgroot'));
run('cp', ['-R', 'root/Rev.vst3', 'pkgroot/']);
run('pkgbuild', ['--quiet', '--root', 'pkgroot', '--identifier', 'com.acme.rev.pkg', '--version', '2.1.0', '--install-location', '/Library/Audio/Plug-Ins/VST3', 'rev-component.pkg']);
run('productbuild', ['--quiet', '--package', 'rev-component.pkg', 'Rev Installer.pkg']);
mkdirSync(join(dir, 'dist'));
run('cp', ['Rev Installer.pkg', 'dist/']);
write('dist/Other.dmg', 'x');
run('zip', ['-q', '-r', 'installer.zip', 'dist']);
const installer = await identifyNative(await readArchive(new Blob([readFileSync(join(dir, 'installer.zip'))]), 'installer.zip'));
const rev = installer.find(i => i.name === 'Rev');
assert.ok(rev, JSON.stringify(installer));
assert.equal(rev.kind, 'Effect');
assert.deepEqual(rev.platforms, ['macOS (x86_64 + arm64)']);
assert.equal(rev.installLocation, '/Library/Audio/Plug-Ins/VST3');
assert.match(rev.path, /^Rev Installer\.pkg › .*Rev\.vst3$/);
assert.ok(installer.find(i => i.installer && i.format === 'macOS disk image'));
console.log('Installer: plugin found inside a zipped product .pkg payload; .dmg flagged.');

// Loose files and binary-header edge cases.
const loose = await identifyNative(new Map([['Rev', new Uint8Array(readFileSync(join(dir, 'Rev')))], ['old.dll', pe]]));
assert.deepEqual(loose.map(l => l.format), ['Windows plugin library (likely VST2)']);
assert.equal(binaryInfo(new Uint8Array(10)), null);
assert.deepEqual(parsePlist(new TextEncoder().encode(plist({ a: '<true/>', b: '<integer>3</integer>', c: '<array><string>x &amp; y</string></array>' }))), { a: true, b: 3, c: ['x & y'] });
console.log('Native plugin identification passed.');
