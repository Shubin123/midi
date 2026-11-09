import { GuestFileError } from './native-vst3-files.js';

export const timeImports = new Set(['_localtime_r', '_gmtime_r', '_nanosleep', '_time', '_mktime', '_timegm']);
const divide = (value, divisor) => value / divisor - (value % divisor < 0n ? 1n : 0n);
const firstDay = year => {
 const previous = year - 1n;
 return 365n * (year - 1970n) + divide(previous, 4n) - divide(previous, 100n) + divide(previous, 400n) - 477n;
};

export function utcTimeFields(seconds) {
 const days = divide(seconds, 86400n), remaining = seconds - days * 86400n;
 let low = -2147481748n, high = 2147485548n;
 if (days < firstDay(low) || days >= firstDay(high)) throw new GuestFileError(84, 'Calendar year exceeds Darwin tm_year');
 while (high - low > 1n) {
  const middle = (low + high) / 2n;
  if (firstDay(middle) <= days) low = middle; else high = middle;
 }
 const leap = low % 4n === 0n && (low % 100n !== 0n || low % 400n === 0n);
 const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], yearDay = Number(days - firstDay(low));
 let month = 0, day = yearDay;
 while (day >= lengths[month]) { day -= lengths[month]; month++; }
 return [Number(remaining % 60n), Number(remaining / 60n % 60n), Number(remaining / 3600n), day + 1, month, Number(low - 1900n), Number((days % 7n + 11n) % 7n), yearDay, 0];
}

export class GuestTime {
 constructor(memory) { this.memory = memory; this.zones = new Map(); }
 monotonicNanoseconds() {
  const milliseconds = this.memory.monotonicClock();
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > Number.MAX_SAFE_INTEGER / 1000000) throw new Error('Invalid guest monotonic clock');
  const tick = BigInt(Math.floor(milliseconds * 1000000));
  if (tick > this.memory.lastTick) this.memory.lastTick = tick;
  return this.memory.lastTick;
 }
 expire() {
  const sleepers = Array.from(this.memory.threads.records).filter(thread => thread.state === 'blocked' && thread.blocked.kind === 'sleep');
  if (!sleepers.length) return false;
  const now = this.monotonicNanoseconds();
  let pending = false;
  for (const thread of sleepers) {
   if (now < thread.sleepDeadline) { pending = true; continue; }
   thread.state = 'runnable'; thread.blocked = null;
  }
  return pending;
 }
 sleep(input) {
  const memory = this.memory, thread = memory.threads.current;
  if (thread.sleepDeadline !== undefined) { delete thread.sleepDeadline; return 0; }
  let bytes;
  try { if (!input) throw new Error('Missing timespec'); bytes = memory.read(input, 16); }
  catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestFileError(14, 'Invalid guest timespec pointer'); }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), seconds = view.getBigInt64(0, true), nanoseconds = view.getBigInt64(8, true);
  if (seconds < 0n || nanoseconds < 0n || nanoseconds >= 1000000000n) throw new GuestFileError(22, 'Invalid guest sleep interval');
  const duration = seconds * 1000000000n + nanoseconds;
  if (!duration) return 0;
  memory.threads.checkBlocking();
  thread.sleepDeadline = this.monotonicNanoseconds() + duration;
  return memory.threads.park('sleep', input);
 }
 invoke(name, [input, output]) {
  if (!timeImports.has(name)) throw new Error(`Unsupported guest time operation ${name}`);
  if (name === '_nanosleep') return this.sleep(input);
  const memory = this.memory;
  if (name === '_mktime' || name === '_timegm') {
   const bytes = memory.read(input, 56), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
   const [second, minute, hour, day, month, year] = [0, 4, 8, 12, 16, 20].map(offset => view.getInt32(offset, true));
   const clock = new Date(0); clock.setUTCFullYear(year + 1900, month, day); clock.setUTCHours(hour, minute, second, 0);
   const seconds = Math.floor(clock.getTime() / 1000);
   if (!Number.isSafeInteger(seconds)) return -1;
   const zone = name === '_timegm' ? 'GMT' : 'UTC';
   if (!this.zones.has(zone)) this.zones.set(zone, memory.objc.cstring(zone));
   utcTimeFields(BigInt(seconds)).forEach((value, index) => view.setInt32(index * 4, value, true));
   view.setBigUint64(48, BigInt(this.zones.get(zone)), true); memory.write(input, bytes);
   return seconds;
  }
  if (name === '_time') {
   const seconds = BigInt(Math.floor(memory.wallClock() / 1000));
   if (input) { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, seconds, true); memory.write(input, bytes); }
   return seconds;
  }
  const access = operation => {
   try { return operation(); }
   catch (error) { if (error instanceof WebAssembly.RuntimeError) throw error; throw new GuestFileError(14, 'Invalid guest calendar pointer'); }
  };
  if (!input || !output) throw new GuestFileError(14, 'Missing guest calendar pointer');
  const source = access(() => memory.read(input, 8)), seconds = new DataView(source.buffer, source.byteOffset, source.byteLength).getBigInt64(0, true), fields = utcTimeFields(seconds);
  access(() => memory.read(output, 56));
  const zone = name === '_gmtime_r' ? 'GMT' : 'UTC';
  if (!this.zones.has(zone)) this.zones.set(zone, memory.objc.cstring(zone));
  const bytes = new Uint8Array(56), view = new DataView(bytes.buffer);
  fields.forEach((value, index) => view.setInt32(index * 4, value, true));
  view.setBigUint64(48, BigInt(this.zones.get(zone)), true); access(() => memory.write(output, bytes)); return output;
 }
 report() { return { timeZone: 'UTC' }; }
}
