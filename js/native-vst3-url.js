export function parseGuestURL(text) {
 if (typeof text !== 'string' || text.length > 1 << 20) throw new Error('Invalid guest URL string');
 if (/[^\x21-\x7e]|\\|%(?![a-f\d]{2})/i.test(text)) throw new Error('Unsupported guest URL character encoding');
 const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(text);
 if (!match) throw new Error('Only absolute HTTP(S) guest URLs are implemented');
 const [, scheme, authority, encodedPath, query, fragment] = match;
 if (/[^a-z\d\-._~!$&'()*+,;=:@/%]/i.test(encodedPath) || [query, fragment].some(value => value !== undefined && /[^a-z\d\-._~!$&'()*+,;=:@/%?]/i.test(value))) throw new Error('Unsupported guest URL character escaping');
 const host = /^(\[[^\]]+\]|[a-z\d._~-]+)(?::\d+)?$/i.exec(authority);
 if (!host) throw new Error('Guest URL authority is not implemented');
 try { new URL(text); } catch { throw new Error('Invalid guest HTTP(S) URL'); }
 let path;
 try { path = decodeURIComponent(encodedPath); } catch { path = null; }
 if (path && path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
 return { absoluteString: text, relativeString: text, scheme, host: host[1].replace(/^\[|\]$/g, ''), path, query: query ?? null, fragment: fragment ?? null };
}
