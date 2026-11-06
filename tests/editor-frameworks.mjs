// node tests/editor-frameworks.mjs: which editor adapter a plug-in gets (js/plugin-editor.js), from what its
// bundle declares or, undeclared, from the framework strings in its binary (js/native-id.js), and what its
// window says for each framework that can't be shown yet.
import assert from 'node:assert/strict';
import { editorFrameworkOf } from '../js/native-id.js';
import { adapterFor, FRAMEWORKS, registerAdapter } from '../js/plugin-editor.js';

const binary = text => new TextEncoder().encode(`\0asm padding ${text} more padding\0`);
assert.equal(editorFrameworkOf(binary('JUCE v7.0.12')), 'juce');
assert.equal(editorFrameworkOf(binary('juce::Component')), 'juce');
assert.equal(editorFrameworkOf(binary('iPlug2 IGraphicsNanoVG')), 'iplug2');
assert.equal(editorFrameworkOf(binary('DISTRHO_PLUGIN_NAME')), 'dpf');
assert.equal(editorFrameworkOf(binary('Dear ImGui 1.90')), 'imgui');
assert.equal(editorFrameworkOf(binary('VSTGUI::CFrame')), 'vstgui');
assert.equal(editorFrameworkOf(binary('JUCE v6.1.0 VSTGUI')), 'juce', 'a JUCE plug-in is JUCE, whatever else it links');
assert.equal(editorFrameworkOf(binary('nothing to see')), null);

// What each one gets: an adapter where there is one, else the reason, naming the framework.
registerAdapter({ id: 'vstgui', label: 'VSTGUI', open: () => null });
const plugin = framework => ({ name: 'P', editor: { framework } });
assert.ok(adapterFor(plugin('vstgui')).adapter, 'VSTGUI has an adapter');
for (const id of ['iplug2', 'dpf', 'juce', 'imgui', 'gl', 'native', 'vstgui-native']) {
 const { adapter, reason, quiet } = adapterFor(plugin(id));
 assert.ok(!adapter && reason && !quiet, `${id}: falls back, and says so`);
 assert.ok(reason.includes(FRAMEWORKS[id].label), `${id}: the reason names it ("${reason}")`);
}
assert.match(adapterFor(plugin('some-new-toolkit')).reason, /uses some-new-toolkit/, 'an unknown framework is named too');
assert.match(adapterFor(plugin('none')).reason, /no editor/);
assert.equal(adapterFor({ name: 'Reverb' }).quiet, true, 'a plain web effect has nothing to say');
console.log('editor frameworks: all checks passed');
