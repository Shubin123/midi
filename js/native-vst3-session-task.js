import { copyGuestRequest } from './native-vst3-request.js';

export function createGuestSessionTask(objc, session, request) {
 if (!objc.pools.length) throw new Error('Autorelease requires a guest pool');
 const state = objc.objects.get(session)?.session;
 if (!state?.active) throw new Error('Cannot create a task on an inactive guest session');
 if (state.tasks.size >= 256) throw new Error('Guest URL session task limit exceeded');
 const identifier = state.nextTask;
 if (identifier < 1n || identifier > 0xffffffffffffffffn) throw new Error('Guest URL session task identifier exhausted');
 const owned = [];
 let handle = 0;
 try {
  const snapshot = copyGuestRequest(objc, request); owned.push(snapshot);
  owned.push(objc.retainObject(session));
  handle = objc.instance(objc.foundationClass('NSURLSessionDataTask'), 0);
  const instance = objc.objects.get(handle);
  instance.sessionTask = { session, identifier, request: snapshot, state: 1, priority: 0.5, description: 0, response: 0, error: 0, sent: 0n, received: 0n, expectedSent: 0n, expectedReceived: 0n };
  instance.references++;
  state.tasks.set(identifier, handle);
  const result = objc.autorelease(handle); state.nextTask++; return result;
 } catch (error) {
  state.tasks.delete(identifier);
  if (handle) { const instance = objc.objects.get(handle); delete instance.sessionTask; instance.references = 1; objc.releaseObject(handle); }
  for (const value of owned.reverse()) objc.releaseObject(value);
  throw error;
 }
}

export function releaseGuestSessionTask(objc, state) {
 objc.objects.get(state.session)?.session?.tasks.delete(state.identifier);
 for (const handle of [state.request, state.description, state.response, state.error, state.session]) if (handle) objc.releaseObject(handle);
}

export function invokeGuestSessionTask(objc, receiver, name, record, object) {
 const state = object?.sessionTask;
 if (!state) return undefined;
 if (name === 'resume') { objc.memory.urlTransport.resume(receiver, state); return 0; }
 if (name === 'cancel') { objc.memory.urlTransport.cancel(receiver, state); return 0; }
 if (name === 'taskIdentifier') return state.identifier;
 if (name === 'state') return state.state;
 if (name === 'originalRequest' || name === 'currentRequest') return state.request;
 const counters = { response: 'response', error: 'error', countOfBytesSent: 'sent', countOfBytesReceived: 'received', countOfBytesExpectedToSend: 'expectedSent', countOfBytesExpectedToReceive: 'expectedReceived' };
 if (Object.hasOwn(counters, name)) return state[counters[name]];
 if (name === 'priority') return { rax: 0, xmm0f: state.priority };
 if (name === 'setPriority:') {
  const value = objc.memory.floatingRegister(0, 32);
  if (!(value < 0 || value > 1)) state.priority = value;
  return 0;
 }
 if (name === 'taskDescription') return state.description;
 if (name === 'setTaskDescription:') {
  const value = objc.memory.register('RDX'), copy = value ? objc.foundationString(objc.memory.core.text(value)) : 0, previous = state.description;
  state.description = copy; if (previous) objc.releaseObject(previous); return 0;
 }
 return undefined;
}
