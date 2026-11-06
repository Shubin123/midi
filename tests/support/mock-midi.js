// A Web MIDI stand-in for the browser suites (installed with browser.beforeScripts, before the page's own
// scripts): navigator.requestMIDIAccess gives an access whose ports the test plugs in and out, and
// window.__midi drives it:
//  plug(name, { identity, replies, manufacturer }) adds an input and an output of that name and tells the page
//   (onstatechange); `identity` is the bytes of its identity reply, sent when the page asks; `replies` maps a
//   SysEx the page sends ("F0 ... F7") to the bytes the device answers.
//  unplug(name) takes it away; send(name, bytes, time) is the device sending; sent(name) what the page sent it.
//  denySysex: true makes { sysex: true } fail, as a browser does when SysEx isn't allowed.
(() => {
 const hex = b => [...b].map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
 const devices = new Map(); // name → { input, output, log: [], options }
 const access = { inputs: new Map(), outputs: new Map(), onstatechange: null, sysexEnabled: false };
 const changed = port => { try { access.onstatechange?.({ port }); } catch (err) { console.error(err); } };
 let n = 0;
 window.__midi = {
  denySysex: false, asked: [],
  plug(name, options = {}) {
   const id = `mock-${++n}`, log = [];
   const input = { id, name, manufacturer: options.manufacturer || '', type: 'input', state: 'connected', connection: 'closed', onmidimessage: null, open() { this.connection = 'open'; return Promise.resolve(this); } };
   const output = { id: `${id}-out`, name, manufacturer: options.manufacturer || '', type: 'output', state: 'connected', connection: 'open',
    send(data, time) {
     const bytes = [...data];
     log.push({ bytes, time: time ?? performance.now(), at: performance.now() });
     const reply = hex(bytes) === 'F0 7E 7F 06 01 F7' ? options.identity : options.replies?.[hex(bytes)];
     if (reply) setTimeout(() => window.__midi.send(name, reply), 5);
    } };
   devices.set(name, { input, output, log, options });
   access.inputs.set(id, input); access.outputs.set(output.id, output);
   changed(input);
   return id;
  },
  unplug(name) {
   const d = devices.get(name);
   if (!d) return;
   d.input.state = d.output.state = 'disconnected';
   access.inputs.delete(d.input.id); access.outputs.delete(d.output.id); devices.delete(name);
   changed(d.input);
  },
  send(name, bytes, time = performance.now()) {
   const d = devices.get(name);
   if (!d?.input.onmidimessage) return false;
   d.input.onmidimessage({ data: Uint8Array.from(typeof bytes === 'string' ? bytes.split(/\s+/).map(h => parseInt(h, 16)) : bytes), timeStamp: time });
   return true;
  },
  sent: name => devices.get(name)?.log || [],
  sentHex: name => (devices.get(name)?.log || []).map(x => hex(x.bytes)),
  clear(name) { const d = devices.get(name); if (d) d.log.length = 0; },
  hex,
 };
 navigator.requestMIDIAccess = (opts = {}) => {
  window.__midi.asked.push(!!opts.sysex);
  if (opts.sysex && window.__midi.denySysex) return Promise.reject(Object.assign(new Error('SysEx not allowed'), { name: 'NotAllowedError' }));
  access.sysexEnabled = !!opts.sysex;
  return Promise.resolve(access);
 };
})();
