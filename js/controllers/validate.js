// Checks a controller preset before it is used: against js/controllers/schema.json (the JSON-schema keywords
// that file uses: type, const, enum, required, properties, additionalProperties, items, minItems, maxItems,
// minimum, maximum, minLength, pattern, $ref), then for what a schema can't say: every mapping, message and
// feedback entry names a control the preset has, ids are unique, `extends` finds its variation, and every
// SysEx template reads. Returns a list of problems in words, each with where it is ("controls[3].id"); empty
// means the preset is good. Pure, so it runs in tests/controllers.mjs as it does in the page.
import { readTemplate } from './preset.js';

const typeOk = (t, v) => (t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'array' ? Array.isArray(v) : t === 'object' ? !!v && typeof v === 'object' && !Array.isArray(v) : t === 'null' ? v === null : typeof v === t);
const say = v => JSON.stringify(v)?.slice(0, 40);

export function checkSchema(schema, value, root = schema, at = '') {
 const out = [];
 const where = at || 'the preset';
 if (schema.$ref) { const def = schema.$ref.replace('#/$defs/', ''); return checkSchema(root.$defs[def], value, root, at); }
 if (schema.const !== undefined && value !== schema.const) return [`${where} must be ${say(schema.const)}, not ${say(value)}`];
 if (schema.enum && !schema.enum.includes(value)) return [`${where} must be one of ${schema.enum.map(say).join(', ')}, not ${say(value)}`];
 if (schema.type) { const types = [].concat(schema.type); if (!types.some(t => typeOk(t, value))) return [`${where} must be ${types.join(' or ')}, not ${say(value)}`]; }
 if (typeof value === 'string') {
  if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${where} is empty`);
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) out.push(`${where} ("${value}") doesn't match ${schema.pattern}`);
 }
 if (typeof value === 'number') {
  if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where} is below ${schema.minimum}`);
  if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where} is above ${schema.maximum}`);
 }
 if (Array.isArray(value)) {
  if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${where} needs at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}`);
  if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${where} takes at most ${schema.maxItems} items`);
  if (schema.items) value.forEach((v, i) => out.push(...checkSchema(schema.items, v, root, `${at}[${i}]`)));
 }
 if (typeOk('object', value) && (schema.properties || schema.required || schema.additionalProperties !== undefined)) {
  for (const k of schema.required || []) if (value[k] === undefined) out.push(`${at ? `${at} ` : ''}needs ${k}`);
  for (const [k, v] of Object.entries(value)) {
   const sub = schema.properties?.[k], path = at ? `${at}.${k}` : k;
   if (sub) out.push(...checkSchema(sub, v, root, path));
   else if (schema.additionalProperties === false) out.push(`${path} isn't part of the format`);
   else if (typeof schema.additionalProperties === 'object') out.push(...checkSchema(schema.additionalProperties, v, root, path));
  }
 }
 return out;
}

// What the schema can't check.
export function checkMeaning(p) {
 const out = [], ids = new Set();
 (p.controls || []).forEach((c, i) => { if (ids.has(c.id)) out.push(`controls[${i}].id "${c.id}" is used twice`); ids.add(c.id); });
 const known = (id, where) => { if (!ids.has(id)) out.push(`${where} names "${id}", which isn't one of the controls`); };
 const channelOk = (ch, where) => { if (ch !== undefined && ch !== 'any' && !(Number.isInteger(ch) && ch >= 1 && ch <= 16)) out.push(`${where} must be 1 to 16 or "any"`); };
 const template = (bytes, where) => { try { readTemplate(bytes); } catch (err) { out.push(`${where}: ${err.message}`); } };
 const progIds = new Set();
 (p.programs || []).forEach((g, i) => {
  if (progIds.has(g.id)) out.push(`programs[${i}].id "${g.id}" is used twice`); progIds.add(g.id);
  for (const [id, m] of Object.entries(g.messages || {})) {
   const where = `programs[${i}] (${g.id}).messages.${id}`;
   known(id, where); channelOk(m.channel, `${where}.channel`);
   const kinds = ['cc', 'note', 'notes', 'bend', 'pressure', 'learn'].filter(k => m[k] !== undefined);
   if (kinds.length !== 1 && !(kinds.length === 2 && kinds.includes('note') && kinds.includes('pressure'))) out.push(`${where} must say one of cc, note, notes, bend, pressure or learn`);
   if (m.notes && m.notes[0] > m.notes[1]) out.push(`${where}.notes goes down`);
  }
  [...(g.enter || []), ...(g.exit || [])].forEach((b, j) => template(b, `programs[${i}] (${g.id}) enter/exit[${j}]`));
 });
 if ((p.programs || []).filter(g => g.default).length > 1) out.push('only one program can be the default');
 const fb = p.feedback || {};
 if (fb.pads) { template(fb.pads.message, 'feedback.pads.message'); Object.keys(fb.pads.index).forEach(id => known(id, 'feedback.pads.index')); (fb.pads.programs || []).forEach(g => { if (!progIds.has(g)) out.push(`feedback.pads.programs names "${g}", which isn't a program`); }); }
 if (fb.leds) fb.leds.controls.forEach(id => known(id, 'feedback.leds.controls'));
 if (fb.screen) { template(fb.screen.message, 'feedback.screen.message'); if (fb.screen.widths.length !== fb.screen.lines) out.push('feedback.screen.widths needs a width for each line'); }
 if (fb.encoders) { template(fb.encoders.message, 'feedback.encoders.message'); Object.keys(fb.encoders.index).forEach(id => known(id, 'feedback.encoders.index')); }
 (p.listen || []).forEach((a, i) => { template(a.message, `listen[${i}].message`); if (a.means === 'program') Object.values(a.values || {}).concat(a.otherwise ? [a.otherwise] : []).forEach(g => { if (!progIds.has(g)) out.push(`listen[${i}] names program "${g}", which isn't one`); }); });
 (p.queries || []).forEach((q, i) => template(q, `queries[${i}]`));
 const varIds = new Set((p.variations || []).map(v => v.id));
 if ((p.variations || []).filter(v => v.default).length > 1) out.push('only one variation can be the default');
 (p.variations || []).forEach((v, i) => {
  const where = `variations[${i}] (${v.id})`;
  if (v.extends && (!varIds.has(v.extends) || v.extends === v.id)) out.push(`${where}.extends names "${v.extends}", which isn't another variation`);
  (v.programs || []).forEach(g => { if (!progIds.has(g)) out.push(`${where}.programs names "${g}", which isn't a program`); });
  const pageIds = new Set();
  (v.pages || []).forEach((pg, j) => {
   if (pageIds.has(pg.id)) out.push(`${where}.pages[${j}].id "${pg.id}" is used twice`); pageIds.add(pg.id);
   if (!pg.params && !pg.from) out.push(`${where}.pages[${j}] (${pg.id}) needs params or from`);
   if (pg.from === 'widget' && !pg.widget) out.push(`${where}.pages[${j}] (${pg.id}) is from a widget but doesn't say which`);
  });
  const action = (a, w) => {
   if (a.do === 'page' && !a.slot) out.push(`${w} is a page knob without a slot`);
   if (a.do === 'param' && !a.param) out.push(`${w} sets a parameter without saying which`);
   if (['loop', 'clear', 'step'].includes(a.do) && !(a.slot || a.index)) out.push(`${w} needs ${a.do === 'step' ? 'index' : 'slot'}`);
   if (a.hold) action(a.hold, `${w}.hold`);
   if (a.shift) action(a.shift, `${w}.shift`);
  };
  for (const [id, a] of Object.entries(v.mappings || {})) { known(id, `${where}.mappings`); action(a, `${where}.mappings.${id}`); }
 });
 return out;
}

export function validate(preset, schema) { const shape = checkSchema(schema, preset); return shape.length ? shape : checkMeaning(preset); }
