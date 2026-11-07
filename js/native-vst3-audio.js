const ids = {
 unknown: '0000000000000000c000000000000046',
 host: '58e595ccdb2d49698b6aaf8c36a664e5',
 component: 'e831ff31f2d54301928ebbee25697802',
 processor: '42043f99b7da453ca569e79d9aaec33d',
 events: '3a2c4214346349feb2c4f397b9695a44',
};
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const fromHex = value => Uint8Array.from(value.match(/../g), byte => parseInt(byte, 16));
const returned32 = memory => Number(BigInt.asIntN(32, memory.engine.reg_read_i64(memory.uc.X86_REG_RAX)));

export class NativeVst3Processor {
 constructor(memory) {
  if (memory.audioHost) throw new Error('A native guest can host only one processor');
  this.memory = memory; memory.audioHost = this; this.stage = 'new'; this.objects = new Map(); this.events = [];
  this.component = 0; this.processor = 0; this.componentInitialized = false; this.active = false; this.processing = false;
  this.blocksProcessed = 0; this.framesProcessed = 0; this.failure = null;
 }
 object(kind, operations) {
  const address = this.memory.allocate(16), table = this.memory.allocate(operations.length * 8);
  this.memory.write(address, new Uint8Array(16)); this.memory.writePointer(address, table);
  operations.forEach((operation, index) => this.memory.writePointer(table + index * 8, this.memory.resolve(`__midi_vst3_${operation}`, 0, 'bind')));
  this.objects.set(address, { kind, references: 1, table }); return address;
 }
 invoke(name, [first, second, third, fourth]) {
  const record = this.objects.get(first); if (!record) throw new Error('Invalid VST3 host callback receiver');
  switch (name) {
   case '__midi_vst3_query': {
    const requested = hex(this.memory.read(second, 16)); this.memory.writePointer(third, 0);
    if (requested !== ids.unknown && requested !== ids[record.kind]) return -1;
    if (record.references >= 65536) throw new Error('VST3 host reference limit exceeded');
    record.references++; this.memory.writePointer(third, first); return 0;
   }
   case '__midi_vst3_retain':
    if (record.references >= 65536) throw new Error('VST3 host reference limit exceeded');
    return ++record.references;
   case '__midi_vst3_release': {
    const remaining = --record.references;
    if (!remaining) { this.objects.delete(first); this.memory.allocations.delete(first); this.memory.allocations.delete(record.table); }
    return remaining;
   }
   case '__midi_vst3_name': {
    if (record.kind !== 'host') throw new Error('Invalid host name receiver');
    const bytes = new Uint8Array(256), view = new DataView(bytes.buffer);
    Array.from('MIDI Browser').forEach((character, index) => view.setUint16(index * 2, character.charCodeAt(0), true));
    this.memory.write(second, bytes); return 0;
   }
   case '__midi_vst3_create':
    if (record.kind !== 'host') throw new Error('Invalid host creation receiver');
    this.memory.writePointer(fourth, 0); return -1;
   case '__midi_vst3_eventCount':
    if (record.kind !== 'events') throw new Error('Invalid event list receiver');
    return this.events.length;
   case '__midi_vst3_event':
    if (record.kind !== 'events') throw new Error('Invalid event list receiver');
    if (!Number.isInteger(second) || second < 0 || second >= this.events.length) return 2;
    this.memory.write(third, this.events[second]); return 0;
   case '__midi_vst3_addEvent': return 3;
   default: throw new Error('Unsupported VST3 host callback');
  }
 }
 checked(object, slot, args, operation) {
  this.memory.virtual(object, slot, args); const code = returned32(this.memory);
  if (code !== 0) throw new Error(`${operation} failed (${code})`);
 }
 open({ classIndex, sampleRate = 48000, maxBlock = 128 } = {}) {
  if (this.stage !== 'new') throw new Error('Native processor has already been opened');
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000 || !Number.isInteger(maxBlock) || maxBlock < 1 || maxBlock > 4096) throw new Error('Invalid native processing configuration');
  this.sampleRate = sampleRate; this.maxBlock = maxBlock;
  try {
   this.stage = 'startup'; this.memory.initialize();
   this.stage = 'factory'; const factory = this.memory.factoryInfo();
   const index = classIndex ?? factory.classes.findIndex(entry => entry.category === 'Audio Module Class');
   if (!Number.isInteger(index) || index < 0 || index >= factory.classes.length || factory.classes[index].category !== 'Audio Module Class') throw new Error('Invalid audio component class');
   this.classInfo = factory.classes[index];
   if (!/^[0-9a-f]{32}$/.test(this.classInfo.cid) || /^0+$/.test(this.classInfo.cid)) throw new Error('Audio component class ID is invalid');
   const cid = this.memory.allocate(16), iid = this.memory.allocate(16), output = this.memory.allocate(8);
   this.memory.write(cid, fromHex(this.classInfo.cid)); this.memory.write(iid, fromHex(ids.component)); this.memory.writePointer(output, 0);
   this.stage = 'creating-component'; this.checked(this.memory.factory, 6, [cid, iid, output], 'createInstance');
   this.component = this.memory.pointer(output); if (!this.component) throw new Error('createInstance returned a null component');
   this.host = this.object('host', ['query', 'retain', 'release', 'name', 'create']);
   this.stage = 'initializing-component'; this.checked(this.component, 3, [this.host], 'IComponent.initialize'); this.componentInitialized = true;
   this.stage = 'querying-processor'; this.memory.write(iid, fromHex(ids.processor)); this.memory.writePointer(output, 0);
   this.checked(this.component, 0, [iid, output], 'IAudioProcessor query'); this.processor = this.memory.pointer(output);
   if (!this.processor) throw new Error('IAudioProcessor query returned null');
   this.checked(this.processor, 5, [0], 'float32 sample format');
   this.stage = 'configuring'; this.inputBuses = this.buses(0, 0); this.outputBuses = this.buses(0, 1); this.eventBuses = this.buses(1, 0);
   if (!this.outputBuses.length) throw new Error('The component has no audio output buses');
   this.inputs = this.buffers(this.inputBuses); this.outputs = this.buffers(this.outputBuses);
   this.eventList = this.object('events', ['query', 'retain', 'release', 'eventCount', 'event', 'addEvent']);
   this.data = this.memory.allocate(80); this.memory.write(this.data, new Uint8Array(80));
   const setup = this.memory.allocate(24), bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
   view.setInt32(0, 2, true); view.setInt32(8, maxBlock, true); view.setFloat64(16, sampleRate, true); this.memory.write(setup, bytes);
   this.checked(this.processor, 7, [setup], 'setupProcessing');
   for (const [media, direction, buses] of [[0, 0, this.inputBuses], [0, 1, this.outputBuses], [1, 0, this.eventBuses]]) for (let bus = 0; bus < buses.length; bus++) this.checked(this.component, 10, [media, direction, bus, 1], 'activateBus');
   this.checked(this.component, 11, [1], 'setActive'); this.active = true;
   this.checked(this.processor, 8, [1], 'setProcessing'); this.processing = true; this.stage = 'processing';
   return { name: this.classInfo.name, sampleRate, maxBlock, inputs: this.inputBuses.map(bus => bus.channels), outputs: this.outputBuses.map(bus => bus.channels), eventInputs: this.eventBuses.length };
  } catch (error) { this.failure = error; this.failureStage = this.stage; throw error; }
 }
 buses(media, direction) {
  this.memory.virtual(this.component, 7, [media, direction]); const count = returned32(this.memory);
  if (count < 0 || count > 16) throw new Error('Native bus count exceeds the supported limit');
  const buses = [], info = this.memory.allocate(280); let channels = 0;
  for (let index = 0; index < count; index++) {
   this.memory.write(info, new Uint8Array(280)); this.checked(this.component, 8, [media, direction, index, info], 'getBusInfo');
   const bytes = this.memory.read(info, 276), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), channelCount = view.getInt32(8, true);
   if (view.getInt32(0, true) !== media || view.getInt32(4, true) !== direction || channelCount < 1 || channelCount > (media ? 16 : 32) || (channels += channelCount) > 128) throw new Error('Invalid native bus description');
   if (!media && view.getUint32(272, true) & 2) throw new Error('Control-voltage buses cannot be routed to the audio preview');
   buses.push({ channels: channelCount });
  }
  return buses;
 }
 buffers(buses) {
  if (!buses.length) return { address: 0, channels: [] };
  const address = this.memory.allocate(buses.length * 24), channels = [];
  this.memory.write(address, new Uint8Array(buses.length * 24));
  buses.forEach((bus, index) => {
   const pointers = this.memory.allocate(bus.channels * 8), bytes = new Uint8Array(4); new DataView(bytes.buffer).setInt32(0, bus.channels, true);
   this.memory.write(address + index * 24, bytes); this.memory.writePointer(address + index * 24 + 16, pointers);
   channels.push(Array.from({ length: bus.channels }, (_, channel) => {
    const buffer = this.memory.allocate(this.maxBlock * 4); this.memory.writePointer(pointers + channel * 8, buffer); return buffer;
   }));
  });
  return { address, channels };
 }
 note(event, frames) {
  const { type, pitch, velocity = 0, channel = 0, offset = 0, bus = 0, noteId = -1 } = event;
  if (!['on', 'off'].includes(type) || !Number.isInteger(pitch) || pitch < 0 || pitch > 127 || !Number.isFinite(velocity) || velocity < 0 || velocity > 1 || !Number.isInteger(channel) || channel < 0 || channel > 15 || !Number.isInteger(offset) || offset < 0 || offset >= frames || !Number.isInteger(bus) || bus < 0 || bus >= this.eventBuses.length || channel >= this.eventBuses[bus].channels || !Number.isInteger(noteId) || noteId < -1 || noteId > 2147483647) throw new Error('Invalid native note event');
  const bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
  view.setInt32(0, bus, true); view.setInt32(4, offset, true); view.setUint16(18, type === 'on' ? 0 : 1, true);
  view.setInt16(24, channel, true); view.setInt16(26, pitch, true); view.setFloat32(type === 'on' ? 32 : 28, velocity, true); view.setInt32(type === 'on' ? 40 : 36, noteId, true); return bytes;
 }
 process(frames, { inputs = [], events = [] } = {}) {
  if (this.stage !== 'processing' || this.failure) throw new Error('Native processor is not available for processing');
  if (!Number.isInteger(frames) || frames < 1 || frames > this.maxBlock || !Array.isArray(inputs) || inputs.length > this.inputBuses.length || !Array.isArray(events) || events.length > 256) throw new Error('Invalid native processing block');
  const notes = events.map(event => this.note(event, frames));
  this.inputs.channels.forEach((bus, index) => {
   if (inputs[index] !== undefined && (!Array.isArray(inputs[index]) || inputs[index].length !== bus.length)) throw new Error('Invalid native audio input bus');
   bus.forEach((pointer, channel) => {
    const samples = inputs[index] === undefined ? new Float32Array(frames) : inputs[index][channel];
    if (!(samples instanceof Float32Array) || samples.length !== frames || samples.some(value => !Number.isFinite(value))) throw new Error('Invalid native audio input samples');
    this.memory.write(pointer, new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
   });
  });
  this.outputs.channels.forEach(bus => bus.forEach(pointer => this.memory.write(pointer, new Uint8Array(frames * 4))));
  const data = new Uint8Array(80), view = new DataView(data.buffer);
  view.setInt32(0, 2, true); view.setInt32(8, frames, true); view.setInt32(12, this.inputBuses.length, true); view.setInt32(16, this.outputBuses.length, true);
  view.setBigUint64(24, BigInt(this.inputs.address), true); view.setBigUint64(32, BigInt(this.outputs.address), true); view.setBigUint64(56, BigInt(this.eventBuses.length ? this.eventList : 0), true);
  this.memory.write(this.data, data); this.events = notes;
  try {
   this.memory.runLoop.drain(); this.checked(this.processor, 9, [this.data], 'process');
   const result = this.outputs.channels.map(bus => bus.map(pointer => {
    const bytes = this.memory.read(pointer, frames * 4), samples = new Float32Array(bytes.slice().buffer);
    if (samples.some(value => !Number.isFinite(value))) throw new Error('Native processor returned non-finite audio'); return samples;
   }));
   this.blocksProcessed++; this.framesProcessed += frames; return result;
  } catch (error) { this.failure = error; this.failureStage = this.stage; throw error; }
 }
 close() {
  if (this.stage === 'closed') return;
  try {
   if (this.processing) { this.checked(this.processor, 8, [0], 'stop processing'); this.processing = false; }
   if (this.active) { this.checked(this.component, 11, [0], 'deactivate'); this.active = false; }
   if (this.componentInitialized) { this.checked(this.component, 4, [], 'terminate'); this.componentInitialized = false; }
   if (this.processor) { this.memory.virtual(this.processor, 2); this.processor = 0; }
   if (this.component) { this.memory.virtual(this.component, 2); this.component = 0; }
  } finally {
   for (const address of [this.host, this.eventList]) if (this.objects.has(address)) this.invoke('__midi_vst3_release', [address]);
   this.stage = 'closed';
  }
 }
 report() { return { stage: this.failureStage || this.stage, componentCreated: !!this.component, componentInitialized: this.componentInitialized, processing: this.processing, blocksProcessed: this.blocksProcessed, framesProcessed: this.framesProcessed }; }
}

export function renderNativeNote(memory, { frames = 12000, sampleRate = 48000, maxBlock = 128, pitch = 60, velocity = 0.8, inputs = [] } = {}, progress = () => {}) {
 if (!Number.isInteger(frames) || frames < 2 || frames > 48000 || !Number.isInteger(pitch) || pitch < 0 || pitch > 127 || !Number.isFinite(velocity) || velocity < 0 || velocity > 1 || !Array.isArray(inputs) || inputs.length > 16) throw new Error('Invalid native render request');
 for (const bus of inputs) if (!Array.isArray(bus) || bus.length > 32 || bus.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)) throw new Error('Invalid native render inputs');
 const processor = new NativeVst3Processor(memory); let failed = false;
 try {
  progress('opening-processor'); const info = processor.open({ sampleRate, maxBlock });
  const channels = info.outputs.map(count => Array.from({ length: count }, () => new Float32Array(frames))), release = Math.floor(frames * 0.75);
  let peak = 0; progress('rendering');
  for (let offset = 0; offset < frames; offset += maxBlock) {
   const count = Math.min(maxBlock, frames - offset), events = [];
   if (!offset && info.eventInputs) events.push({ type: 'on', pitch, velocity });
   if (release >= offset && release < offset + count && info.eventInputs) events.push({ type: 'off', pitch, offset: release - offset });
   const output = processor.process(count, { inputs: inputs.map(bus => bus.map(channel => channel.subarray(offset, offset + count))), events });
   output.forEach((bus, index) => bus.forEach((channel, channelIndex) => {
    channels[index][channelIndex].set(channel, offset); for (const value of channel) peak = Math.max(peak, Math.abs(value));
   }));
  }
  return { sampleRate, frames, peak, silent: peak === 0, buses: channels, blocksProcessed: processor.blocksProcessed, realtime: false };
 } catch (error) { failed = true; throw error; }
 finally { try { processor.close(); } catch (error) { if (!failed) throw error; } }
}
