import { copyGuestSessionConfiguration } from './native-vst3-session-configuration.js';
import { createGuestSessionTask } from './native-vst3-session-task.js';

export function createGuestDelegateQueue(objc) {
 const handle = objc.instance(objc.foundationClass('NSOperationQueue'), 0);
 objc.objects.get(handle).operationQueue = { maximum: 1n, suspended: false }; return handle;
}

export function releaseGuestSession(objc, state) {
 for (const handle of [state.configuration, state.delegate, state.queue, state.description]) if (handle) objc.releaseObject(handle);
}

export function invokeGuestSession(objc, receiver, name, record, object) {
 const memory = objc.memory;
 if (!object && ['sessionWithConfiguration:', 'sessionWithConfiguration:delegate:delegateQueue:'].includes(name)) {
  if (!objc.pools.length) throw new Error('Autorelease requires a guest pool');
  if (Array.from(objc.objects.values()).filter(value => value.session).length >= 32) throw new Error('Guest URL session limit exceeded');
  const configuration = memory.register('RDX'), delegated = name.includes('delegate:'), delegate = delegated ? memory.register('RCX') : 0, queue = delegated ? memory.register('R8') : 0;
  if (delegate && !objc.objects.has(delegate)) throw new Error('Unknown guest session delegate');
  const queueObject = queue ? objc.objects.get(queue) : null;
  if (queue && (!queueObject || objc.klass(queueObject.classHandle).foundation !== 'NSOperationQueue')) throw new Error('Unsupported guest session delegate queue');
  const owned = [];
  let handle = 0;
  try {
   const copied = copyGuestSessionConfiguration(objc, configuration); owned.push(copied);
   const callbackQueue = queue ? objc.retainObject(queue) : createGuestDelegateQueue(objc); owned.push(callbackQueue);
   if (delegate) owned.push(objc.retainObject(delegate));
   handle = objc.instance(record.handle, 0);
   const instance = objc.objects.get(handle);
   instance.session = { configuration: copied, delegate, queue: callbackQueue, description: 0, active: true, tasks: new Map(), nextTask: 1n };
   instance.references++;
   return objc.autorelease(handle);
  } catch (error) {
   if (handle) { const instance = objc.objects.get(handle); delete instance.session; instance.references = 1; objc.releaseObject(handle); }
   for (const value of owned.reverse()) objc.releaseObject(value);
   throw error;
  }
 }
 const state = object?.session;
 if (!state) return undefined;
 if (name === 'finishTasksAndInvalidate') { memory.urlTransport.finish(receiver, state); return 0; }
 if (name === 'dataTaskWithRequest:') return createGuestSessionTask(objc, receiver, memory.register('RDX'));
 if (name === 'configuration') {
  if (!objc.pools.length) throw new Error('Autorelease requires a guest pool');
  const copy = copyGuestSessionConfiguration(objc, state.configuration);
  try { return objc.autorelease(copy); } catch (error) { objc.releaseObject(copy); throw error; }
 }
 if (name === 'delegate') return state.delegate;
 if (name === 'delegateQueue') return state.queue;
 if (name === 'sessionDescription') return state.description;
 if (name === 'setSessionDescription:') {
  const value = memory.register('RDX'), copy = value ? objc.foundationString(memory.core.text(value)) : 0, previous = state.description;
  state.description = copy; if (previous) objc.releaseObject(previous); return 0;
 }
 return undefined;
}
