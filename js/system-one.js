// System 1 on its own: Laya (js/laya.js) teaches the workspace and its plug-ins without a language model. It
// only chooses, from options built here out of the widget guides (js/workspace-guide.js) and the course, so
// every word it "says" was written in advance and every control it points at exists. The page is passed in
// (widgets, controls, values), so all of this runs and is tested without a browser.
import { guideFor } from './workspace-guide.js';
import { LESSONS } from './lessons.js';

const THEORY = 'music theory: notes, scales, keys, intervals, chords, harmony and chord progressions';
const brief = s => s.split(/(?<=\.)\s/)[0]; // the first sentence
// Words in common between a question and an option, so the plain cases need no model at all: a stem match
// scores 1 and two question words side by side in the option ("record a loop") score 1 more.
const STOP = new Set('a an and are be can do does for from get have how i in is it its me my of on or so that the this to what when where which why with you your sound make want would there'.split(' '));
const stem = w => (w.length > 4 ? w.replace(/(ing|ed|ly|er|es|s)$/, '') : w);
const words = text => String(text).toLowerCase().replace(/[^a-z0-9#\s]/g, ' ').split(/\s+/).filter(w => w && !STOP.has(w)).map(stem);
export function overlap(question, text) {
 const q = words(question), t = words(text), set = new Set(t);
 let score = new Set(q.filter(w => set.has(w))).size;
 for (let i = 0; i + 1 < q.length; i++) for (let j = 0; j + 1 < t.length; j++) if (t[j] === q[i] && t[j + 1] === q[i + 1]) { score++; break; }
 return score;
}
// The options that share the most words with the question, or all of them when none share any.
const shortlist = (q, options, texts = options) => {
 const scored = Object.keys(options).map(id => [id, overlap(q, texts[id])]), top = Math.max(...scored.map(([, s]) => s));
 return top > 0 ? Object.fromEntries(scored.filter(([, s]) => s === top).map(([id]) => [id, options[id]])) : options;
};

// A choice of one is no choice: Laya is not asked (it needs at least two options).
const only = pick => async (situation, instructions, options) => { const ids = Object.keys(options); return ids.length < 2 ? { choice: ids[0], confidence: 1, ms: 0 } : pick(situation, instructions, options); };
// A plug-in's own bypass parameter and a module's class picker are not part of its sound; the host's Bypass is.
export const isSoundControl = c => c.kind !== 'button' && c.kind !== 'text' && !/^(bypass|plug-in in this module|layer built-in synth)\b/i.test(c.label);

// A typed or spoken question: first which widget, plug-in or part of theory it is about, then which guide
// step or lesson answers it. `hint` lists widget ids the question names outright, which narrows the first
// choice to them. Returns { widget, step: [text, target] | null, confidence, ms } or { lesson, confidence, ms }.
export async function answer(q, { pick: choose, widgets, hint = [] }) {
 const pick = only(choose);
 const situation = `A student using a synth and music-theory app asks: "${q}"`;
 const pool = hint.length ? widgets.filter(w => hint.includes(w.id)) : widgets;
 const areas = Object.fromEntries(pool.map(w => [w.id, `${w.title}${w.plugin ? ' (plug-in)' : ''}: ${brief(guideFor(w)?.what || 'a widget')}`]));
 if (!hint.length) areas.theory = THEORY;
 const first = await pick(situation, 'Which part of the app, or which subject, is the question about?', areas);
 if (first.choice === 'theory') {
  const lessons = Object.fromEntries(LESSONS.map(l => [l.id, `${l.title}: ${brief(l.text)}`]));
  const second = await pick(situation, 'Which lesson answers the question?', shortlist(q, lessons, Object.fromEntries(LESSONS.map(l => [l.id, `${l.title} ${l.text}`]))));
  return { lesson: LESSONS.find(l => l.id === second.choice), confidence: first.confidence, ms: first.ms + second.ms };
 }
 const widget = pool.find(w => w.id === first.choice), how = guideFor(widget)?.how || [];
 if (!how.length) return { widget, step: null, confidence: first.confidence, ms: first.ms };
 const steps = Object.fromEntries([['what', `what the ${widget.title} is for`], ...how.map(([text], i) => [String(i), text])]);
 const second = await pick(situation, `Which part of the ${widget.title} guide answers the question?`, shortlist(q, steps, { ...steps, what: `${widget.title} ${guideFor(widget)?.what || ''}` }));
 return { widget, step: second.choice === 'what' ? null : how[Number(second.choice)], confidence: Math.min(first.confidence ?? 1, second.confidence ?? 1), ms: first.ms + second.ms };
}

// The next thing to try in a widget or plug-in: Laya picks one control not suggested yet, judging from the
// current settings. Known widgets and plug-ins use their guide's words; any other plug-in gets a tip for each
// of its controls. `controls` are { label, kind, value, min, max }; `given` lists labels already suggested.
// Returns { label, text, target, ms }, or null when every control has had its turn.
export async function nextTip(w, { pick: choose, controls, given = [] }) {
 const pick = only(choose);
 const tunable = controls.filter(isSoundControl), bypass = controls.find(c => /^Bypass\b/.test(c.label) && c.kind === 'checkbox');
 if (bypass) tunable.push(bypass); // the host's Bypass, last: comparing with and without is worth a tip
 const tips = [];
 for (const [text, target] of guideFor(w)?.how || []) {
  const named = target?.split(' › ').pop(); // a numbered label ("Bypass 1") still matches its step ("Bypass")
  const c = target && tunable.find(x => target === x.id || [x.label, x.label.replace(/ \d+$/, '')].includes(named));
  if (c) tips.push({ label: c.label, text, target });
 }
 for (const c of tunable) {
  if (tips.some(t => t.label === c.label)) continue;
  const where = c.kind === 'number' && c.min !== '' && c.max !== '' ? ` (now ${c.value}, from ${c.min} to ${c.max})` : ` (now ${c.value})`;
  tips.push({ label: c.label, text: `Change ${c.label}${where} while you play, and listen to what it does.`, target: `${w.title} › ${c.label}` });
 }
 const left = tips.filter(t => !given.includes(t.label));
 if (!left.length) return null;
 const settings = tunable.map(c => `${c.label} = ${c.value}`).join('; ');
 const situation = `A student is learning the ${w.title}${w.plugin ? ' plug-in' : ' widget'} of a synth. Its settings: ${settings}. Already tried: ${given.join(', ') || 'nothing yet'}.`;
 const { choice, ms } = await pick(situation, 'Which control should the student try next, to learn what it does?', Object.fromEntries(left.map((t, i) => [String(i), t.text])));
 return { ...left[Number(choice)] || left[0], ms };
}
