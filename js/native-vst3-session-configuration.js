const defaults = {
 requestCachePolicy: 0n, networkServiceType: 0n, HTTPCookieAcceptPolicy: 2n,
 HTTPMaximumConnectionsPerHost: 6n,
 timeoutIntervalForRequest: 60, timeoutIntervalForResource: 604800,
 allowsCellularAccess: true, discretionary: false, HTTPShouldUsePipelining: false,
 HTTPShouldSetCookies: true, sessionSendsLaunchEvents: false, waitsForConnectivity: false,
 allowsExpensiveNetworkAccess: true, allowsConstrainedNetworkAccess: true,
 shouldUseExtendedBackgroundIdleMode: false,
};
const setters = new Map(Object.keys(defaults).map(property => [`set${property[0].toUpperCase()}${property.slice(1)}:`, property]));

export function createGuestSessionConfiguration(objc, state = defaults) {
 const handle = objc.instance(objc.foundationClass('NSURLSessionConfiguration'), 0);
 objc.objects.get(handle).sessionConfiguration = { ...state }; return handle;
}

export function copyGuestSessionConfiguration(objc, handle) {
 const state = objc.objects.get(handle)?.sessionConfiguration;
 if (!state) throw new Error('Unsupported guest session configuration');
 return createGuestSessionConfiguration(objc, state);
}

export function invokeGuestSessionConfiguration(objc, receiver, name, record, object) {
 const memory = objc.memory;
 if (!object && name === 'defaultSessionConfiguration') {
  if (!objc.pools.length) throw new Error('Autorelease requires a guest pool');
  const handle = createGuestSessionConfiguration(objc);
  try { return objc.autorelease(handle); } catch (error) { objc.releaseObject(handle); throw error; }
 }
 const state = object?.sessionConfiguration;
 if (!state) return undefined;
 if (name === 'copy' || name === 'copyWithZone:') return copyGuestSessionConfiguration(objc, receiver);
 if (name === 'identifier' || name === 'sharedContainerIdentifier') return 0;
 const property = name === 'isDiscretionary' ? 'discretionary' : name;
 if (Object.hasOwn(defaults, property) && name !== 'discretionary') {
  const value = state[property];
  if (typeof value === 'boolean') return Number(value);
  return typeof value === 'number' ? { rax: 0, xmm0: value } : value;
 }
 const setting = setters.get(name);
 if (!setting) return undefined;
 const value = defaults[setting];
 if (typeof value === 'number') state[setting] = memory.floatingRegister();
 else if (typeof value === 'boolean') state[setting] = !!(memory.argument64(2) & 255n);
 else state[setting] = setting === 'HTTPMaximumConnectionsPerHost' ? BigInt.asIntN(64, memory.argument64(2)) : memory.argument64(2);
 return 0;
}
