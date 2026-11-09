const canonicalMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS']);
const headerToken = /^[!#$%&'*+\-.^_`|~a-z\d]+$/i;

export function releaseGuestRequest(objc, state) {
 for (const key of ['url', 'document', 'body']) if (state[key]) objc.releaseObject(state[key]);
}

function install(objc, handle, state) {
 const retained = [];
 try { for (const key of ['url', 'document', 'body']) if (state[key]) retained.push(objc.retainObject(state[key])); }
 catch (error) { for (const value of retained) objc.releaseObject(value); throw error; }
 const object = objc.objects.get(handle), previous = object.request; object.request = state;
 if (previous) releaseGuestRequest(objc, previous);
 return handle;
}

function createRequest(objc, className, state) {
 const handle = objc.instance(objc.foundationClass(className), 0);
 try { return install(objc, handle, state); } catch (error) { objc.releaseObject(handle); throw error; }
}

export function copyGuestRequest(objc, handle) {
 const state = objc.objects.get(handle)?.request;
 if (!state || !state.url) throw new Error('Unsupported guest task request');
 return createRequest(objc, 'NSURLRequest', { ...state, headers: new Map(state.headers) });
}

export function invokeGuestRequest(objc, receiver, name, record, object) {
 const memory = objc.memory, mutable = record.foundation === 'NSMutableURLRequest';
 const argument = () => memory.register('RDX');
 const url = value => { if (value && !objc.objects.get(value)?.url) throw new Error('Unsupported guest request URL'); return value; };
 const timeout = value => { if (!Number.isFinite(value) || value < 0) throw new Error('Unsupported guest request timeout'); return value; };
 const policy = value => { if (value > 5n) throw new Error('Unsupported guest request cache policy'); return Number(value); };
 const string = text => { if (!objc.pools.length) throw new Error('Autorelease requires a guest pool'); return objc.autorelease(objc.foundationString(text)); };
 const create = (className, state) => createRequest(objc, className, state);
 const factory = !object && ['requestWithURL:', 'requestWithURL:cachePolicy:timeoutInterval:'].includes(name);
 const initializer = object && ['initWithURL:', 'initWithURL:cachePolicy:timeoutInterval:'].includes(name);
 if (factory || initializer) {
  if (factory && !objc.pools.length) throw new Error('Autorelease requires a guest pool');
  const address = url(argument()); if (!address) throw new Error('Missing guest request URL');
  const custom = name.includes('cachePolicy:'), state = { url: address, cachePolicy: custom ? policy(memory.argument64(3)) : 0, timeoutInterval: custom ? timeout(memory.floatingRegister()) : 60, method: 'GET', headers: new Map(), document: 0, body: 0, cookies: true, pipelining: false, cellular: true };
  return factory ? objc.autorelease(create(record.foundation, state)) : install(objc, receiver, state);
 }
 const state = object?.request;
 if (!state) return undefined;
 if (['copy', 'copyWithZone:', 'mutableCopy', 'mutableCopyWithZone:'].includes(name)) {
  const copyingMutable = name.startsWith('mutable');
  if (!copyingMutable && !mutable) return objc.retainObject(receiver);
  return create(copyingMutable ? 'NSMutableURLRequest' : 'NSURLRequest', { ...state, headers: new Map(state.headers) });
 }
 if (name === 'URL') return state.url;
 if (name === 'mainDocumentURL') return state.document;
 if (name === 'cachePolicy') return state.cachePolicy;
 if (name === 'timeoutInterval') return { rax: 0, xmm0: state.timeoutInterval };
 if (name === 'HTTPMethod') return string(state.method);
 if (name === 'HTTPBody') return state.body;
 if (name === 'HTTPBodyStream') return 0;
 const flags = { HTTPShouldHandleCookies: 'cookies', HTTPShouldUsePipelining: 'pipelining', allowsCellularAccess: 'cellular' };
 if (Object.hasOwn(flags, name)) return Number(state[flags[name]]);
 if (name === 'valueForHTTPHeaderField:') { const value = state.headers.get(memory.core.text(argument()).toLowerCase()); return value ? string(value.value) : 0; }
 if (!mutable) return undefined;
 if (name === 'setURL:' || name === 'setMainDocumentURL:') {
  const value = url(argument()), key = name === 'setURL:' ? 'url' : 'document', previous = state[key];
  if (value) objc.retainObject(value); state[key] = value; if (previous) objc.releaseObject(previous); return 0;
 }
 if (name === 'setCachePolicy:') { state.cachePolicy = policy(memory.argument64(2)); return 0; }
 if (name === 'setTimeoutInterval:') { state.timeoutInterval = timeout(memory.floatingRegister()); return 0; }
 if (name === 'setHTTPMethod:') {
  const value = memory.core.text(argument());
  if (value.length > 128 || !headerToken.test(value)) throw new Error('Unsupported guest HTTP method');
  state.method = canonicalMethods.has(value.toUpperCase()) ? value.toUpperCase() : value; return 0;
 }
 if (name === 'setHTTPBody:') {
  const value = argument(), copy = value ? memory.core.invoke('_CFDataCreateCopy', [0, value]) : 0, previous = state.body;
  state.body = copy; if (previous) objc.releaseObject(previous); return 0;
 }
 for (const [property, key] of Object.entries(flags)) if (name === `set${property[0].toUpperCase()}${property.slice(1)}:`) { state[key] = !!(memory.argument64(2) & 255n); return 0; }
 if (name === 'setValue:forHTTPHeaderField:' || name === 'addValue:forHTTPHeaderField:') {
  const field = memory.core.text(memory.register('RCX')), key = field.toLowerCase(), value = argument() ? memory.core.text(argument()) : null;
  if (!headerToken.test(field)) throw new Error('Invalid guest HTTP header field');
  if (value === null) { if (name.startsWith('add')) throw new Error('Missing guest HTTP header value'); state.headers.delete(key); return 0; }
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error('Unsupported guest HTTP header value');
  const previous = state.headers.get(key), combined = name.startsWith('add') && previous ? `${previous.value},${value}` : value;
  const bytes = new TextEncoder().encode(field + combined).length + [...state.headers].filter(([entry]) => entry !== key).reduce((total, [, entry]) => total + new TextEncoder().encode(entry.name + entry.value).length, 0);
  if (bytes > 64 << 10 || !previous && state.headers.size >= 256) throw new Error('Guest HTTP headers exceed their bounded capacity');
  state.headers.set(key, { name: previous?.name || field, value: combined }); return 0;
 }
 return undefined;
}
