import assert from 'node:assert/strict';

// Just enough of the browser for the modules that keep things in it.
const ls = new Map();
globalThis.localStorage = { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) };

const { GUIDES, PLUGIN_GUIDES, WORKSPACE_LESSONS, WORKSPACE_UNIT, guideFor, profiles } = await import('../js/workspace-guide.js');
const { answer, nextTip } = await import('../js/system-one.js');
const { learnPlugin, guideFromProfile, KINDS, ROLES, cachedProfile, keepProfile } = await import('../js/plugin-profile.js');
const { Conversations, KEEP, MAX_ENTRIES } = await import('../js/conversations.js');
const { parsePlayCommand, SYSTEM_PROMPT } = await import('../js/ai-teacher.js');
const { Attempt } = await import('../js/lessons.js');

/* ---- Guides cover every widget the workspace builds ---- */
const TITLES = ['Keyboard', 'Step sequencer', 'Automation', 'Oscillators', 'Envelope (ADSR)', 'Metronome & Tempo', 'Filter', 'Master & Settings', 'Loop recorder', 'Oscilloscope', 'Air', 'Plugins', 'Import / Export', 'Settings'];
assert.deepEqual(Object.keys(GUIDES).sort(), [...TITLES].sort(), 'one guide per widget');
for (const [title, g] of Object.entries(GUIDES)) {
 assert.ok(g.what.length > 30 && g.how.length >= 2, `${title}: says what it is for and how to use it`);
 assert.ok(g.how.every(([text, target]) => text.length > 5 && target), `${title}: every step points at something`);
}
for (const name of ['Reverb', 'Delay', 'Compressor', 'Saturator', 'Chorus', 'Air']) assert.ok(PLUGIN_GUIDES[name], `${name} has a written guide`);

// A plug-in window's guide names its own controls and always ends with Bypass.
const win = (title, text = '') => ({ id: `plugin:${title}`, title, plugin: true, el: { textContent: text } });
const delay = guideFor(win('Delay'));
assert.equal(delay.how[1][1], 'Delay › Feedback');
assert.equal(delay.how.at(-1)[1], 'Delay › Bypass');
assert.match(guideFor(win('Mystery FX')).what, /effect plug-in/, 'an unknown effect gets the general guide');
assert.match(guideFor(win('mda Thing', 'VST3 · Instrument')).what, /instrument/, 'and an unknown instrument the instrument one');

/* ---- Learning a plug-in ---- */
{
 const params = ['Time', 'Feedback', 'Tone', 'Mix'].map(label => ({ label }));
 const p = await learnPlugin('Echo Box', params);
 assert.equal(p.kind, 'delay', 'named an echo');
 assert.deepEqual(p.roles, { Time: 'time', Feedback: 'feedback', Tone: 'tone', Mix: 'mix' });
 assert.equal(p.byLaya, false, 'names alone were enough: Laya not asked');
 assert.equal((await learnPlugin('Box', params)).kind, 'delay', 'a delay by its controls, whatever its name');
 assert.equal((await learnPlugin('Squash', ['Threshold', 'Ratio', 'Makeup'].map(label => ({ label })))).kind, 'dynamics');
 assert.equal((await learnPlugin('mda Piano', [{ label: 'Decay' }], { instrument: true })).kind, 'keys');

 // What the names don't say, Laya settles in one call, choosing only from the written kinds and roles.
 const calls = [];
 const laya = { ask: async (situation, questions) => { calls.push({ situation, questions }); return { ms: 40, answers: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { choice: k === 'kind' ? 'modulation' : 'rate' }])) }; } };
 const q = await learnPlugin('mda Thru-Zero', [{ label: 'Rate' }, { label: 'Wobble' }, { label: 'Mix' }], { laya });
 assert.equal(calls.length, 1, 'one call');
 assert.deepEqual(Object.keys(calls[0].questions), ['kind', 'p0'], 'asks the kind, and only the control the names left open');
 assert.ok(Object.keys(calls[0].questions.kind.criteria).every(k => k in KINDS) && Object.keys(calls[0].questions.p0.criteria).every(k => k in ROLES));
 assert.deepEqual([q.kind, q.roles.Wobble, q.roles.Rate, q.byLaya, q.ms], ['modulation', 'rate', 'rate', true, 40]);

 // The guide made from a profile: what it is, then the mix and the characteristic controls first.
 const g = guideFromProfile(q, 'mda Thru-Zero');
 assert.match(g.what, /modulation effect/);
 assert.equal(g.how[0][1], 'mda Thru-Zero › Mix');
 profiles.set('mda Thru-Zero', q);
 assert.equal(guideFor(win('mda Thru-Zero')).how.at(-1)[1], 'mda Thru-Zero › Bypass', 'a learned plug-in gets its learned guide');

 keepProfile(q, [{ label: 'Rate' }, { label: 'Wobble' }, { label: 'Mix' }]);
 assert.deepEqual(cachedProfile('mda Thru-Zero', [{ label: 'Rate' }, { label: 'Wobble' }, { label: 'Mix' }]), q, 'learned once, remembered');
 assert.equal(cachedProfile('mda Thru-Zero', [{ label: 'Rate' }]), null, 'a different set of controls is learned again');
}

/* ---- System 1 alone: answers and tips are chosen, never written ---- */
{
 const widgets = [{ id: 'filter-group', title: 'Filter', plugin: false }, { id: 'plugin:Delay', title: 'Delay', plugin: true, el: { textContent: '' } }];
 const asked = [];
 const pick = async (situation, instructions, options) => { asked.push(options); const keys = Object.keys(options); return { choice: keys.find(k => /cutoff|Feedback|filter-group|plugin:Delay|relative/i.test(`${k} ${options[k]}`)) || keys[0], confidence: 0.8, ms: 30 }; };
 const r = await answer('how do I make it darker?', { pick, widgets, hint: ['filter-group'] });
 assert.equal(r.widget.title, 'Filter');
 assert.equal(r.step[1], 'filterCutoff', 'points at the cutoff');
 assert.equal(asked.length, 1, 'a widget named in the question is the only candidate, so Laya only chooses the step');
 assert.deepEqual(Object.keys(asked[0]).sort(), ['1', 'what'], 'and words in common narrow it to the steps that mention "darker"');
 assert.equal(r.ms, 30); assert.equal(r.confidence, 0.8);
 asked.length = 0;
 await answer('which one?', { pick, widgets, hint: ['filter-group', 'plugin:Delay'] });
 assert.deepEqual(Object.keys(asked[0]), ['filter-group', 'plugin:Delay'], 'two named widgets: Laya chooses between them');

 asked.length = 0;
 const theory = await answer('what is a relative key?', { pick: async (s, i, o) => ({ choice: 'theory' in o ? 'theory' : Object.keys(o).find(k => /relative/.test(k)), confidence: 0.6, ms: 20 }), widgets });
 assert.equal(theory.lesson.id, 'relative_minor', 'theory goes to the lesson that answers it');

 // "Tempo" names the metronome widget, but its guide says nothing about rhythm, so the lesson stays a choice.
 const more = [...widgets, { id: 'tempo-group', title: 'Metronome & Tempo', plugin: false }, { id: 'looper', title: 'Loop recorder', plugin: false }];
 const offered = [];
 const toLesson = async (s, i, o) => { offered.push(Object.keys(o)); return { choice: 'theory' in o ? 'theory' : Object.keys(o).find(k => /tempo_rhythm/.test(k)) || Object.keys(o)[0], confidence: 0.7, ms: 10 }; };
 const both = await answer('what is the difference between tempo and rhythm?', { pick: toLesson, widgets: more, hint: ['tempo-group'] });
 assert.deepEqual(offered[0], ['tempo-group', 'theory'], 'the widget the question names, and theory');
 assert.equal(both.lesson.id, 'tempo_rhythm');
 offered.length = 0;
 assert.equal((await answer('how do I set the tempo?', { pick: toLesson, widgets: more, hint: ['tempo-group'] })).widget.title, 'Metronome & Tempo', 'a question its guide covers stays with the widget');
 assert.ok(offered.every(o => !o.includes('theory')), 'theory is not offered');
 assert.equal((await answer('how do I record in slot 1?', { pick: toLesson, widgets: more, hint: ['looper'] })).widget.title, 'Loop recorder', 'the "1" of "System 1" brings no lesson in');
 assert.ok(offered.every(o => !o.includes('theory')));
 const systems = await answer('what are System 1 and System 2?', { pick: toLesson, widgets: more });
 assert.equal(systems.lesson.id, 'two_systems', 'the teacher\'s two systems have a lesson too');

 const controls = [{ label: 'Time', kind: 'number', value: '0.3', min: '0', max: '1' }, { label: 'Feedback', kind: 'number', value: '0.2', min: '0', max: '0.95' }, { label: 'Bypass', kind: 'checkbox', value: 'off' }, { label: 'Remove', kind: 'button' }];
 const first = await nextTip(widgets[1], { pick, controls, given: [] });
 assert.equal(first.label, 'Feedback');
 assert.match(first.text, /Feedback: how many echoes/, 'the written guide\'s words');
 const rest = await nextTip(widgets[1], { pick: async (s, i, o) => ({ choice: Object.keys(o)[0], ms: 5 }), controls, given: ['Feedback', 'Time'] });
 assert.equal(rest.label, 'Bypass', 'never a control already suggested, never a button; the host\'s Bypass comes last');
 const vst = await nextTip(widgets[1], { pick: async (s, i, o) => ({ choice: Object.keys(o)[0], ms: 5 }), controls: [{ label: 'Bypass 1', kind: 'checkbox', value: 'off' }, { label: 'Bypass 2', kind: 'number', value: '0', min: '0', max: '1' }, { label: 'Plug-in in this module', kind: 'select', value: 'mda Ambience' }], given: [] });
 assert.equal(vst.label, 'Bypass 1', 'a VST3\'s own bypass parameter and class picker are not sound controls');
 assert.equal(await nextTip(widgets[1], { pick, controls, given: ['Feedback', 'Time', 'Bypass'] }), null, 'all done');
 const unknown = await nextTip({ title: 'Box', plugin: true, el: { textContent: '' } }, { pick: async (s, i, o) => ({ choice: '0', ms: 5 }), controls: [{ label: 'Wobble', kind: 'number', value: '3', min: '0', max: '10' }] });
 assert.match(unknown.text, /Change Wobble \(now 3, from 0 to 10\)/, 'an unlearned control still gets a tip');
}

/* ---- Workspace lessons, checked from the workspace state ---- */
assert.ok(WORKSPACE_LESSONS.every(l => l.unit === WORKSPACE_UNIT && GUIDES[l.widget] && l.show?.length && l.task && l.hint), 'each teaches a real widget and shows where');
{
 const base = { value: () => null, minimized: [], seqSteps: 0, seqPlaying: false, loops: [false, false, false, false], lanesOn: 0, automationShaped: false, plugins: [], pluginEdits: false, pressed: [] };
 const st = (over = {}, values = {}) => ({ ...base, ...over, value: ref => values[ref] ?? null });
 const played = new Attempt(); played.noteOn(60); played.noteOff(60);
 const silent = new Attempt();
 const cases = {
  ws_widgets: [st({ minimized: ['scope-module'] }), st()],
  ws_oscillators: [st({}, { waveformOsc1: 'square' }), st({}, { waveformOsc1: 'sawtooth' })],
  ws_envelope: [st({}, { attack: '0.6' }), st({}, { attack: '0.05' })],
  ws_filter: [st({}, { filterCutoff: '800' }), st({}, { filterCutoff: '5000' })],
  ws_tempo: [st({}, { metronomeToggle: true }), st({}, { metronomeToggle: false })],
  ws_sequencer: [st({ seqSteps: 4, seqPlaying: true }), st({ seqSteps: 4 })],
  ws_looper: [st({ loops: [true, false, false, false] }), st({ loops: [false, true, false, false] })],
  ws_automation: [st({ lanesOn: 1, automationShaped: true }), st({ lanesOn: 1 })],
  ws_plugins: [st({ plugins: ['Delay'] }), st({ plugins: ['Reverb'] })],
  ws_plugin_controls: [st({ plugins: ['Delay'], pluginEdits: true }), st({ plugins: ['Delay'] })],
  ws_instrument: [st({ plugins: ['mda Piano'] }), st({ plugins: ['mda JX10'] })],
  ws_air: [st({}, { 'Air › Enabled': true, 'Air › High Air': '2' }), st({}, { 'Air › Enabled': true, 'Air › High Air': '0' })],
  ws_scope: [st({}, { visualizerSourceSelect: 'osc1' }), st({}, { visualizerSourceSelect: 'master' })],
  ws_export: [st({ pressed: ['Play', 'Export MIDI'] }), st({ pressed: ['Render audio'] })],
 };
 assert.deepEqual(Object.keys(cases).sort(), WORKSPACE_LESSONS.map(l => l.id).sort(), 'every workspace lesson is tested');
 const needsNotes = ['ws_oscillators', 'ws_envelope', 'ws_filter', 'ws_instrument', 'ws_scope'];
 for (const l of WORKSPACE_LESSONS) {
  const [right, wrong] = cases[l.id];
  assert.ok(l.check(played, right), `${l.id}: done`);
  assert.equal(!!l.check(played, wrong), false, `${l.id}: not done`);
  if (needsNotes.includes(l.id)) assert.equal(!!l.check(silent, right), false, `${l.id}: and the student has to play to hear it`);
 }
}

/* ---- The model can point at controls and change them ---- */
assert.match(SYSTEM_PROMPT, /\[WORKSPACE\]/);
assert.deepEqual(parsePlayCommand('Lower the cutoff.\n{"show": "Filter › Cutoff (Hz)", "set": {"Filter › Cutoff (Hz)": 800}}'), { text: 'Lower the cutoff.', play: null, actions: { show: ['Filter › Cutoff (Hz)'], set: [['Filter › Cutoff (Hz)', 800]] } });
assert.deepEqual(parsePlayCommand('Both.\n{"chords": ["C"], "show": ["Filter", "Envelope (ADSR) › Attack (s)"]}').actions, { show: ['Filter', 'Envelope (ADSR) › Attack (s)'], set: [] });
assert.equal(parsePlayCommand('Just music.\n{"chords": ["C"]}').actions, undefined, 'no actions, no key: older replies are unchanged');
assert.deepEqual(parsePlayCommand('{"set": {"a": {"b": 1}, "c": [1], "d": true}}').actions.set, [['d', true]], 'only plain values are set');

/* ---- System 2 supervising System 1 ---- */
{
 const { AiTeacher } = await import('../js/ai-teacher.js');
 const seen = [];
 let reply = 'OK';
 const t = new AiTeacher(); t.setEngine({ generate: async messages => { seen.push(messages.at(-1).content); return reply; } });
 const shown = []; let confirmed = 0;
 t.onResponse = text => shown.push(text);
 await t.ask('how do I make it darker?', { quick: 'Filter: Cutoff: lower it to make the sound darker.', context: '[WORKSPACE]\nFilter controls: Cutoff (Hz) = 5000.', onConfirm: () => confirmed++ });
 assert.match(seen[0], /^\[WORKSPACE\][\s\S]*how do I make it darker\?[\s\S]*quick answer was: "Filter: Cutoff/, 'the model sees the workspace, the question and the quick answer');
 assert.equal(confirmed, 1); assert.deepEqual(shown, [], 'a confirmation adds nothing to the conversation');
 assert.deepEqual(t.conversationHistory.map(m => m.content), ['how do I make it darker?', 'Filter: Cutoff: lower it to make the sound darker.'], 'and the model remembers the quick answer as given');
 reply = 'Not quite: press Arm, not Play, to record.\n{"show": "Loop recorder › Arm 1"}';
 await t.ask('how do I record a loop?', { quick: 'Loop recorder: Play loops a slot.', onConfirm: () => confirmed++ });
 assert.equal(confirmed, 1); assert.deepEqual(shown, ['Not quite: press Arm, not Play, to record.'], 'a wrong quick answer is corrected');
 assert.equal(t.conversationHistory.at(-2).content, 'how do I record a loop?', 'the history keeps the plain question');
}

/* ---- Conversations are kept ---- */
{
 const mem = new Map(), store = { read: (k, f) => (mem.has(k) ? structuredClone(mem.get(k)) : f), save: (k, v) => mem.set(k, structuredClone(v)) };
 const c = new Conversations(store);
 c.add({ kind: 'msg', type: 'user', text: 'What is a fifth?' }, 'What is a fifth?');
 c.current.history.push({ role: 'user', content: 'What is a fifth?' }, { role: 'assistant', content: 'Seven half steps.' });
 c.setLesson('intervals'); c.save(true);
 const again = new Conversations(store);
 assert.equal(again.current.entries.length, 1, 'survives a reload');
 assert.equal(again.current.history.length, 2, 'and so does the model\'s memory of it');
 assert.equal(again.current.lesson, 'intervals');
 assert.equal(again.current.title, 'What is a fifth?');
 const first = again.current.id;
 again.startNew();
 assert.equal(again.past[0].id, first, 'New keeps the old one in the history');
 again.startNew();
 assert.equal(again.past.length, 1, 'an empty conversation is not kept');
 again.add({ kind: 'msg', type: 'user', text: 'second' });
 assert.equal(again.open(first).id, first, 'a past one reopens');
 assert.equal(again.past[0].entries[0].text, 'second', 'and the current one takes its place');
 for (let i = 0; i < MAX_ENTRIES + 10; i++) again.add({ kind: 'msg', type: 'user', text: String(i) });
 assert.equal(again.current.entries.length, MAX_ENTRIES, 'long conversations keep their latest entries');
 for (let i = 0; i < KEEP + 3; i++) { again.add({ kind: 'msg', type: 'user', text: 'x' }); again.startNew(); }
 assert.equal(again.past.length, KEEP, 'and only the latest conversations are kept');
 again.clearAll();
 assert.equal(again.count, 0);
 again.save(true);
}

/* ---- Clearing downloaded models ---- */
{
 const stores = new Map([['webllm/model', ['https://huggingface.co/mlc-ai/Qwen3.5-4B-q4f16_1-MLC/resolve/main/params_shard_0.bin']], ['webllm/config', []], ['laya-4f390866b703e654', ['x']], ['tts-supertonic-v3', ['z']], ['zip-plugins-v1', ['y']]]);
 globalThis.caches = { keys: async () => [...stores.keys()], open: async n => ({ keys: async () => stores.get(n).map(url => ({ url })) }), delete: async n => stores.delete(n) };
 const dbs = ['webllm/model', 'other'];
 globalThis.indexedDB = { databases: async () => dbs.map(name => ({ name })), deleteDatabase: name => { const req = {}; setTimeout(() => { dbs.splice(dbs.indexOf(name), 1); req.onsuccess(); }); return req; } };
 const { modelCacheInfo, clearModelCache } = await import('../js/model-cache.js');
 const info = await modelCacheInfo();
 assert.equal(info.laya, true);
 assert.deepEqual(info.qwen, ['Qwen 3.5 4B']);
 assert.deepEqual(info.voices, ['Supertonic voice'], 'downloaded voices are listed too');
 assert.equal(await clearModelCache(), 5, 'four caches and one database');
 assert.deepEqual([...stores.keys()], ['zip-plugins-v1'], 'plug-in archives are left alone');
 assert.deepEqual(dbs, ['other']);
}

console.log('workspace: all checks passed');
