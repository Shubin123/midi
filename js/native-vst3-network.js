export function sendGuestRequest({ url, method, headers, body, timeout }) {
 const request = new XMLHttpRequest();
 request.open(method, url, false); request.responseType = 'arraybuffer';
 if (timeout > 0) request.timeout = Math.min(timeout, 60) * 1000;
 for (const { name, value } of headers) request.setRequestHeader(name, value);
 try { request.send(body); }
 catch (error) { return { error: { code: error.name === 'TimeoutError' ? -1001 : -1004, description: `The browser refused this request: ${error.message}` } }; }
 if (!request.status) return { error: { code: -1004, description: 'The browser refused this request.' } };
 const fields = request.getAllResponseHeaders().trim().split(/\r?\n/).filter(Boolean).map(line => { const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()]; });
 return { status: request.status, headers: fields, response: new Uint8Array(request.response ?? new ArrayBuffer(0)) };
}
