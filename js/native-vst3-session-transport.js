import { createData } from './native-vst3-data.js';
import { createGuestHTTPResponse, createGuestURLError, urlErrors } from './native-vst3-url-response.js';

const CHUNK = 1 << 20, REGISTERS = ['RDI', 'RSI', 'RDX', 'RCX', 'R8', 'R9'];
const WORKER = '__midi_url_session_worker', RESPONSE = '__midi_url_session_response';

export const urlSessionImport = name => name === WORKER || name === RESPONSE;

export class GuestUrlTransport {
 constructor(memory, send = null) {
  this.memory = memory; this.send = send; this.pending = []; this.script = null; this.pool = 0; this.worker = false; this.block = 0; this.disposition = null;
  this.requests = []; this.resumed = 0; this.completed = 0; this.delegateCalls = 0;
 }
 get objc() { return this.memory.objc; }
 startWorker() {
  if (this.worker) return;
  const memory = this.memory, output = memory.allocate(8);
  try {
   const code = memory.threads.create(output, 0, memory.resolve(WORKER, 0, 'bind'), 0);
   if (code) throw new Error(`Could not start the guest URL session worker (${code})`);
   this.worker = true;
  } finally { memory.allocations.delete(output); }
 }
 enqueue(item) { this.pending.push(item); this.startWorker(); this.memory.threads.wake('url-session', this); }
 resume(handle, state) {
  if (state.state !== 1) return;
  const session = this.objc.objects.get(state.session).session;
  if (session.queue === this.objc.mainOperationQueue) throw new Error('Main-queue URL session delegates are not implemented');
  state.state = 0; this.resumed++; this.enqueue({ handle, state });
 }
 cancel(handle, state) {
  if (state.state === 1) { state.state = 2; this.enqueue({ handle, state }); }
  else if (state.state === 0) state.state = 2;
 }
 finish(handle, session) {
  if (session.invalidating) return;
  session.invalidating = true;
  if (!session.tasks.size) this.enqueue({ invalidate: handle });
 }
 responseBlock() {
  if (this.block) return this.block;
  const memory = this.memory, block = memory.allocate(48), bytes = new Uint8Array(48), view = new DataView(bytes.buffer);
  view.setInt32(8, 1 << 28, true); view.setBigUint64(16, BigInt(memory.resolve(RESPONSE, 0, 'bind')), true); view.setBigUint64(24, BigInt(block + 32), true); view.setBigUint64(40, 32n, true);
  memory.write(block, bytes); return this.block = block;
 }
 invoke(name) {
  if (name === RESPONSE) { this.disposition = Number(BigInt.asIntN(64, this.memory.argument64(1))); return 0; }
  return this.step();
 }
 step() {
  const memory = this.memory, objc = this.objc;
  if (this.pool) { objc.invoke('_objc_autoreleasePoolPop', [this.pool]); this.pool = 0; }
  for (;;) {
   if (!this.script) {
    const item = this.pending.shift();
    if (!item) return memory.threads.park('url-session', this);
    this.script = item.invalidate ? this.invalidate(item.invalidate) : this.deliver(item.handle, item.state);
   }
   this.pool = objc.invoke('_objc_autoreleasePoolPush', []);
   const { value, done } = this.script.next();
   if (!done) return this.enter(value);
   objc.invoke('_objc_autoreleasePoolPop', [this.pool]); this.pool = 0; this.script = null;
  }
 }
 enter({ method, args }) {
  const memory = this.memory, overflow = args.slice(REGISTERS.length);
  const top = Math.floor((memory.threads.current.stackTop - 256 - overflow.length * 8) / 16) * 16, stack = top - 8;
  memory.writePointer(stack, memory.resolve(WORKER, 0, 'bind')); memory.setRegister('RSP', stack);
  overflow.forEach((value, index) => { const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, BigInt(value)), true); memory.write(top + index * 8, bytes); });
  REGISTERS.forEach((name, index) => memory.setRegister(name, args[index] ?? 0));
  this.delegateCalls++; return { tailCall: method.implementation };
 }
 callback(sessionHandle, delegate, name, ...args) {
  if (!delegate) return null;
  const objc = this.objc, method = objc.lookup(objc.klass(objc.objects.get(delegate).classHandle), name);
  return method ? { method, args: [delegate, objc.selector(name), sessionHandle, ...args] } : null;
 }
 perform(state) {
  const objc = this.objc, memory = this.memory, request = objc.objects.get(state.request).request, url = objc.objects.get(request.url).url.absoluteString;
  const data = request.body ? objc.objects.get(request.body) ?? memory.core.object(request.body, 'data') : null, body = data?.length ? memory.read(data.pointer, data.length) : null;
  const log = { method: request.method, url: url.split(/[?#]/)[0] };
  if (this.requests.length < 256) this.requests.push(log);
  if (!this.send) { log.outcome = 'offline'; return { body, error: { code: urlErrors.notConnected, description: 'The guest has no network access; this request was not sent.' } }; }
  let result;
  try { result = this.send({ url, method: request.method, headers: [...request.headers.values()], body, timeout: request.timeoutInterval }); }
  catch (error) { result = { error: { code: urlErrors.cannotConnect, description: error.message || String(error) } }; }
  log.outcome = result.error ? `error ${result.error.code}` : result.status;
  return { body, ...result };
 }
 *deliver(handle, state) {
  const objc = this.objc, sessionHandle = state.session, session = objc.objects.get(sessionHandle).session, delegate = session.delegate;
  const callback = (name, ...args) => this.callback(sessionHandle, delegate, name, handle, ...args);
  let failure = state.state === 2 ? { code: urlErrors.cancelled, description: 'cancelled' } : null;
  if (!failure) {
   const outcome = this.perform(state);
   if (outcome.error) failure = outcome.error;
   else {
    if (outcome.body) {
     const length = BigInt(outcome.body.length); state.sent = state.expectedSent = length;
     const sent = callback('URLSession:task:didSendBodyData:totalBytesSent:totalBytesExpectedToSend:', length, length, length);
     if (sent) yield sent;
    }
    const content = outcome.response, expected = outcome.expected ?? content.length;
    state.expectedReceived = BigInt(expected);
    const url = objc.objects.get(state.request).request.url;
    state.response = createGuestHTTPResponse(objc, url, outcome.status, outcome.headers, expected);
    this.disposition = null;
    const received = callback('URLSession:dataTask:didReceiveResponse:completionHandler:', state.response, this.responseBlock());
    if (received) {
     yield received;
     if (this.disposition === null) throw new Error('Deferred URL session response completion is not implemented');
     if (this.disposition === 0) failure = { code: urlErrors.cancelled, description: 'cancelled' };
     else if (this.disposition !== 1) throw new Error(`Unsupported URL session response disposition ${this.disposition}`);
    }
    for (let offset = 0; !failure && offset < content.length; offset += CHUNK) {
     if (state.state === 2) { failure = { code: urlErrors.cancelled, description: 'cancelled' }; break; }
     const piece = content.subarray(offset, offset + CHUNK), data = objc.autorelease(createData(objc, 'NSData', piece));
     state.received += BigInt(piece.length);
     const chunk = callback('URLSession:dataTask:didReceiveData:', data);
     if (chunk) yield chunk;
    }
   }
  }
  state.state = 3;
  if (failure) state.error = createGuestURLError(objc, failure.code, failure.description);
  this.completed++;
  const finished = callback('URLSession:task:didCompleteWithError:', state.error);
  if (finished) yield finished;
  session.tasks.delete(state.identifier); objc.releaseObject(handle);
  if (session.invalidating && !session.tasks.size) yield* this.invalidate(sessionHandle);
 }
 *invalidate(handle) {
  const objc = this.objc, session = objc.objects.get(handle).session;
  if (!session.active) return;
  const invalid = this.callback(handle, session.delegate, 'URLSession:didBecomeInvalidWithError:', 0);
  if (invalid) yield invalid;
  session.active = false; objc.releaseObject(handle);
 }
 report() {
  return { access: this.send ? 'enabled' : 'offline', resumed: this.resumed, completed: this.completed, delegateCalls: this.delegateCalls, requests: this.requests };
 }
}
