export const urlErrors = { cancelled: -999, timedOut: -1001, cannotConnect: -1004, notConnected: -1009 };

function createHeaderFields(objc, headers) {
 const handle = objc.instance(objc.foundationClass('NSDictionary'), 0), entries = [];
 objc.objects.get(handle).headerFields = entries;
 for (const [name, value] of headers) entries.push({ text: name.toLowerCase(), key: objc.foundationString(name), value: objc.foundationString(value) });
 return handle;
}

export function createGuestHTTPResponse(objc, url, status, headers, expected) {
 const handle = objc.instance(objc.foundationClass('NSHTTPURLResponse'), 0);
 objc.objects.get(handle).urlResponse = { url: objc.retainObject(url), status, expected, headers: createHeaderFields(objc, headers) };
 return handle;
}

export function createGuestURLError(objc, code, description) {
 const handle = objc.instance(objc.foundationClass('NSError'), 0);
 objc.objects.get(handle).urlError = { code, description };
 return handle;
}

export function releaseGuestURLResponse(objc, object) {
 if (object.urlResponse) for (const value of [object.urlResponse.url, object.urlResponse.headers]) objc.releaseObject(value);
 for (const entry of object.headerFields ?? []) { objc.releaseObject(entry.key); objc.releaseObject(entry.value); }
 if (object.enumeration) {
  objc.releaseObject(object.enumeration.source);
  if (object.enumeration.owned) for (const key of object.enumeration.keys) objc.releaseObject(key);
 }
}

export function invokeGuestURLResponse(objc, receiver, name, record, object) {
 const string = text => { if (!objc.pools.length) throw new Error('Autorelease requires a guest pool'); return objc.autorelease(objc.foundationString(text)); };
 if (object?.urlResponse) {
  const state = object.urlResponse;
  if (name === 'statusCode') return state.status;
  if (name === 'expectedContentLength') return state.expected;
  if (name === 'allHeaderFields') return state.headers;
  if (name === 'URL') return state.url;
 }
 if (object?.urlError) {
  if (name === 'code') return object.urlError.code;
  if (name === 'domain') return string('NSURLErrorDomain');
  if (name === 'localizedDescription') return string(object.urlError.description);
 }
 if (object?.headerFields) {
  if (name === 'count') return object.headerFields.length;
  if (name === 'objectForKey:') {
   const key = objc.memory.register('RDX'), text = key ? objc.memory.core.text(key).toLowerCase() : null;
   return object.headerFields.find(entry => entry.text === text)?.value ?? 0;
  }
  if (name === 'keyEnumerator') {
   if (!objc.pools.length) throw new Error('Autorelease requires a guest pool');
   const handle = objc.instance(objc.foundationClass('NSEnumerator'), 0);
   objc.objects.get(handle).enumeration = { source: objc.retainObject(receiver), keys: object.headerFields.map(entry => entry.key), position: 0 };
   return objc.autorelease(handle);
  }
 }
 if (object?.enumeration) {
  const state = object.enumeration;
  if (name === 'nextObject') {
   if (state.position >= state.keys.length) return 0;
   state.last = state.paths?.[state.position] ?? null;
   return state.keys[state.position++];
  }
  if (name === 'skipDescendents' && state.paths) {
   while (state.last !== null && state.position < state.paths.length && state.paths[state.position].startsWith(`${state.last}/`)) state.position++;
   return 0;
  }
 }
 return undefined;
}
